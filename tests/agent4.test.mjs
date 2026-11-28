/**
 * agent 工作區（第三批 3A，只有伺服器端）：版本歷史、權限分級的鑰匙、風險、唯讀分享連結、每週摘要信、agent 成績單。
 * 設計文件：docs/superpowers/specs/2026-11-21-agent-workspace.md（第三批、甲 2、第 21 件）
 *
 * 守的東西，壞掉時大多**畫面看起來正常、只是不該出去的東西出去了／該留的沒留**：
 *   1. 版本歷史：agent 每次寫入之前留一版（留的是寫入「之前」的原文）、算不出來的寫入不留、R2 出事不擋寫入、
 *      自己的修改每小時最多一版、每天至少一版、30 天與 300 版的上限、比較以「東西」為單位、
 *      退回是一次新的寫入（退回再退回回到原樣）、別人的版本 id 一律 404、刪帳號清 R2 prefix、備份不碰它
 *   2. 權限分級的鑰匙：唯讀鑰匙擋掉的集合**剛好等於 WRITE_TOOLS**、專案範圍的鑰匙碰不到別的專案、
 *      每一次呼叫都檢查（改了設定下一個呼叫就生效）、既有的鑰匙行為不變、OAuth 帶得過去
 *   3. 風險：開、關（agent 與擁有者）、只列還開著的、跨專案／跨帳號關不了
 *   4. 唯讀分享連結：預設**只有**專案名、里程碑、任務狀態；日誌、說明書、其他專案、被遮蔽的絕不出現；
 *      token 只存雜湊、重新產生撤銷舊的、專案不在了回 404 不是 500
 *   5. 每週摘要：沒事不寄、休假不寄也不記成送過、失敗不記成送過、一週一封、退訂只關自己那一顆（兩個方向）
 *   6. 成績單：只有數字、被復原的不算完成、跨帳號隔離
 *
 * 突變驗證（加完實際做過，各自只紅在對的地方）：見 CLAUDE.md〈agent 工作區的第三批（3A）〉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, addUser, seedState, readState, unwrap } from './d1.mjs';
import { fakeR2 } from './fake-r2.mjs';
import { handleMcp, handleActivityUndo, TOOLS, WRITE_TOOLS } from '../src/mcp/server.js';
import {
  handleCreateKey, handleListConnections, handleRegister, handleAuthorizeDecision, handleToken, authenticateMcp,
} from '../src/mcp/auth.js';
import {
  handleConnectionSettings, handleApproveProposal, handleCloseRisk, handleAgentScorecard, handleRedactEvent,
} from '../src/handlers/agent.js';
import {
  handleListVersions, handleDiffVersion, handleRestoreVersion, snapshotDaily, maybeUserVersion,
} from '../src/handlers/history.js';
import { handleShareStatus, handleShareCreate, handleShareRevoke, handlePublicProject } from '../src/handlers/projectshare.js';
import { sendWeeklyDigest, weekKeyOf, digestProjects } from '../src/handlers/weekly.js';
import {
  handleReminderStatus, handleReminderEnable, applyUnsubscribe, handleUnsubscribeOneClick, UNSUB_KINDS,
} from '../src/handlers/reminder.js';
import { handlePutState } from '../src/handlers/state.js';
import { handleDeleteAccount } from '../src/handlers/appauth.js';
import { runBackup } from '../src/handlers/backup.js';
import { casWrite, readState as storeReadState } from '../src/mcp/store.js';
import { takeVersion, pruneVersions, diffStates, VERSION_MAX_PER_USER, VERSION_KEEP_MS, versionKey } from '../src/mcp/history.js';
import { hashPassword, sha256 } from '../src/crypto.js';
import { step } from '../src/index.js';

// ------------------------------------------------------------ 共用

const DAY = 24 * 3600 * 1000;
const NEW = { estimateHours: null, actualHours: null, forecastEnd: null, assignee: null, claimedAt: null, links: [] };
const SECRET = '機敏字串-SECRET-9f3a';
function proUser(env, id, email) {
  addUser(env, id, email);
  env.DB.prepare("UPDATE users SET plan_source = 'admin' WHERE id = ?").bind(id).run();
  return { id, email, role: 'user', status: 'approved', planSource: 'admin', planExpiresAt: null };
}
function freeUser(env, id, email) {
  addUser(env, id, email);
  return { id, email, role: 'user', status: 'approved', planSource: null, planExpiresAt: null };
}
const task = (id, name, over = {}) => ({ id, name, start: '2026-12-01', end: '2026-12-10', progress: 0, done: false, todos: [], status: 'todo', blockedNote: '', ...NEW, ...over });
function baseState(over = {}) {
  return { version: 3, majorProjects: [{ id: 'mp_1', name: '大項目' }], items: [{ id: 'it_1', title: '項目甲', date: '2026-12-05', type: 'work' }],
    ganttProjects: [
      { id: 'gp_1', name: '新廠', notes: `<p>筆記 ${SECRET}</p>`, pet: null, brief: `說明書 ${SECRET}`, milestones: [], tasks: [
        task('task_1', '設計', { blockedNote: `卡住原因 ${SECRET}`, assignee: `認領者${SECRET}`, links: [{ url: 'https://example.com/' + SECRET, label: SECRET }] }),
        task('task_2', '施工', { start: '2026-12-11', end: '2026-12-20' }),
      ] },
      { id: 'gp_2', name: '另一個專案-機密', notes: '', pet: null, brief: '', milestones: [], tasks: [task('task_9', '別人的任務')] },
    ], dailyLogs: { '2026-12-01': `<p>每日記錄 ${SECRET}</p>` }, customHolidays: [], customWorkdays: [], absences: {}, ...over };
}
function setup(over = {}, opts = {}) {
  const env = makeEnv();
  if (!opts.noR2) env.BACKUPS = fakeR2();
  const u = proUser(env, 'u1', 'a@x.test');
  seedState(env, 'u1', baseState(over), 1000);
  return { env, u };
}
const post = body => new Request('https://x.test/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
async function keyFor(env, user, name = 'Claude Code', extra = {}) {
  const r = await unwrap(await handleCreateKey(post({ name, ...extra }), env, user));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
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
const stateOf = (env, uid = 'u1') => readState(env, uid).state;
const versions = (env, uid = 'u1') => env.DB.prepare('SELECT * FROM state_versions WHERE user_id = ? ORDER BY created_at, rowid').bind(uid).all().results;
const r2Keys = (env, prefix = 'history/') => [...env.BACKUPS.store.keys()].filter(k => k.startsWith(prefix));
const connIdOf = (env, userId) => env.DB.prepare('SELECT id FROM mcp_connections WHERE user_id = ? ORDER BY created_at LIMIT 1').bind(userId).first().id;
const rawOf = (env, uid = 'u1') => env.DB.prepare('SELECT state FROM user_state WHERE user_id = ?').bind(uid).first().state;
function userEdit(env, fn, uid = 'u1') {
  const cur = readState(env, uid);
  fn(cur.state);
  env.DB.prepare('UPDATE user_state SET state = ?, updated_at = updated_at + 1 WHERE user_id = ?').bind(JSON.stringify(cur.state), uid).run();
}
/** 讓第一次執行的 `UPDATE user_state` 在真正跑之前先插入別人的寫入（確定性的競態） */
function withRaceBeforeFirstUpdate(env, inject) {
  let fired = false;
  const DB = {
    prepare(sql) {
      const stmt = env.DB.prepare(sql);
      if (fired || !/^\s*UPDATE user_state/.test(sql)) return stmt;
      return {
        bind(...args) {
          const bound = stmt.bind(...args);
          return { run() { if (!fired) { fired = true; inject(); } return bound.run(); }, first: () => bound.first(), all: () => bound.all() };
        },
      };
    },
    batch: stmts => env.DB.batch(stmts),
  };
  return { ...env, DB };
}
async function quietly(fn) {
  const w = console.warn, e = console.error;
  const logs = [];
  console.warn = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' '));
  try { return { value: await fn(), logs }; } finally { console.warn = w; console.error = e; }
}

// ============================================================ 1. 版本歷史

