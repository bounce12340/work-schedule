/**
 * agent 問了問題／提了提案要通知到人（第一批 1B，設計文件 5-2）。
 *
 * 守的東西，壞掉時大多**沒有任何徵兆**（信不來、或多寄、或把不該寄出去的字寄出去）：
 *   1. 信與推播裡**絕不出現問題或提案的全文**（那是 agent 寫的外部內容，鎖定畫面別人也看得到）
 *   2. 同一個專案 30 分鐘內最多一封，多的併進 pending，之後由 cron 合併成「還有 N 件」
 *   3. 休假那天不送、只累計；休假結束後補上
 *   4. 送失敗不寫 last_sent_at（沒送成功就不算送過）；寫了就補不回來
 *   5. 開關關著什麼都不做；退訂 kind='agent' 只關這一顆，不與另兩種連坐
 *   6. 是訂閱信：不走交易信的寄件帳號、帶 List-Unsubscribe
 *   7. 有 device token 就同時推播（同一個開關）
 *   8. 自動暫停的那一刻通知；通知失敗不能讓 agent 的提問變成錯誤
 *   9. /api/state/version：只回數字、不把使用者自己的動作算成「agent 剛更新」、只看自己的列
 *
 * 突變驗證（加完實際做過，各自只紅在對的地方）：
 *   - buildAgentEmail 把問題內文放進信 → 「不放全文」紅
 *   - 拿掉 30 分鐘的判斷 → 「節流」紅
 *   - 拿掉 isOnLeave → 「休假」紅
 *   - 送失敗也留著 last_sent_at（拿掉 rollback）→ 「失敗不寫」紅
 *   - 拿掉 agent_notify 的檢查 → 「關著不送」紅
 *   - 把 'agent' 加進 TX_KINDS → 「訂閱信」紅
 *   - UNSUB_KINDS.agent 指到 enabled → 「退訂只關這一顆」紅
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, addUser, seedState, unwrap } from './d1.mjs';
import { handleMcp, handleActivityUndo } from '../src/mcp/server.js';
import { handleCreateKey } from '../src/mcp/auth.js';
import { handleConnectionSettings, handleStateVersion, handleAgentEventsExport, handleAnswerEvent } from '../src/handlers/agent.js';
import { handleReminderStatus, handleReminderEnable, handleUnsubscribe, handleUnsubscribeOneClick } from '../src/handlers/reminder.js';
import { notifyAgentAsk, sendAgentNotifyPending, agentAskLine, AGENT_NOTIFY_MIN_GAP_MS } from '../src/handlers/agentnotify.js';
import { _resetApnsJwtCache } from '../src/apns.js';
import { step } from '../src/index.js';

const NOW = Date.parse('2026-07-15T02:00:00Z');           // 台北 10:00
const TODAY = '2026-07-15';
const SECRET = '機敏內文-不能出現在信裡-sk_live_123';
const MAIL_ENV = { AGENTMAIL_API_KEY: 'am_test_key', AGENTMAIL_INBOX_ID: 'shared@agentmail.test', APP_URL: 'https://app.test' };

async function makeP8() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  let bin = ''; for (const b of der) bin += String.fromCharCode(b);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(bin).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
}
const P8 = await makeP8();

function proUser(env, id, email) {
  addUser(env, id, email);
  env.DB.prepare("UPDATE users SET plan_source = 'admin' WHERE id = ?").bind(id).run();
  return { id, email, role: 'user', status: 'approved', planSource: 'admin', planExpiresAt: null };
}
const baseState = () => ({ version: 3, majorProjects: [], items: [], ganttProjects: [
  { id: 'gp_1', name: '新廠', notes: '', pet: null, brief: '', tasks: [
    { id: 'task_1', name: '設計', start: '2026-01-01', end: '2026-12-31', progress: 0, done: false, todos: [], status: 'todo', blockedNote: '' },
  ] },
  { id: 'gp_2', name: '舊廠', notes: '', pet: null, brief: '', tasks: [] },
], dailyLogs: {}, customHolidays: [], customWorkdays: [], absences: {} });

/** 攔 fetch：AgentMail 記信、APNs 記推播。`mailStatus` 可以讓寄信失敗 */
async function withFakes(opts, fn) {
  const real = globalThis.fetch;
  const mails = [], pushes = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('agentmail.to')) {
      mails.push({ url: u, body: JSON.parse(init.body), auth: init.headers.authorization });
      const st = typeof opts.mailStatus === 'function' ? opts.mailStatus(mails.length) : (opts.mailStatus ?? 200);
      return new Response(st === 200 ? '{"ok":true}' : '{"error":"x"}', { status: st });
    }
    if (u.includes('apple.com')) {
      pushes.push({ url: u, body: JSON.parse(init.body) });
      return new Response('{}', { status: 200 });
    }
    throw new Error('unexpected fetch ' + u);
  };
  try { return await fn({ mails, pushes }); } finally { globalThis.fetch = real; }
}

