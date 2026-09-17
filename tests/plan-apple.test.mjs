/**
 * E2／E3：app 推上來的訂閱交易，與 Apple 的伺服器通知。
 *
 * 這一組守的東西，全部都是**錯了不會有徵兆**的形狀——這正是它們需要測試的理由：
 *
 *   1. **只往後不往前。** app 啟動時把 currentEntitlements 整批送上來，順序不保證。
 *      少了這條，最舊的那一筆會把最新的到期日蓋掉，使用者付了錢卻在幾天後被降級。
 *   2. **退款要往前寫。** 它是「只往後」唯一的例外；漏掉的話退了款的人繼續是 Pro。
 *   3. **管理者的永久方案不被 Apple 蓋掉。** 永久帳號的主人在 app 裡試訂一次再取消，
 *      到期那天就被降回免費——而他從來沒有要求過那件事。
 *   4. **同一份訂閱綁到第二個帳號是「搬過去」不是拒絕。** 訂閱屬於 Apple ID，換帳號
 *      恢復購買是 Apple 設想中的正常操作；拒絕的話使用者會覺得自己付的錢不見了。
 *   5. **通知一律回 200 除了驗簽失敗。** 回 5xx Apple 會重送，而「這筆我不認得」重送
 *      十次也不會變成認得。
 *   6. **productId 白名單。** 不是「有 expiresDate 就算」——日後多一個別的訂閱，不該
 *      讓它也解鎖 Pro。
 *
 * 突變驗證（加完測試實際做過，每一條各自只紅在對的地方）：
 *   - 拿掉 applyEntitlement 的 goesBackwards 判斷 → 「只往後」紅
 *   - 把 revoked 的例外拿掉 → 「退款往前寫」紅
 *   - 拿掉 plan_source === 'admin' 那一段 → 「永久不被蓋」紅
 *   - 把搬移的 UPDATE 拿掉 → 「搬過去」紅
 *   - 驗簽失敗改成回 200 → 「驗簽失敗 401 且零筆事件」紅
 *   - PRODUCT_IDS 改成不檢查 → 「不認得的商品」紅
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePlanApple, handleAppleNotification, PRODUCT_IDS } from '../src/handlers/planapple.js';
import { verifySubscriptionTransaction } from '../src/apppurchase.js';
import { APP_BUNDLE_ID } from '../src/handlers/appauth.js';
import { planOf } from '../src/plan.js';
import { makeEnv, addUser, unwrap } from './d1.mjs';
import { makeFakeApple } from './fake-apple.mjs';

const apple = await makeFakeApple();
const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;
const MONTHLY = 'com.bounceto.workschedule.pro.monthly';
const YEARLY = 'com.bounceto.workschedule.pro.yearly';

/** 一段 Apple 簽的訂閱交易。預設是「一個月後到期的月費」。 */
function txnJws(over = {}) {
  return apple.signJws({
    bundleId: APP_BUNDLE_ID,
    environment: 'Production',
    productId: MONTHLY,
    originalTransactionId: '2000000000000001',
    transactionId: '2000000000000009',
    expiresDate: NOW + 30 * DAY,
    // AppTransaction 才有的欄位要清掉，免得看起來像另一種東西
    appTransactionId: undefined,
    receiptType: undefined,
    ...over,
  });
}

/** 一則 Apple 的伺服器通知（外層 JWS 包一層內層 JWS）。 */
async function notifyJws({ notificationType = 'DID_RENEW', subtype = '', uuid = 'uuid-1', txn = {} } = {}) {
  const inner = await txnJws(txn);
  return apple.signJws({
    notificationType,
    subtype,
    notificationUUID: uuid,
    data: {
      bundleId: APP_BUNDLE_ID,
      environment: 'Production',
      signedTransactionInfo: inner,
    },
    bundleId: undefined,
    appTransactionId: undefined,
    receiptType: undefined,
  });
}

function makeAppleEnv() {
  const env = makeEnv();
  env.__testAppleRootDer = apple.rootDer;   // 正式路徑永遠用內建的 Apple 根
  return env;
}

