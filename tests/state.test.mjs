/**
 * 雲端寫入的樂觀鎖測試。
 *
 * 這一組的重點不是「正常流程會不會過」，而是**競態空窗**：
 * 「先讀版本 → 比對 → 再寫入」這種寫法，在讀與寫之間若有別人改了同一列，
 * 後面的寫入會把對方的變更無聲蓋掉。蓋掉的一方甚至已經收到 200、也已經把
 * 它記成新的合併基準，不會再推一次去救——那份資料就真的不見了。
 *
 * 因此每個 handler 都有一個「在 UPDATE 執行前插入別人的寫入」的測試，
 * 用 withRaceBeforeFirstUpdate 讓那個空窗百分之百重現，而不是靠併發碰運氣。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleGetState, handlePutState } from '../src/handlers/state.js';
import { handleUpdateShared } from '../src/handlers/share.js';
import { makeEnv, addUser, seedState, readState, unwrap, req } from './d1.mjs';

const st = (over = {}) => ({
  version: 1, majorProjects: [], items: [], ganttProjects: [],
  dailyLogs: {}, customHolidays: [], customWorkdays: [],
  availableYears: [2026], selectedGanttProjectId: null, ...over
});
const item = (id, over = {}) => ({
  id, title: 't-' + id, type: 'work', parentId: null, meetingTime: null, link: null,
  date: '2026-03-10', endDate: null, recurrence: null,
  done: false, doneMap: {}, overrides: {}, skipped: {}, ...over
});

/**
 * 讓第一次執行的 `UPDATE user_state` 在真正跑之前先插入一次別人的寫入。
 * 這正是「讀完到寫入之間」那段空窗，用它可以穩定重現原本要靠併發才撞得到的問題。
 */
function withRaceBeforeFirstUpdate(env, inject) {
  let fired = false;
  const DB = {
    prepare(sql) {
      const stmt = env.DB.prepare(sql);
      if (fired || !/^\s*UPDATE user_state/.test(sql)) return stmt;
      return {
        bind(...args) {
          const bound = stmt.bind(...args);
          return {
            run() { if (!fired) { fired = true; inject(); } return bound.run(); },
            first: () => bound.first(),
            all: () => bound.all()
          };
        }
      };
    },
    batch: stmts => env.DB.batch(stmts)
  };
  return { DB };
}

// ---------------------------------------------------------------- PUT /api/state

test('首次寫入：雲端還沒有資料，沒有基準版本也該成功', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.com');
  const { status, body } = await unwrap(
    await handlePutState(req({ state: st({ items: [item('a')] }), baseUpdatedAt: null }), env, 'u1'));
  assert.equal(status, 200);
  assert.equal(readState(env, 'u1').state.items[0].id, 'a');
  assert.equal(readState(env, 'u1').updatedAt, body.updatedAt);
});

test('基準版本相符：更新成功並回傳新版本號', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.com');
  const t0 = seedState(env, 'u1', st({ items: [item('a')] }), 1000);
  const { status, body } = await unwrap(
    await handlePutState(req({ state: st({ items: [item('a', { done: true })] }), baseUpdatedAt: t0 }), env, 'u1'));
  assert.equal(status, 200);
  assert.equal(readState(env, 'u1').state.items[0].done, true);
  assert.notEqual(body.updatedAt, t0);
});

test('基準版本對不上：回 409 並附上遠端內容，遠端資料不被動到', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.com');
  seedState(env, 'u1', st({ items: [item('a', { title: '雲端的' }) ] }), 2000);
  const { status, body } = await unwrap(
    await handlePutState(req({ state: st({ items: [item('a', { title: '本機的' })] }), baseUpdatedAt: 1000 }), env, 'u1'));
  assert.equal(status, 409);
  assert.equal(body.remote.updatedAt, 2000);
  assert.equal(body.remote.state.items[0].title, '雲端的');
  assert.equal(readState(env, 'u1').state.items[0].title, '雲端的', '衝突不該寫入任何東西');
});

test('沒有基準版本但雲端已有資料：當成衝突，不可覆蓋', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.com');
  seedState(env, 'u1', st({ items: [item('a', { title: '雲端的' })] }), 2000);
  const { status } = await unwrap(
    await handlePutState(req({ state: st(), baseUpdatedAt: null }), env, 'u1'));
  assert.equal(status, 409);
  assert.equal(readState(env, 'u1').state.items[0].title, '雲端的');
});

test('競態：比對版本之後、寫入之前被別人改掉 → 必須 409，不能蓋掉對方', async () => {
  const base = makeEnv(); addUser(base, 'u1', 'a@x.com');
  const t0 = seedState(base, 'u1', st({ items: [item('a')] }), 3000);

  // 這個 env 會在 UPDATE 真正執行前，先讓「另一台裝置」寫入一次
  const env = withRaceBeforeFirstUpdate(base, () => {
    base.DB.prepare('UPDATE user_state SET state = ?, updated_at = ? WHERE user_id = ?')
      .bind(JSON.stringify(st({ items: [item('a', { title: '另一台裝置寫的' })] })), 3500, 'u1').run();
  });

  const { status, body } = await unwrap(
    await handlePutState(req({ state: st({ items: [item('a', { title: '我寫的' })] }), baseUpdatedAt: t0 }), env, 'u1'));

  assert.equal(status, 409, '舊寫法會在這裡回 200 並把對方的寫入吃掉');
  assert.equal(readState(base, 'u1').state.items[0].title, '另一台裝置寫的');
  assert.equal(body.remote.state.items[0].title, '另一台裝置寫的', '要把遠端內容回給前端做三方合併');
});

