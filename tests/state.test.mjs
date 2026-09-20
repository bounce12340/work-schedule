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
// handlePutState 現在收整個 user（上限要看方案）。這裡的 U1 沒有方案 → 免費版，
// 而這支測試的 state 都只有 items、沒有專案，永遠碰不到上限。
const U1 = { id: 'u1', email: 'a@x.com', role: 'user', status: 'approved' };

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
    await handlePutState(req({ state: st({ items: [item('a')] }), baseUpdatedAt: null }), env, U1));
  assert.equal(status, 200);
  assert.equal(readState(env, 'u1').state.items[0].id, 'a');
  assert.equal(readState(env, 'u1').updatedAt, body.updatedAt);
});

test('基準版本相符：更新成功並回傳新版本號', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.com');
  const t0 = seedState(env, 'u1', st({ items: [item('a')] }), 1000);
  const { status, body } = await unwrap(
    await handlePutState(req({ state: st({ items: [item('a', { done: true })] }), baseUpdatedAt: t0 }), env, U1));
  assert.equal(status, 200);
  assert.equal(readState(env, 'u1').state.items[0].done, true);
  assert.notEqual(body.updatedAt, t0);
});

test('基準版本對不上：回 409 並附上遠端內容，遠端資料不被動到', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.com');
  seedState(env, 'u1', st({ items: [item('a', { title: '雲端的' }) ] }), 2000);
  const { status, body } = await unwrap(
    await handlePutState(req({ state: st({ items: [item('a', { title: '本機的' })] }), baseUpdatedAt: 1000 }), env, U1));
  assert.equal(status, 409);
  assert.equal(body.remote.updatedAt, 2000);
  assert.equal(body.remote.state.items[0].title, '雲端的');
  assert.equal(readState(env, 'u1').state.items[0].title, '雲端的', '衝突不該寫入任何東西');
});

test('沒有基準版本但雲端已有資料：當成衝突，不可覆蓋', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.com');
  seedState(env, 'u1', st({ items: [item('a', { title: '雲端的' })] }), 2000);
  const { status } = await unwrap(
    await handlePutState(req({ state: st(), baseUpdatedAt: null }), env, U1));
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
    await handlePutState(req({ state: st({ items: [item('a', { title: '我寫的' })] }), baseUpdatedAt: t0 }), env, U1));

  assert.equal(status, 409, '舊寫法會在這裡回 200 並把對方的寫入吃掉');
  assert.equal(readState(base, 'u1').state.items[0].title, '另一台裝置寫的');
  assert.equal(body.remote.state.items[0].title, '另一台裝置寫的', '要把遠端內容回給前端做三方合併');
});

test('有基準版本但那一列已被刪除：當首次寫入補上，不算衝突', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.com');
  const { status } = await unwrap(
    await handlePutState(req({ state: st({ items: [item('a')] }), baseUpdatedAt: 9999 }), env, U1));
  assert.equal(status, 200);
  assert.equal(readState(env, 'u1').state.items[0].id, 'a');
});

