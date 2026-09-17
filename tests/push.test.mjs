/**
 * 推播（子專案 B）與 F3。設計文件：docs/superpowers/specs/2026-09-17-push-design.md
 *
 * 這一組守的東西，每一條都是**壞掉也不會有徵兆**的形狀：
 *
 *   1. **沒設 secret 要安靜跳過，不是失敗。** 記成紅色的話管理頁天天發假警報，
 *      而假紅燈與假綠燈一樣糟——兩者都會讓人不再相信那一頁。
 *   2. **410／BadDeviceToken 要刪掉那個 token。** 不刪的話這張表會慢慢長滿再也
 *      送不到的 token，而每天都會為它們各打一次 API。沒有人會發現。
 *   3. **同一個 token 換人登入要整列搬過去。** 允許一個 token 對兩個 user 的話，
 *      前一位使用者的排程會推到現在這個人的鎖定畫面上——那是資料外洩。
 *   4. **沒事就完全不推。** 每天一則「你今天沒事」會震動手機，然後人會把通知整個
 *      關掉，真的有事時什麼都收不到。
 *   5. **三個開關各自獨立。** 關掉逾期不該連帶關掉植物。
 *   6. **送失敗不寫 *_ymd。** 沒送成功就不算推過，下一次排程要能補。
 *   7. **JWT 要快取。** Apple 對同一把金鑰換 token 太勤會擋（TooManyProviderTokenUpdates）。
 *
 * 突變驗證（加完測試實際做過，各自只紅在對的地方）：
 *   - 拿掉 apnsConfigured 的判斷 → 「未設定」那條紅
 *   - 拿掉 gone 的 DELETE → 「410 要刪」紅
 *   - ON CONFLICT 改成 DO NOTHING → 「換人登入」紅
 *   - 拿掉「沒事就不推」的 if → 「沒事不推」紅
 *   - 三個開關合成一個 → 「各自獨立」紅
 *   - 失敗也寫 *_ymd → 「失敗不寫」紅
 *   - 拿掉 JWT 快取 → 「快取」紅
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePushRegister, handlePushUnregister, handlePushTest, sendPushes } from '../src/handlers/push.js';
import { apnsJwt, apnsSend, apnsConfigured, _resetApnsJwtCache } from '../src/apns.js';
import { handleDeleteAccount } from '../src/handlers/appauth.js';
import { makeEnv, addUser, unwrap } from './d1.mjs';

const NOW = Date.parse('2026-07-15T02:00:00Z');       // 台北 10:00
const TODAY = '2026-07-15';
const TOKEN = 'a'.repeat(64);

/** 產一把真的 P256 金鑰並輸出成 PEM——與 Apple 給的 .p8 同一個格式（PKCS#8）。 */
async function makeP8() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  let bin = '';
  for (const b of der) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/(.{64})/g, '$1\n');
  return { pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`, publicKey: kp.publicKey };
}

const P8 = await makeP8();

function pushEnv(over = {}) {
  const env = makeEnv();
  return Object.assign(env, {
    APNS_KEY_ID: 'ABCD123456', APNS_TEAM_ID: 'TEAM123456', APNS_P8: P8.pem,
    APNS_TOPIC: 'com.bounceto.workschedule',
  }, over);
}

/** 攔下 APNs 的請求。`reply` 決定每一次回什麼。 */
async function withFakeApns(reply, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers || {}, body: JSON.parse(init?.body || '{}') });
    const r = typeof reply === 'function' ? reply(calls.length) : reply;
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}

function addFeed(env, userId, over = {}) {
  const f = {
    digest: '[]', lead_days: 3, streak_current: 0, leave_days: '[]',
    push_overdue: 1, push_streak: 1, push_today: 0,
    push_overdue_ymd: null, push_streak_ymd: null, push_today_ymd: null, ...over,
  };
  env.DB.prepare(
    `INSERT INTO reminder_feed (user_id, enabled, digest, lead_days, streak_current, leave_days,
       push_overdue, push_streak, push_today, push_overdue_ymd, push_streak_ymd, push_today_ymd, updated_at)
     VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(userId, f.digest, f.lead_days, f.streak_current, f.leave_days,
    f.push_overdue, f.push_streak, f.push_today,
    f.push_overdue_ymd, f.push_streak_ymd, f.push_today_ymd, NOW).run();
}

