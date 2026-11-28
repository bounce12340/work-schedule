/**
 * 網頁版訂閱（Paddle）：webhook 寫權利、結帳、設定不外洩。
 *
 * 守的東西與 plan-apple 一樣，全部是**錯了不會有徵兆**的形狀：
 *
 *   1. **驗簽。** 少了它，任何人 POST 一則假的 subscription.created 就能把自己變成 Pro。
 *   2. **user id 由伺服器寫進 custom_data。** 前端送來的 id 一律不採用。
 *   3. **管理者的永久方案不被蓋掉。**
 *   4. **舊事件不理**（Paddle 不保證順序），但**取消可以把到期日往前寫**。
 *   5. **結束類事件只結束網頁那一份**：不碰 Apple 撐著的帳號。
 *   6. **網頁那一份不縮短 Apple 那一份。**
 *   7. **取消自動續訂（scheduled_change）不改到期日**：已付的那一期用到最後一天。
 *   8. **price 白名單。**
 *   9. **API key 與 webhook secret 永遠不出 Worker。**
 *
 * 突變驗證（加完測試實際做過，每一條各自只紅在對的地方）：見 PR 說明。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handlePaddleWebhook, handlePaddleCheckout, handlePaddleConfig, handlePaddlePortal,
  verifyPaddleSignature, paddleExpiry,
} from '../src/handlers/planpaddle.js';
import { handleGetState } from '../src/handlers/state.js';
import { planOf } from '../src/plan.js';
import { makeEnv, addUser, unwrap } from './d1.mjs';

const SECRET = 'pdl_ntfset_test_secret';
const MONTHLY = 'pri_monthly_test';
const YEARLY = 'pri_yearly_test';
const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-11-14T00:00:00Z');
const iso = (t) => new Date(t).toISOString();

function paddleEnv(over = {}) {
  const env = makeEnv();
  Object.assign(env, {
    PADDLE_API_KEY: 'pdl_sdbx_apikey_TEST_ONLY',
    PADDLE_WEBHOOK_SECRET: SECRET,
    PADDLE_CLIENT_TOKEN: 'test_clienttoken',
    PADDLE_PRICE_MONTHLY: MONTHLY,
    PADDLE_PRICE_YEARLY: YEARLY,
    PADDLE_ENV: 'sandbox',
    ...over,
  });
  return env;
}

async function sign(body, { secret = SECRET, ts = Math.floor(Date.now() / 1000) } = {}) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}:${body}`)));
  return `ts=${ts};h1=${[...mac].map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

/** 一則訂閱事件。預設：u1 的月費、這一期到 T0+30 天。 */
function subEvent(over = {}, sub = {}) {
  return {
    event_id: 'evt_1',
    event_type: 'subscription.created',
    occurred_at: iso(T0),
    ...over,
    data: {
      id: 'sub_1',
      status: 'active',
      customer_id: 'ctm_1',
      custom_data: { user_id: 'u1' },
      items: [{ price: { id: MONTHLY } }],
      current_billing_period: { starts_at: iso(T0), ends_at: iso(T0 + 30 * DAY) },
      scheduled_change: null,
      canceled_at: null,
      ...sub,
    },
  };
}

async function deliver(env, ev, signOpts) {
  const body = JSON.stringify(ev);
  const req = new Request('https://x.test/api/paddle/webhook', {
    method: 'POST', headers: { 'paddle-signature': await sign(body, signOpts) }, body,
  });
  return unwrap(await handlePaddleWebhook(req, env));
}

const row = (env, id = 'u1') => env.DB.prepare(
  'SELECT plan_source, plan_expires_at, paddle_subscription_id, paddle_customer_id FROM users WHERE id = ?'
).bind(id).first();
const eventCount = (env) => env.DB.prepare('SELECT COUNT(*) AS n FROM plan_events').first().n;

// ------------------------------------------------------------ 驗簽

