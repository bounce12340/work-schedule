/**
 * agent 工作區（第一批）：進展日誌／提問、連線設定、提案（先審核）、待驗收、暫停。
 * 設計文件：docs/superpowers/specs/2026-11-21-agent-workspace.md
 *
 * 守的東西，壞掉時大多**畫面看起來正常、只是資料或權限靜靜地不對**：
 *   1. 形狀：伺服器建的甘特專案／任務／子待辦與前端 normalizeGanttProjects 逐欄相同（三方合併靠它），
 *      agent 寫的狀態走一次真的 applySnapshot → snapshot 還活著
 *   2. 連線設定放在「連線」上：OAuth 換 token 之後設定仍在；查不到設定＝暫停；既有連線由 migration 回填
 *   3. 暫停：所有寫入類（含日誌、提問、提案）擋、讀照常；同一條連線一小時內被復原 5 次自動暫停
 *   4. review 模式：寫入工具不寫入（資料一個位元都沒變）、長出提案；日誌與提問不受審核擋；
 *      同意時在**當下的資料**上套、一項套不上去整份不套（stale）、同意也進修改紀錄且可復原
 *   5. 待驗收：擋在「done 會不會變成真」（共用寫入路徑），不是某幾個工具——一個一個勾子待辦也繞不過去
 *   6. 日誌：只能加；署名由伺服器填；跨帳號一筆都讀不到；遮蔽只有擁有者；Pro 到期之後擁有者照樣讀與回答
 *   7. 專案消失 30 天才清日誌；讀不到 state 不能當成「專案不見了」
 *   8. 備份帶日誌與還開著的提案；刪帳號清乾淨而且不碰別人
 *
 * 前端的原始碼從 public/index.html 抽出來求值（同 mcp.test.mjs），不複製一份。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeEnv, addUser, seedState, readState, unwrap } from './d1.mjs';
import { handleMcp, handleActivityUndo, TOOLS, WRITE_TOOLS } from '../src/mcp/server.js';
import * as S from '../src/mcp/schedule.js';
import { STATE_OPS } from '../src/mcp/ops.js';
import {
  handleCreateKey, handleRevokeConnection, handleListConnections, handleRegister, handleAuthorizeDecision, handleToken,
} from '../src/mcp/auth.js';
import {
  handleConnectionSettings, handlePauseAll, handleListProposals, handleApproveProposal, handleRejectProposal,
  handleProjectEvents, handleAgentInbox, handleAnswerEvent, handleRedactEvent, handleAcceptTask, handleRejectTask,
  purgeAgentData,
} from '../src/handlers/agent.js';
import { runBackup } from '../src/handlers/backup.js';
import { step } from '../src/index.js';

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
// todoProgress 在〈專案 / 甘特圖〉區段（那一段整個是 DOM，不能整段抽）——只取這一個純函式
const TODO_PROGRESS = HTML.slice(HTML.indexOf('  function todoProgress(todos){'), HTML.indexOf('  function syncTaskFromTodos(t){'));
assert.ok(TODO_PROGRESS.includes('Math.round'), '抽不到 todoProgress');
const F = new Function(`
  let availableYears = [];   // 〈state〉區段的變數；applySnapshot 會寫它，那個區段整段是 DOM 不能抽
  ${section('富文字')}
  ${section('持久化（單一儲存層）')}
  ${section('專案的夥伴')}
  ${section('三方合併')}
  ${TODO_PROGRESS}
  return { normalizeGanttProjects, applySnapshot, snapshot, stableStringify, TASK_STATUSES,
           getGantt: () => ganttProjects };
`)();

// ------------------------------------------------------------ 共用

function proUser(env, id, email) {
  addUser(env, id, email);
  env.DB.prepare("UPDATE users SET plan_source = 'admin' WHERE id = ?").bind(id).run();
  return { id, email, role: 'user', status: 'approved', planSource: 'admin', planExpiresAt: null };
}
function baseState(over = {}) {
  return { version: 3, majorProjects: [{ id: 'mp_1', name: '標案' }], items: [], ganttProjects: [
    { id: 'gp_1', name: '新廠', notes: '', pet: null, brief: '不要動預算', tasks: [
      { id: 'task_1', name: '設計', start: '2026-01-01', end: '2026-01-31', progress: 10, done: false, todos: [], status: 'todo', blockedNote: '' },
      { id: 'task_2', name: '施工', start: '2026-02-01', end: '2026-02-28', progress: 0, done: false, todos: [
        { id: 'td_a', text: '備料', done: false, review: false }, { id: 'td_b', text: '開工', done: false, review: false },
      ], status: 'todo', blockedNote: '' },
    ] },
  ], dailyLogs: {}, customHolidays: [], customWorkdays: [], absences: {}, ...over };
}
async function keyFor(env, user, name = 'Claude Code') {
  const { body } = await unwrap(await handleCreateKey(new Request('https://x.test/api/mcp/keys', {
    method: 'POST', body: JSON.stringify({ name }),
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
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
}
async function call(env, token, name, args = {}) {
  const r = await rpc(env, token, 'tools/call', { name, arguments: args });
  return { isError: !!r.body.result?.isError, data: r.body.result?.structuredContent, raw: r.body };
}
const post = (body) => new Request('https://x.test/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const connIdOf = (env, userId) => env.DB.prepare('SELECT id FROM mcp_connections WHERE user_id = ? ORDER BY created_at LIMIT 1').bind(userId).first().id;
async function setSettings(env, user, connId, body) {
  return unwrap(await handleConnectionSettings(post(body), env, user, connId));
}
/** 一個 Pro 使用者、一份 state、一把金鑰 */
async function setup(over = {}) {
  const env = makeEnv(); const u = proUser(env, 'u1', 'a@x.test');
  seedState(env, 'u1', baseState(over), 1000);
  const t = await keyFor(env, u);
  return { env, u, t, conn: connIdOf(env, 'u1') };
}
const stateOf = env => readState(env, 'u1').state;
const taskOf = (env, id = 'task_1') => stateOf(env).ganttProjects[0].tasks.find(t => t.id === id);
const events = (env, uid = 'u1') => env.DB.prepare('SELECT * FROM project_events WHERE user_id = ? ORDER BY created_at, rowid').bind(uid).all().results;
function userEdit(env, fn) {
  const cur = readState(env, 'u1');
  fn(cur.state);
  env.DB.prepare('UPDATE user_state SET state = ? WHERE user_id = ?').bind(JSON.stringify(cur.state), 'u1').run();
}

// ------------------------------------------------------------ 1. 形狀

test('伺服器建的專案／任務／子待辦丟進前端真正的 normalizeGanttProjects，前後逐字相同', () => {
  let { state } = S.createGanttProject({ ...baseState(), ganttProjects: [] }, '新專案');
  const gpId = state.ganttProjects[0].id;
  ({ state } = S.addGanttTask(state, gpId, { name: '任務一', start: '2026-03-01', end: '2026-03-09' }));
  const tId = state.ganttProjects[0].tasks[0].id;
  ({ state } = S.upsertTaskTodo(state, gpId, tId, { text: '子待辦一' }));
  ({ state } = S.upsertTaskTodo(state, gpId, tId, { text: '子待辦二', done: true }));
  ({ state } = S.updateGanttTask(state, gpId, tId, { status: 'blocked', blockedNote: '等廠商報價' }));
  const gp = state.ganttProjects[0];
  const again = F.normalizeGanttProjects([gp])[0];
  assert.equal(F.stableStringify(again), F.stableStringify(gp));
  // 沒有子待辦的任務、各種狀態也要一樣
  for (const status of ['todo', 'doing', 'waiting', 'review']) {
    let s2 = S.createGanttProject({ ...baseState(), ganttProjects: [] }, 'p').state;
    const p = s2.ganttProjects[0].id;
    s2 = S.addGanttTask(s2, p, { name: 't', start: '2026-03-01', end: '2026-03-02' }).state;
    s2 = S.updateGanttTask(s2, p, s2.ganttProjects[0].tasks[0].id, { status, blockedNote: status === 'waiting' ? '等你' : undefined }).state;
    assert.equal(F.stableStringify(F.normalizeGanttProjects(s2.ganttProjects)[0]), F.stableStringify(s2.ganttProjects[0]), status);
  }
});

test('伺服器改過舊形狀（沒有新欄位）的任務之後，形狀與前端一致', () => {
  const legacy = baseState();
  delete legacy.ganttProjects[0].brief;
  for (const t of legacy.ganttProjects[0].tasks) { delete t.status; delete t.blockedNote; for (const td of t.todos) delete td.review; }
  const r = S.updateGanttTask(legacy, 'gp_1', 'task_2', { name: '施工（改）' });
  const t = r.state.ganttProjects[0].tasks[1];
  assert.equal(t.status, 'todo'); assert.equal(t.blockedNote, ''); assert.equal(t.todos[0].review, false);
  assert.equal(F.stableStringify(F.normalizeGanttProjects(r.state.ganttProjects)[0].tasks[1]), F.stableStringify(t));
});

test('TASK_STATUSES 前後端同一份；項目欄位白名單與工具的 inputSchema 同一份', () => {
  assert.deepEqual(F.TASK_STATUSES, S.TASK_STATUSES);
  const schema = TOOLS.find(t => t.name === 'create_item').inputSchema.properties;
  assert.deepEqual(Object.keys(schema).filter(k => k !== 'requestId').sort(), [...S.ITEM_KEYS].sort());
});

