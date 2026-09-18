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
import { recordCronRun, cronResultErrors, listCronRuns, usageSummary } from '../src/handlers/ops.js';
import { step } from '../src/index.js';
import { createSession } from '../src/session.js';
import { makeEnv, addUser, seedState } from './d1.mjs';

const DAY = 86400_000;
const T0 = Date.parse('2026-09-07T00:00:00Z');

const rows = env => env.DB.prepare('SELECT * FROM cron_runs ORDER BY started_at').all().results;

function run(env, step, ok, detail, at) {
  return recordCronRun(env, { step, ok, detail, startedAt: at, endedAt: at + 1200 });
}

// ------------------------------------------------- 沒丟例外 ≠ 這一步做到了

/**
 * 實際發生過（2026-09-09）：helen 的提醒信被 AgentMail 以 403 擋下（她的信箱進了
 * 退訂名單），`sendOverdueReminders` 把它收進 errors[] 之後**正常回傳**——因為
 * 一個人寄不出去不該讓其他人的信也不寄。於是 step() 記成成功，管理頁顯示
 * 「✓ 正常」，而實際上一封都沒送出去。
 *
 * **假綠燈正是 cron_runs 這張表要防的東西**，由它自己製造出來是最糟的形狀。
 *
 * 下面刻意測 `step()` 本身而不是只測 `cronResultErrors()`：純函式測過了，也只
 * 證明「判斷寫對了」，證明不了 step() 真的有去問它。要測的是那條接線。
 */
test('回傳值裡有 errors 就不能記成成功——否則管理頁會亮假綠燈', async () => {
  const env = makeEnv();
  await step(env, 'reminder', async () => ({
    checked: 1, sent: 0, failed: 1,
    errors: [{ email: 'helen@x.test', error: 'AgentMail 403: message_rejected' }],
  }));

  const r = rows(env);
  assert.equal(r.length, 1);
  assert.equal(r[0].ok, 0, '一封都沒寄出去，不能算成功');
  assert.match(r[0].detail, /403/, '錯誤原因要留在 detail 裡，那是這張表存在的理由');
});

test('部分成功也不算乾淨的成功——有人收不到就是有人收不到', async () => {
  const env = makeEnv();
  await step(env, 'reminder', async () => ({
    checked: 5, sent: 4, failed: 1, errors: [{ email: 'a@x.test', error: 'boom' }],
  }));
  assert.equal(rows(env)[0].ok, 0);
});

test('沒有 errors 的步驟照樣算成功——不要把備份與清理一起判死', async () => {
  const env = makeEnv();
  await step(env, 'backup', async () => ({ key: 'backup/2026-09-09.json', users: 2, states: 2 }));
  await step(env, 'purge', async () => ({ sessions: 0, resets: 0, attempts: 0 }));
  assert.deepEqual(rows(env).map(x => x.ok), [1, 1]);
});

test('空的 errors 陣列是成功，不是失敗', async () => {
  const env = makeEnv();
  await step(env, 'reminder', async () => ({ checked: 2, sent: 2, errors: [] }));
  assert.equal(rows(env)[0].ok, 1);
});

test('丟例外仍然記成失敗（原本的行為不能被弄壞）', async () => {
  const env = makeEnv();
  await step(env, 'backup', async () => { throw new Error('R2 掛了'); });
  const r = rows(env)[0];
  assert.equal(r.ok, 0);
  assert.match(r.detail, /R2 掛了/);
});

test('errors 不是陣列時當作沒有——不要因為形狀怪就把好好的一步判死', () => {
  assert.deepEqual(cronResultErrors({ errors: 'boom' }), []);
  assert.deepEqual(cronResultErrors({}), []);
  assert.deepEqual(cronResultErrors(null), []);
  assert.deepEqual(cronResultErrors(undefined), []);
});

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

// ------------------------------------------------- 寄信記錄（mail_log）
//
// 促成它的真實事件與上面那一組是同一次的另一半：Helen 按了「忘記密碼」，
// 連結**真的產生了**，信卻被寄信商底下的退訂名單擋掉——而 handleForgotPassword
// 一律回 200（那是對的，回「查無此 email」等於做出一個帳號列舉工具），
// 寄信失敗只留了一行 console.error。結果是**沒有任何畫面回答得了那封信寄出去沒有**。
//
// 這一組要守四件事，而它們分別對應四種會讓這張表變回沒有用的改法。

