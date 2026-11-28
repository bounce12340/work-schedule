/**
 * 網頁版訂閱（Paddle）。設計文件：docs/superpowers/specs/2026-11-14-web-subscription-paddle.md
 *
 * 寫的是同一組欄位（users.plan_source / plan_expires_at），`planOf` 一個字都沒改：
 * 「是不是 Pro」仍然只看資料庫，Worker 從不在請求當下去問 Paddle。
 *
 * 三支端點：
 *   GET  /api/plan/paddle/config     前端問「網頁版能不能訂」（沒設定就整塊不顯示）
 *   POST /api/plan/paddle/checkout   伺服器開一筆 transaction，**user id 由伺服器寫進 custom_data**
 *   POST /api/plan/paddle/portal     已訂閱的人去 Paddle 的客戶頁取消／換卡
 *   POST /api/paddle/webhook         Paddle 打進來的（公開；憑證是 HMAC 簽章）
 */
import { json } from './auth.js';
import { planOf } from '../plan.js';

const API_BASE = {
  sandbox: 'https://sandbox-api.paddle.com',
  production: 'https://api.paddle.com',
};

/** 簽章的時間戳超過這麼久就不收。Paddle 官方建議 5 秒；重送是新的簽章，不受影響。 */
const MAX_SIGNATURE_AGE_S = 300;

/** Paddle 的哪些狀態代表「這一期還在」。 */
const LIVE_STATUS = new Set(['active', 'trialing', 'past_due']);

/**
 * 網頁版訂閱要的設定齊不齊。**少一個就當作沒有這個功能**，前端整塊不顯示——
 * 一顆按下去才說「尚未設定」的按鈕，比沒有按鈕更糟。
 */
export function paddleConfig(env) {
  const environment = env.PADDLE_ENV === 'production' ? 'production' : 'sandbox';
  const prices = {
    monthly: env.PADDLE_PRICE_MONTHLY || '',
    yearly: env.PADDLE_PRICE_YEARLY || '',
  };
  const enabled = !!(env.PADDLE_API_KEY && env.PADDLE_WEBHOOK_SECRET && env.PADDLE_CLIENT_TOKEN
    && prices.monthly && prices.yearly);
  return { enabled, environment, prices, clientToken: env.PADDLE_CLIENT_TOKEN || '' };
}

/** 白名單：只有這兩個 price 解鎖 Pro。同 Apple 的 PRODUCT_IDS。 */
function knownPrice(env, priceId) {
  const { prices } = paddleConfig(env);
  return !!priceId && (priceId === prices.monthly || priceId === prices.yearly);
}