function post(url, body) {
  return new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

function userRow(env, id) {
  return env.DB.prepare('SELECT plan_source, plan_expires_at, apple_original_txn FROM users WHERE id = ?').bind(id).first();
}

function events(env) {
  return env.DB.prepare('SELECT user_id, source, kind, notification_uuid, expires_at, detail FROM plan_events ORDER BY rowid').all().results;
}

// ------------------------------------------------------------ 驗簽那一層

test('訂閱交易：驗得過，而且讀出來的欄位就是簽進去的那些', async () => {
  const r = await verifySubscriptionTransaction(await txnJws(), { bundleId: APP_BUNDLE_ID, trustedRootDer: apple.rootDer });
  assert.equal(r.ok, true);
  assert.equal(r.productId, MONTHLY);
  assert.equal(r.originalTransactionId, '2000000000000001');
  assert.equal(r.expiresDate, NOW + 30 * DAY);
  assert.equal(r.revocationDate, null);
});

test('訂閱交易：沒有 expiresDate 就不是訂閱，判成 format', async () => {
  const r = await verifySubscriptionTransaction(await txnJws({ expiresDate: undefined }), { bundleId: APP_BUNDLE_ID, trustedRootDer: apple.rootDer });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'format');
});

test('訂閱交易：bundleId 不對、Sandbox 未放行都要擋', async () => {
  const opts = { bundleId: APP_BUNDLE_ID, trustedRootDer: apple.rootDer };
  assert.equal((await verifySubscriptionTransaction(await txnJws({ bundleId: 'com.someone.else' }), opts)).reason, 'bundle');
  const sandbox = await txnJws({ environment: 'Sandbox' });
  assert.equal((await verifySubscriptionTransaction(sandbox, opts)).reason, 'environment');
  assert.equal((await verifySubscriptionTransaction(sandbox, { ...opts, allowSandbox: true })).ok, true);
});

// ------------------------------------------------------------ POST /api/plan/apple

test('app 推交易：寫進去之後就是 Pro，而且回的是新的到期日', async () => {
  const env = makeAppleEnv();
  addUser(env, 'u1', 'a@x.test');
  const res = await handlePlanApple(post('https://x.test/api/plan/apple', { signedTransaction: await txnJws() }), env, { id: 'u1' });
  const { status, body } = await unwrap(res);

  assert.equal(status, 200);
  assert.equal(body.plan, 'pro');
  assert.equal(body.planExpiresAt, NOW + 30 * DAY);

  const row = userRow(env, 'u1');
  assert.equal(row.plan_source, 'apple');
  assert.equal(row.apple_original_txn, '2000000000000001');
  assert.equal(planOf(row, NOW), 'pro');
});

test('app 推交易：不認得的 productId 一律 400，而且一個欄位都不動', async () => {
  const env = makeAppleEnv();
  addUser(env, 'u1', 'a@x.test');
  const res = await handlePlanApple(
    post('https://x.test/api/plan/apple', { signedTransaction: await txnJws({ productId: 'com.bounceto.workschedule.something.else' }) }),
    env, { id: 'u1' }
  );
  const { status, body } = await unwrap(res);
  assert.equal(status, 400);
  assert.equal(body.reason, 'unknown_product');
  assert.equal(userRow(env, 'u1').plan_source, null);
});

test('app 推交易：驗不過的 JWS 是 400，不是 500', async () => {
  const env = makeAppleEnv();
  addUser(env, 'u1', 'a@x.test');
  const { status } = await unwrap(await handlePlanApple(
    post('https://x.test/api/plan/apple', { signedTransaction: 'not.a.jws' }), env, { id: 'u1' }
  ));
  assert.equal(status, 400);
});

test('只往後不往前：一整批 entitlements 順序顛倒也不會被舊的蓋掉', async () => {
  const env = makeAppleEnv();
  addUser(env, 'u1', 'a@x.test');
  // 故意把最新的放在最前面，舊的在後面——照單全收的寫法會停在最舊那一筆
  const list = [
    await txnJws({ expiresDate: NOW + 365 * DAY, productId: YEARLY }),
    await txnJws({ expiresDate: NOW + 30 * DAY }),
    await txnJws({ expiresDate: NOW + 5 * DAY }),
  ];
  const { status, body } = await unwrap(await handlePlanApple(
    post('https://x.test/api/plan/apple', { signedTransactions: list }), env, { id: 'u1' }
  ));
  assert.equal(status, 200);
  assert.equal(body.planExpiresAt, NOW + 365 * DAY, '最新的那一筆要贏');
  assert.equal(userRow(env, 'u1').plan_expires_at, NOW + 365 * DAY);
});

