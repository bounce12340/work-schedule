/**
 * 方案（free / pro）與上限。設計文件：docs/superpowers/specs/2026-09-16-subscription-design.md
 *
 * 這一組守的東西有三個容易改錯的形狀：
 *
 *   1. 「新的數量 ≤ max(上限, 舊的數量)」——改回「數量 ≤ 上限」的話，Pro 到期的人**連既有的
 *      專案都存不回去**：每一次同步都 402，畫面看起來只是「同步失敗」。降級測試會紅。
 *   2. 寬限期——拿掉的話信用卡過期當天就被降級，而 Apple 還在幫他重試。grace 測試會紅。
 *   3. 前後端的 PLAN_LIMITS 兩份必須逐字相同——前端擋「新增」按鈕、後端擋寫入，兩邊數字
 *      不一樣的症狀是「按鈕讓我新增、同步卻 402」或反過來「按鈕不讓按，其實還沒滿」。
 *
 * 加測試時做過突變驗證：把 exceedsPlanCap 的 max 改回 limit → 2 紅；GRACE_MS 改 0 → 1 紅；
 * 前端的 free.majorProjects 改成 4 → 1 紅；admin 的 touchesAccount 拿掉 → 1 紅。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLAN_LIMITS, GRACE_MS, planOf, planInfo, countProjects, capViolations, exceedsPlanCap } from '../src/plan.js';
import { handleGetState, handlePutState } from '../src/handlers/state.js';
import { handleListUsers, handleUpdateUser } from '../src/handlers/admin.js';
import { handleAiAsk, handleAiStatus } from '../src/handlers/ai.js';
import { getSessionUser, createSession } from '../src/session.js';
import { makeEnv, addUser, seedState, readState, unwrap, req } from './d1.mjs';

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;

const FREE = { id: 'u1', email: 'a@x.test', role: 'user', status: 'approved', planSource: null, planExpiresAt: null };
const PRO = { ...FREE, planSource: 'admin', planExpiresAt: null };

function st(over = {}) {
  return { version: 3, majorProjects: [], items: [], ganttProjects: [], dailyLogs: {}, customHolidays: [], ...over };
}
function majors(n) { return Array.from({ length: n }, (_, i) => ({ id: 'mp' + i, name: '大項目 ' + i })); }
function gantts(n) { return Array.from({ length: n }, (_, i) => ({ id: 'gp' + i, name: '專案 ' + i, tasks: [], notes: '' })); }

// ---------------------------------------------------------------- planOf

test('planOf：沒有來源就是免費；有來源沒到期日是永久 Pro', () => {
  assert.equal(planOf(FREE, NOW), 'free');
  assert.equal(planOf(null, NOW), 'free');
  assert.equal(planOf(PRO, NOW), 'pro');
  // snake_case 的 D1 列也要看得懂：管理頁列全部帳號時是這個形狀
  assert.equal(planOf({ plan_source: 'admin', plan_expires_at: null }, NOW), 'pro');
  assert.equal(planOf({ plan_source: null, plan_expires_at: NOW + DAY }, NOW), 'free', '沒有來源的到期日不算');
});

test('planOf：到期前是 Pro，到期後有 3 天寬限，過了才降級', () => {
  const u = (exp) => ({ ...FREE, planSource: 'apple', planExpiresAt: exp });
  assert.equal(planOf(u(NOW + DAY), NOW), 'pro');
  assert.equal(planOf(u(NOW - DAY), NOW), 'pro', '到期 1 天內仍在寬限');
  assert.equal(planOf(u(NOW - GRACE_MS + 1), NOW), 'pro', '寬限最後一刻');
  assert.equal(planOf(u(NOW - GRACE_MS), NOW), 'free', '寬限結束');
  assert.equal(planOf(u(NOW - 30 * DAY), NOW), 'free');
});

test('planInfo 不含任何 Apple 交易 id', () => {
  const info = planInfo({ ...PRO, apple_original_txn: 'txn-secret', appleOriginalTxn: 'txn-secret' }, NOW);
  assert.deepEqual(info, { plan: 'pro', planSource: 'admin', planExpiresAt: null });
});

// ---------------------------------------------------------------- 上限的純函式

test('countProjects：兩種專案各算各的，缺陣列當 0', () => {
  assert.deepEqual(countProjects(st({ majorProjects: majors(2), ganttProjects: gantts(5) })), { majorProjects: 2, ganttProjects: 5 });
  assert.deepEqual(countProjects({}), { majorProjects: 0, ganttProjects: 0 });
  assert.deepEqual(countProjects(null), { majorProjects: 0, ganttProjects: 0 });
});

test('capViolations：3 個可以，第 4 個超過；Pro 永遠不超過', () => {
  assert.deepEqual(capViolations(st({ majorProjects: majors(3) }), 'free'), []);
  assert.deepEqual(capViolations(st({ majorProjects: majors(4) }), 'free'), [{ kind: 'majorProjects', count: 4, limit: 3 }]);
  assert.deepEqual(capViolations(st({ majorProjects: majors(9), ganttProjects: gantts(9) }), 'pro'), []);
  assert.equal(capViolations(st({ ganttProjects: gantts(4) }), 'free')[0].kind, 'ganttProjects');
});

test('exceedsPlanCap：只有「變多而且超過」才擋——降級的人保留既有的', () => {
  const three = st({ majorProjects: majors(3) });
  const four = st({ majorProjects: majors(4) });
  const five = st({ majorProjects: majors(5) });
  assert.deepEqual(exceedsPlanCap(three, four, 'free'), { kind: 'majorProjects', count: 4, limit: 3 }, '3 → 4 擋');
  assert.deepEqual(exceedsPlanCap(four, five, 'free'), { kind: 'majorProjects', count: 5, limit: 3 }, '降級後 4 → 5 也擋');
  assert.equal(exceedsPlanCap(five, five, 'free'), null, '5 → 5 不擋：改其他東西要存得回去');
  assert.equal(exceedsPlanCap(five, four, 'free'), null, '5 → 4 不擋：刪掉一個一定要能存');
  assert.equal(exceedsPlanCap(null, four, 'free') && exceedsPlanCap(null, four, 'free').kind, 'majorProjects', '雲端還沒有資料時舊的算 0');
  assert.equal(exceedsPlanCap(three, five, 'pro'), null, 'Pro 不擋');
  // 只看數量不看內容：改名、改順序都不算變多
  const renamed = st({ majorProjects: majors(5).map(m => ({ ...m, name: m.name + '！' })) });
  assert.equal(exceedsPlanCap(five, renamed, 'free'), null);
});

// ---------------------------------------------------------------- PUT /api/state

test('PUT：免費帳號 3 → 4 個大項目回 402，而且那一列一個位元都沒動', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.test');
  const t0 = seedState(env, 'u1', st({ majorProjects: majors(3) }), 1000);

  const res = await unwrap(await handlePutState(req({ state: st({ majorProjects: majors(4) }), baseUpdatedAt: t0 }), env, FREE));
  assert.equal(res.status, 402);
  assert.equal(res.body.plan, 'free');
  assert.deepEqual(res.body.over, { kind: 'majorProjects', count: 4, limit: 3 });

  const after = readState(env, 'u1');
  assert.equal(after.updatedAt, t0, '版本號沒動：前端下一次不會因此撞 409');
  assert.equal(after.state.majorProjects.length, 3);
});

test('PUT：同樣的寫入，Pro 帳號回 200', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.test');
  const t0 = seedState(env, 'u1', st({ majorProjects: majors(3) }), 1000);
  const res = await unwrap(await handlePutState(req({ state: st({ majorProjects: majors(4) }), baseUpdatedAt: t0 }), env, PRO));
  assert.equal(res.status, 200);
  assert.equal(readState(env, 'u1').state.majorProjects.length, 4);
});

test('PUT：Pro 到期後手上有 6 個專案，改別的東西照樣存得回去，但第 7 個不行', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.test');
  const lapsed = { ...FREE, planSource: 'apple', planExpiresAt: Date.now() - 30 * DAY };
  const t0 = seedState(env, 'u1', st({ ganttProjects: gantts(6) }), 1000);

  const edit = await unwrap(await handlePutState(
    req({ state: st({ ganttProjects: gantts(6), items: [{ id: 'i1', title: '新的小項目', date: '2026-09-16' }] }), baseUpdatedAt: t0 }), env, lapsed));
  assert.equal(edit.status, 200, '既有的 6 個要能繼續用');

  const t1 = readState(env, 'u1').updatedAt;
  const more = await unwrap(await handlePutState(req({ state: st({ ganttProjects: gantts(7) }), baseUpdatedAt: t1 }), env, lapsed));
  assert.equal(more.status, 402);
  assert.equal(more.body.over.kind, 'ganttProjects');
});

test('PUT：首次寫入（雲端沒有資料）就超過上限也擋', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.test');
  const res = await unwrap(await handlePutState(req({ state: st({ majorProjects: majors(4) }), baseUpdatedAt: null }), env, FREE));
  assert.equal(res.status, 402);
  assert.equal(readState(env, 'u1'), null, '一列都不該寫');
});

test('PUT：剛好 3 個不擋；上限之內的正常寫入完全不多讀一次舊資料', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.test');
  const t0 = seedState(env, 'u1', st(), 1000);
  let selects = 0;
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { if (/^SELECT state FROM user_state/.test(sql)) selects++; return realPrepare(sql); };
  const res = await unwrap(await handlePutState(req({ state: st({ majorProjects: majors(3), ganttProjects: gantts(3) }), baseUpdatedAt: t0 }), env, FREE));
  assert.equal(res.status, 200);
  assert.equal(selects, 0, '沒超過上限就不該為了比對而多讀一次');
});

// ---------------------------------------------------------------- GET /api/state 與 session

test('GET /api/state 的 user 帶方案；session 讀出來的 user 也帶方案欄位', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.test');
  env.DB.prepare("UPDATE users SET plan_source = 'admin', plan_expires_at = NULL WHERE id = 'u1'").run();

  const { token } = await createSession(env, 'u1');
  const user = await getSessionUser(new Request('https://app.test/x', { headers: { authorization: `Bearer ${token}` } }), env);
  assert.equal(user.planSource, 'admin');
  assert.equal(user.planExpiresAt, null);
  assert.equal(planOf(user), 'pro');

  const { body } = await unwrap(await handleGetState(env, user));
  assert.equal(body.user.plan, 'pro');
  assert.equal(body.user.planExpiresAt, null);
  assert.equal('apple_original_txn' in body.user, false);
});

// ---------------------------------------------------------------- 管理者設方案

function patchReq(body) {
  return new Request('https://app.test/api/admin/users/u2', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
const ADMIN = { id: 'u1', email: 'boss@x.test', role: 'admin', status: 'approved' };

test('管理者設方案：永久 Pro 寫進去、記在 admin_activity、清單回算好的 plan', async () => {
  const env = { ...makeEnv(), ADMIN_EMAILS: 'boss@x.test' };
  addUser(env, 'u1', 'boss@x.test', 'admin'); addUser(env, 'u2', 'b@x.test');

  const res = await unwrap(await handleUpdateUser(patchReq({ plan: { source: 'admin', expiresAt: null } }), env, ADMIN, 'u2'));
  assert.equal(res.status, 200);
  assert.equal(res.body.user.plan, 'pro');
  assert.equal(res.body.user.planExpiresAt, null);

  const log = env.DB.prepare('SELECT action, target_email FROM admin_activity').all().results;
  assert.equal(log.length, 1);
  assert.equal(log[0].target_email, 'b@x.test');
  assert.equal(log[0].action, '方案 free → pro（永久）');

  const list = await unwrap(await handleListUsers(env));
  const u2 = list.body.users.find(u => u.id === 'u2');
  assert.equal(u2.plan, 'pro');
  assert.equal('plan_source' in u2, false, '清單回算好的形狀，不回原始欄位');

  // 改回免費也要記；設成一樣的值不記
  const same = await unwrap(await handleUpdateUser(patchReq({ plan: { source: 'admin', expiresAt: null } }), env, ADMIN, 'u2'));
  assert.equal(same.status, 200);
  const back = await unwrap(await handleUpdateUser(patchReq({ plan: { source: null } }), env, ADMIN, 'u2'));
  assert.equal(back.body.user.plan, 'free');
  const log2 = env.DB.prepare('SELECT action FROM admin_activity ORDER BY created_at').all().results;
  assert.deepEqual(log2.map(r => r.action), ['方案 free → pro（永久）', '方案 pro（永久） → free']);
});

test('管理者設方案：到期日要寫得進去，描述帶日期', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'boss@x.test', 'admin'); addUser(env, 'u2', 'b@x.test');
  const exp = Date.UTC(2027, 0, 31);
  const res = await unwrap(await handleUpdateUser(patchReq({ plan: { source: 'admin', expiresAt: exp } }), env, ADMIN, 'u2'));
  assert.equal(res.status, 200);
  assert.equal(res.body.user.planExpiresAt, exp);
  assert.equal(res.body.user.plan, 'pro');
  const log = env.DB.prepare('SELECT action FROM admin_activity').all().results;
  assert.equal(log[0].action, '方案 free → pro（至 2027-01-31）');
});

test('管理者設方案：自己與 ADMIN_EMAILS 名單內的帳號**可以**設——那是給東西，不是停用或降級', async () => {
  const env = { ...makeEnv(), ADMIN_EMAILS: 'boss@x.test,b@x.test' };
  addUser(env, 'u1', 'boss@x.test', 'admin'); addUser(env, 'u2', 'b@x.test', 'admin');

  // 名單內的另一位管理者
  const other = await unwrap(await handleUpdateUser(patchReq({ plan: { source: 'admin', expiresAt: null } }), env, ADMIN, 'u2'));
  assert.equal(other.status, 200, '既有的兩個永久帳號正是名單內的那兩個');

  // 自己
  const selfReq = new Request('https://app.test/api/admin/users/u1', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plan: { source: 'admin', expiresAt: null } }),
  });
  const self = await unwrap(await handleUpdateUser(selfReq, env, ADMIN, 'u1'));
  assert.equal(self.status, 200);

  // 但角色與狀態的兩道保險原樣：同一個請求裡夾帶 status 就回到原本的規則
  const mixed = await unwrap(await handleUpdateUser(patchReq({ plan: { source: null }, status: 'suspended' }), env, ADMIN, 'u2'));
  assert.equal(mixed.status, 403);
  const u2 = env.DB.prepare("SELECT plan_source FROM users WHERE id = 'u2'").first();
  assert.equal(u2.plan_source, 'admin', '被擋下的請求連方案也不能改');
});

test('管理者設方案：格式不對回 400', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'boss@x.test', 'admin'); addUser(env, 'u2', 'b@x.test');
  for (const plan of [{ source: 'apple' }, { source: 'admin', expiresAt: 'tomorrow' }, 'pro', 42]) {
    const res = await unwrap(await handleUpdateUser(patchReq({ plan }), env, ADMIN, 'u2'));
    assert.equal(res.status, 400, JSON.stringify(plan));
  }
});

// ---------------------------------------------------------------- AI 的每日上限依方案

const SCHEDULE = [{ t: '客戶提案', d: '2026-09-16', k: 'meeting', done: false }];
function aiEnv() {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.test');
  return { ...env, DEEPSEEK_API_KEY: 'sk-test' };
}
function ask(body) {
  return new Request('https://app.test/api/ai/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

test('AI：免費版一天 5 次，第 6 次 429；Pro 同一天可以到 20', async () => {
  const env = aiEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '好' } }], usage: { prompt_tokens: 1, completion_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    for (let i = 0; i < 5; i++) {
      env.DB.prepare('INSERT INTO ai_activity (id,user_id,kind,ok,created_at) VALUES (?,?,?,1,?)')
        .bind('x' + i, 'u1', 'ask', NOW - 3_600_000).run();
    }
    const free = await unwrap(await handleAiAsk(ask({ question: 'x', schedule: SCHEDULE }), env, FREE, NOW));
    assert.equal(free.status, 429);
    assert.match(free.body.error, /5 次/);

    const pro = await unwrap(await handleAiAsk(ask({ question: 'x', schedule: SCHEDULE }), env, PRO, NOW));
    assert.equal(pro.status, 200);

    const status = await unwrap(await handleAiStatus(env, FREE));
    assert.equal(status.body.limits.perDay, 5);
    const statusPro = await unwrap(await handleAiStatus(env, PRO));
    assert.equal(statusPro.body.limits.perDay, 20);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------- 前後端的上限要一致

test('前端 index.html 的 PLAN_LIMITS 與 src/plan.js 逐字相同', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const m = html.match(/const PLAN_LIMITS = (\{[\s\S]*?\n  \});/);
  assert.ok(m, 'index.html 裡找不到 const PLAN_LIMITS = {...}');
  const front = new Function(`return ${m[1]};`)();
  assert.deepEqual(front, PLAN_LIMITS);
  assert.equal(front.free.aiPerDay, 5);
  assert.equal(front.pro.majorProjects, Infinity);
});