test('GET /api/state 一併回身分，前端才不必再打一次 /api/auth/me', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.com', 'admin');
  seedState(env, 'u1', st({ items: [item('a')] }), 4000);
  const user = { id: 'u1', email: 'a@x.com', role: 'admin', status: 'approved' };

  const { body } = await unwrap(await handleGetState(env, user));
  // 方案也順帶回：前端啟動時就要知道「＋ 新增」該開表單還是開升級說明
  assert.deepEqual(body.user, { email: 'a@x.com', role: 'admin', status: 'approved', plan: 'free', planSource: null, planExpiresAt: null });
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

test('被分享者勾選：完成的時間戳（doneAt）要一起帶回，不合法的值丟掉', async () => {
  // 遊戲化：少了它，別人幫你勾的那一次永遠「沒有時間」，那一天就永遠不完美
  const env = shareSetup();
  const now = Date.now();
  const { status } = await unwrap(await handleUpdateShared(req({ resource: {
    ...item('A'), done: true, doneMap: { '2026-09': true },
    doneAt: { single: now, '2026-09': now - 1000, bad: 'yesterday', neg: -5 },
  } }), env, bob, 's1', null));
  assert.equal(status, 200);
  const a = readState(env, 'owner').state.items.find(i => i.id === 'A');
  assert.deepEqual(a.doneAt, { single: now, '2026-09': now - 1000 });
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

// ------------------------------------------------------------ 逾期提醒（cron）

import { pickOverdue, taipeiYmd, buildReminderEmail, handleReminderPut,
         handleReminderEnable, sendOverdueReminders } from '../src/handlers/reminder.js';

const rem = (t, d, done = 0) => ({ t, d, k: 'work', done });

test('逾期＝日期早於今天且未完成；今天到期的不算逾期', () => {
  const digest = [
    rem('前天的', '2026-07-29'), rem('昨天的', '2026-07-30'),
    rem('今天的', '2026-07-31'), rem('明天的', '2026-08-01'),
    rem('前天但已完成', '2026-07-29', 1)
  ];
  const out = pickOverdue(digest, '2026-07-31');
  assert.deepEqual(out.map(r => r.t), ['前天的', '昨天的'],
    '今天到期的是「今天要做」，混進逾期會把真正遲交的東西淹沒');
});

test('壞掉的 digest 不會讓 cron 爆掉', () => {
  [null, undefined, 'not an array', 42, [null, {}, { d: 123 }]].forEach(d =>
    assert.deepEqual(pickOverdue(d, '2026-07-31'), []));
});

test('台北時間換日：UTC 前一天的下午已經是台北的隔天', () => {
  assert.equal(taipeiYmd(Date.parse('2026-07-30T16:00:00Z')), '2026-07-31');
  assert.equal(taipeiYmd(Date.parse('2026-07-30T15:59:00Z')), '2026-07-30');
});

test('信件內容：列出逾期天數，超過上限的用「還有 N 項」帶過', () => {
  const rows = Array.from({ length: 25 }, (_, i) => rem('項目' + i, '2026-07-01'));
  const mail = buildReminderEmail(rows, [], '2026-07-31', 'https://example.test');
  assert.match(mail.subject, /25/);
  assert.match(mail.text, /逾期 30 天/);
  assert.match(mail.text, /還有 5 項/, '只列前 20 筆，其餘帶過');
  assert.match(mail.html, /https:\/\/example\.test/);
});

test('信件內容會跳脫使用者輸入，標題不能夾帶標籤', () => {
  const mail = buildReminderEmail([rem('<img src=x onerror=alert(1)>', '2026-07-01')], [], '2026-07-31', '');
  assert.ok(!/<img/.test(mail.html), '標題必須被跳脫');
  assert.match(mail.html, /&lt;img/);
});

test('PUT /api/reminder 只收需要的欄位，日期格式不對的丟掉', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.com');
  const user = { id: 'u1', email: 'a@x.com', role: 'user', status: 'approved' };
  const body = { digest: [
    { t: '正常', d: '2026-07-01', k: 'meeting', done: false },
    { t: '壞日期', d: '2026/07/01', k: 'work' },
    { t: '亂填類型', d: '2026-07-02', k: '<script>' , done: true },
    { t: 'x'.repeat(500), d: '2026-07-03', k: 'work' }
  ] };
  const r = await unwrap(await handleReminderPut(
    new Request('https://x.test/api/reminder', { method:'PUT', body: JSON.stringify(body) }), env, user));
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 3, '日期格式不對的那一筆要被丟掉');
  const saved = JSON.parse(env.DB.prepare('SELECT digest FROM reminder_feed WHERE user_id = ?').bind('u1').first().digest);
  assert.equal(saved[1].k, 'work', '不認得的類型退回預設，不是原樣存下來');
  assert.equal(saved[2].t.length, 200, '標題長度有上限');
});

test('推送摘要絕不改動使用者的開關，但新建的列採用預設值', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.com');
  const user = { id: 'u1', email: 'a@x.com', role: 'user', status: 'approved' };
  const enabledNow = () => env.DB
    .prepare('SELECT enabled FROM reminder_feed WHERE user_id = ?').bind('u1').first().enabled;
  const push = b => handleReminderPut(
    new Request('https://x.test/api/reminder', { method: 'PUT', body: JSON.stringify(b) }), env, user);
  const setEnabled = v => handleReminderEnable(
    new Request('https://x.test', { method: 'POST', body: JSON.stringify({ enabled: v }) }), env, user);

  // 第一次推送會建立這一列。此時使用者還沒表達過任何意見，套用 schema 的預設
  // （開啟）——「預設開啟」若只改 schema 而這句 INSERT 仍寫死 0，就完全不會生效。
  await push({ digest: [rem('a', '2026-07-01')] });
  assert.equal(enabledNow(), 1, '新建的列要拿到預設值');

  // **這一條是現在最重要的方向**：使用者親手關掉之後，同步的副作用絕不能把它
  // 又打開。預設開啟讓這個風險比以前更真實——以前 INSERT 寫死 0，關掉之後
  // 就算 DO UPDATE 出錯也只會維持關閉。
  await setEnabled(false);
  await push({ digest: [rem('b', '2026-07-02')] });
  assert.equal(enabledNow(), 0, '關掉的提醒不能被推送打開——那是使用者明確表達過的選擇');

  await setEnabled(true);
  await push({ digest: [rem('c', '2026-07-03')] });
  assert.equal(enabledNow(), 1, '開著的也要維持開著');
});

/** 攔截 fetch，記錄寄出去的信而不真的送 */
function withFakeMail(fn) {
  const real = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.authorization });
    return new Response('{"ok":true}', { status: 200 });
  };
  return fn(sent).finally(() => { globalThis.fetch = real; });
}

const MAIL_ENV = { AGENTMAIL_API_KEY: 'am_test_key', AGENTMAIL_INBOX_ID: 'am_us_inbox_test', APP_URL: 'https://app.test' };