test('簽章：對的通過；換 secret、改 body、時間戳太舊都不通過', async () => {
  const body = '{"a":1}';
  assert.equal(await verifyPaddleSignature(await sign(body), body, SECRET), true);
  assert.equal(await verifyPaddleSignature(await sign(body, { secret: 'other' }), body, SECRET), false);
  assert.equal(await verifyPaddleSignature(await sign(body), '{"a":2}', SECRET), false);
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.equal(await verifyPaddleSignature(await sign(body, { ts: old }), body, SECRET), false);
  assert.equal(await verifyPaddleSignature('', body, SECRET), false);
  assert.equal(await verifyPaddleSignature(await sign(body), body, ''), false);
});

test('webhook：驗簽失敗回 401，而且一個欄位、一筆事件都不寫', async () => {
  const env = paddleEnv(); addUser(env, 'u1', 'a@x.test');
  const { status } = await deliver(env, subEvent(), { secret: 'forged' });
  assert.equal(status, 401);
  assert.equal(row(env).plan_source, null);
  assert.equal(eventCount(env), 0);
});

// ------------------------------------------------------------ 寫權利

test('訂閱成立：custom_data 的那個帳號變成 Pro，到期日就是這一期的結束日', async () => {
  const env = paddleEnv(); addUser(env, 'u1', 'a@x.test');
  const { status } = await deliver(env, subEvent());
  assert.equal(status, 200);
  const r = row(env);
  assert.equal(r.plan_source, 'paddle');
  assert.equal(r.plan_expires_at, T0 + 30 * DAY);
  assert.equal(r.paddle_subscription_id, 'sub_1');
  assert.equal(r.paddle_customer_id, 'ctm_1');
  assert.equal(planOf(r, T0 + DAY), 'pro');
});

test('不認得的 price：回 200 但一個欄位都不動', async () => {
  const env = paddleEnv(); addUser(env, 'u1', 'a@x.test');
  const { status, body } = await deliver(env, subEvent({}, { items: [{ price: { id: 'pri_someone_else' } }] }));
  assert.equal(status, 200);
  assert.equal(body.rejected, 'unknown_price');
  assert.equal(row(env).plan_source, null);
});

test('管理者的永久方案不被 Paddle 蓋掉', async () => {
  const env = paddleEnv(); addUser(env, 'u1', 'a@x.test');
  env.DB.prepare("UPDATE users SET plan_source = 'admin' WHERE id = 'u1'").run();
  await deliver(env, subEvent());
  const r = row(env);
  assert.equal(r.plan_source, 'admin');
  assert.equal(r.plan_expires_at, null);
});

test('續訂把到期日往後推；比較舊的事件晚到時不理', async () => {
  const env = paddleEnv(); addUser(env, 'u1', 'a@x.test');
  await deliver(env, subEvent());
  await deliver(env, subEvent({ event_id: 'evt_2', event_type: 'subscription.updated', occurred_at: iso(T0 + 30 * DAY) },
    { current_billing_period: { starts_at: iso(T0 + 30 * DAY), ends_at: iso(T0 + 60 * DAY) } }));
  assert.equal(row(env).plan_expires_at, T0 + 60 * DAY);

  // 一則更早發生、但比較晚送到的事件
  await deliver(env, subEvent({ event_id: 'evt_0', event_type: 'subscription.updated', occurred_at: iso(T0 + DAY) }));
  assert.equal(row(env).plan_expires_at, T0 + 60 * DAY);
});

test('取消自動續訂（scheduled_change）不改到期日：已付的那一期用到最後一天', async () => {
  const env = paddleEnv(); addUser(env, 'u1', 'a@x.test');
  await deliver(env, subEvent());
  await deliver(env, subEvent({ event_id: 'evt_2', event_type: 'subscription.updated', occurred_at: iso(T0 + DAY) },
    { scheduled_change: { action: 'cancel', effective_at: iso(T0 + 30 * DAY) } }));
  const r = row(env);
  assert.equal(r.plan_expires_at, T0 + 30 * DAY);
  assert.equal(planOf(r, T0 + 2 * DAY), 'pro');
});

test('真的取消了：到期日往前寫成取消那一刻', async () => {
  const env = paddleEnv(); addUser(env, 'u1', 'a@x.test');
  await deliver(env, subEvent());
  await deliver(env, subEvent({ event_id: 'evt_2', event_type: 'subscription.canceled', occurred_at: iso(T0 + 5 * DAY) },
    { status: 'canceled', canceled_at: iso(T0 + 5 * DAY) }));
  const r = row(env);
  assert.equal(r.plan_expires_at, T0 + 5 * DAY);
  assert.equal(planOf(r, T0 + 9 * DAY), 'free');
});