test('前端的正規化：status 不認得 → todo、blockedNote 截 200、brief 截 4000、review 只在沒完成時才算', () => {
  const [gp] = F.normalizeGanttProjects([{ id: 'g', name: 'x', brief: 'b'.repeat(5000), tasks: [
    { id: 't', name: 'n', start: '2026-01-01', end: '2026-01-02', status: 'hacked', blockedNote: 'n'.repeat(300),
      todos: [{ id: 'a', text: 'x', done: true, review: true }, { id: 'b', text: 'y', done: false, review: true }] },
  ] }]);
  assert.equal(gp.brief.length, 4000);
  assert.equal(gp.tasks[0].status, 'todo');
  assert.equal(gp.tasks[0].blockedNote.length, 200);
  assert.deepEqual(gp.tasks[0].todos.map(t => t.review), [false, true]);
  const old = F.normalizeGanttProjects([{ id: 'g', name: 'x', tasks: [{ id: 't', name: 'n', start: '2026-01-01', end: '2026-01-02' }] }])[0];
  assert.equal(old.brief, ''); assert.equal(old.tasks[0].status, 'todo'); assert.equal(old.tasks[0].blockedNote, '');
});

test('agent 寫的狀態、說明書、待驗收旗標走一次真的 applySnapshot → snapshot 還活著', () => {
  let { state } = S.updateGanttTask(baseState(), 'gp_1', 'task_1', { status: 'blocked', blockedNote: '等廠商' });
  ({ state } = S.updateGanttTask(state, 'gp_1', 'task_1', { status: 'review' }));
  state.ganttProjects[0].tasks[1].todos[1].review = true;
  state.ganttProjects[0].tasks[1].status = 'waiting';
  state.ganttProjects[0].tasks[1].blockedNote = '等你決定';
  assert.equal(F.applySnapshot(JSON.parse(JSON.stringify(state))), true);
  const back = F.snapshot().ganttProjects[0];
  assert.equal(back.brief, '不要動預算');
  assert.equal(back.tasks[0].status, 'review');
  assert.equal(back.tasks[1].status, 'waiting');
  assert.equal(back.tasks[1].blockedNote, '等你決定');
  assert.equal(back.tasks[1].todos[1].review, true);
  assert.equal(back.tasks[1].todos[0].review, false);
});

test('blocked 一定要帶原因；換成別的狀態時舊的原因被清掉；狀態不豁免逾期', async () => {
  assert.throws(() => S.updateGanttTask(baseState(), 'gp_1', 'task_1', { status: 'blocked' }), /原因/);
  assert.throws(() => S.updateGanttTask(baseState(), 'gp_1', 'task_1', { status: 'nope' }), /status/);
  let { state } = S.updateGanttTask(baseState(), 'gp_1', 'task_1', { status: 'blocked', blockedNote: '等廠商' });
  ({ state } = S.updateGanttTask(state, 'gp_1', 'task_1', { status: 'doing' }));
  assert.equal(state.ganttProjects[0].tasks[0].blockedNote, '');
  // 逾期：任務 end 已過、狀態 blocked，get_project_brief 仍標 overdue
  const { env, t } = await setup();
  await call(env, t, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_1', status: 'blocked', blockedNote: '等廠商' });
  const b = await call(env, t, 'get_project_brief', { projectId: 'gp_1' });
  const task = b.data.tasks.find(x => x.id === 'task_1');
  assert.equal(task.status, 'blocked');
  assert.equal(task.overdue, true, 'blocked 不豁免逾期');
});

// ------------------------------------------------------------ 2. 連線設定

test('建金鑰時連線的設定列一起建好（direct、沒暫停）；撤銷時一起刪', async () => {
  const { env, u } = await setup();
  const row = env.DB.prepare('SELECT * FROM mcp_connections').first();
  assert.deepEqual([row.mode, row.paused, row.needs_acceptance], ['direct', 0, 0]);
  const list = (await unwrap(await handleListConnections(env, u))).body.connections;
  assert.deepEqual([list[0].mode, list[0].paused, list[0].needsAcceptance], ['direct', false, false]);
  await handleRevokeConnection(env, u, list[0].id);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM mcp_connections').first().n, 0);
});

test('查不到設定列：當成暫停（最嚴格），寫都擋、讀照常', async () => {
  const { env, t } = await setup();
  env.DB.prepare('DELETE FROM mcp_connections').run();
  const w = await call(env, t, 'create_item', { title: 'x', date: '2026-02-01' });
  assert.equal(w.isError, true);
  assert.match(w.data.error, /暫停/);
  assert.equal((await call(env, t, 'get_overview')).isError, false);
  assert.equal(stateOf(env).items.length, 0);
});

test('既有的連線：migration 的回填把每一條補成 direct，上線那一刻不會全被暫停', async () => {
  const { env, u } = await setup();
  // 模擬「上線前就存在」的連線：一把金鑰、一組 OAuth（access + refresh 共用 grant）
  env.DB.prepare('DELETE FROM mcp_connections').run();
  env.DB.prepare('DELETE FROM mcp_tokens').run();
  const oldKey = 'wsk_legacy-key';
  const { sha256 } = await import('../src/crypto.js');
  const ins = (id, kind, hash, grant) => env.DB.prepare(
    'INSERT INTO mcp_tokens (id, user_id, kind, token_hash, name, grant_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 5, NULL)')
    .bind(id, 'u1', kind, hash, 'legacy', grant).run();
  ins('k1', 'key', await sha256(oldKey), null);
  ins('a1', 'oauth_access', await sha256('wsa_x'), 'grant-1');
  ins('r1', 'oauth_refresh', await sha256('wsr_x'), 'grant-1');
  assert.equal((await call(env, oldKey, 'create_item', { title: 'x', date: '2026-02-01' })).isError, true, '回填之前：被當成暫停');
  const sql = readFileSync(new URL('../migrations/017-agent-workspace.sql', import.meta.url), 'utf8')
    .match(/INSERT OR IGNORE INTO mcp_connections[\s\S]*?;/)[0];
  env.DB.prepare(sql).run();
  assert.deepEqual(env.DB.prepare('SELECT id, mode, paused FROM mcp_connections ORDER BY id').all().results.map(r => [r.id, r.mode, r.paused]),
    [['grant-1', 'direct', 0], ['k1', 'direct', 0]]);
  assert.equal((await call(env, oldKey, 'create_item', { title: 'x', date: '2026-02-01' })).isError, false, '回填之後：照常');
  env.DB.prepare(sql).run();   // 重跑安全
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM mcp_connections').first().n, 2);
});

test('暫停：所有寫入類（含日誌、提問、提案、復原）都擋，讀照常；恢復之後不用重新授權', async () => {
  const { env, u, t, conn } = await setup();
  const c = await call(env, t, 'create_item', { title: '先寫一筆', date: '2026-02-01' });
  assert.equal((await setSettings(env, u, conn, { paused: true })).status, 200);
  const writes = [
    ['create_item', { title: 'x', date: '2026-02-01' }], ['update_item', { itemId: 'x', title: 'y' }], ['set_done', { itemId: 'x', done: true }],
    ['delete_item', { itemId: 'x' }], ['create_major_project', { name: 'x' }], ['create_gantt_project', { name: 'x' }],
    ['add_gantt_task', { projectId: 'gp_1', name: 'x', start: '2026-01-01', end: '2026-01-02' }], ['update_gantt_task', { projectId: 'gp_1', taskId: 'task_1', name: 'x' }],
    ['upsert_task_todo', { projectId: 'gp_1', taskId: 'task_1', text: 'x' }], ['write_daily_log', { text: 'x' }],
    ['add_project_event', { projectId: 'gp_1', kind: 'progress', body: 'x' }], ['propose_changes', { title: 'x', ops: [{ tool: 'create_item', args: { title: 'x', date: '2026-02-01' } }] }],
    ['withdraw_proposal', { proposalId: 'x' }], ['undo_change', { changeId: c.data.changeId }],
  ];
  assert.deepEqual(writes.map(w => w[0]).sort(), [...WRITE_TOOLS].sort(), '暫停清單涵蓋每一個寫入工具');
  for (const [name, args] of writes) {
    const r = await call(env, t, name, args);
    assert.equal(r.isError, true, name);
    assert.match(r.data.error, /暫停/, name);
  }
  assert.equal(stateOf(env).items.length, 1, '暫停期間一個位元都沒動');
  assert.equal(events(env).length, 0);
  for (const name of ['get_overview', 'list_items', 'list_gantt_projects', 'list_recent_changes']) assert.equal((await call(env, t, name, {})).isError, false, name);
  assert.equal((await call(env, t, 'get_project_brief', { projectId: 'gp_1' })).isError, false);
  assert.equal((await setSettings(env, u, conn, { paused: false })).status, 200);
  assert.equal((await call(env, t, 'create_item', { title: '恢復了', date: '2026-02-01' })).isError, false);
});

test('暫停全部：每一條連線都暫停、只動自己的；設定端點驗參數、別人的連線 404', async () => {
  const { env, u, t } = await setup();
  const b = proUser(env, 'u2', 'b@x.test'); seedState(env, 'u2', baseState(), 1000);
  const tb = await keyFor(env, b);
  const t2 = await keyFor(env, u, '第二把');
  const r = await unwrap(await handlePauseAll(post({ paused: true }), env, u));
  assert.equal(r.body.connections, 2);
  assert.equal((await call(env, t, 'create_item', { title: 'x', date: '2026-02-01' })).isError, true);
  assert.equal((await call(env, t2, 'create_item', { title: 'x', date: '2026-02-01' })).isError, true);
  assert.equal((await call(env, tb, 'create_item', { title: 'x', date: '2026-02-01' })).isError, false, '別人的連線不受影響');
  assert.equal(env.DB.prepare("SELECT paused_reason FROM mcp_connections WHERE user_id = 'u1'").first().paused_reason, 'owner');
  assert.equal((await unwrap(await handlePauseAll(post({ paused: 'yes' }), env, u))).status, 400);
  const connB = connIdOf(env, 'u2');
  assert.equal((await setSettings(env, u, connB, { mode: 'review' })).status, 404, '別人的連線');
  assert.equal(env.DB.prepare("SELECT mode FROM mcp_connections WHERE id = ?").bind(connB).first().mode, 'direct');
  assert.equal((await setSettings(env, u, connIdOf(env, 'u1'), { mode: 'nope' })).status, 400);
  assert.equal((await setSettings(env, u, connIdOf(env, 'u1'), { needsAcceptance: 'x' })).status, 400);
});

test('設定可以用列表上看到的 token 列 id 設，也會替沒有設定列的舊連線補一列', async () => {
  const { env, u } = await setup();
  const list = (await unwrap(await handleListConnections(env, u))).body.connections;
  assert.equal((await setSettings(env, u, list[0].id, { mode: 'review' })).body.connection.mode, 'review');
  env.DB.prepare('DELETE FROM mcp_connections').run();
  const r = await setSettings(env, u, list[0].id, { needsAcceptance: true });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.connection.mode, r.body.connection.paused, r.body.connection.needsAcceptance], ['direct', false, true]);
});