test('只往後不往前：送一筆比現況舊的交易回 200 但不改資料庫', async () => {
  const env = makeAppleEnv();
  addUser(env, 'u1', 'a@x.test');
  await handlePlanApple(post('https://x.test/api/plan/apple', { signedTransaction: await txnJws({ expiresDate: NOW + 90 * DAY }) }), env, { id: 'u1' });

  const { status, body } = await unwrap(await handlePlanApple(
    post('https://x.test/api/plan/apple', { signedTransaction: await txnJws({ expiresDate: NOW + 10 * DAY }) }), env, { id: 'u1' }
  ));
  assert.equal(status, 200, '不是錯誤，只是沒有比較新');
  assert.equal(body.planExpiresAt, NOW + 90 * DAY);
});

test('退款：revocationDate 是「只往後」唯一的例外，要往前寫', async () => {
  const env = makeAppleEnv();
  addUser(env, 'u1', 'a@x.test');
  await handlePlanApple(post('https://x.test/api/plan/apple', { signedTransaction: await txnJws({ expiresDate: NOW + 90 * DAY }) }), env, { id: 'u1' });

  await handlePlanApple(post('https://x.test/api/plan/apple', {
    signedTransaction: await txnJws({ expiresDate: NOW + 90 * DAY, revocationDate: NOW - DAY }),
  }), env, { id: 'u1' });

  const row = userRow(env, 'u1');
  assert.equal(row.plan_expires_at, NOW - DAY);
  assert.equal(planOf(row, NOW + 10 * DAY), 'free', '退款之後（過了寬限）就不是 Pro 了');
  assert.ok(events(env).some(e => e.kind === 'refunded'), '要留下一筆退款事件');
});

test('管理者的永久方案不被 Apple 蓋掉，但那次購買仍然要留下記錄', async () => {
  const env = makeAppleEnv();
  addUser(env, 'u1', 'a@x.test');
  env.DB.prepare("UPDATE users SET plan_source = 'admin', plan_expires_at = NULL WHERE id = ?").bind('u1').run();

  const { status, body } = await unwrap(await handlePlanApple(
    post('https://x.test/api/plan/apple', { signedTransaction: await txnJws() }), env, { id: 'u1' }
  ));
  assert.equal(status, 200);
  assert.equal(body.plan, 'pro');

  const row = userRow(env, 'u1');
  assert.equal(row.plan_source, 'admin', '來源不准被改成 apple');
  assert.equal(row.plan_expires_at, null, '永久不准被加上到期日');
  assert.ok(events(env).some(e => e.detail?.includes('管理者')), '要看得到我們刻意沒寫');
});

test('搬移：同一份訂閱綁到第二個帳號是搬過去，不是拒絕', async () => {
  const env = makeAppleEnv();
  addUser(env, 'u1', 'a@x.test');
  addUser(env, 'u2', 'b@x.test');
  const jws = await txnJws();

  await handlePlanApple(post('https://x.test/api/plan/apple', { signedTransaction: jws }), env, { id: 'u1' });
  assert.equal(userRow(env, 'u1').plan_source, 'apple');

  const { status, body } = await unwrap(await handlePlanApple(
    post('https://x.test/api/plan/apple', { signedTransaction: jws }), env, { id: 'u2' }
  ));
  assert.equal(status, 200);
  assert.equal(body.plan, 'pro');

  assert.equal(userRow(env, 'u1').plan_source, null, '舊帳號要被清空');
  assert.equal(userRow(env, 'u1').apple_original_txn, null);
  assert.equal(userRow(env, 'u2').apple_original_txn, '2000000000000001');
  assert.ok(events(env).some(e => e.kind === 'transferred'), '搬移要留下事件');
});

// ------------------------------------------------------------ POST /api/apple/notifications

test('通知：DID_RENEW 把到期日往後推', async () => {
  const env = makeAppleEnv();
  addUser(env, 'u1', 'a@x.test');
  await handlePlanApple(post('https://x.test/api/plan/apple', { signedTransaction: await txnJws() }), env, { id: 'u1' });

  const res = await handleAppleNotification(post('https://x.test/api/apple/notifications', {
    signedPayload: await notifyJws({ notificationType: 'DID_RENEW', txn: { expiresDate: NOW + 60 * DAY } }),
  }), env);

  assert.equal(res.status, 200);
  assert.equal(userRow(env, 'u1').plan_expires_at, NOW + 60 * DAY);
});