async function paddleApi(env, method, path, body) {
  const { environment } = paddleConfig(env);
  const res = await fetch(API_BASE[environment] + path, {
    method,
    headers: {
      authorization: `Bearer ${env.PADDLE_API_KEY}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 一律當失敗 */ }
  if (!res.ok || !data?.data) {
    // 完整內容只進 console，**絕不轉給前端**（同 AI 端點：上游的錯誤原文是最容易漏東西的一條路）
    console.error('paddle api failed', method, path, res.status, JSON.stringify(data?.error || data).slice(0, 500));
    return null;
  }
  return data.data;
}

/**
 * 刪帳號之前問一次：這個帳號有沒有一份**還在扣款**的網頁版訂閱。
 *
 * 刪帳號不會停止 Paddle 的扣款（我們沒有替他取消），所以有效的網頁訂閱必須先擋下來，
 * 請他到客戶頁取消——否則他的帳號沒了、卡卻照扣。回傳：
 *   null                        可以刪（不是網頁訂閱、已過寬限、或 Paddle 說已取消／已排定取消）
 *   { reason: 'paddle_active' }   還在續訂，擋
 *   { reason: 'paddle_unknown' }  問不到（沒設 API key、非 2xx、回應壞掉、沒有訂閱 id）——**也擋，不默默放行**
 *
 * 「有沒有排定取消」**刪除當下問 Paddle**，不信資料庫：取消是在 Paddle 的客戶頁做的，
 * subscription.updated 的 webhook 可能還沒到。Paddle 的錯誤原文只進 console（paddleApi 已處理），
 * 絕不轉給前端。admin 永久方案與 Apple 的訂閱不在這裡擋（Apple 的由前端在確認畫面警告）。
 */
export async function paddleDeletionGuard(env, userRow, nowMs = Date.now()) {
  if (!userRow || userRow.plan_source !== 'paddle') return null;
  if (planOf(userRow, nowMs) !== 'pro') return null;          // 已到期（含 3 天寬限）：不會再扣款
  const subId = userRow.paddle_subscription_id;
  if (!subId || !env.PADDLE_API_KEY) {
    console.error('paddle deletion guard: cannot check subscription', subId ? 'no api key' : 'no subscription id');
    return { reason: 'paddle_unknown' };
  }
  let sub = null;
  try {
    sub = await paddleApi(env, 'GET', `/subscriptions/${encodeURIComponent(subId)}`);
  } catch (e) {
    console.error('paddle deletion guard: request failed', e?.message || String(e));
  }
  if (!sub) return { reason: 'paddle_unknown' };
  if (sub.status === 'canceled' || sub.scheduled_change?.action === 'cancel') return null;
  return { reason: 'paddle_active' };
}

/** 同 planapple.js：寫失敗只 console.warn。去重是省事，不是正確性的前提。 */
async function recordPlanEvent(env, ev) {
  try {
    await env.DB.prepare(
      `INSERT INTO plan_events (id, user_id, source, kind, original_txn, notification_uuid, expires_at, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), ev.userId ?? null, ev.source, ev.kind,
      ev.originalTxn ?? null, ev.notificationUuid ?? null,
      ev.expiresAt ?? null, ev.detail ?? null, Date.now()
    ).run();
  } catch (e) {
    console.warn('plan_events write failed', e?.message || e);
  }
}

// ------------------------------------------------------------ 前端用的三支

export function handlePaddleConfig(env) {
  const c = paddleConfig(env);
  // clientToken 是 Paddle 設計給瀏覽器用的公開 token；API key 與 webhook secret 永遠不出 Worker
  return json(c.enabled
    ? { enabled: true, environment: c.environment, clientToken: c.clientToken }
    : { enabled: false });
}

/**
 * 開一筆結帳。**user id 由伺服器寫進 custom_data**，不讓前端決定——前端送來的 id 能把
 * 付的錢記到別人身上，這裡不留那條路。
 *
 * 已經是 Pro 的人回 409：不讓同一個人付兩份錢（例如 app 裡已經訂了）。
 */
export async function handlePaddleCheckout(request, env, user) {
  const cfg = paddleConfig(env);
  if (!cfg.enabled) return json({ error: '網頁版訂閱尚未開放' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: '格式錯誤' }, 400); }
  const interval = body?.interval === 'yearly' ? 'yearly' : body?.interval === 'monthly' ? 'monthly' : null;
  if (!interval) return json({ error: '方案不對' }, 400);

  const row = await env.DB.prepare(
    'SELECT id, email, plan_source, plan_expires_at, paddle_customer_id FROM users WHERE id = ?'
  ).bind(user.id).first();
  if (!row) return json({ error: '找不到帳號' }, 404);
  if (planOf(row) === 'pro') {
    return json({ error: '這個帳號已經是 Pro', planSource: row.plan_source }, 409);
  }

  const txn = await paddleApi(env, 'POST', '/transactions', {
    items: [{ price_id: cfg.prices[interval], quantity: 1 }],
    custom_data: { user_id: row.id },
    // 之前訂過的人沿用同一個 Paddle 客戶，客戶頁才看得到完整的歷史
    ...(row.paddle_customer_id ? { customer_id: row.paddle_customer_id } : {}),
  });
  if (!txn?.id) return json({ error: '暫時無法開始結帳，請稍後再試' }, 502);

  return json({
    transactionId: txn.id,
    clientToken: cfg.clientToken,
    environment: cfg.environment,
    // 新客戶時預先填好 email，少打一次字；Paddle 仍讓他改
    email: row.paddle_customer_id ? null : row.email,
  });
}