async function pkce() {
  const verifier = 'v'.repeat(20) + crypto.randomUUID().replace(/-/g, '');
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...d)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}
async function oauthToken(env, params) {
  const res = await handleToken(new Request('https://x.test/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(),
  }), env);
  return { status: res.status, body: await res.json() };
}

test('設成 review → 走真的 /oauth/token 換一次 refresh → 仍然是 review（設定不放在會被輪替掉的 token 上）', async () => {
  const env = makeEnv(); const u = proUser(env, 'u1', 'a@x.test');
  seedState(env, 'u1', baseState(), 1000);
  const client = (await unwrap(await handleRegister(new Request('https://x.test/oauth/register', {
    method: 'POST', body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] }),
  }), env))).body;
  const { verifier, challenge } = await pkce();
  const dec = (await unwrap(await handleAuthorizeDecision(new Request('https://x.test/api/oauth/decision', {
    method: 'POST', body: JSON.stringify({ approve: true, client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_challenge: challenge }),
  }), env, u))).body;
  const code = new URL(dec.redirect).searchParams.get('code');
  const t1 = (await oauthToken(env, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: client.redirect_uris[0] })).body;
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM mcp_connections').first().n, 1, '授權時建了設定列');
  const listed = (await unwrap(await handleListConnections(env, u))).body.connections;
  await setSettings(env, u, listed[0].id, { mode: 'review', needsAcceptance: true });
  const t2 = (await oauthToken(env, { grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: client.client_id })).body;
  assert.ok(t2.access_token && t2.access_token !== t1.access_token);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM mcp_connections').first().n, 1, '輪替沒有多出或弄丟設定列');
  const r = await call(env, t2.access_token, 'create_item', { title: '換 token 之後', date: '2026-02-01' });
  assert.equal(r.data.proposed, true, '仍是 review');
  assert.equal(stateOf(env).items.length, 0);
  // 再輪替一次、撤銷：設定列跟著 grant 一起刪
  const t3 = (await oauthToken(env, { grant_type: 'refresh_token', refresh_token: t2.refresh_token })).body;
  assert.equal((await call(env, t3.access_token, 'create_item', { title: 'x', date: '2026-02-01' })).data.proposed, true);
  const cur = (await unwrap(await handleListConnections(env, u))).body.connections;
  await handleRevokeConnection(env, u, cur[0].id);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM mcp_connections').first().n, 0);
});

test('自動暫停：同一條連線一小時內被復原 5 次 → 暫停（4 次不會）；別條連線不受影響', async () => {
  const { env, u, t } = await setup();
  const t2 = await keyFor(env, u, '另一條');
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await call(env, t, 'create_item', { title: 'n' + i, date: '2026-02-01' })).data.changeId);
  for (let i = 0; i < 4; i++) assert.equal((await unwrap(await handleActivityUndo(env, u, ids[i]))).body.autoPaused, false);
  assert.equal(env.DB.prepare("SELECT paused FROM mcp_connections WHERE id = ?").bind(connIdOf(env, 'u1')).first().paused, 0);
  const fifth = await unwrap(await handleActivityUndo(env, u, ids[4]));
  assert.equal(fifth.body.autoPaused, true);
  const row = env.DB.prepare("SELECT paused, paused_reason FROM mcp_connections WHERE id = (SELECT conn_id FROM mcp_activity WHERE id = ?)").bind(ids[0]).first();
  assert.deepEqual([row.paused, row.paused_reason], [1, 'auto']);
  assert.equal((await call(env, t, 'create_item', { title: 'x', date: '2026-02-01' })).isError, true);
  assert.equal((await call(env, t2, 'create_item', { title: 'x', date: '2026-02-01' })).isError, false);
});

test('復原時間窗：超過一小時的復原不算進自動暫停', async () => {
  const { env, u, t } = await setup();
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await call(env, t, 'create_item', { title: 'n' + i, date: '2026-02-01' })).data.changeId);
  for (let i = 0; i < 4; i++) await handleActivityUndo(env, u, ids[i]);
  env.DB.prepare('UPDATE mcp_activity SET undone_at = ? WHERE undone_at IS NOT NULL').bind(Date.now() - 2 * 3600 * 1000).run();
  assert.equal((await unwrap(await handleActivityUndo(env, u, ids[4]))).body.autoPaused, false);
});

// ------------------------------------------------------------ 3. 新工具

test('create_gantt_project：建空專案、可復原；免費帳號的上限照擋', async () => {
  const { env, u, t } = await setup();
  const r = await call(env, t, 'create_gantt_project', { name: '新專案' });
  assert.equal(r.isError, false, JSON.stringify(r.raw));
  assert.equal(stateOf(env).ganttProjects.length, 2);
  assert.deepEqual(F.normalizeGanttProjects(stateOf(env).ganttProjects.slice(1)), stateOf(env).ganttProjects.slice(1));
  assert.equal((await call(env, t, 'undo_change', { changeId: r.data.changeId })).isError, false);
  assert.equal(stateOf(env).ganttProjects.length, 1);
  // 上限：state 已經有 3 個專案、帳號降成免費 → 第 4 個被擋
  userEdit(env, st => { for (const n of ['b', 'c']) st.ganttProjects.push({ id: 'gp_' + n, name: n, notes: '', pet: null, brief: '', tasks: [] }); });
  env.DB.prepare("UPDATE users SET plan_source = 'admin' WHERE id = 'u1'").run();
  const free = { ...u, planSource: null };
  const { casWrite } = await import('../src/mcp/store.js');
  await assert.rejects(casWrite(env, free, st => S.createGanttProject(st, 'd')), /方案的上限/);
});

test('upsert_task_todo：新增、修改、勾選；進度由子待辦算；找不到的 id 擋下', async () => {
  const { env, t } = await setup();
  const a = await call(env, t, 'upsert_task_todo', { projectId: 'gp_1', taskId: 'task_1', text: '第一步' });
  assert.equal(a.isError, false, JSON.stringify(a.raw));
  assert.equal(a.data.task.todos.length, 1);
  const tid = a.data.task.todos[0].id;
  const b = await call(env, t, 'upsert_task_todo', { projectId: 'gp_1', taskId: 'task_1', todoId: tid, done: true });
  assert.equal(b.data.task.progress, 100); assert.equal(b.data.task.done, true);
  assert.equal((await call(env, t, 'upsert_task_todo', { projectId: 'gp_1', taskId: 'task_1', todoId: 'nope', done: true })).isError, true);
  assert.equal((await call(env, t, 'upsert_task_todo', { projectId: 'gp_1', taskId: 'task_1' })).isError, true, '新增要帶 text');
  assert.equal((await call(env, t, 'upsert_task_todo', { projectId: 'gp_1', taskId: 'nope', text: 'x' })).isError, true);
  // 復原最後一筆：回到未完成
  assert.equal((await call(env, t, 'undo_change', { changeId: b.data.changeId })).isError, false);
  assert.equal(taskOf(env).done, false);
});