test('版本歷史：agent 寫入之前留一版——留的是寫入「之前」的原文，署名是連線，摘要說得出做了什麼', async () => {
  const { env, u } = setup();
  const t = await keyFor(env, u, 'Claude Code');
  const before = rawOf(env);
  const r = await call(env, t, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_2', progress: 40 });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  const vs = versions(env);
  assert.equal(vs.length, 1);
  assert.equal(vs[0].actor, 'Claude Code');
  assert.match(vs[0].summary, /update_gantt_task/);
  assert.equal(env.BACKUPS.store.get(versionKey('u1', vs[0].id)).body, before, '版本內容與寫入之前的原文逐字相同');
  assert.equal(stateOf(env).ganttProjects[0].tasks[1].progress, 40, '寫入照常生效');
});

test('版本歷史：算不出來的寫入（ToolError）不留版本', async () => {
  const { env, u } = setup();
  const t = await keyFor(env, u);
  const r = await call(env, t, 'update_gantt_task', { projectId: 'gp_1', taskId: 'nope', progress: 40 });
  assert.equal(r.isError, true);
  assert.equal(versions(env).length, 0);
  assert.equal(r2Keys(env).length, 0);
});

test('版本歷史：直接寫入、apply_changes、同意提案、整批復原，每一種寫入之前都留版本', async () => {
  const { env, u } = setup();
  const t = await keyFor(env, u);
  await call(env, t, 'set_task_estimate', { projectId: 'gp_1', taskId: 'task_2', estimateHours: 3 });
  assert.equal(versions(env).length, 1, '直接寫入');
  const batch = await call(env, t, 'apply_changes', { ops: [
    { tool: 'update_gantt_task', args: { projectId: 'gp_1', taskId: 'task_2', progress: 20 } },
    { tool: 'update_gantt_task', args: { projectId: 'gp_1', taskId: 'task_2', status: 'doing' } },
  ] });
  assert.equal(batch.isError, false, JSON.stringify(batch.data));
  assert.equal(versions(env).length, 2, 'apply_changes');
  const undo = await call(env, t, 'undo_change', { changeId: batch.data.changeIds[0], batch: true });
  assert.equal(undo.isError, false, JSON.stringify(undo.data));
  assert.equal(versions(env).length, 3, '整批復原');
  // 同意提案
  await handleConnectionSettings(post({ mode: 'review' }), env, u, connIdOf(env, 'u1'));
  const prop = await call(env, t, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_1', progress: 77 });
  assert.equal(prop.data.proposed, true);
  assert.equal(versions(env).length, 3, '提案還沒同意之前什麼都沒寫、也不留版本');
  const ap = await handleApproveProposal(env, u, prop.data.proposalId);
  assert.equal(ap.status, 200);
  assert.equal(versions(env).length, 4, '同意提案');
});

test('版本歷史：R2 寫不進去不讓 agent 的寫入失敗；沒綁 R2 也一樣（安靜略過）', async () => {
  const { env, u } = setup();
  const t = await keyFor(env, u);
  env.BACKUPS.failPut = true;
  const { value: r, logs } = await quietly(() => call(env, t, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_2', progress: 40 }));
  assert.equal(r.isError, false, '寫入成功');
  assert.equal(stateOf(env).ganttProjects[0].tasks[1].progress, 40);
  assert.equal(versions(env).length, 0, '沒留下索引（檔案沒寫成，不留一個指向不存在檔案的索引）');
  assert.ok(logs.some(l => /state version failed/.test(l)), '要出聲');

  const b = setup({}, { noR2: true });
  const t2 = await keyFor(b.env, b.u);
  const r2 = await call(b.env, t2, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_2', progress: 40 });
  assert.equal(r2.isError, false);
  assert.equal(versions(b.env).length, 0);
});

test('版本歷史：只有 Pro 留（到期後停止留新版）；退回用 force 不看方案', async () => {
  const env = makeEnv(); env.BACKUPS = fakeR2();
  const free = freeUser(env, 'f1', 'f@x.test');
  seedState(env, 'f1', baseState(), 1000);
  await casWrite(env, free, s => ({ state: { ...s, extra: 1 } }), { version: { actor: 'x', summary: () => 's' } });
  assert.equal(versions(env, 'f1').length, 0, '免費帳號不留');
  await casWrite(env, free, s => ({ state: { ...s, extra: 2 } }), { version: { actor: 'user', force: true, summary: () => '退回' } });
  assert.equal(versions(env, 'f1').length, 1, 'force 留');
});

test('版本歷史：內容與最新一版相同不重複留；留版本回報 same', async () => {
  const { env } = setup();
  const raw = rawOf(env);
  const a = await takeVersion(env, 'u1', raw, { actor: 'x', summary: 's' });
  const b = await takeVersion(env, 'u1', raw, { actor: 'x', summary: 's' });
  assert.ok(a.id); assert.equal(b.same, true);
  assert.equal(versions(env).length, 1);
  assert.equal(r2Keys(env).length, 1);
});

test('版本歷史：自己的修改（PUT /api/state）最多每小時一版，只有 Pro', async () => {
  const { env, u } = setup();
  const put = async (state, base) => handlePutState(new Request('https://x.test/api/state', { method: 'PUT', body: JSON.stringify({ state, baseUpdatedAt: base }) }), env, u);
  let cur = readState(env, 'u1');
  let r = await unwrap(await put({ ...cur.state, a: 1 }, cur.updatedAt));
  assert.equal(r.status, 200);
  assert.equal(versions(env).length, 1, '第一次寫入留一版');
  assert.equal(versions(env)[0].actor, 'user');
  cur = readState(env, 'u1');
  r = await unwrap(await put({ ...cur.state, a: 2 }, cur.updatedAt));
  assert.equal(versions(env).length, 1, '一小時內不再留');
  env.DB.prepare('UPDATE state_versions SET created_at = created_at - ?').bind(2 * 3600 * 1000).run();
  cur = readState(env, 'u1');
  await put({ ...cur.state, a: 3 }, cur.updatedAt);
  assert.equal(versions(env).length, 2, '過了一小時再留一版');

  const free = freeUser(env, 'f1', 'f@x.test');
  seedState(env, 'f1', baseState(), 1000);
  const fr = readState(env, 'f1');
  await handlePutState(new Request('https://x.test/api/state', { method: 'PUT', body: JSON.stringify({ state: { ...fr.state, a: 1 }, baseUpdatedAt: fr.updatedAt }) }), env, free);
  assert.equal(versions(env, 'f1').length, 0, '免費帳號不留');
});

test('版本歷史：每日 cron——每個 Pro 帳號每天至少一版，同一天不重複，免費帳號略過，並清舊的', async () => {
  const { env } = setup();
  freeUser(env, 'f1', 'f@x.test'); seedState(env, 'f1', baseState(), 1000);
  const NOW = Date.parse('2026-12-01T00:30:00Z');
  const r1 = await snapshotDaily(env, NOW);
  assert.equal(r1.taken, 1); assert.deepEqual(r1.errors, []);
  assert.equal(versions(env).length, 1); assert.equal(versions(env)[0].actor, 'system');
  assert.equal(versions(env, 'f1').length, 0);
  const r2 = await snapshotDaily(env, NOW + 1000);
  assert.equal(r2.taken, 0, '同一天（台北）不重複');
  assert.equal(versions(env).length, 1);
  // R2 出事：errors 要有（step 才不會記成乾淨的成功）
  env.BACKUPS.failPut = true;
  userEdit(env, s => { s.x = 1; });
  const { value: r3 } = await quietly(() => snapshotDaily(env, NOW + 2 * DAY));
  assert.equal(r3.errors.length, 1);
});

test('版本歷史：超過 30 天的清掉（R2 的檔案一起）；每個帳號最多 300 版，最舊的先走；別人的不碰', async () => {
  const { env } = setup();
  proUser(env, 'u2', 'b@x.test'); seedState(env, 'u2', baseState(), 1000);
  const T0 = Date.parse('2026-06-01T00:00:00Z');
  await takeVersion(env, 'u1', JSON.stringify({ n: 'old' }), { actor: 'x', summary: 'old', nowMs: T0 });
  await takeVersion(env, 'u2', JSON.stringify({ n: 'other-old' }), { actor: 'x', summary: 'old', nowMs: T0 });
  assert.equal(versions(env).length, 1);
  // 31 天後的下一次留版本順手清掉過期的
  await takeVersion(env, 'u1', JSON.stringify({ n: 'new' }), { actor: 'x', summary: 'new', nowMs: T0 + VERSION_KEEP_MS + DAY });
  assert.deepEqual(versions(env).map(v => v.summary), ['new']);
  assert.equal(r2Keys(env, 'history/u1/').length, 1, 'R2 的舊檔也刪了');
  assert.equal(versions(env, 'u2').length, 1, '別人的一列不動');
  assert.equal(r2Keys(env, 'history/u2/').length, 1);

  // 上限 300
  const T1 = Date.parse('2026-12-01T00:00:00Z');
  for (let i = 0; i < VERSION_MAX_PER_USER + 5; i++) await takeVersion(env, 'u1', JSON.stringify({ i }), { actor: 'x', summary: 'v' + i, nowMs: T1 + i * 1000 });
  const vs = versions(env);
  assert.equal(vs.length, VERSION_MAX_PER_USER);
  assert.equal(vs[0].summary, 'v5', '最舊的先走');
  assert.equal(vs.at(-1).summary, 'v' + (VERSION_MAX_PER_USER + 4));
  assert.equal(r2Keys(env, 'history/u1/').length, VERSION_MAX_PER_USER, 'R2 與索引一樣多');
  assert.equal(versions(env, 'u2').length, 1);
});

test('版本歷史：R2 刪除失敗時保留那一列，下次再清（不留一個沒人清的檔案）', async () => {
  const { env } = setup();
  const T0 = Date.parse('2026-06-01T00:00:00Z');
  await takeVersion(env, 'u1', '{"a":1}', { actor: 'x', summary: 'old', nowMs: T0 });
  env.BACKUPS.failDelete = true;
  await quietly(() => pruneVersions(env, 'u1', T0 + VERSION_KEEP_MS + DAY));
  assert.equal(versions(env).length, 1, '檔案沒刪成，索引留著');
  env.BACKUPS.failDelete = false;
  assert.equal(await pruneVersions(env, 'u1', T0 + VERSION_KEEP_MS + DAY), 1);
  assert.equal(versions(env).length, 0); assert.equal(r2Keys(env).length, 0);
});

test('版本歷史：比較以「東西」為單位（項目、專案、任務、每日記錄、設定）；鍵的順序不同不算差異', () => {
  const a = baseState();
  const b = JSON.parse(JSON.stringify(a));
  b.items[0].title = '項目乙';
  b.ganttProjects[0].tasks[1].progress = 50;
  b.ganttProjects[0].tasks.push(task('task_3', '新任務'));
  b.ganttProjects[1].name = '改名';
  b.dailyLogs['2026-12-02'] = '<p>新</p>';
  b.customHolidays = ['2026-12-25'];
  delete b.majorProjects[0];
  b.majorProjects = [];
  const d = diffStates(a, b);
  const has = (entity, id, field) => d.rows.find(r => r.entity === entity && r.id === id && r.field === field);
  assert.equal(has('item', 'it_1', 'title').before, '項目甲');
  assert.equal(has('item', 'it_1', 'title').after, '項目乙');
  assert.equal(has('ganttTask', 'gp_1/task_2', 'progress').after, '50');
  assert.ok(has('ganttTask', 'gp_1/task_3', '（新增）'));
  assert.equal(has('ganttProject', 'gp_2', 'name').name, '改名');
  assert.ok(has('dailyLog', '2026-12-02', '內容'));
  assert.ok(has('setting', 'customHolidays', 'customHolidays'));
  assert.ok(has('majorProject', 'mp_1', '（刪除）'));
  // 鍵順序不同、內容相同 → 沒有差異
  const reordered = JSON.parse(JSON.stringify(a));
  reordered.ganttProjects[0].tasks[0] = Object.fromEntries(Object.entries(reordered.ganttProjects[0].tasks[0]).reverse());
  assert.equal(diffStates(a, reordered).rows.length, 0);
});

test('版本歷史：列版本、比較、退回；退回是一次新的寫入——先把現在留成一版，退回再退回回到原樣', async () => {
  const { env, u } = setup();
  const t = await keyFor(env, u);
  const original = rawOf(env);
  await call(env, t, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_2', progress: 55 });   // V1＝original
  const afterAgent = rawOf(env);
  assert.notEqual(afterAgent, original);
  const list = await unwrap(await handleListVersions(env, u));
  assert.equal(list.body.versions.length, 1);
  assert.ok(!('body' in list.body.versions[0]) && !JSON.stringify(list.body).includes(SECRET), '只回索引，不回內容');
  const v1 = list.body.versions[0].id;

  const d = await unwrap(await handleDiffVersion(env, u, v1));
  assert.equal(d.status, 200);
  const row = d.body.rows.find(r => r.field === 'progress');
  assert.equal(row.before, '0'); assert.equal(row.after, '55', 'before＝那一版、after＝現在');

  // 退回到 V1
  const rs = await unwrap(await handleRestoreVersion(env, u, v1));
  assert.equal(rs.status, 200, JSON.stringify(rs.body));
  assert.deepEqual(stateOf(env), JSON.parse(original), '回到那一版');
  const vs = versions(env);
  assert.equal(vs.length, 2, '先把退回之前的現在留成一版');
  assert.equal(env.BACKUPS.store.get(versionKey('u1', vs[1].id)).body, afterAgent);
  // 再退回「退回之前」那一版 → 回到 agent 改完的樣子
  const rs2 = await unwrap(await handleRestoreVersion(env, u, vs[1].id));
  assert.equal(rs2.status, 200);
  assert.deepEqual(stateOf(env), JSON.parse(afterAgent), '退回本身也退得回去');
  assert.equal(versions(env).length, 3);
});

test('版本歷史：退回走樂觀鎖——中間插進別的寫入，重讀重算，那個寫入被留在版本裡不會無聲消失', async () => {
  const { env, u } = setup();
  const t = await keyFor(env, u);
  await call(env, t, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_2', progress: 55 });
  const v1 = versions(env)[0].id;
  const raced = withRaceBeforeFirstUpdate(env, () => userEdit(env, s => { s.dailyLogs['2026-12-09'] = '<p>另一台裝置剛打的</p>'; }));
  const rs = await unwrap(await handleRestoreVersion(raced, u, v1));
  assert.equal(rs.status, 200);
  assert.equal(stateOf(env).ganttProjects[0].tasks[1].progress, 0, '退回生效');
  const bodies = versions(env).map(v => env.BACKUPS.store.get(versionKey('u1', v.id)).body);
  assert.ok(bodies.some(b => b.includes('另一台裝置剛打的')), '競態中寫進去的內容留在某一版裡，可以退回找到');
});

test('版本歷史：別人的版本 id 一律 404（列、比較、退回），且什麼都沒動', async () => {
  const { env, u } = setup();
  const u2 = proUser(env, 'u2', 'b@x.test'); seedState(env, 'u2', baseState({ items: [] }), 2000);
  await takeVersion(env, 'u2', rawOf(env, 'u2'), { actor: 'x', summary: 'B 的版本' });
  const vB = versions(env, 'u2')[0].id;
  const before = rawOf(env, 'u1'), beforeB = rawOf(env, 'u2');
  assert.equal((await handleDiffVersion(env, u, vB)).status, 404);
  assert.equal((await handleRestoreVersion(env, u, vB)).status, 404);
  assert.equal((await unwrap(await handleListVersions(env, u))).body.versions.length, 0, 'A 的清單裡沒有 B 的');
  assert.equal(rawOf(env, 'u1'), before); assert.equal(rawOf(env, 'u2'), beforeB);
  assert.equal(versions(env, 'u1').length, 0);
  assert.ok(u2);
});

test('版本歷史：版本內容不在了（過期被清／R2 出事）回 410 說得出來，不是 500；不要求 Pro', async () => {
  const { env } = setup();
  const free = freeUser(env, 'f1', 'f@x.test'); seedState(env, 'f1', baseState(), 1000);
  await takeVersion(env, 'f1', rawOf(env, 'f1'), { actor: 'x', summary: 's' });
  const id = versions(env, 'f1')[0].id;
  assert.equal((await handleListVersions(env, free)).status, 200, '免費帳號也看得到清單');
  env.BACKUPS.store.clear();
  assert.equal((await handleDiffVersion(env, free, id)).status, 410);
  assert.equal((await handleRestoreVersion(env, free, id)).status, 410);
});

test('版本歷史：刪帳號——索引與 R2 的整個 prefix 都清掉，別人的一個都不動；每日備份不帶它、輪替不碰它', async () => {
  const env = makeEnv(); env.BACKUPS = fakeR2();
  const hash = await hashPassword('correct-horse');
  for (const [id, em] of [['A', 'a@x.test'], ['B', 'b@x.test']]) {
    env.DB.prepare('INSERT INTO users (id, email, password_hash, role, status, created_at, plan_source) VALUES (?, ?, ?, ?, ?, 0, ?)').bind(id, em, hash, 'user', 'approved', 'admin').run();
    seedState(env, id, baseState(), 1);
    for (let i = 0; i < 3; i++) await takeVersion(env, id, JSON.stringify({ id, i }), { actor: 'x', summary: 's' + i, nowMs: 1_000_000 + i });
  }
  // 備份：不帶歷史、也不被歷史影響；輪替只碰 backup/
  const bk = await runBackup(env, Date.parse('2026-12-01T02:00:00Z'));
  const saved = JSON.parse(env.BACKUPS.store.get(bk.key).body);
  assert.ok(!('stateVersions' in saved) && !JSON.stringify(saved).includes('history/'), '備份不含版本歷史');
  assert.equal(r2Keys(env).length, 6, '備份與輪替沒碰 history/');

  const res = await handleDeleteAccount(new Request('https://x.test/api/auth/account', { method: 'DELETE', body: JSON.stringify({ password: 'correct-horse' }) }), env, { id: 'A', email: 'a@x.test' });
  assert.equal(res.status, 200);
  assert.equal(versions(env, 'A').length, 0); assert.equal(r2Keys(env, 'history/A/').length, 0);
  assert.equal(versions(env, 'B').length, 3, 'B 的索引原樣'); assert.equal(r2Keys(env, 'history/B/').length, 3, 'B 的檔案原樣');
});

test('版本歷史：刪帳號時 R2 出事不擋刪帳號（只出聲）；cron 的 history 那一步 errors 非空會被記成失敗', async () => {
  const env = makeEnv(); env.BACKUPS = fakeR2();
  const hash = await hashPassword('pw-123456');
  env.DB.prepare('INSERT INTO users (id, email, password_hash, role, status, created_at, plan_source) VALUES (?, ?, ?, ?, ?, 0, ?)').bind('A', 'a@x.test', hash, 'user', 'approved', 'admin').run();
  seedState(env, 'A', baseState(), 1);
  await takeVersion(env, 'A', '{"a":1}', { actor: 'x', summary: 's' });
  env.BACKUPS.failList = true;
  const { value: res } = await quietly(() => handleDeleteAccount(new Request('https://x.test/x', { method: 'DELETE', body: JSON.stringify({ password: 'pw-123456' }) }), env, { id: 'A', email: 'a@x.test' }));
  assert.equal(res.status, 200);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM users').first().n, 0);

  const e2 = makeEnv(); e2.BACKUPS = fakeR2();
  proUser(e2, 'u1', 'a@x.test'); seedState(e2, 'u1', baseState(), 1);
  e2.BACKUPS.failPut = true;
  await quietly(() => step(e2, 'history', () => snapshotDaily(e2)));
  const run = e2.DB.prepare("SELECT ok FROM cron_runs WHERE step = 'history'").first();
  assert.equal(run.ok, 0);
});

// ============================================================ 2. 權限分級的鑰匙

const MIN_ARGS = { projectId: 'gp_1', taskId: 'task_1', itemId: 'it_1', changeId: 'x', proposalId: 'x', prId: 'x', name: 'n', title: 't', text: 't',
  date: '2026-12-01', done: true, kind: 'progress', body: 'b', url: 'https://github.com/o/r/pull/1', ops: [{ tool: 'create_item', args: { title: 'a', date: '2026-12-01' } }], since: '2026-01-01' };

test('唯讀鑰匙：被擋掉的工具集合剛好等於 WRITE_TOOLS（多擋少擋都不行），資料一個位元都沒動，讀照常', async () => {
  const { env, u } = setup();
  const t = await keyFor(env, u, 'RO', { scope: 'read' });
  const before = rawOf(env);
  const rejected = new Set();
  for (const tool of TOOLS) {
    const args = { ...MIN_ARGS };
    const r = await call(env, t, tool.name, args);
    if (r.isError && /只能讀/.test(r.data?.error || '')) rejected.add(tool.name);
  }
  assert.deepEqual([...rejected].sort(), [...WRITE_TOOLS].sort());
  // 預演也擋（讀取鑰匙不碰任何寫入工具，沒有例外）
  assert.equal((await call(env, t, 'create_item', { title: 'a', date: '2026-12-01', dryRun: true })).isError, true);
  assert.equal(rawOf(env), before, '資料不變');
  assert.equal(versions(env).length, 0);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM mcp_activity').first().n, 0);
  assert.equal((await call(env, t, 'get_overview')).isError, false);
  assert.equal((await call(env, t, 'get_project_brief', { projectId: 'gp_1' })).isError, false);
});

test('權限範圍每一次呼叫都檢查：把鑰匙改成唯讀，下一個呼叫就被擋（不必換 token）', async () => {
  const { env, u } = setup();
  const t = await keyFor(env, u);
  assert.equal((await call(env, t, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_2', progress: 1 })).isError, false);
  env.DB.prepare("UPDATE mcp_tokens SET scope = 'read' WHERE kind = 'key'").run();
  const r = await call(env, t, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_2', progress: 2 });
  assert.equal(r.isError, true); assert.match(r.data.error, /只能讀/);
  assert.equal(stateOf(env).ganttProjects[0].tasks[1].progress, 1);
});

test('既有的鑰匙（沒有 scope／project_id 的舊列，欄位預設值）行為不變：能寫、碰得到所有專案', async () => {
  const { env, u } = setup();
  const token = 'wsk_legacy_' + 'x'.repeat(30);
  env.DB.prepare("INSERT INTO mcp_tokens (id, user_id, kind, token_hash, name, created_at) VALUES ('legacy', 'u1', 'key', ?, '舊金鑰', 0)").bind(await sha256(token)).run();
  env.DB.prepare("INSERT INTO mcp_connections (id, user_id, mode, paused, needs_acceptance, created_at, updated_at) VALUES ('legacy', 'u1', 'direct', 0, 0, 0, 0)").run();
  const auth = await authenticateMcp(new Request('https://x.test/mcp', { headers: { authorization: 'Bearer ' + token } }), env);
  assert.equal(auth.scope, 'write'); assert.equal(auth.projectId, null);
  assert.equal((await call(env, token, 'update_gantt_task', { projectId: 'gp_2', taskId: 'task_9', progress: 5 })).isError, false);
  assert.equal((await call(env, token, 'create_item', { title: '新', date: '2026-12-01' })).isError, false);
});

test('建立金鑰：scope 與 projectId 要驗（不合法的 scope、不存在的專案都 400），合法的存得進去、列表看得到', async () => {
  const { env, u } = setup();
  const bad1 = await unwrap(await handleCreateKey(post({ name: 'x', scope: 'admin' }), env, u));
  assert.equal(bad1.status, 400);
  const bad2 = await unwrap(await handleCreateKey(post({ name: 'x', projectId: 'gp_nope' }), env, u));
  assert.equal(bad2.status, 400);
  const ok = await unwrap(await handleCreateKey(post({ name: '只讀 A', scope: 'read', projectId: 'gp_1' }), env, u));
  assert.equal(ok.status, 200); assert.equal(ok.body.scope, 'read'); assert.equal(ok.body.projectId, 'gp_1');
  const def = await unwrap(await handleCreateKey(post({ name: '預設' }), env, u));
  assert.equal(def.body.scope, 'write'); assert.equal(def.body.projectId, null);
  const list = (await unwrap(await handleListConnections(env, u))).body.connections;
  const a = list.find(c => c.name === '只讀 A');
  assert.equal(a.access, 'read'); assert.equal(a.projectId, 'gp_1');
  assert.equal(list.find(c => c.name === '預設').access, 'write');
  // 金鑰原文不在資料庫
  assert.ok(!JSON.stringify(env.DB.prepare('SELECT * FROM mcp_tokens').all().results).includes(ok.body.token));
});

test('專案範圍的鑰匙：只碰得到那一個專案——別的專案的讀、寫、批次、提案、PR 一律擋，專案清單只剩它', async () => {
  const { env, u } = setup();
  const full = await keyFor(env, u, '全權');
  const t = await keyFor(env, u, '只管 A', { projectId: 'gp_1' });
  const denied = async (name, args) => {
    const r = await call(env, t, name, args);
    assert.equal(r.isError, true, name + ' 應該被擋');
    assert.match(r.data.error, /只能碰指定的那一個專案/, name);
  };
  const before = rawOf(env);
  await denied('get_project_brief', { projectId: 'gp_2' });
  await denied('list_project_events', { projectId: 'gp_2' });
  await denied('add_project_event', { projectId: 'gp_2', kind: 'progress', body: 'x' });
  await denied('add_gantt_task', { projectId: 'gp_2', name: 'x', start: '2026-12-01', end: '2026-12-02' });
  await denied('update_gantt_task', { projectId: 'gp_2', taskId: 'task_9', progress: 9 });
  await denied('update_gantt_task', { projectId: 'gp_2', taskId: 'task_9', progress: 9, dryRun: true });
  await denied('set_task_estimate', { projectId: 'gp_2', taskId: 'task_9', estimateHours: 1 });
  await denied('claim_task', { projectId: 'gp_2', taskId: 'task_9' });
  await denied('upsert_pr', { projectId: 'gp_2', url: 'https://github.com/o/r/pull/1' });
  await denied('list_project_prs', { projectId: 'gp_2' });
  await denied('apply_changes', { ops: [
    { tool: 'update_gantt_task', args: { projectId: 'gp_1', taskId: 'task_2', progress: 1 } },
    { tool: 'update_gantt_task', args: { projectId: 'gp_2', taskId: 'task_9', progress: 1 } } ] });
  await denied('apply_changes', { ops: [{ tool: 'create_item', args: { title: 'a', date: '2026-12-01' } }] });
  await denied('propose_changes', { title: 't', ops: [{ tool: 'update_gantt_task', args: { projectId: 'gp_2', taskId: 'task_9', progress: 1 } }] });
  // 沒有專案概念的工具整個擋
  for (const [name, args] of [['create_item', { title: 'a', date: '2026-12-01' }], ['update_item', { itemId: 'it_1', title: 'b' }],
    ['set_done', { itemId: 'it_1', done: true }], ['delete_item', { itemId: 'it_1' }], ['create_major_project', { name: 'n' }],
    ['create_gantt_project', { name: 'n' }], ['write_daily_log', { text: 't' }], ['list_items', {}],
    ['get_schedule', { from: '2026-12-01', to: '2026-12-10' }], ['list_recent_changes', {}], ['get_changes_since', { since: '2026-01-01' }],
    ['undo_change', { changeId: 'x' }]]) await denied(name, args);
  // 夾帶一個「對的」projectId 也不行：項目類的工具沒有專案概念，不是比 projectId 比得過就放行
  for (const [name, args] of [['create_item', { title: 'a', date: '2026-12-01' }], ['update_item', { itemId: 'it_1', title: 'b' }], ['set_done', { itemId: 'it_1', done: true }],
    ['delete_item', { itemId: 'it_1' }], ['create_gantt_project', { name: 'n' }]]) await denied(name, { ...args, projectId: 'gp_1' });
  assert.equal(rawOf(env), before, '被擋的呼叫一個位元都沒寫');
  // 自己的專案照常
  assert.equal((await call(env, t, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_2', progress: 33 })).isError, false);
  assert.equal((await call(env, t, 'get_project_brief', { projectId: 'gp_1' })).isError, false);
  const ok = await call(env, t, 'apply_changes', { ops: [{ tool: 'update_gantt_task', args: { projectId: 'gp_1', taskId: 'task_2', progress: 34 } }] });
  assert.equal(ok.isError, false, JSON.stringify(ok.data));
  // 清單只剩它
  const ov = await call(env, t, 'get_overview');
  assert.deepEqual(ov.data.ganttProjects.map(g => g.id), ['gp_1']); assert.deepEqual(ov.data.majorProjects, []); assert.equal(ov.data.itemCount, 0);
  const lg = await call(env, t, 'list_gantt_projects');
  assert.deepEqual(lg.data.projects.map(g => g.id), ['gp_1']);
  assert.ok(!JSON.stringify(ov.data).includes('機密') && !JSON.stringify(lg.data).includes('機密'));
  // 全權的鑰匙看得到兩個（對照：過濾是鑰匙的範圍造成的）
  assert.equal((await call(env, full, 'get_overview')).data.ganttProjects.length, 2);
});

test('專案範圍的鑰匙：unlink_pr 只能解除自己專案的 PR；別專案的 PR 擋掉、不存在的走原本的「找不到」', async () => {
  const { env, u } = setup();
  const full = await keyFor(env, u, '全權');
  const t = await keyFor(env, u, '只管 A', { projectId: 'gp_1' });
  const p1 = await call(env, full, 'upsert_pr', { projectId: 'gp_1', url: 'https://github.com/o/r/pull/1' });
  const p2 = await call(env, full, 'upsert_pr', { projectId: 'gp_2', url: 'https://github.com/o/r/pull/2' });
  const id1 = p1.data.pr?.id || p1.data.prId || env.DB.prepare("SELECT id FROM project_prs WHERE number = 1").first().id;
  const id2 = env.DB.prepare("SELECT id FROM project_prs WHERE number = 2").first().id;
  assert.ok(p2);
  const bad = await call(env, t, 'unlink_pr', { prId: id2 });
  assert.equal(bad.isError, true); assert.match(bad.data.error, /只能碰指定的那一個專案/);
  assert.equal(env.DB.prepare("SELECT COUNT(*) AS n FROM project_prs WHERE number = 2").first().n, 1);
  assert.equal((await call(env, t, 'unlink_pr', { prId: id1 })).isError, false);
  assert.equal(env.DB.prepare("SELECT COUNT(*) AS n FROM project_prs WHERE number = 1").first().n, 0);
  const none = await call(env, t, 'unlink_pr', { prId: 'nope' });
  assert.doesNotMatch(none.data?.error || '', /只能碰指定/);
});

async function pkce() {
  const verifier = 'v'.repeat(20) + crypto.randomUUID().replace(/-/g, '');
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: btoa(String.fromCharCode(...d)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') };
}
test('OAuth：授權時選的唯讀／專案範圍會帶進 access 與 refresh（換新一組之後仍在）；不合法的範圍 400；沒選就是原本的樣子', async () => {
  const { env, u } = setup();
  const client = (await unwrap(await handleRegister(new Request('https://x.test/oauth/register', {
    method: 'POST', body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] }) }), env))).body;
  const decide = async (extra, ch) => unwrap(await handleAuthorizeDecision(post({ approve: true, client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_challenge: ch, state: 's', ...extra }), env, u));
  const exchange = async (code, verifier) => {
    const res = await handleToken(new Request('https://x.test/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: client.redirect_uris[0] }).toString() }), env);
    return res.json();
  };
  const bad = await decide({ access: 'root' }, (await pkce()).challenge);
  assert.equal(bad.status, 400);
  assert.equal((await decide({ projectId: 'gp_nope' }, (await pkce()).challenge)).status, 400);

  const { verifier, challenge } = await pkce();
  const ok = await decide({ access: 'read', projectId: 'gp_1' }, challenge);
  const code = new URL(ok.body.redirect).searchParams.get('code');
  const tk = await exchange(code, verifier);
  const a1 = await authenticateMcp(new Request('https://x.test/mcp', { headers: { authorization: 'Bearer ' + tk.access_token } }), env);
  assert.equal(a1.scope, 'read'); assert.equal(a1.projectId, 'gp_1');
  assert.equal((await call(env, tk.access_token, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_2', progress: 5 })).isError, true);
  const rt = await (await handleToken(new Request('https://x.test/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tk.refresh_token }).toString() }), env)).json();
  const a2 = await authenticateMcp(new Request('https://x.test/mcp', { headers: { authorization: 'Bearer ' + rt.access_token } }), env);
  assert.equal(a2.scope, 'read'); assert.equal(a2.projectId, 'gp_1');
  // 沒選＝原本的樣子
  const p2 = await pkce();
  const plain = await decide({}, p2.challenge);
  const tk2 = await exchange(new URL(plain.body.redirect).searchParams.get('code'), p2.verifier);
  const a3 = await authenticateMcp(new Request('https://x.test/mcp', { headers: { authorization: 'Bearer ' + tk2.access_token } }), env);
  assert.equal(a3.scope, 'write'); assert.equal(a3.projectId, null);
});

// ============================================================ 3. 風險

test('風險：agent 開、get_project_brief 列出還開著的、agent 用 closesEventId 關閉並留結案說明；已關的不再列', async () => {
  const { env, u } = setup();
  const t = await keyFor(env, u, 'Claude');
  const open = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'risk', body: '供應商可能延遲' });
  assert.equal(open.isError, false, JSON.stringify(open.data));
  let brief = await call(env, t, 'get_project_brief', { projectId: 'gp_1' });
  assert.equal(brief.data.openRisks.length, 1);
  assert.equal(brief.data.openRisks[0].untrusted_text, '供應商可能延遲', '外部文字放在 untrusted_text 底下');
  assert.equal(brief.data.openRisks[0].status, 'open');
  const close = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'risk', body: '已改用備用供應商', closesEventId: open.data.eventId });
  assert.equal(close.isError, false, JSON.stringify(close.data));
  assert.equal(close.data.closedRiskId, open.data.eventId);
  brief = await call(env, t, 'get_project_brief', { projectId: 'gp_1' });
  assert.equal(brief.data.openRisks.length, 0);
  const rows = env.DB.prepare("SELECT status, ref_id, body FROM project_events WHERE kind = 'risk' ORDER BY created_at, rowid").all().results;
  assert.deepEqual(rows.map(r => r.status), ['closed', 'closed']);
  assert.equal(rows[1].ref_id, open.data.eventId); assert.equal(rows[1].body, '已改用備用供應商');
  // 再關一次、關不是 risk 的、closesEventId 搭配別的 kind
  assert.equal((await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'risk', body: 'x', closesEventId: open.data.eventId })).isError, true);
  const prog = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'progress', body: '進展' });
  assert.equal((await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'risk', body: 'x', closesEventId: prog.data.eventId })).isError, true);
  assert.equal((await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'progress', body: 'x', closesEventId: open.data.eventId })).isError, true);
});

test('風險：不能關別的專案的、別的帳號的；每日上限寫不進結案說明時把風險還原成開著', async () => {
  const { env, u } = setup();
  const u2 = proUser(env, 'u2', 'b@x.test'); seedState(env, 'u2', baseState(), 1);
  const t = await keyFor(env, u, 'Claude'); const t2 = await keyFor(env, u2, 'Other');
  const r1 = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'risk', body: 'A 的風險' });
  const other = await call(env, t, 'add_project_event', { projectId: 'gp_2', kind: 'risk', body: 'gp_2 的風險' });
  assert.equal((await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'risk', body: 'x', closesEventId: other.data.eventId })).isError, true, '別的專案');
  const x = await call(env, t2, 'add_project_event', { projectId: 'gp_1', kind: 'risk', body: 'x', closesEventId: r1.data.eventId });
  assert.equal(x.isError, true, '別的帳號'); assert.match(x.data.error, /找不到/);
  assert.equal(env.DB.prepare("SELECT status FROM project_events WHERE id = ?").bind(r1.data.eventId).first().status, 'open');
  // 上限
  const dayStart = Date.parse(new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10) + 'T00:00:00+08:00');
  for (let i = 0; i < 200; i++) env.DB.prepare("INSERT INTO project_events (id, user_id, project_id, kind, actor, body, created_at) VALUES (?, 'u1', 'gp_1', 'progress', 'Claude', 'x', ?)").bind('f' + i, dayStart + 1000 + i).run();
  const capped = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'risk', body: '結案', closesEventId: r1.data.eventId });
  assert.equal(capped.isError, true);
  assert.equal(env.DB.prepare("SELECT status FROM project_events WHERE id = ?").bind(r1.data.eventId).first().status, 'open', '還原成開著');
});

test('風險：擁有者也能關（寫一筆結案說明）；別人的風險 404；已關的 409；暫停的連線 agent 不能關', async () => {
  const { env, u } = setup();
  const u2 = proUser(env, 'u2', 'b@x.test'); seedState(env, 'u2', baseState(), 1);
  const t = await keyFor(env, u, 'Claude');
  const r = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'risk', body: '風險' });
  assert.equal((await handleCloseRisk(env, u2, r.data.eventId)).status, 404);
  assert.equal(env.DB.prepare("SELECT status FROM project_events WHERE id = ?").bind(r.data.eventId).first().status, 'open');
  assert.equal((await handleCloseRisk(env, u, r.data.eventId)).status, 200);
  assert.equal((await handleCloseRisk(env, u, r.data.eventId)).status, 409);
  assert.equal(env.DB.prepare("SELECT COUNT(*) AS n FROM project_events WHERE actor = 'user' AND kind = 'risk' AND status = 'closed'").first().n, 1);
  const r2 = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'risk', body: '風險二' });
  await handleConnectionSettings(post({ paused: true }), env, u, connIdOf(env, 'u1'));
  assert.equal((await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'risk', body: 'x', closesEventId: r2.data.eventId })).isError, true);
});