/** 一個 Pro 使用者、一份 state、一份 reminder_feed（要有退訂 token 之外的偏好） */
function setup(feedOver = {}, envOver = {}) {
  const env = Object.assign(makeEnv(), MAIL_ENV, envOver);
  const u = proUser(env, 'u1', 'a@x.test');
  seedState(env, 'u1', baseState(), 1000);
  const f = { agent_notify: 1, leave_days: '[]', ...feedOver };
  env.DB.prepare('INSERT INTO reminder_feed (user_id, enabled, digest, leave_days, agent_notify, updated_at) VALUES (?,1,?,?,?,?)')
    .bind('u1', '[]', f.leave_days, f.agent_notify, NOW).run();
  return { env, u };
}
const feed = env => env.DB.prepare('SELECT * FROM reminder_feed WHERE user_id = ?').bind('u1').first();
const stRow = (env, pid = 'gp_1') => env.DB.prepare('SELECT * FROM agent_notify_state WHERE user_id = ? AND project_id = ?').bind('u1', pid).first();
const whole = m => JSON.stringify(m.body);

let rid = 0;
async function keyFor(env, user, name = 'Claude') {
  const { body } = await unwrap(await handleCreateKey(new Request('https://x.test/api/mcp/keys', { method: 'POST', body: JSON.stringify({ name }) }), env, user));
  return body.token;
}
async function call(env, token, name, args = {}) {
  const res = await handleMcp(new Request('https://x.test/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }),
  }), env);
  const b = await res.json();
  return { isError: !!b.result?.isError, data: b.result?.structuredContent };
}
const post = body => new Request('https://x.test/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

// ------------------------------------------------------------ 1. 不放全文

test('信與推播裡絕不出現問題的全文（主旨、純文字、HTML、推播都查）', async () => {
  const { env, u } = setup();
  env.DB.prepare("INSERT INTO device_tokens (token, user_id, environment, created_at) VALUES (?, 'u1', 'production', 0)").bind('a'.repeat(64)).run();
  Object.assign(env, { APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_P8: P8 });
  _resetApnsJwtCache();
  const t = await keyFor(env, u, 'Claude Code');
  await withFakes({}, async ({ mails, pushes }) => {
    const r = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'question', body: SECRET, options: ['甲案', '乙案'] });
    assert.equal(r.isError, false);
    assert.equal(mails.length, 1);
    assert.ok(!whole(mails[0]).includes('sk_live'), '信裡不能有問題內文');
    assert.ok(!whole(mails[0]).includes('機敏內文'));
    assert.ok(!whole(mails[0]).includes('甲案'), '選項也是外部內容');
    assert.match(mails[0].body.subject, /Claude Code 在「新廠」等你決定 1 件事/);
    assert.equal(pushes.length, 1, '有 device token 就同時推播');
    assert.ok(!JSON.stringify(pushes[0].body).includes('sk_live'), '推播裡也不能有');
    assert.match(JSON.stringify(pushes[0].body), /新廠/);
  });
  // 提案同樣不放標題與內容
  await handleConnectionSettings(post({ mode: 'review' }), env, u, env.DB.prepare('SELECT id FROM mcp_connections').first().id);
  await withFakes({}, async ({ mails }) => {
    env.DB.prepare('DELETE FROM agent_notify_state').run();
    const r = await call(env, t, 'propose_changes', { title: SECRET, ops: [{ tool: 'update_gantt_task', args: { projectId: 'gp_1', taskId: 'task_1', name: SECRET } }] });
    assert.equal(r.isError, false);
    assert.equal(mails.length, 1);
    assert.ok(!whole(mails[0]).includes('sk_live'), '提案的標題與改動內容也不能在信裡');
    assert.match(mails[0].body.subject, /等你決定/);
  });
});