test('write_daily_log：附加在今天既有內容後面、跳脫 HTML、不碰別天、可復原', async () => {
  const { env, t } = await setup();
  const today = S.isYmd(new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)) && new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  userEdit(env, st => { st.dailyLogs = { [today]: '<p>我自己寫的</p>', '2020-01-01': '<p>舊的</p>' }; });
  const r = await call(env, t, 'write_daily_log', { text: '第一行 <script>alert(1)</script>\n第二行 & "引號"' });
  assert.equal(r.isError, false, JSON.stringify(r.raw));
  const logs = stateOf(env).dailyLogs;
  assert.ok(logs[today].startsWith('<p>我自己寫的</p>'), '沒有蓋掉使用者寫的');
  assert.ok(logs[today].includes('<p>第一行 &lt;script&gt;alert(1)&lt;/script&gt;</p><p>第二行 &amp; &quot;引號&quot;</p>'));
  assert.ok(!logs[today].includes('<script>'));
  assert.equal(logs['2020-01-01'], '<p>舊的</p>');
  assert.equal((await call(env, t, 'undo_change', { changeId: r.data.changeId })).isError, false);
  assert.equal(stateOf(env).dailyLogs[today], '<p>我自己寫的</p>');
  // 沒有既有內容：復原後那一天的鍵消失
  userEdit(env, st => { delete st.dailyLogs[today]; });
  const r2 = await call(env, t, 'write_daily_log', { text: 'hi' });
  await call(env, t, 'undo_change', { changeId: r2.data.changeId });
  assert.ok(!(today in stateOf(env).dailyLogs));
  assert.equal((await call(env, t, 'write_daily_log', { text: '  \n ' })).isError, true);
});

test('工具清單：每個工具都有 annotations；讀取的標 readOnly、刪除標 destructive；既有 13 個工具名與必填不變', async () => {
  const { env, t } = await setup();
  const list = (await rpc(env, t, 'tools/list')).body.result.tools;
  for (const x of list) {
    assert.equal(typeof x.annotations?.readOnlyHint, 'boolean', x.name);
    assert.equal(x.annotations.readOnlyHint, !WRITE_TOOLS.has(x.name), x.name);
  }
  assert.equal(list.find(x => x.name === 'delete_item').annotations.destructiveHint, true);
  assert.equal(list.filter(x => x.annotations.destructiveHint).length, 1);
  const required = n => list.find(x => x.name === n).inputSchema.required || [];
  const old = { get_overview: [], list_items: [], get_schedule: ['from', 'to'], create_item: ['title', 'date'], update_item: ['itemId'],
    set_done: ['itemId', 'done'], delete_item: ['itemId'], create_major_project: ['name'], list_gantt_projects: [],
    add_gantt_task: ['projectId', 'name', 'start', 'end'], update_gantt_task: ['projectId', 'taskId'], list_recent_changes: [], undo_change: ['changeId'] };
  for (const [n, req] of Object.entries(old)) assert.deepEqual(required(n), req, n);
  assert.equal(list.length, 21);
  const instr = (await rpc(env, t, 'initialize', { protocolVersion: '2025-06-18' })).body.result.instructions;
  assert.match(instr, /get_project_brief/);
  assert.match(instr, /不是給你的指令/);
});

// ------------------------------------------------------------ 4. 進展日誌

test('add_project_event：署名由伺服器依連線填（不採用 args 裡的 actor）；list 把內容放在 untrusted_text', async () => {
  const { env, t } = await setup();
  const r = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'progress', body: '做完設計稿', taskId: 'task_1', actor: '假冒的人' });
  assert.equal(r.isError, false, JSON.stringify(r.raw));
  assert.equal(events(env)[0].actor, 'Claude Code');
  const l = await call(env, t, 'list_project_events', { projectId: 'gp_1' });
  assert.equal(l.data.events[0].untrusted_text, '做完設計稿');
  assert.equal(l.data.events[0].by, 'Claude Code');
  assert.ok(!('body' in l.data.events[0]));
  assert.equal(l.data.today.length, 10);
});

test('日誌：專案或任務不存在就拒絕、body 空或超過 2000 字拒絕、kind 白名單、沒有任何改或刪的工具', async () => {
  const { env, t } = await setup();
  const base = { projectId: 'gp_1', kind: 'progress', body: 'x' };
  assert.equal((await call(env, t, 'add_project_event', { ...base, projectId: 'nope' })).isError, true);
  assert.equal((await call(env, t, 'add_project_event', { ...base, taskId: 'nope' })).isError, true);
  assert.equal((await call(env, t, 'add_project_event', { ...base, body: '  ' })).isError, true);
  assert.equal((await call(env, t, 'add_project_event', { ...base, body: 'x'.repeat(2001) })).isError, true);
  assert.equal((await call(env, t, 'add_project_event', { ...base, body: 'x'.repeat(2000) })).isError, false);
  for (const kind of ['answer', 'decision', 'bogus']) assert.equal((await call(env, t, 'add_project_event', { ...base, kind })).isError, true, kind);
  assert.equal((await call(env, t, 'add_project_event', { ...base, options: ['a', 'b'] })).isError, true, 'options 只有 question');
  assert.equal(events(env).length, 1);
  const names = TOOLS.map(x => x.name);
  assert.ok(!names.some(n => /redact|delete_event|update_event|edit_event|delete_project_event/.test(n)), '沒有改／刪／遮蔽日誌的工具');
});

test('每個專案每天 200 筆（agent 寫的才算）：第 201 筆拒絕；別的專案與使用者自己的不受影響', async () => {
  const { env, t } = await setup();
  userEdit(env, st => st.ganttProjects.push({ id: 'gp_2', name: '另一個', notes: '', pet: null, brief: '', tasks: [] }));
  const ins = env.DB.prepare(`INSERT INTO project_events (id, user_id, project_id, kind, actor, body, created_at) VALUES (?, 'u1', ?, 'progress', ?, 'x', ?)`);
  for (let i = 0; i < 199; i++) ins.bind('e' + i, 'gp_1', 'Claude Code', Date.now()).run();
  for (let i = 0; i < 50; i++) ins.bind('u' + i, 'gp_1', 'user', Date.now()).run();
  assert.equal((await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'progress', body: '第 200 筆' })).isError, false);
  const over = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'progress', body: '第 201 筆' });
  assert.equal(over.isError, true); assert.match(over.data.error, /上限/);
  assert.equal((await call(env, t, 'add_project_event', { projectId: 'gp_2', kind: 'progress', body: '別的專案' })).isError, false);
});

test('question：任務標成 waiting（可復原）、選項與期限存起來；withdraw 撤回自己的問題', async () => {
  const { env, t } = await setup();
  const q = await call(env, t, 'add_project_event', { projectId: 'gp_1', taskId: 'task_1', kind: 'question', body: '用 A 還是 B？', options: ['A', 'B'], defaultAfter: '2099-01-01' });
  assert.equal(q.isError, false, JSON.stringify(q.raw));
  assert.equal(taskOf(env).status, 'waiting');
  const row = events(env)[0];
  assert.deepEqual([row.status, row.options, row.default_after], ['open', '["A","B"]', '2099-01-01']);
  assert.equal(env.DB.prepare("SELECT COUNT(*) AS n FROM mcp_activity WHERE tool = 'add_project_event'").first().n, 1);
  for (const bad of [{ options: ['only'] }, { options: ['a', 'b', 'c', 'd', 'e'] }, { options: ['a', 'a'] }, { defaultAfter: 'tomorrow' }]) {
    assert.equal((await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'question', body: 'q', ...bad })).isError, true, JSON.stringify(bad));
  }
  const w = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'withdraw', refId: q.data.eventId, body: '我自己想通了' });
  assert.equal(w.isError, false, JSON.stringify(w.raw));
  assert.equal(events(env).find(e => e.id === q.data.eventId).status, 'withdrawn');
  assert.equal(taskOf(env).status, 'waiting', '撤回不改任務狀態');
  assert.equal((await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'withdraw', refId: q.data.eventId, body: 'again' })).isError, true, '已經撤回過');
});

test('withdraw：不能撤回別人的問題、也不能撤回不是問題的紀錄', async () => {
  const { env, t } = await setup();
  const b = proUser(env, 'u2', 'b@x.test'); seedState(env, 'u2', baseState(), 1000);
  const tb = await keyFor(env, b);
  const qb = await call(env, tb, 'add_project_event', { projectId: 'gp_1', kind: 'question', body: 'B 的問題' });
  const r = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'withdraw', refId: qb.data.eventId, body: 'x' });
  assert.equal(r.isError, true);
  assert.equal(env.DB.prepare('SELECT status FROM project_events WHERE id = ?').bind(qb.data.eventId).first().status, 'open');
  const p = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'progress', body: 'p' });
  assert.equal((await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'withdraw', refId: p.data.eventId, body: 'x' })).isError, true);
});

test('跨帳號：兩個人都有 gp_1，B 的 agent 讀不到 A 的日誌、brief 也不含', async () => {
  const { env, u, t } = await setup();
  const b = proUser(env, 'u2', 'b@x.test'); seedState(env, 'u2', baseState(), 1000);
  const tb = await keyFor(env, b);
  await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'handoff', body: 'A 的秘密交接' });
  await call(env, tb, 'add_project_event', { projectId: 'gp_1', kind: 'progress', body: 'B 的進展' });
  const lb = await call(env, tb, 'list_project_events', { projectId: 'gp_1' });
  assert.ok(!JSON.stringify(lb.data).includes('A 的秘密'));
  assert.equal(lb.data.events.length, 1);
  const bb = await call(env, tb, 'get_project_brief', { projectId: 'gp_1' });
  assert.ok(!JSON.stringify(bb.data).includes('A 的秘密'));
  assert.equal(bb.data.latestHandoff, null);
  const own = await unwrap(await handleProjectEvents(env, { id: 'u2' }, 'gp_1', new URL('https://x.test/api/projects/gp_1/events')));
  assert.ok(!JSON.stringify(own.body).includes('A 的秘密'));
});