test('風險：擁有者關閉時可附一句說明（去頭尾空白、純文字、≤500 字）；沒給就維持原句；太長 400 且不動', async () => {
  const { env, u } = setup();
  const t = await keyFor(env, u, 'Claude');
  const closing = id => env.DB.prepare("SELECT body FROM project_events WHERE actor = 'user' AND kind = 'risk' AND status = 'closed' AND ref_id = ?").bind(id).first();
  const r1 = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'risk', body: '風險一' });
  assert.equal((await handleCloseRisk(env, u, r1.data.eventId, post({ note: '  已經請廠商補件了\n  ' }))).status, 200);
  assert.equal(closing(r1.data.eventId).body, '已經請廠商補件了');
  const r2 = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'risk', body: '風險二' });
  assert.equal((await handleCloseRisk(env, u, r2.data.eventId, post({}))).status, 200);
  assert.equal(closing(r2.data.eventId).body, '擁有者關閉了這個風險', '沒給 note');
  const r3 = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'risk', body: '風險三' });
  assert.equal((await handleCloseRisk(env, u, r3.data.eventId, post({ note: '   ' }))).status, 200);
  assert.equal(closing(r3.data.eventId).body, '擁有者關閉了這個風險', '全是空白當作沒給');
  const r4 = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'risk', body: '風險四' });
  assert.equal((await handleCloseRisk(env, u, r4.data.eventId, post({ note: 'x'.repeat(501) }))).status, 400);
  assert.equal(env.DB.prepare("SELECT status FROM project_events WHERE id = ?").bind(r4.data.eventId).first().status, 'open', '太長不動任何東西');
  assert.equal((await handleCloseRisk(env, u, r4.data.eventId, post({ note: 'x'.repeat(500) }))).status, 200, '剛好 500 可以');
  // 說明是純文字：原樣存（前端 textContent），不被解讀
  const r5 = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'risk', body: '風險五' });
  await handleCloseRisk(env, u, r5.data.eventId, post({ note: '<img src=x onerror=alert(1)>' }));
  assert.equal(closing(r5.data.eventId).body, '<img src=x onerror=alert(1)>');
});