test('連線名稱是外部來的字串：HTML 裡跳脫、換行去掉', async () => {
  const { env } = setup();
  await withFakes({}, async ({ mails }) => {
    await notifyAgentAsk(env, 'u1', 'gp_1', '<img src=x onerror=alert(1)>\n惡意', NOW);
    assert.equal(mails.length, 1);
    assert.ok(!mails[0].body.html.includes('<img'), '名稱要跳脫');
    assert.ok(!/\n惡意/.test(mails[0].body.subject), '主旨不能有換行');
  });
});

test('沒有專案的提案（project_id 空）：話術不寫「在「」」', () => {
  assert.equal(agentAskLine('Claude', null, 2), 'Claude 有 2 件事等你決定');
  assert.equal(agentAskLine('Claude', '新廠', 2), 'Claude 在「新廠」等你決定 2 件事');
});

// ------------------------------------------------------------ 2. 節流與合併

test('節流：同一個專案 30 分鐘內最多一封，多的併進 pending；別的專案各自算', async () => {
  const { env } = setup();
  await withFakes({}, async ({ mails }) => {
    assert.equal((await notifyAgentAsk(env, 'u1', 'gp_1', 'Claude', NOW)).action, 'sent');
    assert.equal((await notifyAgentAsk(env, 'u1', 'gp_1', 'Claude', NOW + 60_000)).action, 'throttled');
    assert.equal((await notifyAgentAsk(env, 'u1', 'gp_1', 'Claude', NOW + 29 * 60_000)).action, 'throttled');
    assert.equal(mails.length, 1, 'agent 連問三題不該是三封信');
    assert.equal(stRow(env).pending, 2, '被擋下的兩件記在 pending');
    // 別的專案不受影響
    assert.equal((await notifyAgentAsk(env, 'u1', 'gp_2', 'Claude', NOW + 60_000)).action, 'sent');
    assert.equal(mails.length, 2);
    // 超過 30 分鐘：下一次提問把累計的一起講
    assert.equal((await notifyAgentAsk(env, 'u1', 'gp_1', 'Claude', NOW + AGENT_NOTIFY_MIN_GAP_MS + 1)).action, 'sent');
    assert.equal(mails.length, 3);
    assert.match(mails[2].body.subject, /還有 3 件/);
    assert.equal(stRow(env).pending, 0);
  });
});

test('cron 補送：被節流擋下來的合併成「還有 N 件」；30 分鐘還沒到的不送', async () => {
  const { env } = setup();
  await withFakes({}, async ({ mails }) => {
    await notifyAgentAsk(env, 'u1', 'gp_1', 'Claude', NOW);
    await notifyAgentAsk(env, 'u1', 'gp_1', 'Claude', NOW + 1000);
    await notifyAgentAsk(env, 'u1', 'gp_1', 'Claude', NOW + 2000);
    assert.equal(mails.length, 1);
    const early = await sendAgentNotifyPending(env, NOW + 10 * 60_000);
    assert.equal(early.checked, 0, '還沒滿 30 分鐘');
    const out = await sendAgentNotifyPending(env, NOW + 31 * 60_000);
    assert.equal(out.sent, 1);
    assert.equal(mails.length, 2);
    assert.match(mails[1].body.subject, /還有 2 件/);
    assert.ok(!whole(mails[1]).includes('sk_live'));
    assert.equal(stRow(env).pending, 0);
    // 沒有 pending 就不再送
    assert.equal((await sendAgentNotifyPending(env, NOW + 99 * 60_000)).checked, 0);
  });
});

