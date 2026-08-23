/**
 * 事前提醒。
 *
 * 最重要的一條是**「沒事就閉嘴」那個閘門有沒有守住**。加了事前提醒之後，會觸發
 * 寄信的條件變寬了，那道閘門就更要守住，不是更不必——每天一封「你今天沒事」的信
 * 只會訓練收件者忽略這個寄件人，真的有事時反而看不到。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickOverdue, pickUpcoming, addDays, buildReminderEmail, sendOverdueReminders, DEFAULT_LEAD_DAYS,
} from '../src/handlers/reminder.js';
import { makeEnv, addUser } from './d1.mjs';

const TODAY = '2026-08-21';
const d = (t, date, done = 0) => ({ t, d: date, k: 'work', done });

const DIGEST = [
  d('前天的', '2026-08-19'),
  d('昨天的', '2026-08-20'),
  d('今天的', '2026-08-21'),
  d('明天的', '2026-08-22'),
  d('三天後', '2026-08-24'),
  d('十天後', '2026-08-31'),
  d('做完了', '2026-08-22', 1),
];

test('逾期與即將到期剛好互補，不重疊也不漏接', () => {
  const over = pickOverdue(DIGEST, TODAY).map(r => r.t);
  const soon = pickUpcoming(DIGEST, TODAY, 3).map(r => r.t);

  assert.deepEqual(over, ['前天的', '昨天的']);
  assert.deepEqual(soon, ['今天的', '明天的', '三天後'], '8/21 + 3 天 = 8/24，含邊界');
  assert.equal(over.filter(t => soon.includes(t)).length, 0, '同一項不能同時出現在兩段');
});

test('今天到期屬於「即將」而不是「逾期」——它還沒遲到', () => {
  assert.ok(!pickOverdue(DIGEST, TODAY).some(r => r.d === TODAY));
  assert.ok(pickUpcoming(DIGEST, TODAY, 1).some(r => r.d === TODAY));
});

test('leadDays 是含邊界的：剛好第 N 天要算進去', () => {
  // 8/24 正好是 8/21 + 3。差一天的邊界最容易寫錯，所以兩側各測一次。
  assert.deepEqual(pickUpcoming(DIGEST, TODAY, 2).map(r => r.t), ['今天的', '明天的']);
  assert.deepEqual(pickUpcoming(DIGEST, TODAY, 3).map(r => r.t), ['今天的', '明天的', '三天後']);
});

test('leadDays 為 0 代表只在逾期時通知——原本的行為要留得回去', () => {
  assert.deepEqual(pickUpcoming(DIGEST, TODAY, 0), []);
  assert.deepEqual(pickUpcoming(DIGEST, TODAY, undefined), []);
});

test('已完成的項目兩段都不出現', () => {
  assert.ok(!pickUpcoming(DIGEST, TODAY, 30).some(r => r.t === '做完了'));
});

test('addDays 跨月與跨年都要對', () => {
  assert.equal(addDays('2026-08-30', 3), '2026-09-02');
  assert.equal(addDays('2026-12-30', 5), '2027-01-04');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29', '閏年');
});

// ---------------------------------------------------------------- 信件內容

test('信件：兩段都有時，逾期排在前面且主旨兩者都提', () => {
  const mail = buildReminderEmail(
    pickOverdue(DIGEST, TODAY), pickUpcoming(DIGEST, TODAY, 3), TODAY, 'https://app.test');

  assert.match(mail.subject, /2 個已逾期/);
  assert.match(mail.subject, /3 個即將到期/);
  assert.ok(mail.text.indexOf('【已逾期】') < mail.text.indexOf('【即將到期】'), '逾期要在前面');
  assert.ok(mail.html.indexOf('已逾期') < mail.html.indexOf('即將到期'));
});

test('信件：只有即將到期時，主旨不能寫成「逾期提醒」嚇人', () => {
  const mail = buildReminderEmail([], pickUpcoming(DIGEST, TODAY, 3), TODAY, '');
  assert.match(mail.subject, /即將到期/);
  assert.ok(!/逾期/.test(mail.subject), '沒有逾期就不該出現這兩個字');
});

test('信件：用「今天到期」「明天到期」而不是「0 天後」', () => {
  const mail = buildReminderEmail([], pickUpcoming(DIGEST, TODAY, 3), TODAY, '');
  assert.match(mail.text, /今天到期/);
  assert.match(mail.text, /明天到期/);
  assert.ok(!/0 天後/.test(mail.text));
});

test('信件：即將到期的標題一樣要跳脫', () => {
  const mail = buildReminderEmail([], [d('<img src=x onerror=alert(1)>', '2026-08-22')], TODAY, '');
  assert.ok(!/<img/.test(mail.html));
  assert.match(mail.html, /&lt;img/);
});

// ---------------------------------------------------------------- cron 行為

const AGENTMAIL = 'https://api.agentmail.to';

async function withMail(fn) {
  const real = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes(AGENTMAIL)) { sent.push(JSON.parse(init.body)); return Response.json({ ok: true }); }
    throw new Error('不預期的請求 ' + url);
  };
  try { return await fn(sent); } finally { globalThis.fetch = real; }
}

function mailEnv() {
  return Object.assign(makeEnv(), {
    AGENTMAIL_API_KEY: 'k', AGENTMAIL_INBOX_ID: 'bot@agentmail.to', APP_URL: 'https://app.test',
  });
}

/** 台北時間 8/21 上午（cron 實際觸發的時刻） */
const NOW = Date.parse('2026-08-21T00:30:00Z');