// ============================================================ 4. 唯讀分享連結

function addEvent(env, over) {
  const e = { id: crypto.randomUUID(), user_id: 'u1', project_id: 'gp_1', task_id: null, kind: 'progress', actor: 'Claude', body: '內文', ref_id: null, status: null, redacted_at: null, created_at: Date.now(), ...over };
  env.DB.prepare('INSERT INTO project_events (id, user_id, project_id, task_id, kind, actor, body, ref_id, status, redacted_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind(e.id, e.user_id, e.project_id, e.task_id, e.kind, e.actor, e.body, e.ref_id, e.status, e.redacted_at, e.created_at).run();
  return e.id;
}
async function createShare(env, u, pid = 'gp_1', include) {
  const r = await unwrap(await handleShareCreate(post(include ? { include } : {}), env, u, pid));
  return r;
}
const pub = async (env, token) => { const r = await handlePublicProject(env, token); return { status: r.status, text: await r.text(), headers: r.headers }; };

function richState() {
  const s = baseState();
  s.ganttProjects[0].milestones = [{ id: 'ms_1', name: '上線', date: '2026-12-15' }];
  s.ganttProjects[0].tasks[0].forecastEnd = '2026-12-25';   // 把關里程碑的任務預測比里程碑日晚 → 有風險
  return s;
}
function seedLeaky(env) {
  addEvent(env, { kind: 'progress', body: `進展 ${SECRET}` });
  addEvent(env, { kind: 'handoff', body: `交接 ${SECRET}` });
  addEvent(env, { kind: 'question', body: `提問 ${SECRET}`, status: 'open' });
  addEvent(env, { kind: 'decision', body: `決策 ${SECRET}` });
  addEvent(env, { kind: 'risk', body: `風險 ${SECRET}`, status: 'open' });
  env.DB.prepare("INSERT INTO project_prs (id, user_id, project_id, repo, number, title, state, checks, review, author, url, source, updated_at) VALUES ('pr1','u1','gp_1','o/r',1,?,'open','passing','none',?,'https://github.com/o/r/pull/1','agent',1)")
    .bind(`PR標題 ${SECRET}`, `作者 ${SECRET}`).run();
}

test('分享連結：token 只回一次、資料庫只有雜湊；狀態端點回得出「有沒有」但回不出 token', async () => {
  const { env, u } = setup();
  const r = await createShare(env, u);
  assert.equal(r.status, 200);
  assert.match(r.body.url, /\/p\/[A-Za-z0-9_-]{20,}$/);
  assert.ok(r.body.url.endsWith(r.body.token));
  assert.ok(!JSON.stringify(env.DB.prepare('SELECT * FROM project_shares').all().results).includes(r.body.token), '資料庫裡沒有原文');
  assert.equal(env.DB.prepare('SELECT token_hash FROM project_shares').first().token_hash, await sha256(r.body.token));
  const st = await unwrap(await handleShareStatus(env, u, 'gp_1'));
  assert.equal(st.body.active.id, r.body.id); assert.ok(!JSON.stringify(st.body).includes(r.body.token));
  assert.equal((await unwrap(await handleShareStatus(env, u, 'gp_2'))).body.active, null);
});

test('分享連結：預設內容只有專案名、里程碑（含有沒有風險）、任務的名稱／起訖／狀態／進度／預測——日誌、說明書、其他專案、每日記錄一個字都沒有', async () => {
  const { env, u } = setup(); seedLeaky(env);
  userEdit(env, () => {});
  env.DB.prepare('UPDATE user_state SET state = ?').bind(JSON.stringify(richState())).run();
  const { body } = await createShare(env, u);
  const r = await pub(env, body.token);
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(SECRET), '機敏字串（日誌、說明書、筆記、認領、卡住的原因、連結、每日記錄、PR）一個都不在預設內容裡');
  assert.ok(!r.text.includes('機密') && !r.text.includes('別人的任務'), '其他專案不在');
  const j = JSON.parse(r.text);
  assert.deepEqual(Object.keys(j).sort(), ['includes', 'milestones', 'project', 'tasks', 'today']);
  assert.equal(j.project.name, '新廠');
  assert.deepEqual(Object.keys(j.tasks[0]).sort(), ['done', 'end', 'forecastEnd', 'name', 'progress', 'start', 'status']);
  assert.equal(j.milestones[0].atRisk, true, '預測超過里程碑日');
  assert.equal(j.tasks[0].forecastEnd, '2026-12-25');
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
});