test('併發：兩個同時進來的提問只有一個領得到那封信（compare-and-swap）', async () => {
  const { env } = setup();
  await withFakes({}, async ({ mails }) => {
    const rs = await Promise.all([1, 2, 3].map(() => notifyAgentAsk(env, 'u1', 'gp_1', 'Claude', NOW)));
    assert.equal(mails.length, 1, '平行問三題不該是三封信');
    assert.equal(rs.filter(r => r.action === 'sent').length, 1);
  });
});

// ------------------------------------------------------------ 3. 休假

test('休假那天不送、只累計；cron 當天也不補；休假過了由 cron 補上（還有 N 件）', async () => {
  const { env } = setup({ leave_days: JSON.stringify([TODAY]) });
  await withFakes({}, async ({ mails }) => {
    assert.equal((await notifyAgentAsk(env, 'u1', 'gp_1', 'Claude', NOW)).action, 'leave');
    assert.equal((await notifyAgentAsk(env, 'u1', 'gp_1', 'Claude', NOW + 3600_000)).action, 'leave');
    assert.equal(mails.length, 0);
    const row = stRow(env);
    assert.equal(row.pending, 2);
    assert.equal(row.last_sent_at, null, '沒送就不寫 last_sent_at');
    const sameDay = await sendAgentNotifyPending(env, NOW + 5 * 3600_000);
    assert.equal(sameDay.onLeave, 1);
    assert.equal(mails.length, 0);
    // 隔天
    const next = await sendAgentNotifyPending(env, NOW + 24 * 3600_000);
    assert.equal(next.sent, 1);
    assert.match(mails[0].body.subject, /還有 2 件/);
  });
});

test('休假只看「今天」：別的日子休假照送；壞掉的 leave_days 當成沒休假', async () => {
  const { env } = setup({ leave_days: JSON.stringify(['2026-07-16']) });
  await withFakes({}, async ({ mails }) => {
    assert.equal((await notifyAgentAsk(env, 'u1', 'gp_1', 'Claude', NOW)).action, 'sent');
    env.DB.prepare("UPDATE reminder_feed SET leave_days = '{壞掉'").run();
    assert.equal((await notifyAgentAsk(env, 'u1', 'gp_2', 'Claude', NOW)).action, 'sent');
    assert.equal(mails.length, 2);
  });
});

// ------------------------------------------------------------ 4. 失敗

test('送失敗不寫 last_sent_at、pending 照留；下一次要能補', async () => {
  const { env } = setup();
  await withFakes({ mailStatus: 403 }, async ({ mails }) => {
    assert.equal((await notifyAgentAsk(env, 'u1', 'gp_1', 'Claude', NOW)).action, 'failed');
    assert.equal(mails.length, 1);
    const row = stRow(env);
    assert.equal(row.last_sent_at, null, '沒送成功就不算送過');
    assert.equal(row.pending, 1);
  });
  await withFakes({}, async ({ mails }) => {
    // 緊接著下一次提問就能送（不是被 30 分鐘擋住），而且把前一件一起講
    assert.equal((await notifyAgentAsk(env, 'u1', 'gp_1', 'Claude', NOW + 1000)).action, 'sent');
    assert.match(mails[0].body.subject, /還有 2 件/);
  });
});

test('cron 補送失敗：記進 errors[]，step() 因此不會記成乾淨的成功', async () => {
  const { env } = setup();
  await withFakes({}, async () => { await notifyAgentAsk(env, 'u1', 'gp_1', 'Claude', NOW); await notifyAgentAsk(env, 'u1', 'gp_1', 'Claude', NOW + 1); });
  await withFakes({ mailStatus: 500 }, async () => {
    const out = await sendAgentNotifyPending(env, NOW + 31 * 60_000);
    assert.equal(out.failed, 1);
    assert.ok(out.errors.length >= 1);
    assert.equal(stRow(env).pending, 1);
    await step(env, 'agent_notify', async () => out);
    assert.equal(env.DB.prepare("SELECT ok FROM cron_runs WHERE step = 'agent_notify'").first().ok, 0);
  });
});