test('通知：同一個 notificationUUID 不重做', async () => {
  const env = makeAppleEnv();
  addUser(env, 'u1', 'a@x.test');
  await handlePlanApple(post('https://x.test/api/plan/apple', { signedTransaction: await txnJws() }), env, { id: 'u1' });

  const payload = await notifyJws({ uuid: 'same-uuid', txn: { expiresDate: NOW + 60 * DAY } });
  await handleAppleNotification(post('https://x.test/api/apple/notifications', { signedPayload: payload }), env);
  const before = events(env).length;

  const { status, body } = await unwrap(await handleAppleNotification(
    post('https://x.test/api/apple/notifications', { signedPayload: payload }), env
  ));
  assert.equal(status, 200);
  assert.equal(body.duplicate, true);
  assert.equal(events(env).length, before, '第二次不該再長出事件');
});

test('通知：EXPIRED 把到期日設成通知裡的時間（可以往前）', async () => {
  const env = makeAppleEnv();
  addUser(env, 'u1', 'a@x.test');
  await handlePlanApple(post('https://x.test/api/plan/apple', { signedTransaction: await txnJws({ expiresDate: NOW + 90 * DAY }) }), env, { id: 'u1' });

  await handleAppleNotification(post('https://x.test/api/apple/notifications', {
    signedPayload: await notifyJws({ notificationType: 'EXPIRED', uuid: 'exp-1', txn: { expiresDate: NOW - DAY } }),
  }), env);

  assert.equal(userRow(env, 'u1').plan_expires_at, NOW - DAY);
});

test('通知：DID_CHANGE_RENEWAL_STATUS（取消自動續訂）一個欄位都不改', async () => {
  const env = makeAppleEnv();
  addUser(env, 'u1', 'a@x.test');
  await handlePlanApple(post('https://x.test/api/plan/apple', { signedTransaction: await txnJws({ expiresDate: NOW + 90 * DAY }) }), env, { id: 'u1' });

  const res = await handleAppleNotification(post('https://x.test/api/apple/notifications', {
    signedPayload: await notifyJws({ notificationType: 'DID_CHANGE_RENEWAL_STATUS', subtype: 'AUTO_RENEW_DISABLED', uuid: 'cancel-1' }),
  }), env);

  assert.equal(res.status, 200);
  assert.equal(userRow(env, 'u1').plan_expires_at, NOW + 90 * DAY, '已經付掉的那一期不准被沒收');
  assert.ok(events(env).some(e => e.kind === 'DID_CHANGE_RENEWAL_STATUS'), '但要記下來');
});

test('通知：找不到帳號回 200 並記事件（可能是先訂了還沒註冊）', async () => {
  const env = makeAppleEnv();
  const { status, body } = await unwrap(await handleAppleNotification(
    post('https://x.test/api/apple/notifications', { signedPayload: await notifyJws({ uuid: 'orphan-1' }) }), env
  ));
  assert.equal(status, 200);
  assert.equal(body.unmatched, true);
  const ev = events(env);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].user_id, null);
  assert.ok(ev[0].detail.includes('找不到'));
});

test('通知：驗簽失敗回 401，而且 plan_events 一筆都不留', async () => {
  const env = makeAppleEnv();
  addUser(env, 'u1', 'a@x.test');

  // 換一組不在鏈上的金鑰簽 → 簽章對不上
  const other = await makeFakeApple();
  const forged = await other.signJws({
    notificationType: 'DID_RENEW', notificationUUID: 'forged-1',
    data: { bundleId: APP_BUNDLE_ID, environment: 'Production' },
  });

  const { status } = await unwrap(await handleAppleNotification(
    post('https://x.test/api/apple/notifications', { signedPayload: forged }), env
  ));
  assert.equal(status, 401);
  assert.equal(events(env).length, 0, '驗不過就什麼都不寫');
});

test('通知：管理者的永久方案也不被通知蓋掉', async () => {
  const env = makeAppleEnv();
  addUser(env, 'u1', 'a@x.test');
  env.DB.prepare("UPDATE users SET plan_source = 'admin', plan_expires_at = NULL, apple_original_txn = ? WHERE id = ?")
    .bind('2000000000000001', 'u1').run();

  await handleAppleNotification(post('https://x.test/api/apple/notifications', {
    signedPayload: await notifyJws({ notificationType: 'EXPIRED', uuid: 'exp-admin', txn: { expiresDate: NOW - DAY } }),
  }), env);

  const row = userRow(env, 'u1');
  assert.equal(row.plan_source, 'admin');
  assert.equal(row.plan_expires_at, null, '永久帳號不准因為一則通知就被關掉');
});

test('兩個 productId 就是 App Store Connect 要建的那兩個', () => {
  assert.deepEqual([...PRODUCT_IDS].sort(), [MONTHLY, YEARLY].sort());
});