test('分享連結：勾選才多帶——events 只有進展與交接、risks 只有還開著的、prs 帶標題但不帶作者；被遮蔽的永遠不出現', async () => {
  const { env, u } = setup(); seedLeaky(env);
  const red = addEvent(env, { kind: 'progress', body: '被遮蔽之前的內文-REDACTED-X' });
  assert.equal((await handleRedactEvent(env, u, red)).status, 200);
  addEvent(env, { kind: 'risk', body: '已關的風險-CLOSED-X', status: 'closed' });
  const redRisk = addEvent(env, { kind: 'risk', body: '被遮蔽的風險-REDACTED-R', status: 'open' });
  await handleRedactEvent(env, u, redRisk);

  const a = await createShare(env, u, 'gp_1', ['events']);
  const ja = JSON.parse((await pub(env, a.body.token)).text);
  assert.deepEqual(ja.events.map(e => e.kind).sort(), ['handoff', 'progress']);
  assert.ok(!('risks' in ja) && !('prs' in ja));
  const txtA = JSON.stringify(ja);
  assert.ok(!txtA.includes('提問') && !txtA.includes('決策') && !txtA.includes('風險'), '沒勾的種類不出現');
  assert.ok(!txtA.includes('REDACTED'), '被遮蔽的不出現');

  const b = await createShare(env, u, 'gp_1', ['events', 'questions', 'decisions', 'risks', 'prs']);
  const tb = (await pub(env, b.body.token)).text;
  const jb = JSON.parse(tb);
  assert.deepEqual([...new Set(jb.events.map(e => e.kind))].sort(), ['decision', 'handoff', 'progress', 'question']);
  assert.deepEqual(jb.risks.map(r => r.text), [`風險 ${SECRET}`], '只有還開著、沒被遮蔽的');
  assert.equal(jb.prs[0].title, `PR標題 ${SECRET}`); assert.ok(!('author' in jb.prs[0]));
  assert.ok(!tb.includes('REDACTED') && !tb.includes('CLOSED-X') && !tb.includes(`作者 ${SECRET}`));
  assert.ok(!tb.includes('說明書') && !tb.includes('每日記錄') && !tb.includes('別人的任務'));
});