test('get_project_brief：說明書、最新交接、任務（含逾期）、待回答的問題、交接之後的回答、最近 10 筆、開著的提案', async () => {
  const { env, u, t } = await setup();
  await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'handoff', body: '舊交接' });
  const q = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'question', body: '舊問題', defaultAfter: '2020-01-01', options: ['甲', '乙'] });
  await new Promise(r => setTimeout(r, 5));
  await unwrap(await handleAnswerEvent(post({ body: '選甲' }), env, u, q.data.eventId));
  await new Promise(r => setTimeout(r, 5));
  await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'handoff', body: '新交接' });
  const q2 = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'question', body: '還沒回的', defaultAfter: '2020-01-01' });
  await new Promise(r => setTimeout(r, 5));
  const q3 = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'question', body: '交接後回答的' });
  await unwrap(await handleAnswerEvent(post({ body: '好' }), env, u, q3.data.eventId));
  await call(env, t, 'propose_changes', { title: '提案一', ops: [{ tool: 'create_item', args: { title: 'x', date: '2026-02-01' } }] });
  const b = (await call(env, t, 'get_project_brief', { projectId: 'gp_1' })).data;
  assert.equal(b.brief.untrusted_text, '不要動預算');
  assert.equal(b.latestHandoff.untrusted_text, '新交接');
  assert.equal(b.tasks.find(x => x.id === 'task_1').overdue, true);
  assert.deepEqual(b.openQuestions.map(x => x.untrusted_text), ['還沒回的']);
  assert.equal(b.openQuestions[0].pastDeadline, true);
  assert.deepEqual(b.answersSinceLastHandoff.map(x => x.untrusted_text), ['好'], '舊交接之前回答的不再列');
  assert.ok(b.recentEvents.length <= 10 && b.recentEvents.length > 0);
  assert.deepEqual(b.openProposals.map(x => x.title), ['提案一']);
});

// ------------------------------------------------------------ 5. 擁有者的日誌端點

test('回答：寫 answer＋decision、問題變 answered、任務狀態不變；第二次回答 409；別人回答不了', async () => {
  const { env, u, t } = await setup();
  const q = await call(env, t, 'add_project_event', { projectId: 'gp_1', taskId: 'task_1', kind: 'question', body: '用 A 還是 B？', options: ['A', 'B'] });
  const b = proUser(env, 'u2', 'b@x.test'); seedState(env, 'u2', baseState(), 1000);
  assert.equal((await unwrap(await handleAnswerEvent(post({ body: '偷答' }), env, b, q.data.eventId))).status, 404);
  assert.equal((await unwrap(await handleAnswerEvent(post({ body: '' }), env, u, q.data.eventId))).status, 400);
  const r = await unwrap(await handleAnswerEvent(post({ body: '選 A' }), env, u, q.data.eventId));
  assert.equal(r.status, 200);
  const evs = events(env);
  assert.deepEqual(evs.map(e => [e.kind, e.actor]), [['question', 'Claude Code'], ['answer', 'user'], ['decision', 'user']]);
  assert.equal(evs[0].status, 'answered');
  assert.equal(evs[1].ref_id, evs[0].id);
  assert.match(evs[2].body, /用 A 還是 B？[\s\S]*選 A/);
  assert.equal(taskOf(env).status, 'waiting', '回答了不代表 agent 已經讀到：狀態不自動解除');
  assert.equal((await unwrap(await handleAnswerEvent(post({ body: '再答' }), env, u, q.data.eventId))).status, 409);
  assert.equal(events(env).length, 3);
});

test('遮蔽：body 清空、留骨架；只有擁有者（別人 404）；agent 讀到的是空的；不能遮兩次', async () => {
  const { env, u, t } = await setup();
  const e = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'progress', body: '密碼是 hunter2' });
  const b = proUser(env, 'u2', 'b@x.test');
  assert.equal((await unwrap(await handleRedactEvent(env, b, e.data.eventId))).status, 404);
  assert.equal(events(env)[0].body, '密碼是 hunter2');
  assert.equal((await unwrap(await handleRedactEvent(env, u, e.data.eventId))).status, 200);
  const row = events(env)[0];
  assert.equal(row.body, ''); assert.ok(row.redacted_at); assert.equal(row.kind, 'progress'); assert.equal(row.actor, 'Claude Code');
  const l = await call(env, t, 'list_project_events', { projectId: 'gp_1' });
  assert.deepEqual([l.data.events[0].untrusted_text, l.data.events[0].redacted], ['', true]);
  const own = await unwrap(await handleProjectEvents(env, u, 'gp_1', new URL('https://x.test/x')));
  assert.equal(own.body.events[0].redactedAt > 0, true);
  assert.equal((await unwrap(await handleRedactEvent(env, u, e.data.eventId))).status, 404);
});

test('Pro 到期之後：擁有者照樣讀日誌、回答、處理提案；agent 讀寫都擋；收件匣標出 agent 連不進來', async () => {
  const { env, u, t, conn } = await setup();
  await setSettings(env, u, conn, { mode: 'review' });
  const q = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'question', body: '要不要？' });
  const p = await call(env, t, 'create_item', { title: '提案中', date: '2026-02-01' });
  env.DB.prepare('UPDATE users SET plan_source = NULL WHERE id = ?').bind('u1').run();
  const free = { ...u, planSource: null };
  assert.equal((await call(env, t, 'get_overview')).isError, true, 'agent 被擋');
  const inbox = (await unwrap(await handleAgentInbox(env, free))).body;
  assert.equal(inbox.agentAvailable, false);
  assert.equal(inbox.questions.length, 1); assert.equal(inbox.proposals.length, 1);
  assert.equal((await unwrap(await handleProjectEvents(env, free, 'gp_1', new URL('https://x.test/x')))).body.events.length, 1);
  assert.equal((await unwrap(await handleAnswerEvent(post({ body: '要' }), env, free, q.data.eventId))).status, 200);
  assert.equal((await unwrap(await handleRejectProposal(post({ note: '不用了' }), env, free, p.data.proposalId))).status, 200);
});

test('收件匣：等你回覆的問題（附專案與任務名）、待你審的提案、待你驗收的任務；消失的專案不列', async () => {
  const { env, u, t, conn } = await setup();
  await setSettings(env, u, conn, { needsAcceptance: true });
  await call(env, t, 'add_project_event', { projectId: 'gp_1', taskId: 'task_1', kind: 'question', body: '問', defaultAfter: '2020-01-01' });
  await call(env, t, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_1', done: true });
  await call(env, t, 'propose_changes', { title: '想改', ops: [{ tool: 'create_item', args: { title: 'x', date: '2026-02-01' } }] });
  const inbox = (await unwrap(await handleAgentInbox(env, u))).body;
  assert.deepEqual([inbox.questions[0].projectName, inbox.questions[0].taskName, inbox.questions[0].pastDeadline], ['新廠', '設計', true]);
  assert.deepEqual(inbox.review.map(x => x.taskName), ['設計']);
  assert.equal(inbox.proposals[0].title, '想改');
  assert.equal(inbox.agentAvailable, true);
  userEdit(env, st => { st.ganttProjects = []; });
  const gone = (await unwrap(await handleAgentInbox(env, u))).body;
  assert.equal(gone.questions.length, 0, '專案不在了：留著但不顯示');
  assert.equal(events(env).length >= 2, true, '日誌沒有被刪');
});

// ------------------------------------------------------------ 6. review 模式與提案

test('review 模式：寫入工具不寫入（資料一個位元都沒變、沒有修改紀錄），長出提案並明說尚未生效', async () => {
  const { env, u, t, conn } = await setup();
  await setSettings(env, u, conn, { mode: 'review' });
  const before = JSON.stringify(readState(env, 'u1'));
  const calls = [
    ['create_item', { title: '新的', date: '2026-02-01' }], ['create_major_project', { name: '新大項目' }], ['create_gantt_project', { name: '新專案' }],
    ['add_gantt_task', { projectId: 'gp_1', name: 't', start: '2026-01-01', end: '2026-01-02' }],
    ['update_gantt_task', { projectId: 'gp_1', taskId: 'task_1', status: 'doing' }],
    ['upsert_task_todo', { projectId: 'gp_1', taskId: 'task_1', text: 'x' }], ['write_daily_log', { text: 'hi' }],
  ];
  for (const [name, args] of calls) {
    const r = await call(env, t, name, args);
    assert.equal(r.isError, false, name + JSON.stringify(r.raw));
    assert.equal(r.data.proposed, true, name);
    assert.match(r.data.note, /尚未生效/);
  }
  assert.equal(JSON.stringify(readState(env, 'u1')), before, '資料一個位元都沒變');
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM mcp_activity').first().n, 0);
  assert.equal(env.DB.prepare("SELECT COUNT(*) AS n FROM mcp_proposals WHERE status = 'open'").first().n, calls.length);
  // 提案存的是操作，不是結果
  const row = env.DB.prepare('SELECT ops FROM mcp_proposals ORDER BY created_at LIMIT 1').first();
  assert.deepEqual(JSON.parse(row.ops), [{ tool: 'create_item', args: { title: '新的', date: '2026-02-01' } }]);
  // agent 讀到的仍是沒套用的資料
  assert.equal((await call(env, t, 'list_items', {})).data.total, 0);
});

test('review 模式：日誌與提問不經過審核；讀取工具照常', async () => {
  const { env, u, t, conn } = await setup();
  await setSettings(env, u, conn, { mode: 'review' });
  const e = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'progress', body: '我提了一份提案' });
  assert.equal(e.isError, false); assert.ok(e.data.eventId);
  const q = await call(env, t, 'add_project_event', { projectId: 'gp_1', taskId: 'task_1', kind: 'question', body: '問', });
  assert.equal(q.data.taskStatus, 'waiting');
  assert.equal(taskOf(env).status, 'waiting');
  assert.equal(events(env).length, 2);
});