test('cron：有逾期才寄，沒有逾期完全不寄', async () => {
  const base = makeEnv();
  addUser(base, 'u1', 'has@x.com'); addUser(base, 'u2', 'none@x.com');
  const now = Date.parse('2026-07-31T00:00:00Z');
  base.DB.prepare('INSERT INTO reminder_feed (user_id, enabled, digest, updated_at) VALUES (?,1,?,?)')
    .bind('u1', JSON.stringify([rem('遲交的', '2026-07-20')]), now).run();
  base.DB.prepare('INSERT INTO reminder_feed (user_id, enabled, digest, updated_at) VALUES (?,1,?,?)')
    .bind('u2', JSON.stringify([rem('還沒到期', '2026-12-01')]), now).run();

  await withFakeMail(async sent => {
    const out = await sendOverdueReminders({ ...MAIL_ENV, DB: base.DB }, now);
    assert.equal(out.sent, 1);
    assert.equal(out.nothingToSay, 1, '沒有逾期的人完全不寄——每天一封「你沒有逾期」只會被忽略');
    assert.equal(out.notApproved, 0, '兩人都是 approved，不該被算成停用');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.to, 'has@x.com');
    // 路徑必須完全符合官方 OpenAPI 規格。/v0 前綴特別容易漏——文件正文與部分
    // 範例寫成沒有前綴的形式，照抄會 404，而 404 在 log 裡看起來像「inbox 不存在」
    assert.equal(sent[0].url,
      'https://api.agentmail.to/v0/inboxes/am_us_inbox_test/messages/send');
    assert.equal(sent[0].auth, 'Bearer am_test_key');
  });
});

test('cron：同一天不重寄（排程重試不該變成第二封）', async () => {
  const base = makeEnv(); addUser(base, 'u1', 'a@x.com');
  const now = Date.parse('2026-07-31T00:00:00Z');
  base.DB.prepare('INSERT INTO reminder_feed (user_id, enabled, digest, updated_at) VALUES (?,1,?,?)')
    .bind('u1', JSON.stringify([rem('遲交的', '2026-07-20')]), now).run();

  await withFakeMail(async sent => {
    const env = { ...MAIL_ENV, DB: base.DB };
    assert.equal((await sendOverdueReminders(env, now)).sent, 1);
    assert.equal((await sendOverdueReminders(env, now)).sent, 0, '第二次不該再寄');
    assert.equal(sent.length, 1);
    // 隔天又有逾期就會再寄
    assert.equal((await sendOverdueReminders(env, now + 86400000)).sent, 1);
  });
});

test('cron：停用中的帳號不寄；寄失敗不記錄已寄，下次會重試', async () => {
  const base = makeEnv();
  addUser(base, 'u1', 'ok@x.com'); addUser(base, 'u2', 'susp@x.com');
  base.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind('u2').run();
  const now = Date.parse('2026-07-31T00:00:00Z');
  ['u1','u2'].forEach(id => base.DB
    .prepare('INSERT INTO reminder_feed (user_id, enabled, digest, updated_at) VALUES (?,1,?,?)')
    .bind(id, JSON.stringify([rem('遲交的', '2026-07-20')]), now).run());

  // 寄信一律失敗
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('boom', { status: 500 });
  try {
    const env = { ...MAIL_ENV, DB: base.DB };
    const out = await sendOverdueReminders(env, now);
    assert.equal(out.failed, 1, '只有 u1 該被嘗試');
    assert.equal(out.notApproved, 1, '停用中的帳號不寄');
    assert.equal(out.nothingToSay, 0, '兩人都有逾期，不該被算成「沒事要說」');
    // 失敗的原因要留得下來：只有一個 failed 數字的話，「金鑰失效」與
    // 「inbox 不存在」在管理頁上看起來一模一樣，而處理方向完全不同
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0].email, 'ok@x.com');
    assert.match(out.errors[0].error, /500/, '狀態碼要出現在訊息裡');
    assert.equal(base.DB.prepare('SELECT last_sent_ymd FROM reminder_feed WHERE user_id = ?').bind('u1').first().last_sent_ymd,
      null, '沒寄成功就不算寄過，下次排程要能重試');
  } finally { globalThis.fetch = real; }
});

// ------------------------------------------------------------ 連續斷掉的信（cron，F2）
//
// 設計文件 docs/superpowers/specs/2026-09-16-gamification-design.md〈斷掉之後的情勒信〉。
// 這一組守的是三個「不該寄」：沒斷不寄、連續太短不寄、開關關著不寄。會寄信的功能
// 一旦寄過頭，使用者的處理方式是封鎖寄件人——然後逾期提醒也一起收不到。
//
// 突變驗證（加完測試做過）：拿掉 MIN_STREAK_FOR_MAIL 的判斷 → 1 紅；
// broken 改成「有安排就算斷」→ 2 紅；不寫 streak_mail_ymd → 1 紅；
// WHERE streak_mail = 1 改成 enabled = 1 → 1 紅。

import { dayReport, buildStreakEmail, sendStreakBroken, isOnLeave } from '../src/handlers/reminder.js';