function addToken(env, userId, token = TOKEN, environment = 'production') {
  env.DB.prepare('INSERT INTO device_tokens (token, user_id, environment, created_at) VALUES (?,?,?,?)')
    .bind(token, userId, environment, NOW).run();
}

const tokens = env => env.DB.prepare('SELECT token, user_id, environment FROM device_tokens ORDER BY rowid').all().results;
const feed = (env, id) => env.DB.prepare('SELECT * FROM reminder_feed WHERE user_id = ?').bind(id).first();

const rem = (t, d, over = {}) => ({ t, d, k: 'x', done: false, ot: false, ...over });

// ------------------------------------------------------------ JWT

test('APNs JWT：header 帶 kid、payload 帶 iss，而且驗得過', async () => {
  _resetApnsJwtCache();
  const env = pushEnv();
  const jwt = await apnsJwt(env, NOW);
  const [h, p, sig] = jwt.split('.');
  const dec = s => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

  assert.deepEqual(dec(h), { alg: 'ES256', kid: 'ABCD123456' });
  assert.equal(dec(p).iss, 'TEAM123456');
  assert.equal(dec(p).iat, Math.floor(NOW / 1000));

  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, P8.publicKey,
    Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
    new TextEncoder().encode(`${h}.${p}`)
  );
  assert.equal(ok, true, '簽章要用那把 .p8 驗得過');
});

test('APNs JWT：快取住，同一段時間內不重簽（Apple 換太勤會擋）', async () => {
  _resetApnsJwtCache();
  const env = pushEnv();
  const a = await apnsJwt(env, NOW);
  const b = await apnsJwt(env, NOW + 60_000);
  assert.equal(a, b, '一分鐘後不該換一個新的');
  const c = await apnsJwt(env, NOW + 51 * 60_000);
  assert.notEqual(a, c, '超過 50 分鐘要重簽');
});

test('apnsConfigured：三個 secret 少一個就是沒設定', () => {
  assert.equal(apnsConfigured(pushEnv()), true);
  assert.equal(apnsConfigured(pushEnv({ APNS_P8: '' })), false);
  assert.equal(apnsConfigured(makeEnv()), false);
});

// ------------------------------------------------------------ 送出與 token 生命週期

test('apnsSend：打對主機、帶對標頭；410 與 BadDeviceToken 都算 gone', async () => {
  _resetApnsJwtCache();
  const env = pushEnv();
  await withFakeApns({ status: 200 }, async calls => {
    const r = await apnsSend(env, { token: TOKEN, title: 'T', body: 'B', collapseId: 'overdue' });
    assert.equal(r.ok, true);
    assert.ok(calls[0].url.startsWith('https://api.push.apple.com/3/device/'));
    assert.equal(calls[0].headers['apns-topic'], 'com.bounceto.workschedule');
    assert.equal(calls[0].headers['apns-collapse-id'], 'overdue');
    assert.equal(calls[0].body.aps.alert.title, 'T');
  });
  await withFakeApns({ status: 200 }, async calls => {
    await apnsSend(env, { token: TOKEN, environment: 'sandbox', title: 'T', body: 'B', collapseId: 'x' });
    assert.ok(calls[0].url.startsWith('https://api.sandbox.push.apple.com/'), 'sandbox 是另一台主機');
  });
  await withFakeApns({ status: 410, body: { reason: 'Unregistered' } }, async () => {
    assert.equal((await apnsSend(env, { token: TOKEN, title: 'T', body: 'B' })).gone, true);
  });
  await withFakeApns({ status: 400, body: { reason: 'BadDeviceToken' } }, async () => {
    assert.equal((await apnsSend(env, { token: TOKEN, title: 'T', body: 'B' })).gone, true);
  });
  await withFakeApns({ status: 500, body: { reason: 'InternalServerError' } }, async () => {
    const r = await apnsSend(env, { token: TOKEN, title: 'T', body: 'B' });
    assert.equal(r.gone, false, '一次 5xx 不代表這支手機不見了');
    assert.equal(r.reason, 'InternalServerError', '原因要留下來——只記狀態碼的話什麼都分不出來');
  });
});