test('review 模式：參數行不通當場回錯、不留一份注定套不上去的提案；review 下不能自己復原', async () => {
  const { env, u, t, conn } = await setup();
  const c = await call(env, t, 'create_item', { title: '先建一個', date: '2026-02-01' });
  await setSettings(env, u, conn, { mode: 'review' });
  const bad = await call(env, t, 'update_item', { itemId: 'nope', title: 'x' });
  assert.equal(bad.isError, true);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM mcp_proposals').first().n, 0);
  const undo = await call(env, t, 'undo_change', { changeId: c.data.changeId });
  assert.equal(undo.isError, true);
  assert.equal(stateOf(env).items.length, 1);
});

test('propose_changes：direct 模式也建提案；整份同意＝依序全套、每個 change 一列修改紀錄（帶連線）、各自可復原', async () => {
  const { env, u, t, conn } = await setup();
  const p = await call(env, t, 'propose_changes', { title: '重排', ops: [
    { tool: 'create_item', args: { title: '新項目', date: '2026-03-01' } },
    { tool: 'update_gantt_task', args: { projectId: 'gp_1', taskId: 'task_1', end: '2026-02-15', status: 'doing' } },
    { tool: 'write_daily_log', args: { text: '提案套用了' } },
  ] });
  assert.equal(p.data.proposed, true, JSON.stringify(p.raw));
  assert.equal(stateOf(env).items.length, 0);
  const listed = (await unwrap(await handleListProposals(env, u))).body.proposals;
  assert.equal(listed.length, 1);
  const rows = listed[0].preview.rows;
  assert.ok(rows.some(r => r.field === '新增' && /新項目/.test(r.after)), JSON.stringify(rows));
  assert.ok(rows.some(r => r.entity.includes('設計') && r.field === '結束' && r.before === '2026-01-31' && r.after === '2026-02-15'));
  assert.ok(rows.some(r => r.field === '狀態' && r.before === 'todo' && r.after === 'doing'));
  const ap = await unwrap(await handleApproveProposal(env, u, p.data.proposalId));
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.equal(stateOf(env).items[0].title, '新項目');
  assert.equal(taskOf(env).end, '2026-02-15');
  const act = env.DB.prepare('SELECT tool, conn_id, actor FROM mcp_activity ORDER BY rowid').all().results;
  assert.deepEqual(act.map(a => a.tool), ['create_item', 'update_gantt_task', 'write_daily_log']);
  assert.ok(act.every(a => a.conn_id === conn && a.actor === 'Claude Code'));
  assert.equal(env.DB.prepare('SELECT status FROM mcp_proposals').first().status, 'approved');
  // 同意之後的修改照樣可以復原（結束日那一筆）
  const ids = env.DB.prepare("SELECT id FROM mcp_activity WHERE tool = 'update_gantt_task'").first().id;
  assert.equal((await unwrap(await handleActivityUndo(env, u, ids))).status, 200);
  assert.equal(taskOf(env).end, '2026-01-31');
  assert.equal((await unwrap(await handleApproveProposal(env, u, p.data.proposalId))).status, 409, '同意過的不能再同意');
});

test('同意時在「當下的資料」上套：使用者在提案之後改了別的欄位，兩邊都在', async () => {
  const { env, u, t, conn } = await setup();
  await setSettings(env, u, conn, { mode: 'review' });
  const p = await call(env, t, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_1', name: 'agent 要改的名字' });
  userEdit(env, st => { st.ganttProjects[0].tasks[0].end = '2026-05-05'; });
  assert.equal((await unwrap(await handleApproveProposal(env, u, p.data.proposalId))).status, 200);
  assert.deepEqual([taskOf(env).name, taskOf(env).end], ['agent 要改的名字', '2026-05-05']);
});

test('套不上去的操作：整份不套、標 stale、回的錯誤說出是第幾個；其他操作的效果也不留', async () => {
  const { env, u, t, conn } = await setup();
  const made = await call(env, t, 'create_item', { title: '會被刪', date: '2026-02-01' });
  const victim = made.data.item.id;
  await setSettings(env, u, conn, { mode: 'review' });
  const p = await call(env, t, 'propose_changes', { title: '兩步', ops: [
    { tool: 'create_item', args: { title: '不該留下', date: '2026-03-01' } },
    { tool: 'update_item', args: { itemId: victim, title: '改它' } },
  ] });
  assert.equal(p.data.proposed, true, JSON.stringify(p.raw));
  userEdit(env, st => { st.items = st.items.filter(i => i.id !== victim); });
  const before = JSON.stringify(readState(env, 'u1').state);
  const ap = await unwrap(await handleApproveProposal(env, u, p.data.proposalId));
  assert.equal(ap.status, 409);
  assert.equal(ap.body.status, 'stale');
  assert.deepEqual([ap.body.failingOp.index, ap.body.failingOp.tool], [1, 'update_item']);
  assert.match(ap.body.error, /第 2 個操作/);
  assert.equal(JSON.stringify(readState(env, 'u1').state), before, '一個位元都沒寫');
  const row = env.DB.prepare('SELECT status, note FROM mcp_proposals WHERE id = ?').bind(p.data.proposalId).first();
  assert.equal(row.status, 'stale'); assert.match(row.note, /第 2 個操作/);
  assert.equal(env.DB.prepare("SELECT COUNT(*) AS n FROM mcp_activity WHERE tool = 'propose_changes' OR summary LIKE '%不該留下%'").first().n, 0);
});

test('競態：同意的那一刻使用者的寫入剛好落在中間——重讀重算，兩邊都在', async () => {
  const { env, u, t, conn } = await setup();
  await setSettings(env, u, conn, { mode: 'review' });
  const p = await call(env, t, 'create_item', { title: 'agent 的項目', date: '2026-02-01' });
  const realPrepare = env.DB.prepare.bind(env.DB);
  let raced = false;
  env.DB.prepare = (sql) => {
    if (!raced && sql.startsWith('UPDATE user_state SET state')) {
      raced = true;
      const cur = readState(env, 'u1');
      cur.state.majorProjects.push({ id: 'mp_web', name: '網頁上剛加的' });
      realPrepare('UPDATE user_state SET state = ?, updated_at = ? WHERE user_id = ?').bind(JSON.stringify(cur.state), 9000, 'u1').run();
    }
    return realPrepare(sql);
  };
  const ap = await unwrap(await handleApproveProposal(env, u, p.data.proposalId));
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  const s = stateOf(env);
  assert.ok(s.majorProjects.some(m => m.id === 'mp_web'), '使用者那一筆沒被蓋掉');
  assert.equal(s.items[0].title, 'agent 的項目');
});

test('兩個裝置同時按同意：只有一個領得到那份提案，資料只套一次', async () => {
  const { env, u, t, conn } = await setup();
  await setSettings(env, u, conn, { mode: 'review' });
  const p = await call(env, t, 'create_item', { title: '只該有一個', date: '2026-02-01' });
  const rs = await Promise.all([handleApproveProposal(env, u, p.data.proposalId), handleApproveProposal(env, u, p.data.proposalId)]);
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 409]);
  assert.equal(stateOf(env).items.length, 1);
});

test('退回：記下理由、不寫入；處理過的不能再同意或再退回', async () => {
  const { env, u, t, conn } = await setup();
  await setSettings(env, u, conn, { mode: 'review' });
  const p = await call(env, t, 'create_item', { title: 'x', date: '2026-02-01' });
  assert.equal((await unwrap(await handleRejectProposal(post({ note: '日期不對' }), env, u, p.data.proposalId))).status, 200);
  const row = env.DB.prepare('SELECT status, note, decided_at FROM mcp_proposals').first();
  assert.deepEqual([row.status, row.note], ['rejected', '日期不對']); assert.ok(row.decided_at);
  assert.equal(stateOf(env).items.length, 0);
  assert.equal((await unwrap(await handleApproveProposal(env, u, p.data.proposalId))).status, 409);
  assert.equal((await unwrap(await handleRejectProposal(post({}), env, u, p.data.proposalId))).status, 409);
});