test('通知寄不出去不能讓 agent 的提問變成錯誤（提問已經寫進去了，回錯誤會讓它重送而問兩次）', async () => {
  const { env, u } = setup();
  const t = await keyFor(env, u);
  await withFakes({ mailStatus: 500 }, async () => {
    const r = await call(env, t, 'add_project_event', { projectId: 'gp_1', kind: 'question', body: '要不要？' });
    assert.equal(r.isError, false);
    assert.equal(env.DB.prepare("SELECT COUNT(*) AS n FROM project_events WHERE kind = 'question'").first().n, 1);
  });
});

// ------------------------------------------------------------ 5. 開關與退訂

test('開關關著什麼都不送、也不累計 pending；沒有 reminder_feed 那一列＝開', async () => {
  const { env } = setup({ agent_notify: 0 });
  await withFakes({}, async ({ mails }) => {
    assert.equal((await notifyAgentAsk(env, 'u1', 'gp_1', 'Claude', NOW)).action, 'off');
    assert.equal(mails.length, 0);
    assert.equal(stRow(env), null);
  });
  // 沒有那一列
  const env2 = Object.assign(makeEnv(), MAIL_ENV);
  proUser(env2, 'u1', 'a@x.test'); seedState(env2, 'u1', baseState(), 1);
  await withFakes({}, async ({ mails }) => {
    assert.equal((await notifyAgentAsk(env2, 'u1', 'gp_1', 'Claude', NOW)).action, 'sent');
    assert.equal(mails.length, 1);
    // 順手建了那一列，退訂 token 有地方存（沒有的話信裡的連結是一個不存在的 token）
    const token = env2.DB.prepare('SELECT unsub_token FROM reminder_feed WHERE user_id = ?').bind('u1').first().unsub_token;
    assert.ok(token && token.length >= 20);
    assert.match(mails[0].body.text, new RegExp('/unsub\\?t=' + token + '&k=agent'));
  });
});

test('cron：開關後來關掉的，pending 清掉（再打開時不該收到一封過期的信）', async () => {
  const { env } = setup();
  await withFakes({}, async ({ mails }) => {
    await notifyAgentAsk(env, 'u1', 'gp_1', 'Claude', NOW);
    await notifyAgentAsk(env, 'u1', 'gp_1', 'Claude', NOW + 1);
    env.DB.prepare('UPDATE reminder_feed SET agent_notify = 0').run();
    const out = await sendAgentNotifyPending(env, NOW + 31 * 60_000);
    assert.equal(out.off, 1);
    assert.equal(mails.length, 1);
    assert.equal(stRow(env).pending, 0);
  });
});

