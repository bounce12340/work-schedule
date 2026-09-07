/**
 * 維運可見度：cron 執行記錄與功能使用狀況。
 *
 * 這一組要守的是**「看不見」本身就是 bug** 這件事。
 *
 * 促成它的真實事件：提醒信整整兩週沒有寄出，而所有條件都成立——提醒是開著的、
 * 帳號是 approved、digest 裡確實有即將到期的項目。系統沒有任何徵兆，因為寄信
 * 失敗只留了一行 console.warn，而那行字在 Cloudflare 後台，沒有人會去翻。
 *
 * 所以這裡最重要的兩條不是「有沒有寫進去」，而是：
 *
 *   1. **失敗也要寫，而且錯誤訊息要留得住。** 只記成功的話，「沒在跑」與
 *      「一切正常」在畫面上完全一樣——那就是原本的狀態。
 *   2. **今天失敗了，就不能算成「今天有成功」。** lastOkAt 是管理頁真正會看的
 *      那個數字；把失敗算進去的話，這整個功能會親手製造出它要防的那種假綠燈。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordCronRun, listCronRuns, usageSummary } from '../src/handlers/ops.js';
import { createSession } from '../src/session.js';
import { makeEnv, addUser, seedState } from './d1.mjs';

const DAY = 86400_000;
const T0 = Date.parse('2026-09-07T00:00:00Z');

const rows = env => env.DB.prepare('SELECT * FROM cron_runs ORDER BY started_at').all().results;

function run(env, step, ok, detail, at) {
  return recordCronRun(env, { step, ok, detail, startedAt: at, endedAt: at + 1200 });
}

// ---------------------------------------------------------------- 寫入

test('成功與失敗都要寫進去', async () => {
  const env = makeEnv();
  await run(env, 'backup', true, '{"users":2}', T0);
  await run(env, 'reminder', false, 'AgentMail 401: invalid key', T0);

  const r = rows(env);
  assert.equal(r.length, 2);
  const rem = r.find(x => x.step === 'reminder');
  assert.equal(rem.ok, 0);
  assert.match(rem.detail, /401/, '失敗的原因是這張表存在的理由，不能只記「失敗了」');
});

test('耗時記得下來——每次都跑很久也是一種徵兆', async () => {
  const env = makeEnv();
  await recordCronRun(env, { step: 'purge', ok: true, detail: '{}', startedAt: T0, endedAt: T0 + 4500 });
  const list = await listCronRuns(env, T0);
  assert.equal(list.runs[0].ms, 4500);
});

test('detail 有長度上限，錯誤訊息不能把這一欄變成任意大小的儲存空間', async () => {
  const env = makeEnv();
  await run(env, 'reminder', false, 'x'.repeat(9000), T0);
  assert.ok(rows(env)[0].detail.length <= 1000);
});

test('寫入失敗只能吞掉，不可以往上丟——排程已經做完了', async () => {
  const env = makeEnv();
  env.DB.batch = async () => { throw new Error('D1 掛了'); };
  await assert.doesNotReject(() => run(env, 'backup', true, '{}', T0),
    '記錄寫不進去，不該讓一次成功的備份看起來像失敗');
});

test('保留 30 天，寫入時順手清掉更舊的', async () => {
  const env = makeEnv();
  await run(env, 'backup', true, '{}', T0 - 40 * DAY);
  await run(env, 'backup', true, '{}', T0 - 20 * DAY);
  assert.equal(rows(env).length, 2, '清理是在下一次寫入時才發生');

  await run(env, 'backup', true, '{}', T0);
  const left = rows(env).map(r => r.started_at);
  assert.equal(left.length, 2);
  assert.ok(!left.includes(T0 - 40 * DAY), '40 天前的該被清掉');
  assert.ok(left.includes(T0 - 20 * DAY), '20 天前的還在保留期內');
});

// ---------------------------------------------------------------- 讀出來的判讀

test('今天失敗不能算成今天有成功', async () => {
  const env = makeEnv();
  await run(env, 'reminder', true, '{"sent":1}', T0 - 14 * DAY);   // 最後一次真的成功
  for (let i = 13; i >= 0; i--) {                                   // 之後天天失敗
    await run(env, 'reminder', false, 'AgentMail 401', T0 - i * DAY);
  }

  const { steps } = await listCronRuns(env, T0);
  assert.equal(steps.reminder.lastRunAt, T0, '每天都有跑');
  assert.equal(steps.reminder.lastOkAt, T0 - 14 * DAY,
    '最後成功停在兩週前——這正是要被看見的那個數字');
  assert.match(steps.reminder.lastError, /401/, '最近一次的失敗原因要拿得到');
});

test('沒跑過的 step 根本不會出現，而不是顯示成成功', async () => {
  const env = makeEnv();
  await run(env, 'backup', true, '{}', T0);
  const { steps } = await listCronRuns(env, T0);
  assert.ok(!('reminder' in steps), '從未執行與執行成功必須分得出來');
});

test('步驟名稱從記錄本身取，cron 多一件事不必改這裡', async () => {
  const env = makeEnv();
  await run(env, 'somethingNew', true, '{}', T0);
  const { steps } = await listCronRuns(env, T0);
  assert.ok(steps.somethingNew, '寫死一份步驟清單的話，新工作會靜靜地不被監看');
});

test('最新的排前面', async () => {
  const env = makeEnv();
  await run(env, 'backup', true, '{}', T0 - 2 * DAY);
  await run(env, 'backup', true, '{}', T0);
  await run(env, 'backup', true, '{}', T0 - DAY);
  const { runs } = await listCronRuns(env, T0);
  assert.deepEqual(runs.map(r => r.startedAt), [T0, T0 - DAY, T0 - 2 * DAY]);
});

// ---------------------------------------------------------------- 使用狀況

function seedUsage(env) {
  addUser(env, 'u1', 'heavy@x.test');
  addUser(env, 'u2', 'light@x.test');
  // seedState 自己會 stringify——這裡傳物件
  seedState(env, 'u1', {
    items: Array.from({ length: 64 }, (_, i) => ({ id: 'i' + i, title: '極機密的專案代號', date: '2026-09-07' })),
    ganttProjects: [{ id: 'g1', name: 'A' }, { id: 'g2', name: 'B' }],
  }, T0);
  seedState(env, 'u2', { items: [{ id: 'x', title: 'x', date: '2026-09-07' }], ganttProjects: [] }, T0);
  env.DB.prepare("INSERT INTO reminder_feed (user_id, enabled, digest, lead_days, last_sent_ymd, updated_at) VALUES ('u1',1,'[]',3,'2026-08-24',?)")
    .bind(T0).run();
}

test('數得出誰是重度使用者——這是排效能問題順序的依據', async () => {
  const env = makeEnv();
  seedUsage(env);
  const { users } = await usageSummary(env, T0);
  const heavy = users.find(u => u.email === 'heavy@x.test');
  assert.equal(heavy.items, 64);
  assert.equal(heavy.gantt, 2);
  assert.equal(users.find(u => u.email === 'light@x.test').items, 1);
});

test('只回數量與狀態，一個字的排程內容都不能出現', async () => {
  const env = makeEnv();
  seedUsage(env);
  const raw = JSON.stringify(await usageSummary(env, T0));
  assert.ok(!raw.includes('極機密的專案代號'),
    '要回答的是「有沒有人在用」，沒有理由為此把所有人的排程送到瀏覽器');
  assert.ok(!raw.includes('"state"'), '整包 state 也不該出現');
});

test('提醒的狀態帶得出來——「開著卻兩週沒寄」要一眼看得到', async () => {
  const env = makeEnv();
  seedUsage(env);
  const { users } = await usageSummary(env, T0);
  const heavy = users.find(u => u.email === 'heavy@x.test');
  assert.equal(heavy.reminderOn, true);
  assert.equal(heavy.lastSentYmd, '2026-08-24');
  assert.equal(users.find(u => u.email === 'light@x.test').reminderOn, false,
    '沒有那一列的人是「關著」，不是 undefined');
});

test('沒有雲端資料的帳號回 0，不是 null 也不是整個消失', async () => {
  const env = makeEnv();
  addUser(env, 'u3', 'never@x.test');
  const { users } = await usageSummary(env, T0);
  const u = users.find(x => x.email === 'never@x.test');
  assert.ok(u, '從未同步過的帳號也要出現——「註冊了但沒在用」本身就是訊號');
  assert.equal(u.items, 0);
  assert.equal(u.bytes, 0);
});

test('一份壞掉的 state 只讓那一列的數字變成 0，不會讓整張表查不出來', async () => {
  const env = makeEnv();
  seedUsage(env);
  addUser(env, 'u9', 'broken@x.test');
  // 刻意繞過 seedState：它會 stringify，那樣寫進去的仍是合法 JSON，
  // 測不到「欄位裡就是一段壞掉的字串」這個真正會發生的情況
  env.DB.prepare('INSERT INTO user_state (user_id, state, updated_at, created_at) VALUES (?,?,?,?)')
    .bind('u9', '{ 這不是 JSON', T0, T0).run();

  const { users } = await usageSummary(env, T0);
  assert.equal(users.length, 3);
  assert.equal(users.find(u => u.email === 'broken@x.test').items, 0);
  assert.equal(users.find(u => u.email === 'heavy@x.test').items, 64, '其他人不受影響');
});

test('只算還沒過期的裝置', async () => {
  const env = makeEnv();
  addUser(env, 'u1', 'a@x.test');
  await createSession(env, 'u1', 'Live');
  env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .bind('dead', 'u1', 0, T0 - DAY).run();

  const { users } = await usageSummary(env, T0);
  assert.equal(users[0].devices, 1, '過期的 session 不是「登入中的裝置」');
});

test('全站總數帶出來——ICS 與分享是 0 這件事要有地方看得到', async () => {
  const env = makeEnv();
  seedUsage(env);
  const { totals } = await usageSummary(env, T0);
  assert.equal(totals.ics, 0);
  assert.equal(totals.shares, 0);
});