test('有基準版本但那一列已被刪除：當首次寫入補上，不算衝突', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.com');
  const { status } = await unwrap(
    await handlePutState(req({ state: st({ items: [item('a')] }), baseUpdatedAt: 9999 }), env, 'u1'));
  assert.equal(status, 200);
  assert.equal(readState(env, 'u1').state.items[0].id, 'a');
});

test('GET /api/state 一併回身分，前端才不必再打一次 /api/auth/me', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.com', 'admin');
  seedState(env, 'u1', st({ items: [item('a')] }), 4000);
  const user = { id: 'u1', email: 'a@x.com', role: 'admin', status: 'approved' };

  const { body } = await unwrap(await handleGetState(env, user));
  assert.deepEqual(body.user, { email: 'a@x.com', role: 'admin', status: 'approved' });
  assert.equal(body.updatedAt, 4000);
  assert.equal(body.state.items[0].id, 'a');

  // 還沒同步過的帳號要回 state:null（不是 404），但身分照給
  addUser(env, 'u2', 'b@x.com');
  const empty = await unwrap(await handleGetState(env, { id: 'u2', email: 'b@x.com', role: 'user', status: 'approved' }));
  assert.equal(empty.body.state, null);
  assert.equal(empty.body.user.email, 'b@x.com');
});

// ------------------------------------------------------- PUT /api/shared/:shareId

function shareSetup() {
  const env = makeEnv();
  addUser(env, 'owner', 'owner@x.com');
  addUser(env, 'bob', 'bob@x.com');
  seedState(env, 'owner', st({ items: [item('A'), item('B', { title: '擁有者的另一項' })] }), 5000);
  env.DB.prepare(`INSERT INTO shares (id, owner_id, target_id, resource_kind, resource_id, permission, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind('s1', 'owner', 'bob', 'item', 'A', 'edit', 0).run();
  return env;
}
const bob = { id: 'bob', email: 'bob@x.com', role: 'user', status: 'approved' };

test('被分享者勾選：只動到被授權的那一項，其餘原樣寫回', async () => {
  const env = shareSetup();
  const { status } = await unwrap(
    await handleUpdateShared(req({ resource: { ...item('A'), done: true } }), env, bob, 's1', null));
  assert.equal(status, 200);
  const after = readState(env, 'owner').state;
  assert.equal(after.items.find(i => i.id === 'A').done, true);
  assert.equal(after.items.find(i => i.id === 'B').title, '擁有者的另一項');
});

test('競態：擁有者在讀取與寫回之間推送 → 兩邊的變更都要留下', async () => {
  const base = shareSetup();
  const env = withRaceBeforeFirstUpdate(base, () => {
    // 擁有者剛好在這個空窗推上一份改過 B 的資料
    const cur = readState(base, 'owner').state;
    cur.items.find(i => i.id === 'B').title = '擁有者剛改的';
    base.DB.prepare('UPDATE user_state SET state = ?, updated_at = ? WHERE user_id = ?')
      .bind(JSON.stringify(cur), 5500, 'owner').run();
  });

  const { status } = await unwrap(
    await handleUpdateShared(req({ resource: { ...item('A'), done: true } }), env, bob, 's1', null));

  assert.equal(status, 200);
  const after = readState(base, 'owner').state;
  assert.equal(after.items.find(i => i.id === 'A').done, true, '被分享者的勾選要生效');
  assert.equal(after.items.find(i => i.id === 'B').title, '擁有者剛改的',
    '舊寫法會在這裡把擁有者的變更無聲蓋掉');
});

test('操作記錄交給 waitUntil，不擋住回應', async () => {
  const env = shareSetup();
  const pending = [];
  const ctx = { waitUntil: p => pending.push(p) };
  const { status } = await unwrap(
    await handleUpdateShared(req({ resource: { ...item('A'), done: true } }), env, bob, 's1', ctx));
  assert.equal(status, 200);
  assert.equal(pending.length, 1, '記錄應該被丟給 waitUntil 而不是 await 在回應前面');

  await Promise.all(pending);
  const log = env.DB.prepare('SELECT actor_id, resource_id, action FROM share_activity').bind().all();
  assert.equal(log.results.length, 1);
  assert.equal(log.results[0].actor_id, 'bob');
  assert.equal(log.results[0].action, '標記完成');
});

test('沒有 ctx 時仍然要寫記錄（本機或舊呼叫端）', async () => {
  const env = shareSetup();
  await handleUpdateShared(req({ resource: { ...item('A'), done: true } }), env, bob, 's1', null);
  assert.equal(env.DB.prepare('SELECT id FROM share_activity').bind().all().results.length, 1);
});

test('只有檢視權限：拒絕寫入', async () => {
  const env = shareSetup();
  env.DB.prepare("UPDATE shares SET permission = 'view' WHERE id = ?").bind('s1').run();
  const { status } = await unwrap(
    await handleUpdateShared(req({ resource: { ...item('A'), done: true } }), env, bob, 's1', null));
  assert.equal(status, 403);
  assert.equal(readState(env, 'owner').state.items.find(i => i.id === 'A').done, false);
});

test('白名單合併：拿 edit 權限也改不到標題與日期', async () => {
  const env = shareSetup();
  await handleUpdateShared(
    req({ resource: { ...item('A'), title: '我把它改名了', date: '2030-01-01', done: true } }),
    env, bob, 's1', null);
  const a = readState(env, 'owner').state.items.find(i => i.id === 'A');
  assert.equal(a.title, 't-A', '標題只有擁有者能改');
  assert.equal(a.date, '2026-03-10', '日期只有擁有者能改');
  assert.equal(a.done, true, '完成狀態才是被授權的欄位');
});