const mailRows = env => env.DB.prepare('SELECT * FROM mail_log ORDER BY created_at').all().results;

/** 把 fetch 換成一個照劇本回答的假貨。回傳收到的請求，讓測試也能驗「有沒有真的去寄」。 */
function fakeFetch(replies) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return { ok: r.status < 400, status: r.status, text: async () => r.body || '' };
  };
  return seen;
}

test('mail_log：寄成功寫一筆 ok=1，而且**不留信的內容**', async () => {
  const env = makeEnv();
  env.AGENTMAIL_API_KEY = 'k'; env.AGENTMAIL_INBOX_ID = 'i@agentmail.to';
  const real = globalThis.fetch;
  try {
    const seen = fakeFetch([{ status: 200 }]);
    const { sendMail } = await import('../src/mail.js');
    await sendMail(env, 'helen@x.com', { subject: '重設你的密碼', text: '連結 https://x/reset?token=SECRET', html: '<b>SECRET</b>' }, 'reset');
    assert.equal(seen.length, 1, '信真的寄出去了');

    const rs = mailRows(env);
    assert.equal(rs.length, 1);
    assert.equal(rs[0].kind, 'reset');
    assert.equal(rs[0].to_email, 'helen@x.com');
    assert.equal(rs[0].ok, 1);
    // 成功時 detail 是 NULL。重設連結、驗證碼、某個人的排程摘要都沒有理由
    // 留在資料庫裡——要回答的只是「有沒有寄成功」。
    assert.equal(rs[0].detail, null);
    const dump = JSON.stringify(rs);
    assert.ok(!dump.includes('SECRET'), '信的內容不該進到記錄裡');
    assert.ok(!dump.includes('重設你的密碼'), '主旨也不進去');
  } finally { globalThis.fetch = real; }
});

test('mail_log：被擋下來要寫 ok=0、留住回應原文，而且 sendMail 仍然要丟例外', async () => {
  const env = makeEnv();
  env.AGENTMAIL_API_KEY = 'k'; env.AGENTMAIL_INBOX_ID = 'i@agentmail.to';
  const real = globalThis.fetch;
  try {
    fakeFetch([{ status: 403, body: '{"error":"message_rejected: recipient is suppressed"}' }]);
    const { sendMail } = await import('../src/mail.js');
    await assert.rejects(
      () => sendMail(env, 'helen@x.com', { subject: 's', text: 't' }, 'reset'),
      /403/,
      '寄失敗一定要讓呼叫端知道——吞掉的話 last_sent_ymd 那類判斷會以為寄過了');

    const rs = mailRows(env);
    assert.equal(rs.length, 1);
    assert.equal(rs[0].ok, 0);
    // **回應原文是分辨原因的唯一線索。** 只記狀態碼的話，「key 無效」與
    // 「這個收件人被擋」看起來一模一樣，而兩者的處理方向完全不同。
    assert.match(rs[0].detail, /message_rejected/);
  } finally { globalThis.fetch = real; }
});

test('mail_log：secret 沒設也要記一筆——「沒設定」與「被擋」在症狀上一模一樣', async () => {
  const env = makeEnv();   // 刻意不設 AGENTMAIL_*
  const { sendMail } = await import('../src/mail.js');
  await assert.rejects(() => sendMail(env, 'a@x.com', { subject: 's', text: 't' }, 'verify'), /AGENTMAIL_API_KEY/);
  const rs = mailRows(env);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].ok, 0);
  assert.equal(rs[0].kind, 'verify');
  assert.match(rs[0].detail, /AGENTMAIL_API_KEY/);
});