function seedReminder(env, digest, leadDays) {
  addUser(env, 'u1', 'a@x.test');
  env.DB.prepare(
    'INSERT INTO reminder_feed (user_id, enabled, digest, lead_days, updated_at) VALUES (?, 1, ?, ?, ?)'
  ).bind('u1', JSON.stringify(digest), leadDays, 0).run();
}

test('cron：沒有逾期但有即將到期時，會寄——這是這個功能的重點', async () => {
  const env = mailEnv();
  seedReminder(env, [d('明天的', '2026-08-22')], 3);

  await withMail(async sent => {
    const r = await sendOverdueReminders(env, NOW);
    assert.equal(r.sent, 1);
    assert.match(sent[0].subject, /即將到期/);
  });
});

test('cron：兩段都空就完全不寄——「沒事就閉嘴」的閘門要守住', async () => {
  const env = mailEnv();
  seedReminder(env, [d('很久以後', '2026-12-01'), d('做完了', '2026-08-20', 1)], 3);

  await withMail(async sent => {
    const r = await sendOverdueReminders(env, NOW);
    assert.equal(r.sent, 0);
    assert.equal(r.skipped, 1);
    assert.equal(sent.length, 0, '一封都不能寄');
  });
});

test('cron：lead_days = 0 的人只在逾期時收到信', async () => {
  const env = mailEnv();
  seedReminder(env, [d('明天的', '2026-08-22')], 0);

  await withMail(async sent => {
    assert.equal((await sendOverdueReminders(env, NOW)).sent, 0, '只有即將到期，他不想收');
    assert.equal(sent.length, 0);
  });

  // 換成有逾期的，同一個人就該收到
  const env2 = mailEnv();
  seedReminder(env2, [d('昨天的', '2026-08-20')], 0);
  await withMail(async sent => {
    assert.equal((await sendOverdueReminders(env2, NOW)).sent, 1);
    assert.match(sent[0].subject, /逾期/);
  });
});

test('沒有指定 lead_days 的列會拿到預設值，不是 0——升級後的舊資料要照樣收到提醒', async () => {
  const env = mailEnv();
  addUser(env, 'u1', 'a@x.test');
  // 不寫 lead_days，交給 schema 的 DEFAULT。既有資料庫跑完 migrations/001 之後
  // 每一列都是這個狀態——如果預設變成 0，所有人的事前提醒會靜靜地不生效。
  env.DB.prepare(
    'INSERT INTO reminder_feed (user_id, enabled, digest, updated_at) VALUES (?, 1, ?, 0)'
  ).bind('u1', JSON.stringify([d('明天的', '2026-08-22')])).run();

  const row = env.DB.prepare('SELECT lead_days FROM reminder_feed WHERE user_id = ?').bind('u1').first();
  assert.equal(row.lead_days, DEFAULT_LEAD_DAYS, 'schema 的預設值要與程式的預設值一致');

  await withMail(async sent => {
    assert.equal((await sendOverdueReminders(env, NOW)).sent, 1);
    assert.equal(sent.length, 1);
  });
});