/** 去 Paddle 的客戶頁：取消、換信用卡、看收據都在那裡，不自己做一份。 */
export async function handlePaddlePortal(request, env, user) {
  const cfg = paddleConfig(env);
  if (!cfg.enabled) return json({ error: '網頁版訂閱尚未開放' }, 503);
  const row = await env.DB.prepare(
    'SELECT paddle_customer_id, paddle_subscription_id FROM users WHERE id = ?'
  ).bind(user.id).first();
  if (!row?.paddle_customer_id) return json({ error: '這個帳號沒有網頁版的訂閱' }, 404);

  const session = await paddleApi(env, 'POST', `/customers/${encodeURIComponent(row.paddle_customer_id)}/portal-sessions`,
    row.paddle_subscription_id ? { subscription_ids: [row.paddle_subscription_id] } : {});
  const url = session?.urls?.general?.overview;
  if (!url) return json({ error: '暫時打不開訂閱管理頁，請稍後再試' }, 502);
  return json({ url });
}

// ------------------------------------------------------------ webhook

const enc = new TextEncoder();

function hexToBytes(hex) {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/**
 * 驗 `Paddle-Signature: ts=…;h1=…`：h1 是 HMAC-SHA256(secret, `${ts}:${原始 body}`)。
 *
 * 用 `crypto.subtle.verify` 比對而不是自己比字串：它是 constant-time 的（同密碼比對
 * 不用 ===）。時間戳太舊也擋，免得一則被攔下來的通知被拿去重放。
 */
export async function verifyPaddleSignature(header, rawBody, secret, nowMs = Date.now()) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(String(header).split(';').map(kv => {
    const i = kv.indexOf('=');
    return i < 0 ? [kv, ''] : [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
  }));
  const ts = Number(parts.ts);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > MAX_SIGNATURE_AGE_S) return false;
  const sig = hexToBytes(parts.h1 || '');
  if (!sig) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, sig, enc.encode(`${parts.ts}:${rawBody}`));
}

const ms = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : null;
};

/**
 * 一則訂閱事件 → 這個帳號應該到什麼時候為止。
 *
 *   active／trialing／past_due → 這一期的結束日（past_due 時 Paddle 還在重試扣款，
 *                                到期後 planOf 的 3 天寬限照樣適用）
 *   canceled → canceled_at（**可以往前**，同 Apple 的退款）
 *   paused   → paused_at（Paddle 是在一期結束時才暫停，所以那一刻就是到期）
 *
 * 「取消自動續訂」在 Paddle 是 subscription.updated 帶 scheduled_change，status 仍是
 * active：**到期日一個字都不改**，已經付的那一期照樣用到最後一天（同 Apple 的
 * DID_CHANGE_RENEWAL_STATUS）。
 */
export function paddleExpiry(sub) {
  if (!sub) return null;
  if (sub.status === 'canceled') return { expiresAt: ms(sub.canceled_at) ?? Date.now(), ended: true };
  if (sub.status === 'paused') return { expiresAt: ms(sub.paused_at) ?? Date.now(), ended: true };
  if (LIVE_STATUS.has(sub.status)) {
    const end = ms(sub.current_billing_period?.ends_at);
    return end ? { expiresAt: end, ended: false } : null;
  }
  return null;
}

/**
 * POST /api/paddle/webhook
 *
 * **一律回 200，除了驗簽失敗**（同 Apple 的通知）：回 5xx 的話 Paddle 會一直重送，
 * 而「這筆我不認得」重送幾次也不會變成認得。
 */