test('mail_log：寫記錄失敗不能把一封已經寄出去的信變成錯誤', async () => {
  const env = makeEnv();
  env.AGENTMAIL_API_KEY = 'k'; env.AGENTMAIL_INBOX_ID = 'i@agentmail.to';
  const realFetch = globalThis.fetch, realWarn = console.warn;
  const batch = env.DB.batch.bind(env.DB);
  try {
    fakeFetch([{ status: 200 }]);
    env.DB.batch = async () => { throw new Error('no such table: mail_log'); };
    console.warn = () => {};
    const { sendMail } = await import('../src/mail.js');
    // migration 還沒跑的那一刻就是這個形狀：表不在，但信照樣要寄得出去
    assert.equal(await sendMail(env, 'a@x.com', { subject: 's', text: 't' }, 'reminder'), true);
  } finally { globalThis.fetch = realFetch; console.warn = realWarn; env.DB.batch = batch; }
});

test('listMailLog：分 kind 數，而且失敗要單獨數得出來', async () => {
  const env = makeEnv();
  const { listMailLog } = await import('../src/handlers/ops.js');
  const ins = (kind, to, ok, detail, at) => env.DB.prepare(
    'INSERT INTO mail_log (id, kind, to_email, ok, detail, created_at) VALUES (?,?,?,?,?,?)'
  ).bind(kind + at, kind, to, ok, detail, at).run();
  await ins('reset', 'helen@x.com', 0, 'AgentMail 403: message_rejected', T0 + 3);
  await ins('reminder', 'josh@x.com', 1, null, T0 + 2);
  await ins('reminder', 'helen@x.com', 1, null, T0 + 1);

  const d = await listMailLog(env, T0 + 10);
  assert.equal(d.byKind.reminder.sent, 2);
  assert.equal(d.byKind.reminder.failed, 0);
  // 這一行就是那次事故：訂閱信都寄出去了，交易信一封都沒有。
  // 兩者混在一個總數裡的話，畫面上會顯示「今天寄了 3 封」——完全看不出問題。
  assert.equal(d.byKind.reset.sent, 0);
  assert.equal(d.byKind.reset.failed, 1);
  assert.match(d.byKind.reset.lastError, /message_rejected/);
  assert.equal(d.mails[0].kind, 'reset', '最新的在最前面');
});

// ------------------------------------- 交易信與訂閱信分家（#58）
//
// 擋掉 helen 密碼重設信的那份退訂名單是**帳號層級**的：三個 inbox 的 per-inbox
// 名單全都是空的（唯讀 API 查過兩次），名單卻照樣生效。所以修法只有一個方向
// ——交易信走另一組憑證。這幾條守的是那條路真的通、而且**沒設定時看得出來**。
//
// 突變驗證：TX_KINDS 改成空集合 → 2 紅；只設一半就採用 → 1 紅；
// mailSenders 的 split 永遠回 true → 1 紅；sender 不寫進 mail_log → 2 紅。

/** 用假的 fetch 寄一封信，回傳「實際打去哪個 inbox 的 URL」。 */
async function sentTo(env, kind) {
  const realFetch = globalThis.fetch;
  try {
    const seen = fakeFetch([{ status: 200 }]);
    const { sendMail } = await import('../src/mail.js');
    await sendMail(env, 'helen@x.com', { subject: 's', text: 't' }, kind);
    return seen[0].url;
  } finally { globalThis.fetch = realFetch; }
}
// 刻意**不**在這裡把 console.warn 消音：pickSender 的「只設一半」就是靠它說話的，
// 消音等於把要測的那句話吃掉（第一版就是這樣紅的，而紅的理由是 helper 的錯）。

test('分家：設定好之後，交易信走 TX 帳號、訂閱信照舊', async () => {
  const env = makeEnv();
  env.AGENTMAIL_API_KEY = 'bulk-key'; env.AGENTMAIL_INBOX_ID = 'bulk@agentmail.to';
  env.AGENTMAIL_TX_API_KEY = 'tx-key'; env.AGENTMAIL_TX_INBOX_ID = 'tx@agentmail.to';

  // 交易信＝使用者按了按鈕正在等的那一封。退訂名單不該擋得住它。
  assert.match(await sentTo(env, 'reset'), /tx%40agentmail\.to/);
  assert.match(await sentTo(env, 'verify'), /tx%40agentmail\.to/);
  // 訂閱信＝系統主動送的。它本來就該受退訂名單管。
  assert.match(await sentTo(env, 'reminder'), /bulk%40agentmail\.to/);
  assert.match(await sentTo(env, 'streak'), /bulk%40agentmail\.to/);
  // 沒帶 kind 的走訂閱那一組：多一個帳號的成本由「主動送的」承擔才合理
  assert.match(await sentTo(env, 'unknown'), /bulk%40agentmail\.to/);
});