/** 昨天到期的一筆。ot = 按時完成（由前端的遊戲化引擎判斷後推上來） */
const gRow = (t, d, ot = 0) => ({ t, d, k: 'work', done: ot, ot });

test('dayReport：那天沒安排就不算斷；全部按時也不算；有一件沒按時才算', () => {
  const y = '2026-09-20';
  assert.equal(dayReport([], y).broken, false, '沒安排的日子不斷火焰——使用者的裁決');
  assert.equal(dayReport([gRow('別天的', '2026-09-19', 1)], y).broken, false);
  assert.equal(dayReport([gRow('按時的', y, 1)], y).broken, false);
  const bad = dayReport([gRow('按時的', y, 1), gRow('沒做完的', y, 0)], y);
  assert.equal(bad.broken, true);
  assert.deepEqual(bad.missed.map(r => r.t), ['沒做完的']);
  assert.equal(bad.scheduled, 2);
  // 「做完了但太晚」也算斷：ot 是前端判斷的，這裡只數
  assert.equal(dayReport([{ t: '補勾的', d: y, k: 'work', done: 1, ot: 0 }], y).broken, true);
});

test('dayReport：壞掉的 digest 不會讓 cron 爆掉', () => {
  [null, undefined, 'not an array', 42, [null, {}, { d: 123 }]].forEach(d =>
    assert.equal(dayReport(d, '2026-09-20').broken, false));
});

test('信件是櫻花樹在講話：講事實、不評價、不寫「加油」', () => {
  const mail = buildStreakEmail(12, [gRow('標案初審', '2026-09-20'), gRow('查廠報告', '2026-09-20')], 'https://app.test');
  assert.match(mail.text, /12 天/);
  assert.match(mail.text, /〈標案初審〉和〈查廠報告〉/, '點名要像人在講話，不是條列');
  // 畫面上的角色是櫻花樹，信的署名必須是同一個角色——不一致的症狀是
  // 「畫面上是櫻花樹，信卻是別的植物寫的」，不會壞也不會報錯
  assert.match(mail.text, /你的櫻花樹/, '署名是角色本人');
  assert.ok(!/植物/.test(mail.text) && !/植物/.test(mail.html), '植物已經退休了，信裡不該再有它');
  assert.ok(!/加油|沒關係|放棄/.test(mail.text), '那三句會把這封信的用途取消掉');
  assert.match(mail.html, /https:\/\/app\.test/);
});

test('信件：超過三件用「還有 N 件」帶過，標題要跳脫', () => {
  const rows = Array.from({ length: 6 }, (_, i) => gRow('項目' + i, '2026-09-20'));
  const mail = buildStreakEmail(3, rows, '');
  assert.match(mail.text, /還有 3 件/);
  const evil = buildStreakEmail(3, [gRow('<img src=x onerror=alert(1)>', '2026-09-20')], '');
  assert.ok(!/<img/.test(evil.html), '標題必須被跳脫');
});