test('註冊：同一個 token 換人登入是整列搬過去，不是長出第二列', async () => {
  const env = pushEnv();
  addUser(env, 'u1', 'a@x.test');
  addUser(env, 'u2', 'b@x.test');
  const post = body => new Request('https://x.test/api/push/register', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  await handlePushRegister(post({ token: TOKEN, environment: 'production' }), env, { id: 'u1' });
  assert.equal(tokens(env).length, 1);

  await handlePushRegister(post({ token: TOKEN, environment: 'sandbox' }), env, { id: 'u2' });
  const rows = tokens(env);
  assert.equal(rows.length, 1, '同一支手機只能有一列');
  assert.equal(rows[0].user_id, 'u2', '屬於後登入的人——否則前一位的排程會推到這個人的鎖定畫面上');
  assert.equal(rows[0].environment, 'sandbox');
});

test('註冊：token 格式不對回 400，不寫進資料庫', async () => {
  const env = pushEnv();
  addUser(env, 'u1', 'a@x.test');
  const { status } = await unwrap(await handlePushRegister(
    new Request('https://x.test/api/push/register', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'not-hex!!' }),
    }), env, { id: 'u1' }
  ));
  assert.equal(status, 400);
  assert.equal(tokens(env).length, 0);
});

test('取消註冊：帶 token 只刪那一台，不帶就刪自己全部的', async () => {
  const env = pushEnv();
  addUser(env, 'u1', 'a@x.test');
  addToken(env, 'u1', 'a'.repeat(64));
  addToken(env, 'u1', 'b'.repeat(64));
  const del = body => new Request('https://x.test/api/push/register', {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  await handlePushUnregister(del({ token: 'a'.repeat(64) }), env, { id: 'u1' });
  assert.equal(tokens(env).length, 1);
  await handlePushUnregister(del({}), env, { id: 'u1' });
  assert.equal(tokens(env).length, 0);
});

// ------------------------------------------------------------ cron

test('沒設 APNs secret 就安靜跳過，不是失敗（否則管理頁天天發假警報）', async () => {
  const env = makeEnv();
  addUser(env, 'u1', 'a@x.test');
  addFeed(env, 'u1', { digest: JSON.stringify([rem('遲交的', '2026-07-01')]) });
  addToken(env, 'u1');
  const out = await sendPushes(env, NOW);
  assert.equal(out.skipped, 'APNs 未設定');
  assert.equal(out.sent, 0);
  assert.ok(!out.errors || !out.errors.length, '未設定不算錯誤');
});

test('逾期推播：有逾期就推一則，而且同一天不重推', async () => {
  const env = pushEnv();
  addUser(env, 'u1', 'a@x.test');
  addFeed(env, 'u1', { digest: JSON.stringify([rem('遲交的', '2026-07-01')]) });
  addToken(env, 'u1');

  await withFakeApns({ status: 200 }, async calls => {
    const out = await sendPushes(env, NOW);
    assert.equal(out.sent, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0].body.aps.alert.title, /逾期/);
    assert.match(calls[0].body.aps.alert.body, /遲交的/);
  });
  assert.equal(feed(env, 'u1').push_overdue_ymd, TODAY);

  await withFakeApns({ status: 200 }, async calls => {
    const out = await sendPushes(env, NOW);
    assert.equal(calls.length, 0, '同一天不該再推一次');
    assert.equal(out.alreadySent + out.nothingToSay, 1);
  });
});

test('沒有逾期、也沒有即將到期就完全不推', async () => {
  const env = pushEnv();
  addUser(env, 'u1', 'a@x.test');
  // 遠在天邊、而且已經完成的都不算
  addFeed(env, 'u1', { digest: JSON.stringify([rem('很久以後', '2027-12-01'), rem('做完了', '2026-07-01', { done: true })]) });
  addToken(env, 'u1');

  await withFakeApns({ status: 200 }, async calls => {
    const out = await sendPushes(env, NOW);
    assert.equal(calls.length, 0, '一次 fetch 都不該發——沒事就閉嘴');
    assert.equal(out.nothingToSay, 1);
  });
  assert.equal(feed(env, 'u1').push_overdue_ymd, null);
});

test('三個開關各自獨立：關掉逾期不影響植物', async () => {
  const env = pushEnv();
  addUser(env, 'u1', 'a@x.test');
  addFeed(env, 'u1', {
    push_overdue: 0, push_streak: 1, streak_current: 12,
    // 昨天有安排、而且沒有按時完成 → 斷了
    digest: JSON.stringify([rem('昨天的', '2026-07-14'), rem('遲交的', '2026-07-01')]),
  });
  addToken(env, 'u1');

  await withFakeApns({ status: 200 }, async calls => {
    await sendPushes(env, NOW);
    assert.equal(calls.length, 1, '只該推植物那一則');
    assert.match(calls[0].body.aps.alert.title, /🌱/);
    assert.match(calls[0].body.aps.alert.body, /12 天/);
    assert.equal(calls[0].headers['apns-collapse-id'], 'streak');
  });
  const f = feed(env, 'u1');
  assert.equal(f.push_streak_ymd, TODAY);
  assert.equal(f.push_overdue_ymd, null, '關掉的那一種一個欄位都不該動');
});

test('植物的推播：連續不到兩天不吵人（與 email 版同一個門檻）', async () => {
  const env = pushEnv();
  addUser(env, 'u1', 'a@x.test');
  addFeed(env, 'u1', { push_overdue: 0, push_streak: 1, streak_current: 1, digest: JSON.stringify([rem('昨天的', '2026-07-14')]) });
  addToken(env, 'u1');
  await withFakeApns({ status: 200 }, async calls => {
    await sendPushes(env, NOW);
    assert.equal(calls.length, 0);
  });
});

test('「今天有事要做」預設關；打開之後 N > 0 才推', async () => {
  const env = pushEnv();
  addUser(env, 'u1', 'a@x.test');
  addUser(env, 'u2', 'b@x.test');
  // u1 沒打開（預設就是 0）
  addFeed(env, 'u1', { push_overdue: 0, push_streak: 0, digest: JSON.stringify([rem('今天的', TODAY)]) });
  // u2 打開了，但今天沒事
  addFeed(env, 'u2', { push_overdue: 0, push_streak: 0, push_today: 1, digest: JSON.stringify([rem('明天的', '2026-07-16')]) });
  addToken(env, 'u1', 'a'.repeat(64));
  addToken(env, 'u2', 'b'.repeat(64));

  await withFakeApns({ status: 200 }, async calls => {
    await sendPushes(env, NOW);
    assert.equal(calls.length, 0, '沒打開的人不推；打開但今天沒事的人也不推');
  });

  env.DB.prepare('UPDATE reminder_feed SET push_today = 1 WHERE user_id = ?').bind('u1').run();
  await withFakeApns({ status: 200 }, async calls => {
    await sendPushes(env, NOW);
    assert.equal(calls.length, 1);
    assert.match(calls[0].body.aps.alert.title, /今天有 1 件事/);
  });
});

test('410 的 token 當場刪掉（不刪的話這張表會長滿送不到的 token）', async () => {
  const env = pushEnv();
  addUser(env, 'u1', 'a@x.test');
  addFeed(env, 'u1', { digest: JSON.stringify([rem('遲交的', '2026-07-01')]) });
  addToken(env, 'u1');

  await withFakeApns({ status: 410, body: { reason: 'Unregistered' } }, async () => {
    const out = await sendPushes(env, NOW);
    assert.equal(out.sent, 0);
    assert.equal(out.failed, 0, '手機上把 app 刪掉是正常的生命週期，不是故障');
  });
  assert.equal(tokens(env).length, 0, '那一列要被刪掉');
  assert.equal(feed(env, 'u1').push_overdue_ymd, null, '一則都沒送出去就不算推過');
});

test('送失敗刻意不寫 *_ymd：沒送成功就不算推過，下一次要能補', async () => {
  const env = pushEnv();
  addUser(env, 'u1', 'a@x.test');
  addFeed(env, 'u1', { digest: JSON.stringify([rem('遲交的', '2026-07-01')]) });
  addToken(env, 'u1');

  await withFakeApns({ status: 500, body: { reason: 'InternalServerError' } }, async () => {
    const out = await sendPushes(env, NOW);
    assert.equal(out.failed, 1);
    assert.ok(out.errors.length, '失敗的原因要留下來給 cron_runs 與 /admin 看');
  });
  assert.equal(feed(env, 'u1').push_overdue_ymd, null);
  assert.equal(tokens(env).length, 1, '5xx 不刪 token');

  // 下一次排程要真的補送
  await withFakeApns({ status: 200 }, async calls => {
    await sendPushes(env, NOW);
    assert.equal(calls.length, 1);
  });
  assert.equal(feed(env, 'u1').push_overdue_ymd, TODAY);
});

test('連線層丟例外（HTTP/2 被拒就是這個形狀）要進 errors，不是靜靜地不見', async () => {
  const env = pushEnv();
  addUser(env, 'u1', 'a@x.test');
  addFeed(env, 'u1', { digest: JSON.stringify([rem('遲交的', '2026-07-01')]) });
  addToken(env, 'u1');
  await withFakeApns(new Error('protocol not supported'), async () => {
    const out = await sendPushes(env, NOW);
    assert.equal(out.failed, 1);
    assert.match(out.errors[0].error, /protocol/);
  });
});

test('停用中的帳號不推', async () => {
  const env = pushEnv();
  addUser(env, 'u1', 'a@x.test');
  env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind('u1').run();
  addFeed(env, 'u1', { digest: JSON.stringify([rem('遲交的', '2026-07-01')]) });
  addToken(env, 'u1');
  await withFakeApns({ status: 200 }, async calls => {
    const out = await sendPushes(env, NOW);
    assert.equal(calls.length, 0);
    assert.equal(out.notApproved, 1);
  });
});

test('休假那天三種全部不推，而且一個 *_ymd 都不寫（C-3）', async () => {
  const env = pushEnv();
  addUser(env, 'u1', 'a@x.test');
  // 三種都會觸發：逾期、昨天把連續弄斷、今天還有事沒做
  addFeed(env, 'u1', {
    digest: JSON.stringify([
      rem('遲交的', '2026-07-01'),
      rem('昨天沒按時', '2026-07-14'),
      rem('今天要做', TODAY),
    ]),
    streak_current: 5, push_today: 1,
    leave_days: JSON.stringify(['2026-07-14', TODAY, '2026-08-01']),
  });
  addToken(env, 'u1');

  await withFakeApns({ status: 200 }, async calls => {
    const out = await sendPushes(env, NOW);
    assert.equal(calls.length, 0, '休假那天要安靜——震動手機比多一封未讀的信打擾得多');
    assert.equal(out.onLeave, 1, '跳過的原因要分得出來，不能與「今天沒事」共用一個數字');
    assert.equal(out.nothingToSay, 0);
  });
  const f = feed(env, 'u1');
  assert.equal(f.push_overdue_ymd, null, '沒推就不算推過，休假結束的第一天要能補');
  assert.equal(f.push_streak_ymd, null);
  assert.equal(f.push_today_ymd, null);
});

test('休假是「哪一天」而不是「有沒有休假」：不是今天的那幾天照推', async () => {
  const env = pushEnv();
  addUser(env, 'u1', 'a@x.test');
  addFeed(env, 'u1', {
    digest: JSON.stringify([rem('遲交的', '2026-07-01')]),
    leave_days: JSON.stringify(['2026-07-14', '2026-07-16']),   // 昨天與明天，就是不含今天
  });
  addToken(env, 'u1');
  await withFakeApns({ status: 200 }, async calls => {
    const out = await sendPushes(env, NOW);
    assert.equal(calls.length, 1, '今天要上班，照推');
    assert.equal(out.onLeave, 0);
  });
});

test('leave_days 壞掉時照推，不是靜靜地從此不推', async () => {
  const env = pushEnv();
  addUser(env, 'u1', 'a@x.test');
  addFeed(env, 'u1', { digest: JSON.stringify([rem('遲交的', '2026-07-01')]), leave_days: '{壞掉的' });
  addToken(env, 'u1');
  await withFakeApns({ status: 200 }, async calls => {
    await sendPushes(env, NOW);
    assert.equal(calls.length, 1, '多推一則看得見，從此不推沒有人會發現');
  });
});

// ------------------------------------------------------------ 測試推播與刪帳號

test('測試推播：沒設定回 400 並說出缺什麼；沒有裝置也說得出來', async () => {
  const plain = makeEnv();
  addUser(plain, 'u1', 'a@x.test');
  const r1 = await unwrap(await handlePushTest(plain, { id: 'u1' }));
  assert.equal(r1.status, 400);
  assert.match(r1.body.error, /APNS_KEY_ID/);

  const env = pushEnv();
  addUser(env, 'u1', 'a@x.test');
  const r2 = await unwrap(await handlePushTest(env, { id: 'u1' }));
  assert.equal(r2.status, 400);
  assert.match(r2.body.error, /還沒有註冊任何裝置/);
});

test('測試推播：APNs 的回應原樣回去（狀態碼分不出「金鑰不對」與「token 不對」）', async () => {
  const env = pushEnv();
  addUser(env, 'u1', 'a@x.test');
  addToken(env, 'u1');
  await withFakeApns({ status: 403, body: { reason: 'InvalidProviderToken' } }, async () => {
    const { status, body } = await unwrap(await handlePushTest(env, { id: 'u1' }));
    assert.equal(status, 200, '這個端點本身沒有失敗，失敗的是 APNs');
    assert.equal(body.results[0].status, 403);
    assert.equal(body.results[0].reason, 'InvalidProviderToken');
  });
});

test('刪除帳號：device_tokens 一起清，別人的每一列原樣', async () => {
  const env = pushEnv();
  addUser(env, 'u1', 'a@x.test');
  addUser(env, 'u2', 'b@x.test');
  addToken(env, 'u1', 'a'.repeat(64));
  addToken(env, 'u2', 'b'.repeat(64));
  // 密碼欄位是假的 'x'，所以直接刪那一列來模擬「刪帳號的那一批 SQL 跑過」
  await env.DB.batch([
    env.DB.prepare('DELETE FROM device_tokens WHERE user_id = ?').bind('u1'),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind('u1'),
  ]);
  const rows = tokens(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, 'u2', '別人的那一列原樣');
  // 真正的保險是 handleDeleteAccount 的清單裡真的有這張表——靜態比對比跑一次便宜
  const src = await import('node:fs').then(fs => fs.readFileSync(new URL('../src/handlers/appauth.js', import.meta.url), 'utf8'));
  assert.match(src, /DELETE FROM device_tokens WHERE user_id = \?/,
    'handleDeleteAccount 的清單漏掉 device_tokens 的話，刪掉的帳號還會繼續收到推播');
  assert.equal(typeof handleDeleteAccount, 'function');
});