test('每個帳號最多 20 份開著的提案；超過當場回錯，處理掉一份又能提', async () => {
  const { env, u, t, conn } = await setup();
  await setSettings(env, u, conn, { mode: 'review' });
  let first;
  for (let i = 0; i < 20; i++) { const r = await call(env, t, 'create_item', { title: 'n' + i, date: '2026-02-01' }); first ||= r.data.proposalId; assert.equal(r.data.proposed, true); }
  const over = await call(env, t, 'create_item', { title: '第 21 份', date: '2026-02-01' });
  assert.equal(over.isError, true); assert.match(over.data.error, /20/);
  await unwrap(await handleRejectProposal(post({}), env, u, first));
  assert.equal((await call(env, t, 'create_item', { title: '又能提了', date: '2026-02-01' })).data.proposed, true);
});

test('propose_changes 的 ops 驗證：只收寫入類工具、最多 20 個、不能是空的、requestId 不會被存進提案', async () => {
  const { env, t } = await setup();
  const ok = { tool: 'create_item', args: { title: 'x', date: '2026-02-01', requestId: 'inner' } };
  assert.equal((await call(env, t, 'propose_changes', { title: 'x', ops: [] })).isError, true);
  assert.equal((await call(env, t, 'propose_changes', { title: 'x', ops: [{ tool: 'undo_change', args: {} }] })).isError, true);
  assert.equal((await call(env, t, 'propose_changes', { title: 'x', ops: [{ tool: 'add_project_event', args: {} }] })).isError, true);
  assert.equal((await call(env, t, 'propose_changes', { title: 'x', ops: Array(21).fill(ok) })).isError, true);
  const p = await call(env, t, 'propose_changes', { title: 'x', ops: [ok] });
  assert.equal(p.isError, false);
  assert.deepEqual(JSON.parse(env.DB.prepare('SELECT ops FROM mcp_proposals').first().ops)[0].args, { title: 'x', date: '2026-02-01' });
});

test('撤回提案：只有提案的那條連線能撤回；別人的提案不能碰；同意不了別人的提案', async () => {
  const { env, u, t } = await setup();
  const t2 = await keyFor(env, u, '另一條連線');
  const b = proUser(env, 'u2', 'b@x.test'); seedState(env, 'u2', baseState(), 1000);
  const tb = await keyFor(env, b);
  const p = await call(env, t, 'propose_changes', { title: 'x', ops: [{ tool: 'create_item', args: { title: 'x', date: '2026-02-01' } }] });
  assert.equal((await call(env, t2, 'withdraw_proposal', { proposalId: p.data.proposalId })).isError, true, '別條連線');
  assert.equal((await call(env, tb, 'withdraw_proposal', { proposalId: p.data.proposalId })).isError, true, '別人');
  assert.equal((await unwrap(await handleApproveProposal(env, b, p.data.proposalId))).status, 404);
  assert.equal((await unwrap(await handleRejectProposal(post({}), env, b, p.data.proposalId))).status, 404);
  assert.deepEqual((await unwrap(await handleListProposals(env, b))).body.proposals, []);
  assert.equal(env.DB.prepare('SELECT status FROM mcp_proposals').first().status, 'open');
  assert.equal((await call(env, t, 'withdraw_proposal', { proposalId: p.data.proposalId })).isError, false);
  assert.equal(env.DB.prepare('SELECT status FROM mcp_proposals').first().status, 'withdrawn');
  assert.equal((await unwrap(await handleApproveProposal(env, u, p.data.proposalId))).status, 409);
});

test('requestId 對提案也有效：同一個 id 重送只長一份提案', async () => {
  const { env, u, t, conn } = await setup();
  await setSettings(env, u, conn, { mode: 'review' });
  const a = await call(env, t, 'create_item', { title: 'x', date: '2026-02-01', requestId: 'dup' });
  const b = await call(env, t, 'create_item', { title: 'x', date: '2026-02-01', requestId: 'dup' });
  assert.equal(a.data.proposalId, b.data.proposalId);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM mcp_proposals').first().n, 1);
});

// ------------------------------------------------------------ 7. 待驗收

async function acceptanceSetup() {
  const s = await setup();
  await setSettings(s.env, s.u, s.conn, { needsAcceptance: true });
  return s;
}