test('分享連結：重新產生撤銷舊的；撤銷後 404；不存在的 token 404；include 不合法 400；冪等', async () => {
  const { env, u } = setup();
  const a = await createShare(env, u);
  const b = await createShare(env, u);
  assert.equal((await pub(env, a.body.token)).status, 404, '舊的失效');
  assert.equal((await pub(env, b.body.token)).status, 200);
  assert.equal(env.DB.prepare("SELECT COUNT(*) AS n FROM project_shares WHERE revoked_at IS NULL").first().n, 1, '同一個專案同時只有一個有效連結');
  assert.equal((await pub(env, 'x'.repeat(30))).status, 404);
  assert.equal((await createShare(env, u, 'gp_1', ['everything'])).status, 400);
  assert.equal((await createShare(env, u, 'gp_nope')).status, 404);
  const rv = await unwrap(await handleShareRevoke(env, u, 'gp_1'));
  assert.equal(rv.body.revoked, 1);
  assert.equal((await pub(env, b.body.token)).status, 404);
  assert.equal((await unwrap(await handleShareRevoke(env, u, 'gp_1'))).body.ok, true);
});

test('分享連結：專案被刪了／資料不見了回 404，不是 500', async () => {
  const { env, u } = setup();
  const a = await createShare(env, u);
  userEdit(env, s => { s.ganttProjects = s.ganttProjects.filter(g => g.id !== 'gp_1'); });
  assert.equal((await pub(env, a.body.token)).status, 404);
  env.DB.prepare('DELETE FROM user_state').run();
  assert.equal((await pub(env, a.body.token)).status, 404);
  env.DB.prepare("INSERT INTO user_state (user_id, state, updated_at, created_at) VALUES ('u1', 'not json', 1, 1)").run();
  assert.equal((await pub(env, a.body.token)).status, 404, '壞掉的資料也不是 500');
});