export async function handlePaddleWebhook(request, env) {
  const raw = await request.text();
  const okSig = await verifyPaddleSignature(
    request.headers.get('paddle-signature'), raw, env.PADDLE_WEBHOOK_SECRET
  );
  if (!okSig) {
    console.error('paddle webhook: bad signature');
    return json({ error: '驗證失敗' }, 401);
  }

  let ev;
  try { ev = JSON.parse(raw); } catch { return json({ ok: true, ignored: 'format' }); }
  const eventId = String(ev?.event_id || '');
  const type = String(ev?.event_type || '');
  const sub = ev?.data || {};

  if (eventId) {
    const seen = await env.DB.prepare('SELECT id FROM plan_events WHERE notification_uuid = ?').bind(eventId).first();
    if (seen) return json({ ok: true, duplicate: true });
  }

  // 退款調整：只有「已核准的整筆退款」收回 Pro（見 applyPaddleRefund）；其餘一律只記一筆
  if (type === 'adjustment.created' || type === 'adjustment.updated') {
    const r = await handleAdjustment(env, sub, ev);
    await recordPlanEvent(env, {
      userId: r.userId, source: 'paddle', kind: r.applied ? 'refunded' : `skipped:${r.reason}`,
      originalTxn: String(sub.subscription_id || ''), notificationUuid: eventId, detail: `${type} ${sub.action}/${sub.type}/${sub.status}`,
    });
    return json({ ok: true, applied: r.applied });
  }

  // 只處理訂閱事件；其餘（交易、客戶）照樣記一筆，讓那筆錢在系統裡有痕跡
  if (!type.startsWith('subscription.')) {
    await recordPlanEvent(env, { source: 'paddle', kind: type || 'unknown', notificationUuid: eventId, detail: sub.id || '' });
    return json({ ok: true, recorded: true });
  }

  const subId = String(sub.id || '');
  const priceIds = (sub.items || []).map(i => i?.price?.id).filter(Boolean);
  if (!priceIds.some(p => knownPrice(env, p))) {
    await recordPlanEvent(env, { source: 'paddle', kind: 'unknown_price', originalTxn: subId, notificationUuid: eventId, detail: priceIds.join(',') });
    return json({ ok: true, rejected: 'unknown_price' });
  }

  const exp = paddleExpiry(sub);
  if (!exp) {
    await recordPlanEvent(env, { source: 'paddle', kind: type, originalTxn: subId, notificationUuid: eventId, detail: `status=${sub.status}` });
    return json({ ok: true, recorded: true });
  }

  // 找帳號：先看 custom_data 裡伺服器自己寫進去的 user id，再看已經綁好的訂閱 id
  const userId = sub.custom_data?.user_id ? String(sub.custom_data.user_id) : null;
  let row = userId
    ? await env.DB.prepare('SELECT id, plan_source, plan_expires_at, paddle_subscription_id, paddle_event_at FROM users WHERE id = ?').bind(userId).first()
    : null;
  if (!row && subId) {
    row = await env.DB.prepare('SELECT id, plan_source, plan_expires_at, paddle_subscription_id, paddle_event_at FROM users WHERE paddle_subscription_id = ?').bind(subId).first();
  }
  if (!row) {
    // 找不到帳號不是錯誤（例如帳號已刪除），但要留下痕跡
    await recordPlanEvent(env, { source: 'paddle', kind: type, originalTxn: subId, notificationUuid: eventId, expiresAt: exp.expiresAt, detail: '找不到對應帳號' });
    return json({ ok: true, unmatched: true });
  }

  const result = await applyPaddle(env, row, {
    subId, customerId: sub.customer_id ? String(sub.customer_id) : null,
    occurredAt: ms(ev.occurred_at) ?? Date.now(), ...exp,
  });
  await recordPlanEvent(env, {
    userId: row.id, source: 'paddle', kind: result.applied ? (exp.ended ? 'ended' : 'subscribed') : `skipped:${result.reason}`,
    originalTxn: subId, notificationUuid: eventId, expiresAt: exp.expiresAt, detail: `${type} status=${sub.status}`,
  });
  return json({ ok: true, applied: result.applied });
}

/**
 * 一則 adjustment（退款／信用額度／拒付）→ 該不該收回網頁版的 Pro。
 *
 * 全部成立才收回（缺一個就只記一筆）：
 *   - action 是 refund 或 chargeback（credit 是折抵下一期的帳款，不是把錢還回去）
 *   - status 是 approved（pending_approval 還沒定、rejected 被駁回了）
 *   - **type 是 full**：部分退款（例如補償一個月的一部分）不代表使用者不該再有這一期。
 *     這是刻意的選擇：寧可漏收一次部分退款（管理者在 /admin 看得到 plan_events），也不要
 *     因為退了一點小錢就把付全額的人降級——前者看得見、可以補，後者使用者當場被鎖在外面
 *   - 帶 subscription_id，而且就是這個帳號**現在**那一份網頁訂閱（plan_source=paddle）：
 *     只結束網頁那一份——不是 paddle、訂閱 id 不同、admin 永久方案、Apple 那一份一律不動
 * 收回＝plan_expires_at 往前寫成現在（planOf 仍有 3 天寬限，同其他結束類事件）。
 * 冪等：已經過期的不再動（不會把到期日往後移）；同一則事件的重送由 event_id 去重擋掉。
 * 比事件時間：比上一次處理的舊就不理（同 applyPaddle）。
 */