test('結束類事件只結束網頁那一份：帳號由 Apple 撐著時一個欄位都不動', async () => {
  const env = paddleEnv(); addUser(env, 'u1', 'a@x.test');
  env.DB.prepare("UPDATE users SET plan_source = 'apple', plan_expires_at = ? WHERE id = 'u1'").bind(T0 + 90 * DAY).run();
  await deliver(env, subEvent({ event_type: 'subscription.canceled' }, { status: 'canceled', canceled_at: iso(T0) }));
  const r = row(env);
  assert.equal(r.plan_source, 'apple');
  assert.equal(r.plan_expires_at, T0 + 90 * DAY);
});

test('網頁那一份不縮短 Apple 那一份，但記下訂閱 id（之後才取消得了）', async () => {
  const env = paddleEnv(); addUser(env, 'u1', 'a@x.test');
  env.DB.prepare("UPDATE users SET plan_source = 'apple', plan_expires_at = ? WHERE id = 'u1'").bind(T0 + 300 * DAY).run();
  await deliver(env, subEvent());
  const r = row(env);
  assert.equal(r.plan_source, 'apple');
  assert.equal(r.plan_expires_at, T0 + 300 * DAY);
  assert.equal(r.paddle_subscription_id, 'sub_1');
  assert.equal(r.paddle_customer_id, 'ctm_1');
});

test('同一則事件送兩次：第二次只回 duplicate', async () => {
  const env = paddleEnv(); addUser(env, 'u1', 'a@x.test');
  await deliver(env, subEvent());
  const n = eventCount(env);
  const { body } = await deliver(env, subEvent());
  assert.equal(body.duplicate, true);
  assert.equal(eventCount(env), n);
});

test('找不到帳號不是錯誤：回 200 並留下一筆事件', async () => {
  const env = paddleEnv();
  const { status, body } = await deliver(env, subEvent({}, { custom_data: { user_id: 'nobody' } }));
  assert.equal(status, 200);
  assert.equal(body.unmatched, true);
  assert.equal(eventCount(env), 1);
});

// ------------------------------------------------------------ 退款（adjustment）

/** 一則 adjustment 事件。預設：sub_1 的「已核准的整筆退款」。 */
function adjEvent(over = {}, adj = {}) {
  return {
    event_id: 'evt_adj_1',
    event_type: 'adjustment.updated',
    occurred_at: iso(Date.now()),
    ...over,
    data: {
      id: 'adj_1', action: 'refund', type: 'full', status: 'approved',
      subscription_id: 'sub_1', transaction_id: 'txn_1', customer_id: 'ctm_1',
      ...adj,
    },
  };
}
async function subscribed() {
  const env = paddleEnv(); addUser(env, 'u1', 'a@x.test');
  await deliver(env, subEvent({ occurred_at: iso(T0) }, { current_billing_period: { starts_at: iso(Date.now()), ends_at: iso(Date.now() + 20 * DAY) } }));
  assert.equal(row(env).plan_source, 'paddle');
  return env;
}

test('退款：已核准的整筆退款把網頁版 Pro 往前收回成現在（plan_source 仍是 paddle，寬限照 planOf）', async () => {
  const env = await subscribed();
  const before = Date.now();
  const { status, body } = await deliver(env, adjEvent());
  assert.equal(status, 200);
  assert.equal(body.applied, true);
  const r = row(env);
  assert.equal(r.plan_source, 'paddle');
  assert.ok(r.plan_expires_at >= before && r.plan_expires_at <= Date.now(), '到期日＝現在');
  assert.equal(planOf(r, Date.now() + 4 * DAY), 'free');
});

test('退款：拒付（chargeback）已核准的整筆也收回', async () => {
  const env = await subscribed();
  const { body } = await deliver(env, adjEvent({}, { action: 'chargeback' }));
  assert.equal(body.applied, true);
});