test('分享連結：跨帳號——別人建不了我的專案的連結、看不到、撤不掉；兩個帳號各自的連結只看到各自的專案；刪帳號一起清', async () => {
  const { env, u } = setup();
  const u2 = proUser(env, 'u2', 'b@x.test'); seedState(env, 'u2', baseState(), 2000);
  const a = await createShare(env, u, 'gp_1');
  // u2 的 state 也有 gp_1（同一個 id）：不同帳號、各自的資料
  userEdit(env, s => { s.ganttProjects[0].name = 'B 的新廠'; }, 'u2');
  const b = await createShare(env, u2, 'gp_1');
  assert.equal(JSON.parse((await pub(env, a.body.token)).text).project.name, '新廠');
  assert.equal(JSON.parse((await pub(env, b.body.token)).text).project.name, 'B 的新廠');
  assert.equal((await unwrap(await handleShareRevoke(env, u2, 'gp_1'))).body.revoked, 1, 'u2 只撤得到自己的');
  assert.equal((await pub(env, a.body.token)).status, 200, 'A 的連結沒被動');
  const hash = await hashPassword('correct-horse');
  env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, 'u1').run();
  await handleDeleteAccount(new Request('https://x.test/x', { method: 'DELETE', body: JSON.stringify({ password: 'correct-horse' }) }), env, u);
  assert.equal((await pub(env, a.body.token)).status, 404);
  assert.equal(env.DB.prepare("SELECT COUNT(*) AS n FROM project_shares WHERE user_id = 'u2'").first().n, 1);
});

// ============================================================ 5. 每週摘要

const MON = Date.parse('2026-11-23T02:00:00Z');   // 台北星期一 10:00
const WEEK = '2026-11-23';
const MAIL_ENV = { AGENTMAIL_API_KEY: 'am_test_key', AGENTMAIL_INBOX_ID: 'shared@agentmail.test', APP_URL: 'https://app.test' };
async function withMail(opts, fn) {
  const real = globalThis.fetch; const mails = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('agentmail.to')) throw new Error('unexpected fetch ' + url);
    mails.push({ body: JSON.parse(init.body), url: String(url) });
    const st = typeof opts.status === 'function' ? opts.status(mails.length) : (opts.status ?? 200);
    return new Response(st === 200 ? '{"ok":true}' : '{"error":"x"}', { status: st });
  };
  try { return await fn(mails); } finally { globalThis.fetch = real; }
}
function weeklySetup(feed = {}, stateOver = {}) {
  const env = Object.assign(makeEnv(), MAIL_ENV); env.BACKUPS = fakeR2();
  const u = proUser(env, 'u1', 'a@x.test');
  const s = baseState(); s.ganttProjects[0].tasks[0].end = '2026-11-01';   // 逾期
  seedState(env, 'u1', { ...s, ...stateOver }, 1000);
  const f = { weekly_mail: 1, leave_days: '[]', ...feed };
  env.DB.prepare('INSERT INTO reminder_feed (user_id, enabled, digest, leave_days, weekly_mail, updated_at) VALUES (?, 1, ?, ?, ?, 1)').bind('u1', '[]', f.leave_days, f.weekly_mail).run();
  return { env, u };
}
const feedOf = env => env.DB.prepare('SELECT * FROM reminder_feed WHERE user_id = ?').bind('u1').first();

test('每週摘要：有事就寄一封（訂閱信、帶退訂連結與 List-Unsubscribe）；信裡只有專案名與數字，沒有任何日誌文字；寫進 mail_log', async () => {
  const { env } = weeklySetup();
  addEvent(env, { kind: 'question', body: `提問全文 ${SECRET}`, status: 'open' });
  addEvent(env, { kind: 'risk', body: `風險全文 ${SECRET}`, status: 'open' });
  addEvent(env, { kind: 'progress', body: `進展全文 ${SECRET}` });
  await withMail({}, async mails => {
    const r = await sendWeeklyDigest(env, MON);
    assert.equal(r.sent, 1, JSON.stringify(r)); assert.deepEqual(r.errors, []);
    assert.equal(mails.length, 1);
    const m = mails[0].body;
    assert.match(m.subject, /每週摘要/);
    assert.ok(m.text.includes('新廠') && m.html.includes('新廠'));
    assert.match(m.text, /逾期 1 件/); assert.match(m.text, /等你回覆 1 題/); assert.match(m.text, /風險 1 個/);
    assert.ok(!m.text.includes(SECRET) && !m.html.includes(SECRET) && !m.subject.includes(SECRET), '信裡沒有任何日誌全文');
    assert.ok(!m.text.includes('另一個專案-機密'), '沒有事的專案不列');
    assert.ok(m.headers['List-Unsubscribe'] && m.headers['List-Unsubscribe-Post'], '訂閱信帶一鍵退訂標頭');
    assert.match(m.headers['List-Unsubscribe'], /k=weekly/);
    assert.match(m.text, /unsub\?t=.*&k=weekly/);
    assert.equal(mails[0].url.includes('shared%40agentmail.test'), true, '走訂閱信的寄件帳號（不是交易信的）');
  });
  assert.equal(feedOf(env).weekly_mail_week, WEEK);
  const log = env.DB.prepare("SELECT kind, ok FROM mail_log").all().results.map(r => ({ ...r }));
  assert.deepEqual(log, [{ kind: 'weekly', ok: 1 }]);
});

test('每週摘要：一週只寄一封；下一週再寄；星期四以後不寄（不補一封過期的週報）', async () => {
  const { env } = weeklySetup();
  await withMail({}, async mails => {
    assert.equal((await sendWeeklyDigest(env, MON)).sent, 1);
    const again = await sendWeeklyDigest(env, MON + 2 * 3600e3);
    assert.equal(again.sent, 0); assert.equal(again.alreadySent, 1);
    assert.equal((await sendWeeklyDigest(env, MON + DAY)).alreadySent, 1, '星期二也不重寄');
    assert.equal(mails.length, 1);
    const next = await sendWeeklyDigest(env, MON + 7 * DAY);
    assert.equal(next.sent, 1); assert.equal(feedOf(env).weekly_mail_week, '2026-11-30');
  });
  const e2 = weeklySetup();
  await withMail({}, async mails => {
    const thu = await sendWeeklyDigest(e2.env, MON + 3 * DAY);
    assert.equal(thu.notSendDay, true); assert.equal(mails.length, 0);
    assert.equal(feedOf(e2.env).weekly_mail_week, null);
  });
  assert.equal(weekKeyOf('2026-11-29'), '2026-11-23', '星期日屬於前一個星期一的那一週');
  assert.equal(weekKeyOf('2026-11-23'), '2026-11-23');
});

test('每週摘要：沒事不寄、不記成送過；開關關著不看；沒核准的帳號略過', async () => {
  const quiet = weeklySetup({}, { ganttProjects: [{ id: 'gp_1', name: '安靜', notes: '', brief: '', milestones: [], tasks: [task('t1', '未來', { start: '2027-01-01', end: '2027-02-01' })] }] });
  await withMail({}, async mails => {
    const r = await sendWeeklyDigest(quiet.env, MON);
    assert.equal(r.nothingToSay, 1); assert.equal(r.sent, 0); assert.equal(mails.length, 0);
    assert.equal(feedOf(quiet.env).weekly_mail_week, null, '沒寄不算寄過');
  });
  const off = weeklySetup({ weekly_mail: 0 });
  await withMail({}, async mails => { const r = await sendWeeklyDigest(off.env, MON); assert.equal(r.checked, 0); assert.equal(mails.length, 0); });
  const pend = weeklySetup();
  pend.env.DB.prepare("UPDATE users SET status = 'pending'").run();
  await withMail({}, async mails => { const r = await sendWeeklyDigest(pend.env, MON); assert.equal(r.notApproved, 1); assert.equal(mails.length, 0); });
});