test('是訂閱信：不走交易信的寄件帳號（退訂名單該擋得住它）、帶 List-Unsubscribe 兩個標頭', async () => {
  const { env } = setup({}, { AGENTMAIL_TX_API_KEY: 'am_tx', AGENTMAIL_TX_INBOX_ID: 'tx@agentmail.test' });
  await withFakes({}, async ({ mails }) => {
    await notifyAgentAsk(env, 'u1', 'gp_1', 'Claude', NOW);
    assert.match(mails[0].url, /shared%40agentmail\.test/, '走共用那一組，不是交易信那一組');
    assert.equal(mails[0].auth, 'Bearer am_test_key');
    const h = mails[0].body.headers;
    assert.match(h['List-Unsubscribe'], /\/api\/unsub\/one-click\?t=.+&k=agent>/);
    assert.equal(h['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.match(mails[0].body.html, /k=agent/);
    assert.ok(!/k=reminder|k=streak/.test(mails[0].body.html));
  });
  assert.equal(env.DB.prepare("SELECT kind FROM mail_log").first().kind, 'agent');
});

test('退訂 kind=agent：只關 agent 通知，逾期提醒與櫻花樹的信一個位元都沒動；一鍵退訂也一樣', async () => {
  const { env } = setup();
  await withFakes({}, async ({ mails }) => { await notifyAgentAsk(env, 'u1', 'gp_1', 'Claude', NOW); });
  const token = feed(env).unsub_token;
  const res = await unwrap(await handleUnsubscribe(new Request('https://x.test/api/unsub', { method: 'POST', body: JSON.stringify({ token, kind: 'agent' }) }), env));
  assert.equal(res.body.ok, true);
  let row = feed(env);
  assert.equal(row.agent_notify, 0);
  assert.equal(row.enabled, 1, '逾期提醒沒動');
  assert.equal(row.streak_mail, 1, '櫻花樹的信沒動');
  // 反方向：退訂逾期提醒不連坐 agent 通知
  env.DB.prepare('UPDATE reminder_feed SET agent_notify = 1').run();
  await handleUnsubscribe(new Request('https://x.test/api/unsub', { method: 'POST', body: JSON.stringify({ token, kind: 'reminder' }) }), env);
  assert.equal(feed(env).agent_notify, 1, '退訂別種不連坐 agent');
  // 一鍵退訂（郵件軟體那顆按鈕）走同一支
  const oc = await handleUnsubscribeOneClick(new URL(`https://x.test/api/unsub/one-click?t=${token}&k=agent`), env);
  assert.equal(oc.status, 200);
  assert.equal(feed(env).agent_notify, 0);
  // 關掉之後不再收到
  await withFakes({}, async ({ mails }) => {
    assert.equal((await notifyAgentAsk(env, 'u1', 'gp_2', 'Claude', NOW + 99 * 3600_000)).action, 'off');
    assert.equal(mails.length, 0);
  });
});

test('/api/reminder：agentNotify 預設開；單獨切它；其他五顆的送出不會順手改掉它；「全部都不要了」會關它', async () => {
  const env = makeEnv(); const u = proUser(env, 'u1', 'a@x.test');
  const status = async () => (await unwrap(await handleReminderStatus(env, u))).body;
  assert.equal((await status()).agentNotify, true, '沒有那一列也是開');
  const enable = body => handleReminderEnable(post(body), env, u);
  await enable({ enabled: true, leadDays: 3 });
  assert.equal((await status()).agentNotify, true);
  await enable({ enabled: true, leadDays: 3, agentNotify: false });
  assert.equal((await status()).agentNotify, false);
  // 別的開關的送出（沒帶 agentNotify）不能把它打開
  await enable({ enabled: true, leadDays: 3, streakMail: false, pushOverdue: true });
  assert.equal((await status()).agentNotify, false);
  await enable({ enabled: true, leadDays: 3, agentNotify: true });
  assert.equal((await status()).agentNotify, true);
  await enable({ enabled: false, leadDays: 3, streakMail: false, pushOverdue: false, pushStreak: false, pushToday: false, agentNotify: false });
  const s = await status();
  assert.deepEqual([s.enabled, s.streakMail, s.pushOverdue, s.pushStreak, s.pushToday, s.agentNotify], [false, false, false, false, false, false]);
});

// ------------------------------------------------------------ 6. 自動暫停

test('自動暫停的那一刻寄一封信（同一個開關）；開關關著就不寄；信裡說得出是哪一條連線', async () => {
  const { env, u } = setup();
  const t = await keyFor(env, u, '實驗用 agent');
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await call(env, t, 'create_item', { title: 'n' + i, date: '2026-02-01' })).data.changeId);
  await withFakes({}, async ({ mails }) => {
    for (let i = 0; i < 4; i++) await handleActivityUndo(env, u, ids[i]);
    assert.equal(mails.length, 0, '還沒到 5 次不寄');
    const r = await unwrap(await handleActivityUndo(env, u, ids[4]));
    assert.equal(r.body.autoPaused, true);
    assert.equal(mails.length, 1);
    assert.match(mails[0].body.subject, /已自動暫停「實驗用 agent」/);
    assert.match(mails[0].body.html, /k=agent/, '訂閱信：帶退訂連結');
  });
  // 開關關著
  const e2 = setup({ agent_notify: 0 });
  const t2 = await keyFor(e2.env, e2.u);
  const ids2 = [];
  for (let i = 0; i < 5; i++) ids2.push((await call(e2.env, t2, 'create_item', { title: 'n' + i, date: '2026-02-01' })).data.changeId);
  await withFakes({}, async ({ mails }) => {
    for (const id of ids2) await handleActivityUndo(e2.env, e2.u, id);
    assert.equal(e2.env.DB.prepare('SELECT paused_reason AS r FROM mcp_connections').first().r, 'auto');
    assert.equal(mails.length, 0);
  });
});