async function handleAdjustment(env, adj, ev) {
  if (!['refund', 'chargeback'].includes(adj.action)) return { applied: false, reason: 'not_refund' };
  if (adj.status !== 'approved') return { applied: false, reason: 'not_approved' };
  if (adj.type !== 'full') return { applied: false, reason: 'partial' };
  const subId = String(adj.subscription_id || '');
  if (!subId) return { applied: false, reason: 'no_subscription' };
  const row = await env.DB.prepare(
    'SELECT id, plan_source, plan_expires_at, paddle_subscription_id, paddle_event_at FROM users WHERE paddle_subscription_id = ?'
  ).bind(subId).first();
  if (!row) return { applied: false, reason: 'unmatched' };
  if (row.plan_source !== 'paddle') return { applied: false, userId: row.id, reason: 'not_this_subscription' };
  const occurredAt = ms(ev.occurred_at) ?? Date.now();
  if (row.paddle_event_at != null && occurredAt < row.paddle_event_at) return { applied: false, userId: row.id, reason: 'stale' };
  const now = Date.now();
  if (row.plan_expires_at != null && row.plan_expires_at <= now) return { applied: false, userId: row.id, reason: 'already_ended' };
  // 單句帶條件：以我們讀到的那個到期日為準，中間被別的事件改走就不寫
  const r = await env.DB.prepare(
    `UPDATE users SET plan_expires_at = ?, paddle_event_at = ?
      WHERE id = ? AND plan_source = 'paddle' AND paddle_subscription_id = ? AND plan_expires_at IS ?`
  ).bind(now, occurredAt, row.id, subId, row.plan_expires_at).run();
  return r.meta?.changes === 1 ? { applied: true, userId: row.id } : { applied: false, userId: row.id, reason: 'raced' };
}

/**
 * 把一則 Paddle 訂閱事件寫成帳號的權利。規則與 Apple 那一條一一對應：
 *
 *   1. 管理者的永久方案**不被蓋掉**。
 *   2. **事件比上一次處理的舊就不理**（Paddle 不保證送達順序）。比的是 occurred_at，
 *      不是「只往後」：同一份訂閱的取消必須能把到期日往前寫。
 *   3. 帳號現在由 **Apple 的訂閱**撐著、而且撐得比這則事件久 → 不動（不讓網頁那一份
 *      把 app 那一份縮短）。結束類的事件只結束**網頁那一份**：plan_source 不是 paddle
 *      或訂閱 id 對不上時一律不動。
 */
export async function applyPaddle(env, row, ev) {
  if (row.plan_source === 'admin') return { applied: false, reason: 'admin_plan' };

  if (row.paddle_subscription_id === ev.subId && row.paddle_event_at != null && ev.occurredAt < row.paddle_event_at) {
    return { applied: false, reason: 'stale' };
  }

  if (ev.ended) {
    if (row.plan_source !== 'paddle' || row.paddle_subscription_id !== ev.subId) {
      return { applied: false, reason: 'not_this_subscription' };
    }
  } else if (row.plan_source === 'apple' && row.plan_expires_at != null && row.plan_expires_at >= ev.expiresAt) {
    // 仍然記下訂閱 id 與客戶 id：之後他才進得了客戶頁去取消多付的那一份
    await env.DB.prepare(
      'UPDATE users SET paddle_subscription_id = ?, paddle_customer_id = COALESCE(?, paddle_customer_id), paddle_event_at = ? WHERE id = ?'
    ).bind(ev.subId, ev.customerId, ev.occurredAt, row.id).run();
    return { applied: false, reason: 'apple_longer' };
  }

  await env.DB.prepare(
    `UPDATE users SET plan_source = 'paddle', plan_expires_at = ?, paddle_subscription_id = ?,
            paddle_customer_id = COALESCE(?, paddle_customer_id), paddle_event_at = ?
      WHERE id = ?`
  ).bind(ev.expiresAt, ev.subId, ev.customerId, ev.occurredAt, row.id).run();
  return { applied: true };
}