test('退款：pending_approval、rejected、credit、部分退款都一個欄位不動（只記一筆事件）', async () => {
  const env = await subscribed();
  const was = row(env);
  let n = 0;
  for (const adj of [{ status: 'pending_approval' }, { status: 'rejected' }, { action: 'credit' }, { type: 'partial' }, { action: 'chargeback_warning' }]) {
    const { status, body } = await deliver(env, adjEvent({ event_id: 'evt_adj_x' + (n++) }, adj));
    assert.equal(status, 200);
    assert.equal(body.applied, false, JSON.stringify(adj));
    assert.deepEqual(row(env), was, JSON.stringify(adj));
  }
  assert.ok(eventCount(env) >= 1 + 5, '每一則都留痕跡');
});

test('退款：只動網頁那一份——訂閱 id 對不上、plan_source 不是 paddle（Apple 撐著）、admin 永久方案都不動', async () => {
  // 訂閱 id 不同
  let env = await subscribed();
  let was = row(env);
  await deliver(env, adjEvent({}, { subscription_id: 'sub_other' }));
  assert.deepEqual(row(env), was, '別份訂閱');
  // 沒帶訂閱 id（一次性購買的退款）
  await deliver(env, adjEvent({ event_id: 'evt_adj_2' }, { subscription_id: null }));
  assert.deepEqual(row(env), was, '沒有訂閱 id');
  // Apple 撐著：訂閱 id 記著，但 plan_source 是 apple
  env = await subscribed();
  env.DB.prepare("UPDATE users SET plan_source = 'apple', plan_expires_at = ? WHERE id = 'u1'").bind(Date.now() + 300 * DAY).run();
  was = row(env);
  const r = await deliver(env, adjEvent());
  assert.equal(r.body.applied, false);
  assert.deepEqual(row(env), was, 'Apple 那一份不縮短');
  // admin
  env = await subscribed();
  env.DB.prepare("UPDATE users SET plan_source = 'admin', plan_expires_at = NULL WHERE id = 'u1'").run();
  await deliver(env, adjEvent());
  assert.equal(row(env).plan_source, 'admin');
  assert.equal(row(env).plan_expires_at, null);
});

test('退款：驗簽照舊（偽造的 adjustment 回 401，什麼都不寫）', async () => {
  const env = await subscribed();
  const was = row(env); const n = eventCount(env);
  const { status } = await deliver(env, adjEvent(), { secret: 'forged' });
  assert.equal(status, 401);
  assert.deepEqual(row(env), was);
  assert.equal(eventCount(env), n);
});

test('退款：同一則重送回 duplicate；另一則同樣的退款（已經收回）不會把到期日再動', async () => {
  const env = await subscribed();
  await deliver(env, adjEvent());
  const after = row(env);
  assert.equal((await deliver(env, adjEvent())).body.duplicate, true);
  const again = await deliver(env, adjEvent({ event_id: 'evt_adj_again' }));
  assert.equal(again.body.applied, false);
  assert.deepEqual(row(env), after);
});

test('退款：比上一次處理還舊的事件不理（Paddle 不保證順序）', async () => {
  const env = await subscribed();
  env.DB.prepare("UPDATE users SET paddle_event_at = ? WHERE id = 'u1'").bind(Date.now() + DAY).run();
  const was = row(env);
  const { body } = await deliver(env, adjEvent());
  assert.equal(body.applied, false);
  assert.deepEqual(row(env), was);
});

test('paddleExpiry：三種狀態各自的到期日', () => {
  assert.equal(paddleExpiry({ status: 'past_due', current_billing_period: { ends_at: iso(T0) } }).expiresAt, T0);
  assert.deepEqual(paddleExpiry({ status: 'canceled', canceled_at: iso(T0) }), { expiresAt: T0, ended: true });
  assert.deepEqual(paddleExpiry({ status: 'paused', paused_at: iso(T0) }), { expiresAt: T0, ended: true });
  assert.equal(paddleExpiry({ status: 'active' }), null);   // 沒有結束日：不猜
});

// ------------------------------------------------------------ 結帳、客戶頁、設定

