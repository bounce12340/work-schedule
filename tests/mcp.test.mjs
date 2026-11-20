/**
 * MCP（讓 AI agent 連進來讀寫排程）。設計文件：docs/superpowers/specs/2026-11-20-mcp-server.md
 *
 * 守的東西，壞掉時大多**沒有徵兆**：
 *   1. 沒有憑證、憑證被撤銷、帳號不是 Pro → 讀不到也寫不了（401／工具錯誤）
 *   2. agent 建出來的項目丟進 index.html **真正的** normalizeItems 跑一次，前後逐字相同
 *      ——不同的話，使用者下一次同步會跳出一個根本不存在的衝突
 *   3. 每一筆寫入都有紀錄、復原得回來；使用者後來又改過的，復原不准蓋掉它
 *   4. 只動自己的資料：別人的那一列一個位元組都不變
 *   5. OAuth：PKCE 驗得出錯、授權碼只能用一次、redirect_uri 對不上就不轉址、
 *      refresh 輪替後舊的作廢、撤銷連 access token 一起作廢
 *   6. token 只存雜湊
 *   7. normalizeRecurrence 的移植與前端逐字相同
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeEnv, addUser, seedState, readState, unwrap } from './d1.mjs';
import { handleMcp } from '../src/mcp/server.js';
import * as S from '../src/mcp/schedule.js';
import {
  handleCreateKey, handleRevokeConnection, handleListConnections, handleRegister,
  handleAuthorizeRedirect, handleAuthorizeDecision, handleToken,
} from '../src/mcp/auth.js';
import { handleActivityUndo } from '../src/mcp/server.js';
import { handleDeleteAccount } from '../src/handlers/appauth.js';
import { hashPassword, sha256 } from '../src/crypto.js';

// ------------------------------------------------------------ 前端的真正原始碼

const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
function section(name) {
  const head = `  // ================= ${name}`;
  const start = HTML.indexOf(head);
  assert.notEqual(start, -1, `找不到區段「${name}」`);
  const eol = HTML.indexOf('\n', start);
  const next = HTML.indexOf('  // ================= ', eol);
  return HTML.slice(eol, next);
}
const F = new Function(`
  ${section('富文字')}
  ${section('持久化（單一儲存層）')}
  ${section('三方合併')}
  return { normalizeItems, normalizeRecurrence, stableStringify };
`)();

// ------------------------------------------------------------ 共用


function proUser(env, id, email) {
  addUser(env, id, email);
  env.DB.prepare("UPDATE users SET plan_source = 'admin' WHERE id = ?").bind(id).run();
  return { id, email, role: 'user', status: 'approved', planSource: 'admin', planExpiresAt: null };
}
function baseState(over = {}) {
  return { version: 3, majorProjects: [{ id: 'mp_1', name: '標案' }], items: [], ganttProjects: [
    { id: 'gp_1', name: '新廠', notes: '', pet: null, tasks: [
      { id: 'task_1', name: '設計', start: '2026-01-01', end: '2026-01-31', progress: 10, done: false, todos: [] },
    ] },
  ], dailyLogs: {}, customHolidays: [], customWorkdays: [], absences: {}, ...over };
}
async function keyFor(env, user) {
  const { body } = await unwrap(await handleCreateKey(new Request('https://x.test/api/mcp/keys', {
    method: 'POST', body: JSON.stringify({ name: 'Claude Code' }),
  }), env, user));
  return body.token;
}
let rid = 0;
async function rpc(env, token, method, params) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await handleMcp(new Request('https://x.test/mcp', {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }),
  }), env);
  return { status: res.status, headers: res.headers, body: res.status === 202 ? null : await res.json() };
}
async function call(env, token, name, args = {}) {
  const r = await rpc(env, token, 'tools/call', { name, arguments: args });
  const result = r.body.result;
  return { isError: !!result?.isError, data: result?.structuredContent, raw: r.body };
}

// ------------------------------------------------------------ 1. 誰進得來

test('沒有憑證：401，而且 WWW-Authenticate 指向 OAuth 的說明文件', async () => {
  const env = makeEnv();
  const r = await rpc(env, null, 'tools/list');
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /resource_metadata="https:\/\/x\.test\/\.well-known\/oauth-protected-resource"/);
  const bad = await rpc(env, 'wsk_not-a-real-key', 'tools/list');
  assert.equal(bad.status, 401);
});

test('initialize 與 tools/list：協定版本照對方的、工具清單齊全', async () => {
  const env = makeEnv(); const u = proUser(env, 'u1', 'a@x.test');
  const t = await keyFor(env, u);
  const init = await rpc(env, t, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.body.result.protocolVersion, '2025-03-26');
  assert.ok(init.body.result.capabilities.tools);
  const list = await rpc(env, t, 'tools/list');
  const names = list.body.result.tools.map(x => x.name);
  for (const n of ['get_overview', 'get_schedule', 'create_item', 'set_done', 'delete_item', 'undo_change']) assert.ok(names.includes(n), n);
  // 通知沒有 id：收下就好，回 202、沒有內容
  const res = await handleMcp(new Request('https://x.test/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }), env);
  assert.equal(res.status, 202);
});

test('不是 Pro：工具回錯誤，而且一個欄位都不寫', async () => {
  const env = makeEnv(); const u = proUser(env, 'u1', 'a@x.test');
  seedState(env, 'u1', baseState(), 1000);
  const t = await keyFor(env, u);
  env.DB.prepare('UPDATE users SET plan_source = NULL WHERE id = ?').bind('u1').run();   // 訂閱到期
  const r = await call(env, t, 'create_item', { title: 'x', date: '2026-02-01' });
  assert.equal(r.isError, true);
  assert.match(r.data.error, /Pro/);
  assert.equal(readState(env, 'u1').state.items.length, 0);
});

test('金鑰撤銷之後立刻不能用；回應與列表都不含 token 原文，資料庫只存雜湊', async () => {
  const env = makeEnv(); const u = proUser(env, 'u1', 'a@x.test');
  const t = await keyFor(env, u);
  const row = env.DB.prepare('SELECT token_hash FROM mcp_tokens').first();
  assert.notEqual(row.token_hash, t);
  assert.equal(row.token_hash, await sha256(t));
  const list = (await unwrap(await handleListConnections(env, u))).body;
  assert.ok(!JSON.stringify(list).includes(t));
  assert.equal((await rpc(env, t, 'tools/list')).status, 200);
  await handleRevokeConnection(env, u, list.connections[0].id);
  assert.equal((await rpc(env, t, 'tools/list')).status, 401);
});

test('撤銷別人的金鑰：404，而且那把照樣能用', async () => {
  const env = makeEnv(); const a = proUser(env, 'u1', 'a@x.test'); const b = proUser(env, 'u2', 'b@x.test');
  const tb = await keyFor(env, b);
  const id = env.DB.prepare('SELECT id FROM mcp_tokens WHERE user_id = ?').bind('u2').first().id;
  assert.equal((await unwrap(await handleRevokeConnection(env, a, id))).status, 404);
  assert.equal((await rpc(env, tb, 'tools/list')).status, 200);
});

// ------------------------------------------------------------ 2. 形狀與前端一致

test('agent 建出來的項目丟進前端真正的 normalizeItems，前後逐字相同', () => {
  const cases = [
    { title: '月報', date: '2026-03-05', type: 'assignment', majorProjectId: 'mp_1', tags: ['b', 'a', 'a'],
      recurrence: { freq: 'monthly', day: 5, holidayRule: 'postpone' } },
    { title: '出差', date: '2026-03-10', endDate: '2026-03-12', type: 'meeting', meetingTime: '09:30', link: 'https://x.test' },
    { title: '週會', date: '2026-03-02', recurrence: { freq: 'weekly', weekdays: [3, 1, 1] }, noticeOnly: true },
  ];
  for (const f of cases) {
    const { state } = S.createItem(baseState(), f);
    const it = state.items[0];
    const again = F.normalizeItems([it])[0];
    assert.equal(F.stableStringify(again), F.stableStringify(it), f.title);
  }
});

test('normalizeRecurrence 的移植與前端逐字相同', () => {
  const inputs = [
    null, { freq: 'daily' }, { freq: 'monthly' }, { freq: 'monthly', mode: 'nthWeekday', nth: -1, weekday: 5 },
    { freq: 'weekly', weekdays: [6, 0, 0, 9] }, { freq: 'biweekly' }, { freq: 'yearly', count: '3', until: '2027-01-01' },
    { freq: 'quarterly', day: 99, holidayRule: 'advance', count: 9999 },
  ];
  for (const r of inputs) assert.deepEqual(S.normalizeRecurrence(r), F.normalizeRecurrence(r), JSON.stringify(r));
});

test('改循環頻率會清掉舊的完成紀錄（同前端：格式不同，留著會在改回來時復活）', () => {
  let { state } = S.createItem(baseState(), { title: '報表', date: '2026-01-05', recurrence: { freq: 'monthly', day: 5 } });
  const id = state.items[0].id;
  ({ state } = S.setDone(state, id, '2026-01', true));
  assert.equal(state.items[0].doneMap['2026-01'], true);
  ({ state } = S.updateItem(state, id, { recurrence: { freq: 'quarterly' } }));
  assert.deepEqual(state.items[0].doneMap, {});
  assert.deepEqual(state.items[0].doneAt, {});
});

test('循環項目勾完成一定要帶對格式的 occurrenceKey', () => {
  const { state } = S.createItem(baseState(), { title: '週報', date: '2026-01-05', recurrence: { freq: 'weekly', weekdays: [1] } });
  const id = state.items[0].id;
  assert.throws(() => S.setDone(state, id, undefined, true), /occurrenceKey/);
  assert.throws(() => S.setDone(state, id, '2026-01', true), /occurrenceKey/);
  const r = S.setDone(state, id, 'W2026-01-05', true, 123);
  assert.equal(r.state.items[0].doneMap['W2026-01-05'], true);
  assert.equal(r.state.items[0].doneAt['W2026-01-05'], 123);
});

// ------------------------------------------------------------ 3. 寫入、紀錄、復原

test('透過 MCP 新增：寫進雲端、版本號變了、留下一筆紀錄', async () => {
  const env = makeEnv(); const u = proUser(env, 'u1', 'a@x.test');
  seedState(env, 'u1', baseState(), 1000);
  const t = await keyFor(env, u);
  const r = await call(env, t, 'create_item', { title: '送件', date: '2026-02-01', type: 'assignment' });
  assert.equal(r.isError, false, JSON.stringify(r.raw));
  const after = readState(env, 'u1');
  assert.equal(after.state.items.length, 1);
  assert.notEqual(after.updatedAt, 1000);
  const log = env.DB.prepare('SELECT actor, tool, summary FROM mcp_activity').all().results;
  assert.deepEqual(log.map(x => [x.actor, x.tool]), [['Claude Code', 'create_item']]);
});

test('刪掉再從「我的帳號」復原：項目原樣回來', async () => {
  const env = makeEnv(); const u = proUser(env, 'u1', 'a@x.test');
  const { state } = S.createItem(baseState(), { title: '重要', date: '2026-02-01' });
  const original = state.items[0];
  seedState(env, 'u1', state, 1000);
  const t = await keyFor(env, u);
  const del = await call(env, t, 'delete_item', { itemId: original.id });
  assert.equal(readState(env, 'u1').state.items.length, 0);
  const res = await unwrap(await handleActivityUndo(env, u, del.data.changeId));
  assert.equal(res.status, 200);
  assert.deepEqual(readState(env, 'u1').state.items, [original]);
  // 同一筆不能復原兩次
  assert.equal((await unwrap(await handleActivityUndo(env, u, del.data.changeId))).status, 409);
});

test('使用者後來又改過的：復原不准蓋掉它', async () => {
  const env = makeEnv(); const u = proUser(env, 'u1', 'a@x.test');
  seedState(env, 'u1', baseState(), 1000);
  const t = await keyFor(env, u);
  const c = await call(env, t, 'create_item', { title: 'agent 寫的', date: '2026-02-01' });
  // 使用者在網頁上自己改了標題
  const cur = readState(env, 'u1');
  cur.state.items[0].title = '我改過了';
  env.DB.prepare('UPDATE user_state SET state = ? WHERE user_id = ?').bind(JSON.stringify(cur.state), 'u1').run();
  const r = await call(env, t, 'undo_change', { changeId: c.data.changeId });
  assert.equal(r.isError, true);
  assert.equal(readState(env, 'u1').state.items[0].title, '我改過了');
});

test('別人的資料一個位元組都不變；也讀不到別人的排程', async () => {
  const env = makeEnv(); const a = proUser(env, 'u1', 'a@x.test'); proUser(env, 'u2', 'b@x.test');
  seedState(env, 'u1', baseState(), 1000);
  seedState(env, 'u2', baseState({ items: [{ id: 'secret', title: 'B 的秘密', date: '2026-01-01' }] }), 2000);
  const before = JSON.stringify(readState(env, 'u2'));
  const t = await keyFor(env, a);
  await call(env, t, 'create_item', { title: 'A 的', date: '2026-02-01' });
  const list = await call(env, t, 'list_items', {});
  assert.ok(!JSON.stringify(list.data).includes('B 的秘密'));
  const del = await call(env, t, 'delete_item', { itemId: 'secret' });
  assert.equal(del.isError, true);
  assert.equal(JSON.stringify(readState(env, 'u2')), before);
});

test('寫入撞到別的裝置剛好寫進去：重讀重算，兩邊的修改都在', async () => {
  const env = makeEnv(); const u = proUser(env, 'u1', 'a@x.test');
  seedState(env, 'u1', baseState(), 1000);
  const t = await keyFor(env, u);
  // 在 MCP 的 UPDATE 之前插進一次別人的寫入（同 state.test 的 withRaceBeforeFirstUpdate）
  const realPrepare = env.DB.prepare.bind(env.DB);
  let raced = false;
  env.DB.prepare = (sql) => {
    if (!raced && sql.startsWith('UPDATE user_state SET state')) {
      raced = true;
      const cur = readState(env, 'u1');
      cur.state.majorProjects.push({ id: 'mp_web', name: '網頁上剛加的' });
      realPrepare('UPDATE user_state SET state = ?, updated_at = ? WHERE user_id = ?').bind(JSON.stringify(cur.state), 5000, 'u1').run();
    }
    return realPrepare(sql);
  };
  const r = await call(env, t, 'create_item', { title: 'agent', date: '2026-02-01' });
  assert.equal(r.isError, false);
  const s = readState(env, 'u1').state;
  assert.ok(s.majorProjects.some(m => m.id === 'mp_web'), '別人那一筆沒被蓋掉');
  assert.equal(s.items.length, 1);
});

test('get_schedule 讀的是前端推上來的 digest，逾期照日期判斷', async () => {
  const env = makeEnv(); const u = proUser(env, 'u1', 'a@x.test');
  seedState(env, 'u1', baseState({ items: [
    { id: 'item_a', title: '早就該交', type: 'assignment', date: '2020-01-01', recurrence: null, done: false, doneMap: {}, skipped: {} },
    { id: 'item_b', title: '做完了', type: 'work', date: '2020-01-02', recurrence: { freq: 'monthly', day: 2 }, done: false, doneMap: { '2020-01': true }, skipped: {} },
  ] }), 1000);
  env.DB.prepare('INSERT INTO reminder_feed (user_id, enabled, digest, updated_at) VALUES (?, 1, ?, 0)').bind('u1', JSON.stringify([
    { t: '早就該交', d: '2020-01-01', k: 'assignment', done: 0, ot: 0, i: 'item_a', o: 'single' },
    { t: '做完了', d: '2020-01-02', k: 'work', done: 1, ot: 1, i: 'item_b', o: '2020-01' },
  ])).run();
  const t = await keyFor(env, u);
  const r = await call(env, t, 'get_schedule', { from: '2020-01-01', to: '2020-01-31' });
  assert.deepEqual(r.data.occurrences.map(o => [o.title, o.overdue, o.itemId, o.occurrenceKey]), [['早就該交', true, 'item_a', 'single']]);
  const all = await call(env, t, 'get_schedule', { from: '2020-01-01', to: '2020-01-31', includeDone: true });
  assert.equal(all.data.occurrences.length, 2);
  assert.equal((await call(env, t, 'get_schedule', { from: '2020-01-01', to: '2021-01-01' })).isError, true, '超過 92 天要擋');
});

test('get_schedule 的完成狀態以當下的資料為準：agent 勾完再查要看得到', async () => {
  const env = makeEnv(); const u = proUser(env, 'u1', 'a@x.test');
  const st = baseState({ items: [
    { id: 'item_m', title: '月會', type: 'meeting', date: '2030-01-05', recurrence: { freq: 'monthly', day: 5 }, done: false, doneMap: {}, skipped: {} },
    { id: 'item_s', title: '單次', type: 'work', date: '2030-01-10', recurrence: null, done: false, doneMap: {}, skipped: {} },
    { id: 'item_k', title: '會被略過', type: 'work', date: '2030-01-03', recurrence: { freq: 'monthly', day: 3 }, done: false, doneMap: {}, skipped: {} },
  ] });
  seedState(env, 'u1', st, 1000);
  // digest 比 state 舊（updated_at 500 < 1000）：裡面還有一個已經被刪掉的項目
  env.DB.prepare('INSERT INTO reminder_feed (user_id, enabled, digest, updated_at) VALUES (?, 1, ?, 500)').bind('u1', JSON.stringify([
    { t: '月會', d: '2030-01-05', k: 'meeting', done: 0, i: 'item_m', o: '2030-01' },
    { t: '月會', d: '2030-02-05', k: 'meeting', done: 0, i: 'item_m', o: '2030-02' },
    { t: '單次', d: '2030-01-10', k: 'work', done: 0, i: 'item_s', o: 'single' },
    { t: '會被略過', d: '2030-01-03', k: 'work', done: 0, i: 'item_k', o: '2030-01' },
    { t: '已刪除', d: '2030-01-04', k: 'work', done: 0, i: 'item_gone', o: 'single' },
  ])).run();
  const t = await keyFor(env, u);
  const q = { from: '2030-01-01', to: '2030-02-28', includeDone: true };
  assert.equal((await call(env, t, 'set_done', { itemId: 'item_m', occurrenceKey: '2030-01', done: true })).isError, false);
  assert.equal((await call(env, t, 'set_done', { itemId: 'item_s', done: true })).isError, false);
  const s2 = readState(env, 'u1').state; s2.items.find(i => i.id === 'item_k').skipped = { '2030-01': true };
  env.DB.prepare('UPDATE user_state SET state = ? WHERE user_id = ?').bind(JSON.stringify(s2), 'u1').run();
  const r = await call(env, t, 'get_schedule', q);
  const by = Object.fromEntries(r.data.occurrences.map(o => [o.title + o.date, o.done]));
  assert.equal(by['月會2030-01-05'], true, '剛勾的那一次要是完成');
  assert.equal(by['月會2030-02-05'], false, '同一個項目的另一次不受影響');
  assert.equal(by['單次2030-01-10'], true);
  assert.ok(!('已刪除2030-01-04' in by), '被刪掉的項目不該再出現');
  assert.ok(!('會被略過2030-01-03' in by), '被略過的那一次不該再出現');
  assert.ok(r.data.note, 'digest 比資料舊時要說出來');
  const open = await call(env, t, 'get_schedule', { from: '2030-01-01', to: '2030-02-28' });
  assert.deepEqual(open.data.occurrences.map(o => o.date), ['2030-02-05'], '沒勾的只剩下一次月會');
});

test('甘特任務：有子項目的不准直接改進度', () => {
  const s = baseState();
  s.ganttProjects[0].tasks[0].todos = [{ id: 'td1', text: 'a', done: false }];
  assert.throws(() => S.updateGanttTask(s, 'gp_1', 'task_1', { progress: 50 }), /子項目/);
  const ok = S.updateGanttTask(baseState(), 'gp_1', 'task_1', { progress: 100 });
  assert.equal(ok.state.ganttProjects[0].tasks[0].done, true);
});

test('刪除帳號：金鑰、OAuth 授權碼與修改紀錄一起清掉', async () => {
  const env = makeEnv();
  env.DB.prepare('INSERT INTO users (id, email, password_hash, role, status, created_at, plan_source) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('u1', 'a@x.test', await hashPassword('pw-123456'), 'user', 'approved', 0, 'admin').run();
  const u = { id: 'u1', email: 'a@x.test', role: 'user', status: 'approved', planSource: 'admin' };
  seedState(env, 'u1', baseState(), 1000);
  const t = await keyFor(env, u);
  await call(env, t, 'create_item', { title: 'x', date: '2026-02-01' });
  const res = await handleDeleteAccount(new Request('https://x.test/api/auth/account', {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw-123456' }),
  }), env, u);
  assert.equal(res.status, 200);
  for (const tbl of ['mcp_tokens', 'mcp_activity', 'oauth_codes']) {
    assert.equal(env.DB.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).first().n, 0, tbl);
  }
});

// ------------------------------------------------------------ 5. OAuth

async function pkce() {
  const verifier = 'v'.repeat(20) + crypto.randomUUID().replace(/-/g, '');
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...d)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}
async function register(env, uris = ['https://claude.ai/api/mcp/auth_callback']) {
  return (await unwrap(await handleRegister(new Request('https://x.test/oauth/register', {
    method: 'POST', body: JSON.stringify({ client_name: 'Claude', redirect_uris: uris }),
  }), env))).body;
}
async function approve(env, user, client, challenge, redirect = client.redirect_uris[0]) {
  const { body } = await unwrap(await handleAuthorizeDecision(new Request('https://x.test/api/oauth/decision', {
    method: 'POST', body: JSON.stringify({ approve: true, client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, state: 'st' }),
  }), env, user));
  return body;
}
async function token(env, params) {
  const res = await handleToken(new Request('https://x.test/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(),
  }), env);
  return { status: res.status, body: await res.json() };
}

test('OAuth 全程：註冊 → 允許 → 換 token → 呼叫工具；授權碼只能用一次', async () => {
  const env = makeEnv(); const u = proUser(env, 'u1', 'a@x.test');
  seedState(env, 'u1', baseState(), 1000);
  const client = await register(env);
  const { verifier, challenge } = await pkce();
  const ok = await approve(env, u, client, challenge);
  const back = new URL(ok.redirect);
  assert.equal(back.origin + back.pathname, client.redirect_uris[0]);
  assert.equal(back.searchParams.get('state'), 'st');
  const code = back.searchParams.get('code');
  const params = { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: client.redirect_uris[0] };
  const t1 = await token(env, params);
  assert.equal(t1.status, 200, JSON.stringify(t1.body));
  const r = await call(env, t1.body.access_token, 'get_overview');
  assert.equal(r.isError, false);
  assert.equal((await token(env, params)).body.error, 'invalid_grant', '同一個授權碼第二次要失敗');
});

test('OAuth：PKCE 不對、redirect_uri 不對都換不到 token', async () => {
  const env = makeEnv(); const u = proUser(env, 'u1', 'a@x.test');
  const client = await register(env);
  const { challenge } = await pkce();
  const code1 = new URL((await approve(env, u, client, challenge)).redirect).searchParams.get('code');
  const bad = await token(env, { grant_type: 'authorization_code', code: code1, code_verifier: 'x'.repeat(50), client_id: client.client_id, redirect_uri: client.redirect_uris[0] });
  assert.equal(bad.body.error, 'invalid_grant');
  const { verifier, challenge: c2 } = await pkce();
  const code2 = new URL((await approve(env, u, client, c2)).redirect).searchParams.get('code');
  const bad2 = await token(env, { grant_type: 'authorization_code', code: code2, code_verifier: verifier, client_id: client.client_id, redirect_uri: 'https://evil.test/cb' });
  assert.equal(bad2.body.error, 'invalid_grant');
});

test('OAuth：沒登記過的 redirect_uri 絕不轉址（open redirect）；允許時也一樣擋', async () => {
  const env = makeEnv(); const u = proUser(env, 'u1', 'a@x.test');
  const client = await register(env);
  const res = await handleAuthorizeRedirect(new Request(
    `https://x.test/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('https://evil.test/cb')}&code_challenge=abc&code_challenge_method=S256`), env);
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('location'), null);
  const { challenge } = await pkce();
  const r = await unwrap(await handleAuthorizeDecision(new Request('https://x.test/api/oauth/decision', {
    method: 'POST', body: JSON.stringify({ approve: true, client_id: client.client_id, redirect_uri: 'https://evil.test/cb', code_challenge: challenge }),
  }), env, u));
  assert.equal(r.status, 400);
  // 註冊時就只收 https（或 localhost）
  const reg = await unwrap(await handleRegister(new Request('https://x.test/oauth/register', {
    method: 'POST', body: JSON.stringify({ redirect_uris: ['http://evil.test/cb'] }),
  }), env));
  assert.equal(reg.status, 400);
});

test('OAuth：免費帳號按允許也拿不到授權碼', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.test');
  const u = { id: 'u1', email: 'a@x.test', role: 'user', status: 'approved' };
  const client = await register(env);
  const { challenge } = await pkce();
  const r = await unwrap(await handleAuthorizeDecision(new Request('https://x.test/api/oauth/decision', {
    method: 'POST', body: JSON.stringify({ approve: true, client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_challenge: challenge }),
  }), env, u));
  assert.equal(r.status, 402);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_codes').first().n, 0);
});

test('OAuth：refresh 輪替後舊的作廢；撤銷連線後 access token 立刻失效', async () => {
  const env = makeEnv(); const u = proUser(env, 'u1', 'a@x.test');
  const client = await register(env);
  const { verifier, challenge } = await pkce();
  const code = new URL((await approve(env, u, client, challenge)).redirect).searchParams.get('code');
  const t1 = (await token(env, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: client.redirect_uris[0] })).body;
  const t2 = await token(env, { grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: client.client_id });
  assert.equal(t2.status, 200);
  assert.equal((await token(env, { grant_type: 'refresh_token', refresh_token: t1.refresh_token })).body.error, 'invalid_grant');
  assert.equal((await rpc(env, t1.access_token, 'tools/list')).status, 401, '舊的 access token 跟著作廢');
  assert.equal((await rpc(env, t2.body.access_token, 'tools/list')).status, 200);
  // 撤銷：列表裡那一列是 refresh，撤銷要連同 access 一起
  const conn = (await unwrap(await handleListConnections(env, u))).body.connections;
  assert.equal(conn.length, 1);
  assert.equal(conn[0].kind, 'oauth');
  await handleRevokeConnection(env, u, conn[0].id);
  assert.equal((await rpc(env, t2.body.access_token, 'tools/list')).status, 401);
});