test('分家：沒設定時安靜退回共用那一組——今天的信不能因此寄不出去', async () => {
  const env = makeEnv();
  env.AGENTMAIL_API_KEY = 'bulk-key'; env.AGENTMAIL_INBOX_ID = 'bulk@agentmail.to';
  assert.match(await sentTo(env, 'reset'), /bulk%40agentmail\.to/);

  const { mailSenders } = await import('../src/mail.js');
  const sd = mailSenders(env);
  assert.equal(sd.split, false, '沒分家就要說沒分家——這一格就是 helen 那次的形狀');
  assert.equal(sd.halfConfigured, false);
});

test('分家：只設一半要退回去、要出聲，而且不准當成已經分家', async () => {
  const realWarn = console.warn;
  const warned = [];
  try {
    console.warn = (...a) => warned.push(a.join(' '));
    const env = makeEnv();
    env.AGENTMAIL_API_KEY = 'bulk-key'; env.AGENTMAIL_INBOX_ID = 'bulk@agentmail.to';
    env.AGENTMAIL_TX_INBOX_ID = 'tx@agentmail.to';   // 少了 TX_API_KEY

    // 退回去而不是丟例外：丟例外的症狀是交易信全部停掉，比「設定沒生效」更糟
    assert.match(await sentTo(env, 'reset'), /bulk%40agentmail\.to/);
    assert.ok(warned.some(w => /AGENTMAIL_TX/.test(w)),
      '靜靜退回去的症狀是「我明明設定了，卻什麼都沒發生」');

    const { mailSenders } = await import('../src/mail.js');
    const sd = mailSenders(env);
    assert.equal(sd.split, false, '半套不算分家');
    assert.equal(sd.halfConfigured, true, '而且要分得出「半套」與「根本沒設」');
    assert.equal(sd.tx, null, '沒真的生效就不要報一個會讓人以為生效了的位址');
  } finally { console.warn = realWarn; }
});

test('mailSenders 不回任何一把 key', async () => {
  const env = makeEnv();
  env.AGENTMAIL_API_KEY = 'BULK-SECRET'; env.AGENTMAIL_INBOX_ID = 'bulk@agentmail.to';
  env.AGENTMAIL_TX_API_KEY = 'TX-SECRET'; env.AGENTMAIL_TX_INBOX_ID = 'tx@agentmail.to';
  const { mailSenders } = await import('../src/mail.js');
  const dump = JSON.stringify(mailSenders(env));
  assert.ok(!dump.includes('SECRET'), '信箱位址是公開的 From，key 不是');
});

test('mail_log 記下實際用了哪個信箱——設定說不出「歷史上到底有沒有分家」', async () => {
  const env = makeEnv();
  env.AGENTMAIL_API_KEY = 'bulk-key'; env.AGENTMAIL_INBOX_ID = 'bulk@agentmail.to';
  env.AGENTMAIL_TX_API_KEY = 'tx-key'; env.AGENTMAIL_TX_INBOX_ID = 'tx@agentmail.to';
  await sentTo(env, 'reset');
  await sentTo(env, 'reminder');

  const rs = mailRows(env);
  assert.equal(rs.find(r => r.kind === 'reset').sender, 'tx@agentmail.to');
  assert.equal(rs.find(r => r.kind === 'reminder').sender, 'bulk@agentmail.to');

  // 而且要走得到管理頁：改設定的那一刻 senders 就變了，證明不了歷史，
  // 所以「那幾封從哪裡出去的」一定要從每一列本身讀出來
  const { listMailLog } = await import('../src/handlers/ops.js');
  const d = await listMailLog(env, T0 + 10);
  assert.deepEqual(d.byKind.reset.senders, ['tx@agentmail.to']);
  assert.deepEqual(d.byKind.reminder.senders, ['bulk@agentmail.to']);
  assert.equal(d.senders.split, true);
});