function withFetch(fn) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/transactions')) return Response.json({ data: { id: 'txn_1' } });
    if (String(url).includes('/portal-sessions')) return Response.json({ data: { urls: { general: { overview: 'https://portal.test/x' } } } });
    return Response.json({ error: { code: 'nope' } }, { status: 400 });
  };
  return fn(calls).finally(() => { globalThis.fetch = orig; });
}
const postJson = (body) => new Request('https://x.test/api/plan/paddle/checkout', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('結帳：custom_data 的 user id 是伺服器的，前端送什麼都不採用', () => withFetch(async (calls) => {
  const env = paddleEnv(); addUser(env, 'u1', 'a@x.test');
  const { status, body } = await unwrap(await handlePaddleCheckout(postJson({ interval: 'yearly', user_id: 'someone-else' }), env, { id: 'u1' }));
  assert.equal(status, 200);
  assert.equal(body.transactionId, 'txn_1');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/sandbox-api\.paddle\.com\/transactions$/);
  assert.deepEqual(calls[0].body.custom_data, { user_id: 'u1' });
  assert.equal(calls[0].body.items[0].price_id, YEARLY);
}));

test('結帳：已經是 Pro 回 409；沒設定回 503；方案不對回 400——三種都不打 Paddle', () => withFetch(async (calls) => {
  const env = paddleEnv(); addUser(env, 'u1', 'a@x.test');
  env.DB.prepare("UPDATE users SET plan_source = 'apple', plan_expires_at = ? WHERE id = 'u1'").bind(Date.now() + 30 * DAY).run();
  assert.equal((await unwrap(await handlePaddleCheckout(postJson({ interval: 'monthly' }), env, { id: 'u1' }))).status, 409);

  const bare = makeEnv(); addUser(bare, 'u2', 'b@x.test');
  assert.equal((await unwrap(await handlePaddleCheckout(postJson({ interval: 'monthly' }), bare, { id: 'u2' }))).status, 503);

  const env3 = paddleEnv(); addUser(env3, 'u3', 'c@x.test');
  assert.equal((await unwrap(await handlePaddleCheckout(postJson({ interval: 'weekly' }), env3, { id: 'u3' }))).status, 400);
  assert.equal(calls.length, 0);
}));

test('客戶頁：沒有網頁版訂閱的人 404；有的人拿到 Paddle 給的網址', () => withFetch(async () => {
  const env = paddleEnv(); addUser(env, 'u1', 'a@x.test');
  const req = () => new Request('https://x.test/api/plan/paddle/portal', { method: 'POST' });
  assert.equal((await unwrap(await handlePaddlePortal(req(), env, { id: 'u1' }))).status, 404);
  env.DB.prepare("UPDATE users SET paddle_customer_id = 'ctm_1', paddle_subscription_id = 'sub_1' WHERE id = 'u1'").run();
  const { status, body } = await unwrap(await handlePaddlePortal(req(), env, { id: 'u1' }));
  assert.equal(status, 200);
  assert.equal(body.url, 'https://portal.test/x');
}));

test('設定：只回公開的 client token，API key 與 webhook secret 一個字都不出去', async () => {
  const env = paddleEnv();
  const text = JSON.stringify((await unwrap(handlePaddleConfig(env))).body);
  assert.match(text, /"enabled":true/);
  assert.ok(!text.includes(env.PADDLE_API_KEY));
  assert.ok(!text.includes(SECRET));
  assert.deepEqual((await unwrap(handlePaddleConfig(makeEnv()))).body, { enabled: false });
});

test('身分：網頁版帶 webBilling，app 不帶（app 裡只能走 Apple 的 IAP）', async () => {
  const env = paddleEnv(); addUser(env, 'u1', 'a@x.test');
  const user = { id: 'u1', email: 'a@x.test', role: 'user', status: 'approved' };
  const web = await unwrap(await handleGetState(env, user, new Request('https://x.test/api/state')));
  assert.equal(web.body.user.webBilling, true);
  const app = await unwrap(await handleGetState(env, user, new Request('https://x.test/api/state', { headers: { 'x-app-client': 'ios/1.3.0' } })));
  assert.equal('webBilling' in app.body.user, false);
});