test('待驗收：set_done／done:true／進度 100 都不會真的完成，改標 review 並寫一筆「請驗收」', async () => {
  for (const args of [{ done: true }, { progress: 100 }]) {
    const { env, t } = await acceptanceSetup();
    const r = await call(env, t, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_1', ...args });
    assert.equal(r.isError, false, JSON.stringify(r.raw));
    const task = taskOf(env);
    assert.equal(task.done, false, JSON.stringify(args));
    assert.equal(task.status, 'review');
    assert.ok(task.progress <= 99);
    assert.match(r.data.note, /驗收/);
    const ev = events(env);
    assert.equal(ev.length, 1); assert.match(ev[0].body, /請驗收/); assert.equal(ev[0].task_id, 'task_1'); assert.equal(ev[0].actor, 'Claude Code');
  }
});

test('待驗收：一個一個勾完所有子待辦也繞不過去——最後一個留在待驗收（半勾）', async () => {
  const { env, t } = await acceptanceSetup();
  const a = await call(env, t, 'upsert_task_todo', { projectId: 'gp_1', taskId: 'task_2', todoId: 'td_a', done: true });
  assert.equal(a.data.task.status, 'todo'); assert.equal(a.data.task.progress, 50);
  assert.equal(events(env).length, 0, '還沒到最後一個：不攔');
  const b = await call(env, t, 'upsert_task_todo', { projectId: 'gp_1', taskId: 'task_2', todoId: 'td_b', done: true });
  assert.equal(b.isError, false, JSON.stringify(b.raw));
  const task = taskOf(env, 'task_2');
  assert.deepEqual([task.done, task.status, task.progress], [false, 'review', 50]);
  assert.deepEqual(task.todos.map(x => [x.done, x.review]), [[true, false], [false, true]]);
  assert.equal(events(env).length, 1);
  // 新增一個本來就是完成的子待辦、讓任務「有效完成」變真，也攔得住
  const c = await call(env, t, 'upsert_task_todo', { projectId: 'gp_1', taskId: 'task_1', text: '一步到位', done: true });
  assert.equal(c.data.task.done, false); assert.equal(c.data.task.status, 'review');
  assert.equal(c.data.task.todos[0].review, true);
});

test('驗收通過：真的完成（待驗收的子待辦勾起來、旗標清掉、狀態回 todo）；沒有子待辦的任務 done＋100', async () => {
  const { env, u, t } = await acceptanceSetup();
  await call(env, t, 'upsert_task_todo', { projectId: 'gp_1', taskId: 'task_2', todoId: 'td_a', done: true });
  await call(env, t, 'upsert_task_todo', { projectId: 'gp_1', taskId: 'task_2', todoId: 'td_b', done: true });
  await call(env, t, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_1', done: true });
  assert.equal((await unwrap(await handleAcceptTask(env, u, 'gp_1', 'task_2'))).status, 200);
  const t2 = taskOf(env, 'task_2');
  assert.deepEqual([t2.done, t2.progress, t2.status], [true, 100, 'todo']);
  assert.deepEqual(t2.todos.map(x => [x.done, x.review]), [[true, false], [true, false]]);
  assert.equal((await unwrap(await handleAcceptTask(env, u, 'gp_1', 'task_1'))).status, 200);
  const t1 = taskOf(env);
  assert.deepEqual([t1.done, t1.progress, t1.status], [true, 100, 'todo']);
  assert.equal((await unwrap(await handleAcceptTask(env, u, 'gp_1', 'task_1'))).status, 409, '已經不在待驗收');
  assert.ok(events(env).some(e => e.actor === 'user' && /驗收通過/.test(e.body)));
  // 前端 normalize 之後仍然一致
  assert.equal(F.stableStringify(F.normalizeGanttProjects(stateOf(env).ganttProjects)), F.stableStringify(stateOf(env).ganttProjects));
});

test('退回：理由必填、寫進日誌（actor=user）、狀態回 doing、旗標清掉、done 維持 false；別人不能退回', async () => {
  const { env, u, t } = await acceptanceSetup();
  await call(env, t, 'upsert_task_todo', { projectId: 'gp_1', taskId: 'task_2', todoId: 'td_a', done: true });
  await call(env, t, 'upsert_task_todo', { projectId: 'gp_1', taskId: 'task_2', todoId: 'td_b', done: true });
  assert.equal((await unwrap(await handleRejectTask(post({ reason: '  ' }), env, u, 'gp_1', 'task_2'))).status, 400);
  const b = proUser(env, 'u2', 'b@x.test'); seedState(env, 'u2', baseState(), 1000);
  const other = await unwrap(await handleRejectTask(post({ reason: '亂退' }), env, b, 'gp_1', 'task_2'));
  assert.equal(other.status, 409, 'B 自己的 gp_1/task_2 不在待驗收');
  assert.equal(taskOf(env, 'task_2').status, 'review', 'A 的任務沒被動到');
  assert.equal((await unwrap(await handleRejectTask(post({ reason: '開工那一步沒做完' }), env, u, 'gp_1', 'task_2'))).status, 200);
  const task = taskOf(env, 'task_2');
  assert.deepEqual([task.status, task.done], ['doing', false]);
  assert.ok(task.todos.every(x => x.review === false));
  const ev = events(env).find(e => e.actor === 'user');
  assert.match(ev.body, /開工那一步沒做完/); assert.equal(ev.kind, 'progress');
  const brief = (await call(env, t, 'get_project_brief', { projectId: 'gp_1' })).data;
  assert.ok(brief.recentEvents.some(e => /開工那一步沒做完/.test(e.untrusted_text)), 'agent 下次開工讀得到理由');
});

test('沒開「要驗收」的連線：照舊直接完成；開著的連線之外的修改也不受影響', async () => {
  const { env, t } = await setup();
  const r = await call(env, t, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_1', done: true });
  assert.equal(r.data.task.done, true);
  assert.equal(taskOf(env).status, 'todo');
  assert.equal(events(env).length, 0);
});

test('待驗收的修改可以復原（紀錄裡的 after 是攔過之後的樣子）', async () => {
  const { env, u, t } = await acceptanceSetup();
  const r = await call(env, t, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_1', progress: 100 });
  assert.equal((await unwrap(await handleActivityUndo(env, u, r.data.changeId))).status, 200);
  const task = taskOf(env);
  assert.deepEqual([task.progress, task.done, task.status], [10, false, 'todo']);
});

test('提案同意時也攔：review 模式＋要驗收，同意的那一刻任務標 review、不完成', async () => {
  const { env, u, t, conn } = await setup();
  await setSettings(env, u, conn, { mode: 'review', needsAcceptance: true });
  const p = await call(env, t, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_1', done: true });
  assert.equal((await unwrap(await handleApproveProposal(env, u, p.data.proposalId))).status, 200);
  assert.deepEqual([taskOf(env).done, taskOf(env).status], [false, 'review']);
  assert.equal(events(env).length, 1);
});

test('applyAcceptance 本身：只攔 false→true；本來就完成的、沒變的、不相干的任務不動', () => {
  const prev = baseState();
  prev.ganttProjects[0].tasks[0].done = true; prev.ganttProjects[0].tasks[0].progress = 100;
  const { state: next } = S.updateGanttTask(prev, 'gp_1', 'task_1', { name: '改名' });
  const r = S.applyAcceptance(prev, next, []);
  assert.equal(r.events.length, 0);
  assert.equal(r.state.ganttProjects[0].tasks[0].done, true, '本來就完成的不被追溯');
  assert.deepEqual(r.state, next);
});

// ------------------------------------------------------------ 8. 專案消失 30 天才清日誌

const DAY = 24 * 3600 * 1000;
function seedEvent(env, uid, pid, id = crypto.randomUUID()) {
  env.DB.prepare(`INSERT INTO project_events (id, user_id, project_id, kind, actor, body, created_at) VALUES (?, ?, ?, 'progress', 'Claude', 'x', 1)`).bind(id, uid, pid).run();
}

test('專案不見：第一次只記下「消失的時間」，滿 30 天才刪日誌；中間救回來就清掉記錄、日誌還在', () => {
  return (async () => {
    const env = makeEnv(); proUser(env, 'u1', 'a@x.test');
    seedState(env, 'u1', baseState(), 1000);
    seedEvent(env, 'u1', 'gp_1'); seedEvent(env, 'u1', 'gp_gone');
    const T0 = Date.UTC(2026, 10, 1);
    let r = await purgeAgentData(env, T0);
    assert.equal(r.marked, 1);
    assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM project_absent').first().n, 1);
    r = await purgeAgentData(env, T0 + 29 * DAY);
    assert.equal(r.eventsPurged, 0, '29 天還在');
    assert.equal(events(env).length, 2);
    // 第 20 天專案被救回來（復原／三方合併）：記錄清掉，日誌還在
    userEdit(env, st => st.ganttProjects.push({ id: 'gp_gone', name: '救回來', notes: '', pet: null, brief: '', tasks: [] }));
    r = await purgeAgentData(env, T0 + 30 * DAY);
    assert.equal(r.cleared, 1); assert.equal(r.eventsPurged, 0);
    assert.equal(events(env).length, 2);
    // 再次消失 → 重新計 30 天
    userEdit(env, st => { st.ganttProjects = st.ganttProjects.filter(g => g.id !== 'gp_gone'); });
    await purgeAgentData(env, T0 + 31 * DAY);
    r = await purgeAgentData(env, T0 + 31 * DAY + 29 * DAY);
    assert.equal(r.eventsPurged, 0);
    r = await purgeAgentData(env, T0 + 31 * DAY + 31 * DAY);
    assert.equal(r.eventsPurged, 1);
    assert.deepEqual(events(env).map(e => e.project_id), ['gp_1'], '還在的專案的日誌原樣');
    assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM project_absent').first().n, 0);
  })();
});

test('讀不到／解析不了 state 的使用者整個跳過：不能把「讀不到」當成「專案不見了」；別人的日誌不受影響', async () => {
  const env = makeEnv(); proUser(env, 'u1', 'a@x.test'); proUser(env, 'u2', 'b@x.test');
  env.DB.prepare('INSERT INTO user_state (user_id, state, updated_at, created_at) VALUES (?, ?, 1, 1)').bind('u1', '{壞掉的 json').run();
  seedState(env, 'u2', baseState(), 1);
  // 能解析、但形狀不對（沒有 ganttProjects／整份是 null）也一樣是「讀不懂」，不是「全部專案都不見了」
  for (const [id, raw] of [['u3', '{"items":[]}'], ['u4', 'null']]) {
    proUser(env, id, id + '@x.test');
    env.DB.prepare('INSERT INTO user_state (user_id, state, updated_at, created_at) VALUES (?, ?, 1, 1)').bind(id, raw).run();
    seedEvent(env, id, 'gp_1');
  }
  seedEvent(env, 'u1', 'gp_1'); seedEvent(env, 'u2', 'gp_missing');
  const T0 = Date.UTC(2026, 10, 1);
  await purgeAgentData(env, T0);
  const r = await purgeAgentData(env, T0 + 40 * DAY);
  assert.equal(r.skippedUsers, 3);
  assert.equal(events(env, 'u3').length + events(env, 'u4').length, 2, '形狀不對的 state：日誌留著');
  assert.equal(events(env, 'u1').length, 1, '壞掉的 state：日誌留著');
  assert.equal(events(env, 'u2').length, 0, 'u2 的消失專案滿 30 天被清');
});

test('專案消失期間：日誌不顯示給擁有者與 agent（留著，救回來還在）', async () => {
  const { env, u, t } = await setup();
  await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'progress', body: '一筆' });
  userEdit(env, st => { st.ganttProjects = []; });
  const own = (await unwrap(await handleProjectEvents(env, u, 'gp_1', new URL('https://x.test/x')))).body;
  assert.deepEqual([own.events.length, own.projectMissing], [0, true]);
  assert.equal((await call(env, t, 'list_project_events', { projectId: 'gp_1' })).isError, true);
  userEdit(env, st => st.ganttProjects.push({ id: 'gp_1', name: '救回來', notes: '', pet: null, brief: '', tasks: [] }));
  assert.equal((await call(env, t, 'list_project_events', { projectId: 'gp_1' })).data.events.length, 1);
});

test('cron 的 step()：purgeAgentData 的結果進 cron_runs（獨立的一步）', async () => {
  const env = makeEnv(); proUser(env, 'u1', 'a@x.test');
  await step(env, 'agent_events', () => purgeAgentData(env));
  const row = env.DB.prepare("SELECT ok FROM cron_runs WHERE step = 'agent_events'").first();
  assert.equal(row.ok, 1);
});

test('決定過超過 90 天的提案順手清掉；還開著的不碰', async () => {
  const env = makeEnv(); proUser(env, 'u1', 'a@x.test');
  const ins = env.DB.prepare("INSERT INTO mcp_proposals (id, user_id, actor, title, ops, status, created_at, decided_at) VALUES (?, 'u1', 'c', 't', '[]', ?, 1, ?)");
  ins.bind('old', 'rejected', 1).run(); ins.bind('open', 'open', null).run(); ins.bind('fresh', 'approved', Date.now()).run();
  const r = await purgeAgentData(env);
  assert.equal(r.proposalsPurged, 1);
  assert.deepEqual(env.DB.prepare('SELECT id FROM mcp_proposals ORDER BY id').all().results.map(x => x.id), ['fresh', 'open']);
});

// ------------------------------------------------------------ 9. 備份

function fakeR2() {
  const store = new Map();
  return { store, async put(k, body, o) { store.set(k, { body, o }); }, async delete(k) { store.delete(k); },
    async list() { return { objects: [...store.keys()].map(key => ({ key })) }; } };
}

test('備份：帶進展日誌與「還開著的」提案（已決定的不帶）', async () => {
  const { env, t, u, conn } = await setup();
  env.BACKUPS = fakeR2();
  await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'handoff', body: '備份我' });
  await setSettings(env, u, conn, { mode: 'review' });
  const keep = await call(env, t, 'create_item', { title: 'open', date: '2026-02-01' });
  const drop = await call(env, t, 'create_item', { title: 'rejected', date: '2026-02-01' });
  await unwrap(await handleRejectProposal(post({}), env, u, drop.data.proposalId));
  const r = await runBackup(env);
  assert.deepEqual([r.projectEvents, r.openProposals], [1, 1]);
  const payload = JSON.parse(env.BACKUPS.store.get(r.key).body);
  assert.equal(payload.projectEvents[0].body, '備份我');
  assert.deepEqual(payload.mcpProposals.map(p => p.id), [keep.data.proposalId]);
});