test('每週摘要：休假那天不寄、也不記成送過；隔天（星期二）補寄', async () => {
  const { env } = weeklySetup({ leave_days: JSON.stringify(['2026-11-23']) });
  await withMail({}, async mails => {
    const r = await sendWeeklyDigest(env, MON);
    assert.equal(r.onLeave, 1); assert.equal(mails.length, 0);
    assert.equal(feedOf(env).weekly_mail_week, null);
    const tue = await sendWeeklyDigest(env, MON + DAY);
    assert.equal(tue.sent, 1); assert.equal(feedOf(env).weekly_mail_week, WEEK);
  });
});

test('每週摘要：寄失敗不記成送過（errors 非空，step 記成失敗），隔天補寄成功', async () => {
  const { env } = weeklySetup();
  await quietly(async () => {
    await withMail({ status: 403 }, async () => {
      const r = await sendWeeklyDigest(env, MON);
      assert.equal(r.failed, 1); assert.equal(r.errors.length, 1); assert.equal(r.sent, 0);
      assert.equal(feedOf(env).weekly_mail_week, null, '沒送成功就不算送過');
      await step(env, 'weekly', () => sendWeeklyDigest(env, MON));
      assert.equal(env.DB.prepare("SELECT ok FROM cron_runs WHERE step = 'weekly'").first().ok, 0);
    });
  });
  await withMail({}, async mails => {
    assert.equal((await sendWeeklyDigest(env, MON + DAY)).sent, 1); assert.equal(mails.length, 1);
  });
  assert.equal(env.DB.prepare("SELECT ok FROM mail_log ORDER BY created_at DESC, rowid DESC").first().ok, 1);
});

test('每週摘要：「這週完成」取自最近 7 天內最早的一版歷史；沒有歷史就不列這個數字（不寫 0）', async () => {
  const { env } = weeklySetup();
  // 一版歷史：task_2 當時還沒完成；現在把它完成
  const old = JSON.parse(rawOf(env));
  await takeVersion(env, 'u1', JSON.stringify(old), { actor: 'x', summary: 'v', nowMs: MON - 3 * DAY });
  userEdit(env, s => { s.ganttProjects[0].tasks[1].done = true; s.ganttProjects[0].tasks[1].progress = 100; });
  await withMail({}, async mails => {
    await sendWeeklyDigest(env, MON);
    assert.match(mails[0].body.text, /完成 1 件/);
  });
  const noHist = weeklySetup();
  userEdit(noHist.env, s => { s.ganttProjects[0].tasks[1].done = true; s.ganttProjects[0].tasks[1].progress = 100; });
  await withMail({}, async mails => {
    await sendWeeklyDigest(noHist.env, MON);
    assert.doesNotMatch(mails[0].body.text, /完成 \d+ 件/, '沒有可比對的歷史就不講');
    assert.match(mails[0].body.text, /逾期 1 件/);
  });
  const p = digestProjects(JSON.parse(rawOf(env)), null, new Map(), '2026-11-23');
  assert.equal(p[0].done, null);
});

test('每週摘要退訂：kind=weekly 只關 weekly_mail；其他每一種 kind 不碰 weekly_mail（兩個方向都不連坐），一鍵退訂同一支', async () => {
  const cols = ['enabled', 'streak_mail', 'agent_notify', 'weekly_mail', 'push_overdue'];
  const snap = env => ({ ...env.DB.prepare(`SELECT ${cols.join(', ')} FROM reminder_feed WHERE user_id = 'u1'`).first() });
  const mk = () => {
    const { env } = weeklySetup();
    env.DB.prepare("UPDATE reminder_feed SET unsub_token = ?, agent_notify = 1, streak_mail = 1 WHERE user_id = 'u1'").bind('tok-' + 'a'.repeat(30)).run();
    return env;
  };
  assert.equal(UNSUB_KINDS.weekly, 'weekly_mail');
  const env = mk();
  assert.deepEqual((await applyUnsubscribe(env, 'tok-' + 'a'.repeat(30), 'weekly')).ok, true);
  assert.deepEqual(snap(env), { enabled: 1, streak_mail: 1, agent_notify: 1, weekly_mail: 0, push_overdue: 1 }, '只有 weekly_mail 被關');
  for (const kind of ['reminder', 'streak', 'agent']) {
    const e = mk();
    await applyUnsubscribe(e, 'tok-' + 'a'.repeat(30), kind);
    assert.equal(snap(e).weekly_mail, 1, `退訂 ${kind} 不關每週摘要`);
  }
  const e3 = mk();
  const res = await handleUnsubscribeOneClick(new URL('https://x.test/api/unsub/one-click?t=tok-' + 'a'.repeat(30) + '&k=weekly'), e3);
  assert.equal(res.status, 200); assert.equal(snap(e3).weekly_mail, 0); assert.equal(snap(e3).agent_notify, 1);
  assert.equal((await applyUnsubscribe(e3, 'tok-' + 'z'.repeat(30), 'weekly')).status, 404, '改到 0 列回 404 不是 ok');
});

test('/api/reminder：weeklyMail 預設關、POST 帶了才改、沒帶沿用；其他開關的送出不會順手改它；「全部都不要了」的 body 會關掉它', async () => {
  const env = makeEnv(); const u = proUser(env, 'u1', 'a@x.test');
  const get = async () => (await unwrap(await handleReminderStatus(env, u))).body;
  assert.equal((await get()).weeklyMail, false, '沒有那一列也是關');
  await handleReminderEnable(post({ enabled: true, weeklyMail: true }), env, u);
  assert.equal((await get()).weeklyMail, true);
  await handleReminderEnable(post({ enabled: true, agentNotify: false, streakMail: false }), env, u);
  const s = await get();
  assert.equal(s.weeklyMail, true, '沒帶就沿用'); assert.equal(s.agentNotify, false);
  await handleReminderEnable(post({ enabled: true, weeklyMail: false }), env, u);
  const s2 = await get();
  assert.equal(s2.weeklyMail, false); assert.equal(s2.agentNotify, false, '關每週摘要不連坐別的（這顆本來就是關的，改成再開一次驗另一個方向）');
  await handleReminderEnable(post({ enabled: true, agentNotify: true }), env, u);
  assert.equal((await get()).weeklyMail, false, '開別的不會順手開它');
  await handleReminderEnable(post({ weeklyMail: true }), env, u);
  await handleReminderEnable(post({ enabled: false, leadDays: 3, streakMail: false, pushOverdue: false, pushStreak: false, pushToday: false, agentNotify: false, weeklyMail: false }), env, u);
  assert.equal((await get()).weeklyMail, false, '全部都不要了');
});

// ============================================================ 6. 成績單

test('成績單：每條連線只有數字——改了幾筆、被復原幾筆、完成幾件（被復原的不算）、預估 vs 實際；沒有任何文字；別的帳號與連線互不相干', async () => {
  const { env, u } = setup();
  const u2 = proUser(env, 'u2', 'b@x.test'); seedState(env, 'u2', baseState(), 1);
  const a = await keyFor(env, u, 'Alpha'); const b = await keyFor(env, u, 'Beta'); const other = await keyFor(env, u2, 'Alpha');
  // Alpha：預估＋實際、完成兩個任務，其中一個被復原
  await call(env, a, 'set_task_estimate', { projectId: 'gp_1', taskId: 'task_1', estimateHours: 4, actualHours: 6 });
  await call(env, a, 'set_task_estimate', { projectId: 'gp_1', taskId: 'task_2', estimateHours: 10 });   // 沒有實際：不進比較
  const d1 = await call(env, a, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_1', done: true });
  const d2 = await call(env, a, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_2', done: true });
  assert.equal(d1.isError, false, JSON.stringify(d1.data));
  await call(env, a, 'undo_change', { changeId: d2.data.changeId });
  // Beta：只改了一次、沒完成任何東西
  await call(env, b, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_1', progress: 50 });
  await call(env, other, 'update_gantt_task', { projectId: 'gp_1', taskId: 'task_2', done: true });
  const res = await unwrap(await handleAgentScorecard(env, u));
  assert.equal(res.status, 200);
  const A = res.body.connections.find(c => c.name === 'Alpha'), B = res.body.connections.find(c => c.name === 'Beta');
  assert.equal(res.body.connections.length, 2, '另一個帳號的連線不在');
  assert.equal(A.tasksCompleted, 1, '被復原的那個不算'); assert.equal(A.undone, 1);
  assert.equal(A.estimateHours, 4); assert.equal(A.actualHours, 6); assert.equal(A.comparedTasks, 1);
  assert.equal(B.tasksCompleted, 0); assert.equal(B.changes, 1); assert.equal(A.active, true);
  const txt = JSON.stringify(res.body);
  for (const word of ['設計', '施工', '新廠', SECRET]) assert.ok(!txt.includes(word), '只有數字，沒有任務／專案的文字：' + word);
  assert.deepEqual(Object.keys(A).sort(), ['active', 'actualHours', 'changes', 'comparedTasks', 'connId', 'estimateHours', 'name', 'tasksCompleted', 'undone']);
});

test('分享連結：擁有者被停用之後，公開頁立刻 404（停用要立即生效，公開頁不是例外）', async () => {
  const { env, u } = setup();
  const { body } = await createShare(env, u);
  assert.equal((await pub(env, body.token)).status, 200);
  env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(u.id).run();
  assert.equal((await pub(env, body.token)).status, 404);
  env.DB.prepare("UPDATE users SET status = 'approved' WHERE id = ?").bind(u.id).run();
  assert.equal((await pub(env, body.token)).status, 200, '恢復之後連結照常（沒有被撤銷）');
});