// ------------------------------------------------------------ 7. 版本端點與匯出

test('/api/state/version：updatedAt 與 agent 那一側最新的動靜；使用者自己的回答不算；提案算；別人的不算', async () => {
  const { env, u } = setup();
  proUser(env, 'u2', 'b@x.test'); seedState(env, 'u2', baseState(), 9);
  const ver = async () => (await unwrap(await handleStateVersion(env, u))).body;
  assert.deepEqual(await ver(), { updatedAt: 1000, latestEventAt: null });
  const ins = (id, actor, at, uid = 'u1') => env.DB.prepare(
    "INSERT INTO project_events (id, user_id, project_id, kind, actor, body, created_at) VALUES (?, ?, 'gp_1', 'progress', ?, 'x', ?)").bind(id, uid, actor, at).run();
  ins('e1', 'Claude', 5000);
  assert.equal((await ver()).latestEventAt, 5000);
  ins('e2', 'user', 9000);                 // 自己的動作不算
  assert.equal((await ver()).latestEventAt, 5000, '使用者自己寫的不能觸發「agent 剛更新了」');
  ins('e3', 'Claude', 99999, 'u2');        // 別人的
  assert.equal((await ver()).latestEventAt, 5000);
  env.DB.prepare("INSERT INTO mcp_proposals (id, user_id, actor, title, ops, status, created_at) VALUES ('p1','u1','Claude','t','[]','open',7000)").run();
  assert.equal((await ver()).latestEventAt, 7000, '新提案也算（它不改 state、不寫日誌）');
  // 只回兩個數字，沒有任何內容
  assert.deepEqual(Object.keys(await ver()).sort(), ['latestEventAt', 'updatedAt']);
});

test('匯出用的日誌端點：只回自己的、被遮蔽的內容是空的', async () => {
  const { env, u } = setup();
  proUser(env, 'u2', 'b@x.test');
  const ins = (id, uid, body, red) => env.DB.prepare(
    "INSERT INTO project_events (id, user_id, project_id, kind, actor, body, redacted_at, created_at) VALUES (?, ?, 'gp_1', 'progress', 'Claude', ?, ?, ?)").bind(id, uid, body, red, Date.now()).run();
  ins('a', 'u1', '我的', null); ins('b', 'u1', '', 123); ins('c', 'u2', '別人的機密', null);
  const r = (await unwrap(await handleAgentEventsExport(env, u))).body;
  assert.deepEqual(r.events.map(e => e.id).sort(), ['a', 'b']);
  assert.ok(!JSON.stringify(r).includes('別人的機密'));
  assert.equal(r.events.find(e => e.id === 'b').body, '');
});

test('使用者回答問題不會觸發通知（寄信的只有 agent 那一側）', async () => {
  const { env, u } = setup();
  env.DB.prepare("INSERT INTO project_events (id, user_id, project_id, kind, actor, body, status, created_at) VALUES ('q1','u1','gp_1','question','Claude','?','open',1)").run();
  await withFakes({}, async ({ mails }) => {
    const r = await unwrap(await handleAnswerEvent(post({ body: '好' }), env, u, 'q1'));
    assert.equal(r.status, 200);
    assert.equal(mails.length, 0);
  });
});