/** 建一個開著 streak_mail 的 feed 列 */
function feed(env, userId, digest, extra = {}) {
  const o = { enabled: 1, streak_mail: 1, streak_current: 12, streak_mail_ymd: null, leave_days: '[]', ...extra };
  env.DB.prepare(
    `INSERT INTO reminder_feed (user_id, enabled, digest, streak_mail, streak_current, streak_mail_ymd,
                                leave_days, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(userId, o.enabled, JSON.stringify(digest), o.streak_mail, o.streak_current, o.streak_mail_ymd,
    o.leave_days, 1).run();
}

// cron 在台北早上 8 點跑；那一刻的「昨天」是 2026-09-20
const CRON_NOW = Date.parse('2026-09-21T00:00:00Z');
const YDAY = '2026-09-20';

test('cron：昨天斷了才寄，全部按時完成的人不寄', async () => {
  const base = makeEnv();
  addUser(base, 'u1', 'broke@x.com'); addUser(base, 'u2', 'kept@x.com');
  feed(base, 'u1', [gRow('沒做完的', YDAY, 0)]);
  feed(base, 'u2', [gRow('按時做完的', YDAY, 1)]);

  await withFakeMail(async sent => {
    const out = await sendStreakBroken({ ...MAIL_ENV, DB: base.DB }, CRON_NOW);
    assert.equal(out.sent, 1);
    assert.equal(out.notBroken, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.to, 'broke@x.com');
    assert.match(sent[0].body.text, /12 天/);
    assert.match(sent[0].body.text, /〈沒做完的〉/);
  });
});

test('cron：同一天只寄一次，隔天才會再寄', async () => {
  const base = makeEnv(); addUser(base, 'u1', 'a@x.com');
  feed(base, 'u1', [gRow('沒做完的', YDAY, 0), gRow('隔天也沒做完', '2026-09-21', 0)]);
  const env = { ...MAIL_ENV, DB: base.DB };
  await withFakeMail(async () => {
    assert.equal((await sendStreakBroken(env, CRON_NOW)).sent, 1);
    const again = await sendStreakBroken(env, CRON_NOW);
    assert.equal(again.sent, 0, '排程重試不該變成第二封');
    assert.equal(again.alreadySent, 1);
    // 隔天的「昨天」是 09-21，那天也沒做完 → 這才是新的一封
    assert.equal((await sendStreakBroken(env, CRON_NOW + 86400000)).sent, 1);
  });
});

test('cron：連續不到兩天不寄——「沒事就閉嘴」在這裡比逾期提醒更重要', async () => {
  const base = makeEnv();
  addUser(base, 'u1', 'one@x.com'); addUser(base, 'u2', 'zero@x.com'); addUser(base, 'u3', 'two@x.com');
  feed(base, 'u1', [gRow('x', YDAY, 0)], { streak_current: 1 });
  feed(base, 'u2', [gRow('x', YDAY, 0)], { streak_current: 0 });
  feed(base, 'u3', [gRow('x', YDAY, 0)], { streak_current: 2 });

  await withFakeMail(async sent => {
    const out = await sendStreakBroken({ ...MAIL_ENV, DB: base.DB }, CRON_NOW);
    assert.equal(out.sent, 1);
    assert.equal(out.tooShort, 2);
    assert.equal(sent[0].body.to, 'two@x.com');
  });
});

test('cron：關掉櫻花樹的信就不寄，而且與逾期提醒的開關各自獨立', async () => {
  const base = makeEnv();
  addUser(base, 'u1', 'off@x.com'); addUser(base, 'u2', 'onlyplant@x.com');
  // 逾期提醒開著、櫻花樹的信關掉 → 不寄
  feed(base, 'u1', [gRow('x', YDAY, 0)], { enabled: 1, streak_mail: 0 });
  // 逾期提醒關掉、櫻花樹的信開著 → 要寄（兩個開關互不牽連）
  feed(base, 'u2', [gRow('x', YDAY, 0)], { enabled: 0, streak_mail: 1 });

  await withFakeMail(async sent => {
    const out = await sendStreakBroken({ ...MAIL_ENV, DB: base.DB }, CRON_NOW);
    assert.equal(out.sent, 1);
    assert.equal(out.checked, 1, '關掉的人根本不該被查到');
    assert.equal(sent[0].body.to, 'onlyplant@x.com');
  });
});

test('cron：停用中的帳號不寄；寄失敗不記錄已寄，下次會重試', async () => {
  const base = makeEnv();
  addUser(base, 'u1', 'sus@x.com'); addUser(base, 'u2', 'fail@x.com');
  base.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = 'u1'").run();
  feed(base, 'u1', [gRow('x', YDAY, 0)]);
  feed(base, 'u2', [gRow('x', YDAY, 0)]);

  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":"forbidden"}', { status: 403 });
  try {
    const out = await sendStreakBroken({ ...MAIL_ENV, DB: base.DB }, CRON_NOW);
    assert.equal(out.notApproved, 1);
    assert.equal(out.failed, 1);
    assert.equal(out.sent, 0);
    assert.equal(out.errors.length, 1, '錯誤訊息要留下來，否則「金鑰失效」與「inbox 不存在」看起來一樣');
    const row = base.DB.prepare("SELECT streak_mail_ymd FROM reminder_feed WHERE user_id = 'u2'").first();
    assert.equal(row.streak_mail_ymd, null, '沒寄成功就不算寄過');
  } finally { globalThis.fetch = real; }
});

// ------------------------------------------------------------ 休假那幾天閉嘴（C-3）
//
// 守的是一件**壞掉也沒有徵兆**的事：休假不該讓任何一種主動送出去的東西照常送，
// 而它一旦反過來壞掉（休假結束後從此不寄了），使用者只會覺得「提醒好像不見了」。
// 所以每一條「不寄」都配一條「該寄的照寄」。
//
// 突變驗證（加完測試實際做過，各自只紅在對的地方）：
//   - 拿掉 sendOverdueReminders 的 isOnLeave 判斷 → 「逾期信」那條紅
//   - 拿掉 sendStreakBroken 的 → 「櫻花樹的信」那條紅
//   - 跳過時順手寫 last_sent_ymd → 「休假結束的第一天要補上」紅
//   - isOnLeave 改成「清單非空就算休假」→ 兩條「不是今天就照寄」紅
//   - isOnLeave 解析失敗時回 true → 「壞掉時照寄」紅
//   - normalizeLeaveDays 不擋格式 → 「PUT 只收 YYYY-MM-DD」紅

test('isOnLeave：問的是「今天在不在清單裡」，壞掉的內容一律當成沒休假', () => {
  const list = JSON.stringify(['2026-07-14', '2026-07-16']);
  assert.equal(isOnLeave(list, '2026-07-14'), true);
  assert.equal(isOnLeave(list, '2026-07-15'), false, '清單非空不等於今天休假');
  // 讀不到就照寄：多一封信看得見，從此不寄沒有人會發現
  [null, undefined, '', '{壞掉的', '"不是陣列"', '42'].forEach(v =>
    assert.equal(isOnLeave(v, '2026-07-14'), false));
});

test('cron：今天休假就整封不寄，而且不寫 last_sent_ymd（結束後第一天要補上）', async () => {
  const base = makeEnv();
  addUser(base, 'u1', 'leave@x.com'); addUser(base, 'u2', 'work@x.com');
  const now = Date.parse('2026-07-31T00:00:00Z');   // 台北 2026-07-31
  const mk = (id, leave) => base.DB.prepare(
    'INSERT INTO reminder_feed (user_id, enabled, digest, leave_days, updated_at) VALUES (?,1,?,?,?)'
  ).bind(id, JSON.stringify([rem('遲交的', '2026-07-20')]), JSON.stringify(leave), now).run();
  mk('u1', ['2026-07-31']);
  // 昨天與下週休假，今天要上班。**故意不放隔天**——下面還要用隔天驗「休假結束
  // 後第一天真的補上」，那一天 u2 也休假的話，測到的就不是 u1 那條路了。
  mk('u2', ['2026-07-30', '2026-08-05']);

  await withFakeMail(async sent => {
    const env = { ...MAIL_ENV, DB: base.DB };
    const out = await sendOverdueReminders(env, now);
    assert.equal(out.sent, 1, '今天要上班的人照寄');
    assert.equal(out.onLeave, 1);
    assert.equal(out.nothingToSay, 0, '跳過的原因要分得出來，不能與「今天沒事」共用一個數字');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.to, 'work@x.com');

    assert.equal(base.DB.prepare("SELECT last_sent_ymd FROM reminder_feed WHERE user_id = 'u1'")
      .first().last_sent_ymd, null, '沒寄就不算寄過');

    // 休假結束的第一天要真的補上（逾期本來就會繼續累積）。u2 隔天也會再收到一封
    // ——那是逾期提醒本來就每天寄，所以這裡問的是「u1 收到了沒」而不是總數
    const next = await sendOverdueReminders(env, now + 86400000);
    assert.equal(next.onLeave, 0);
    assert.equal(sent.filter(m => m.body.to === 'leave@x.com').length, 1,
      '休假那天一封都沒有，結束後的第一天補上');
  });
});

test('cron：休假那天連櫻花樹的信也不寄——問的是今天，不是斷掉的那一天', async () => {
  const base = makeEnv();
  addUser(base, 'u1', 'onleave@x.com'); addUser(base, 'u2', 'backtowork@x.com');
  // u1 今天請假 → 不寄
  feed(base, 'u1', [gRow('沒做完的', YDAY, 0)], { leave_days: JSON.stringify(['2026-09-21']) });
  // u2 昨天（斷掉的那一天）請假、今天上班 → 照寄：他的連續確實斷了，櫻花樹講的是事實
  feed(base, 'u2', [gRow('沒做完的', YDAY, 0)], { leave_days: JSON.stringify([YDAY]) });

  await withFakeMail(async sent => {
    const out = await sendStreakBroken({ ...MAIL_ENV, DB: base.DB }, CRON_NOW);
    assert.equal(out.sent, 1);
    assert.equal(out.onLeave, 1);
    assert.equal(sent[0].body.to, 'backtowork@x.com');
    assert.equal(base.DB.prepare("SELECT streak_mail_ymd FROM reminder_feed WHERE user_id = 'u1'")
      .first().streak_mail_ymd, null, '沒寄就不算寄過');
  });
});

test('PUT /api/reminder：leaveDays 只收 YYYY-MM-DD，去重排序，沒帶就沿用舊值', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.com');
  const user = { id: 'u1', email: 'a@x.com', role: 'user', status: 'approved' };
  const put = body => handleReminderPut(
    new Request('https://x.test/api/reminder', { method: 'PUT', body: JSON.stringify(body) }), env, user);
  const leave = () => JSON.parse(env.DB
    .prepare("SELECT leave_days FROM reminder_feed WHERE user_id = 'u1'").first().leave_days);

  await put({ digest: [], leaveDays: ['2026-09-20', '2026-09-18', '2026-09-20', '2026/09/19', 42, null] });
  assert.deepEqual(leave(), ['2026-09-18', '2026-09-20'],
    '格式不對的丟掉、重複的去掉、存進去的順序穩定（同一份資料每次序列化都一樣）');

  // 舊版前端還沒開始推這個欄位，不該因此把使用者的休假清單清空
  await put({ digest: [] });
  assert.deepEqual(leave(), ['2026-09-18', '2026-09-20'], '沒帶就沿用');

  // 真的清空要送一個空陣列
  await put({ digest: [], leaveDays: [] });
  assert.deepEqual(leave(), []);
});

test('PUT /api/reminder 收下 ot 與連續天數；POST 的兩個開關互不影響', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.com');
  const user = { id: 'u1', email: 'a@x.com', role: 'user', status: 'approved' };
  const read = () => env.DB.prepare('SELECT digest, streak_current, enabled, streak_mail FROM reminder_feed WHERE user_id = ?').bind('u1').first();

  await handleReminderPut(new Request('https://x.test/api/reminder', { method: 'PUT', body: JSON.stringify({
    digest: [{ t: '按時', d: '2026-09-20', k: 'work', done: 1, ot: true },
             { t: '沒按時', d: '2026-09-20', k: 'work', done: 1 }],
    streak: { current: 12, best: 30 }
  }) }), env, user);
  let row = read();
  assert.deepEqual(JSON.parse(row.digest).map(r => r.ot), [1, 0]);
  assert.equal(row.streak_current, 12);
  assert.equal(row.streak_mail, 1, '新建的列採用預設值（開啟）');

  // 關掉櫻花樹的信，逾期提醒維持開著
  await handleReminderEnable(new Request('https://x.test', { method: 'POST',
    body: JSON.stringify({ enabled: true, streakMail: false }) }), env, user);
  row = read();
  assert.equal(row.streak_mail, 0);
  assert.equal(row.enabled, 1);

  // 沒帶 streakMail 的請求（例如只改提前天數）不能把它又打開
  await handleReminderEnable(new Request('https://x.test', { method: 'POST',
    body: JSON.stringify({ enabled: true, leadDays: 5 }) }), env, user);
  assert.equal(read().streak_mail, 0, '沒帶就沿用——那是使用者明確表達過的選擇');

  // 推送摘要同樣不能打開它
  await handleReminderPut(new Request('https://x.test/api/reminder', { method: 'PUT',
    body: JSON.stringify({ digest: [] }) }), env, user);
  assert.equal(read().streak_mail, 0);
  assert.equal(read().streak_current, 12, '沒帶 streak 就沿用舊值，不歸零');
});

// ------------------------------------------------------ 退訂連結（信裡自己的出口）
//
// 為什麼要有這一段：2026-09-20 查清楚 helen 的密碼重設信被擋的**根因**——
// 她在 Gmail 裡按了「取消訂閱」，寄信商把她加進**帳號層級**的退訂名單，
// 於是連她自己索取的信一起擋掉。
//
// 她會去按那顆按鈕，是因為我們的信裡**沒有自己的出口**。所以這一段守的不是
// 「退訂會不會生效」，而是三件比較安靜、壞掉也看不出來的事：
//   1. 信裡真的有那個連結（沒有的話，大家繼續去按 Gmail 那顆）
//   2. 兩種信**不互相連坐**（連坐正是 Gmail 那顆按鈕的錯，我們不能犯同一個）
//   3. 這個 token **只關不開**，而且改到 0 列要講出來，不能回 ok

// buildStreakEmail 在上面的〈櫻花樹的信〉那一段已經 import 過，這裡不重複
import { handleUnsubscribe, ensureUnsubToken, unsubUrl } from '../src/handlers/reminder.js';

/** 直接讀那一列，斷言才看得到真正存進去的值 */
const feedRow = (env, id = 'u1') =>
  env.DB.prepare('SELECT * FROM reminder_feed WHERE user_id = ?').bind(id).first();

const unsubReq = (token, kind) => new Request('https://x.test/api/unsub', {
  method: 'POST', body: JSON.stringify({ token, kind })
});

test('退訂：信裡真的帶著連結，而且兩封信各自帶不同的 kind', async () => {
  const base = makeEnv(); addUser(base, 'u1', 'a@x.com');
  const now = Date.parse('2026-07-31T00:00:00Z');
  base.DB.prepare('INSERT INTO reminder_feed (user_id, enabled, digest, updated_at) VALUES (?,1,?,?)')
    .bind('u1', JSON.stringify([rem('遲交的', '2026-07-20')]), now).run();

  await withFakeMail(async sent => {
    await sendOverdueReminders({ ...MAIL_ENV, DB: base.DB }, now);
    const token = feedRow(base).unsub_token;
    assert.ok(token && token.length >= 20, '寄信時要產生 token 並存起來');
    // **純文字版也要有。** 有些人就是在純文字模式讀信，只有 HTML 版有出口
    // 等於對那些人來說沒有出口。
    assert.match(sent[0].body.text, new RegExp('/unsub\\?t=' + token + '&k=reminder'));
    assert.match(sent[0].body.html, new RegExp('k=reminder'));
    assert.ok(!/k=streak/.test(sent[0].body.html), '逾期提醒信不該帶櫻花樹的 kind');
  });
});

test('退訂：只關掉指定的那一種，另一種原樣（Gmail 那顆按鈕犯的就是這個錯）', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.com');
  env.DB.prepare(
    'INSERT INTO reminder_feed (user_id, enabled, streak_mail, digest, unsub_token, updated_at) VALUES (?,1,1,?,?,?)'
  ).bind('u1', '[]', 'tok_' + 'x'.repeat(30), 1).run();
  const token = feedRow(env).unsub_token;

  assert.equal((await unwrap(await handleUnsubscribe(unsubReq(token, 'reminder'), env))).body.ok, true);
  let row = feedRow(env);
  assert.equal(row.enabled, 0, '逾期提醒關掉了');
  assert.equal(row.streak_mail, 1, '**櫻花樹的信一個位元都沒動**——這一條就是整件事的重點');

  // 反方向也要成立：同一個 token 換一個 kind，關的是另一個開關
  assert.equal((await unwrap(await handleUnsubscribe(unsubReq(token, 'streak'), env))).body.ok, true);
  assert.equal(feedRow(env).streak_mail, 0);
});

test('退訂：錯的 token 不生效，而且要說出來（回 ok 等於假綠燈）', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.com');
  env.DB.prepare(
    'INSERT INTO reminder_feed (user_id, enabled, digest, unsub_token, updated_at) VALUES (?,1,?,?,?)'
  ).bind('u1', '[]', 'tok_' + 'y'.repeat(30), 1).run();

  const res = await unwrap(await handleUnsubscribe(unsubReq('tok_' + 'z'.repeat(30), 'reminder'), env));
  assert.equal(res.status, 404, '改到 0 列是錯誤，不是成功');
  assert.ok(!res.body.ok);
  assert.equal(feedRow(env).enabled, 1, '別人的設定一個位元都沒動');
});

test('退訂：kind 是白名單，認不得的一律退回（永不拼進 SQL）', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.com');
  const token = 'tok_' + 'w'.repeat(30);
  env.DB.prepare(
    'INSERT INTO reminder_feed (user_id, enabled, digest, unsub_token, updated_at) VALUES (?,1,?,?,?)'
  ).bind('u1', '[]', token, 1).run();

  for (const bad of ['enabled', 'push_overdue', 'enabled = 0, streak_mail', '', 'REMINDER']) {
    const res = await unwrap(await handleUnsubscribe(unsubReq(token, bad), env));
    assert.equal(res.status, 400, `「${bad}」不該被當成合法的 kind`);
  }
  assert.equal(feedRow(env).enabled, 1, '一輪下來什麼都沒被改到');
});

test('退訂：這個 token 只關不開——重複點是冪等，永遠不會把通知打開', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.com');
  const token = 'tok_' + 'v'.repeat(30);
  env.DB.prepare(
    'INSERT INTO reminder_feed (user_id, enabled, digest, unsub_token, updated_at) VALUES (?,1,?,?,?)'
  ).bind('u1', '[]', token, 1).run();

  for (let i = 0; i < 3; i++) {
    assert.equal((await unwrap(await handleUnsubscribe(unsubReq(token, 'reminder'), env))).body.ok, true);
    assert.equal(feedRow(env).enabled, 0, '第 ' + (i + 1) + ' 次之後仍然是關的');
  }
});

test('退訂：沒有 APP_URL 就不放半個連結（點下去只會看到「連結不完整」）', () => {
  assert.equal(unsubUrl('', 'tok_abcdefghijklmnopqrstuv', 'reminder'), '');
  assert.equal(unsubUrl('https://app.test', '', 'reminder'), '');
  assert.equal(unsubUrl('https://app.test', 'tok_abcdefghijklmnopqrstuv', '亂寫的'), '');
  assert.equal(unsubUrl('https://app.test/', 'tok_abc', 'streak'),
    'https://app.test/unsub?t=tok_abc&k=streak', '結尾的斜線不該變成兩條');

  // 沒有連結時信照樣寄得出去，只是少那一行——不能因此爆掉
  const mail = buildReminderEmail([rem('遲交的', '2026-07-01')], [], '2026-07-31', '', '');
  assert.ok(!/unsub/.test(mail.text + mail.html));
  assert.ok(mail.text.length > 0);
});

test('退訂：ensureUnsubToken 併發時以資料庫裡的那一個為準', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.com');
  env.DB.prepare('INSERT INTO reminder_feed (user_id, enabled, digest, updated_at) VALUES (?,1,?,?)')
    .bind('u1', '[]', 1).run();

  // 兩條路徑同時要 token。要是輸的那條回傳自己產的值，就會把一個從來不存在於
  // 資料庫裡的 token 寄出去——使用者點了之後改到 0 列，畫面上是「連結已失效」，
  // 而他什麼都沒做錯。
  const [a, b] = await Promise.all([
    ensureUnsubToken(env, 'u1', null),
    ensureUnsubToken(env, 'u1', null)
  ]);
  assert.equal(a, b, '兩邊拿到同一個');
  assert.equal(a, feedRow(env).unsub_token, '而且就是資料庫裡的那一個');

  // 已經有了就原樣回，不會每寄一封信就換一個（換了等於舊信裡的連結全部失效）
  assert.equal(await ensureUnsubToken(env, 'u1', a), a);
});

test('退訂：櫻花樹的信也帶連結，而且帶的是 streak', async () => {
  const mail = buildStreakEmail(12, [rem('沒做完的', '2026-07-30')], 'https://app.test',
    'https://app.test/unsub?t=tok_abc&k=streak');
  assert.match(mail.text, /k=streak/);
  assert.match(mail.html, /k=streak/);
  assert.ok(!/k=reminder/.test(mail.text + mail.html));
});
