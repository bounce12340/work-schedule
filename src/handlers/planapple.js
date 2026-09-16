/**
 * 訂閱權利的寫入：app 推上來的交易（E2）與 Apple 的伺服器通知（E3）。
 *
 * 設計文件：docs/superpowers/specs/2026-09-16-subscription-design.md〈三、寫入權利的三條路〉
 *
 * 兩條路寫的是同一組欄位，所以中間那一段（`applyEntitlement`）只有一份。分歧只在
 * 外層：一邊有 Bearer、知道是誰；另一邊是 Apple 直接打進來的，要靠
 * `originalTransactionId` 回頭找帳號。
 */
import { json } from './auth.js';
import { verifySubscriptionTransaction, verifyAppleJws, checkBundleEnvironment } from '../apppurchase.js';
import { APP_BUNDLE_ID } from './appauth.js';
import { planInfo } from '../plan.js';

/**
 * 我們賣的兩個 product。**白名單，不是「有 expiresDate 就算」**：同一個 app 日後
 * 若多一個別的訂閱（例如加購），不該讓它也解鎖 Pro。
 *
 * 這兩個字串必須與 App Store Connect 裡建的 product id 逐字相同，而那件事沒有
 * 東西能替我們檢查——打錯的症狀是「買得下去，但買完還是免費版」，400 的
 * `unknown_product` 就是為了讓那個症狀說得出話。
 */
export const PRODUCT_IDS = new Set([
  'com.bounceto.workschedule.pro.monthly',
  'com.bounceto.workschedule.pro.yearly',
]);

const verifyOpts = (env) => ({
  bundleId: APP_BUNDLE_ID,
  allowSandbox: env.APP_PURCHASE_ALLOW_SANDBOX === '1',
  trustedRootDer: env.__testAppleRootDer,   // 只有測試會設；正式路徑是 undefined
});

/**
 * 記一筆 plan_events。
 *
 * **寫失敗只 console.warn**，同 share_activity / admin_activity：記錄寫不進去，
 * 不該讓一次已經成功的權利更新變成 500。
 *
 * 這在通知那一條看起來很危險——`notification_uuid` 正是去重的依據，寫不進去就
 * 會重做一次。但重做是安全的：底下每一種寫入規則本身都是冪等的（「只往後」寫
 * 同一個到期日是同一個結果、搬移到已經是自己的帳號是 no-op）。**去重是省事，
 * 不是正確性的前提**——這一點要寫下來，否則下一個人會以為它是。
 */
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

/**
 * 把一筆已驗過的訂閱交易寫成帳號的權利。
 *
 * @param {object} env
 * @param {object} userRow  至少要有 id、plan_source、plan_expires_at
 * @param {object} txn      verifySubscriptionTransaction 的結果
 * @param {object} meta     { source, kind, notificationUuid }
 * @returns {Promise<{applied:boolean, reason?:string, expiresAt:number}>}
 */
async function applyEntitlement(env, userRow, txn, meta) {
  const revoked = txn.revocationDate != null;
  const expiresAt = revoked ? txn.revocationDate : txn.expiresDate;

  // 管理者手動給的永久帳號**不會被 Apple 蓋掉**。否則永久帳號的主人只要在 app 裡
  // 試訂一次再取消，到期那天就被降回免費——他從來沒有要求過那件事。
  //
  // 代價要說清楚：他真的付了錢的話，那筆訂閱不會被記在 apple_original_txn 上，
  // 日後管理者取消永久身分時他會變回免費，要「恢復購買」一次才接得回來。兩害相權，
  // 「永久帳號被無聲降級」比較嚴重，因為當事人不會知道為什麼。
  if (userRow.plan_source === 'admin') {
    await recordPlanEvent(env, {
      userId: userRow.id, source: meta.source, kind: meta.kind,
      originalTxn: txn.originalTransactionId, notificationUuid: meta.notificationUuid,
      expiresAt, detail: '管理者設定的方案，不被 Apple 覆蓋',
    });
    return { applied: false, reason: 'admin_plan', expiresAt };
  }

  // 同一份訂閱綁在別的帳號上：**搬過去，不是拒絕**。訂閱屬於 Apple ID 不屬於我們的
  // 帳號，換帳號登入再「恢復購買」是 Apple 設想中的正常操作。
  //
  // 單句帶條件的 UPDATE，理由同〈樂觀鎖必須是單句 SQL〉：先 SELECT 再決定的話，
  // 兩邊同時恢復購買就會雙雙看到「沒有別人」然後一起寫，UNIQUE 會讓後者 500。
  const moved = await env.DB.prepare(
    `UPDATE users SET plan_source = NULL, plan_expires_at = NULL, apple_original_txn = NULL
      WHERE apple_original_txn = ? AND id != ?`
  ).bind(txn.originalTransactionId, userRow.id).run();
  if (moved.meta?.changes) {
    await recordPlanEvent(env, {
      userId: userRow.id, source: meta.source, kind: 'transferred',
      originalTxn: txn.originalTransactionId, expiresAt,
      detail: `訂閱從別的帳號搬到 ${userRow.id}`,
    });
  }

  // **只往後不往前**：app 可能把一疊舊交易一起送上來（currentEntitlements 是整批的），
  // 照單全收會讓最舊的那一筆把最新的到期日蓋掉。退款是唯一的例外——那本來就是
  // 「提早結束」，要往前寫。
  const current = userRow.plan_expires_at;
  const goesBackwards = current != null && expiresAt <= current;
  if (goesBackwards && !revoked) {
    return { applied: false, reason: 'stale', expiresAt: current };
  }

  await env.DB.prepare(
    `UPDATE users SET plan_source = 'apple', plan_expires_at = ?, apple_original_txn = ? WHERE id = ?`
  ).bind(expiresAt, txn.originalTransactionId, userRow.id).run();

  await recordPlanEvent(env, {
    userId: userRow.id, source: meta.source, kind: revoked ? 'refunded' : meta.kind,
    originalTxn: txn.originalTransactionId, notificationUuid: meta.notificationUuid,
    expiresAt, detail: txn.productId,
  });
  return { applied: true, expiresAt };
}

/**
 * POST /api/plan/apple   （要 Bearer／cookie）
 *
 * body：`{ signedTransaction }` 或 `{ signedTransactions: [...] }`
 *
 * **收陣列是刻意的**：app 在啟動時把 `Transaction.currentEntitlements` 整批送上來，
 * 那本來就是一個清單。拆成 N 次請求等於 N 次往返、N 次 session 查詢，而且中間失敗
 * 一次就留下一半的狀態。
 *
 * 一批裡只要有一筆寫得進去就算成功；全部都驗不過才回 400。
 */
export async function handlePlanApple(request, env, user) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '格式錯誤' }, 400); }

  const list = Array.isArray(body?.signedTransactions)
    ? body.signedTransactions
    : (body?.signedTransaction ? [body.signedTransaction] : []);
  if (!list.length) return json({ error: '缺少交易' }, 400);
  if (list.length > 20) return json({ error: '一次最多 20 筆' }, 400);

  const row = await env.DB.prepare(
    'SELECT id, plan_source, plan_expires_at FROM users WHERE id = ?'
  ).bind(user.id).first();
  if (!row) return json({ error: '找不到帳號' }, 404);

  let applied = 0;
  let lastReason = null;
  for (const jws of list) {
    const txn = await verifySubscriptionTransaction(jws, verifyOpts(env));
    if (!txn.ok) { lastReason = txn.reason; continue; }
    if (!PRODUCT_IDS.has(txn.productId)) { lastReason = 'unknown_product'; continue; }

    const res = await applyEntitlement(env, row, txn, { source: 'app', kind: 'subscribed' });
    if (res.applied) {
      applied++;
      // 同一批裡的下一筆要看得到剛寫進去的到期日，否則「只往後」形同虛設
      row.plan_expires_at = res.expiresAt;
      row.plan_source = 'apple';
    } else if (!lastReason) {
      lastReason = res.reason;
    }
  }

  const after = await env.DB.prepare(
    'SELECT plan_source, plan_expires_at FROM users WHERE id = ?'
  ).bind(user.id).first();

  // 一筆都沒寫進去、而且原因是驗不過或不是我們的商品 → 400。
  // 「已經是最新的」（stale）與「管理者的方案」不是錯誤，照樣回 200 並附上現況。
  if (!applied && lastReason && lastReason !== 'stale' && lastReason !== 'admin_plan') {
    return json({ error: '交易驗證失敗', reason: lastReason }, 400);
  }
  return json({ ok: true, applied, ...planInfo(after) });
}

/**
 * Apple 的伺服器通知型別 → 我們要做什麼。
 *
 * 補的洞是這一個：**Apple 續訂成功、使用者只用網頁、從不開 app** → 沒有人來更新
 * 到期日 → 網頁版把付了錢的人降級。收了錢還關門是最糟的形狀，所以它在 v1。
 *
 * 反過來的「取消訂閱、再也不開 app」不是洞：資料庫存的是到期日，到了那天自然
 * 變回 free。
 */
const NOTIFY_ACTION = {
  SUBSCRIBED: 'subscribed',
  DID_RENEW: 'renewed',
  DID_CHANGE_RENEWAL_PREF: 'renewed',
  OFFER_REDEEMED: 'subscribed',
  EXPIRED: 'expired',
  GRACE_PERIOD_EXPIRED: 'expired',
  REFUND: 'refunded',
  REVOKE: 'revoked',
};

/**
 * POST /api/apple/notifications   （公開；Apple 打進來的）
 *
 * **一律回 200，除了驗簽失敗。** 回 5xx 的話 Apple 會重送，而「這筆我不認得」
 * 重送十次也不會變成認得——只會在對方那邊堆一列永遠失敗的重試。
 */
export async function handleAppleNotification(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '格式錯誤' }, 401); }

  const outer = await verifyAppleJws(body?.signedPayload, verifyOpts(env));
  if (!outer.ok) {
    console.error('apple notification: bad signature', outer.reason);
    return json({ error: '驗證失敗' }, 401);
  }
  const p = outer.payload;
  const data = p.data || {};

  // 外層的 bundleId／environment 在 data 底下，所以共用的檢查在這裡自己餵。
  const bad = checkBundleEnvironment(
    { bundleId: data.bundleId, environment: data.environment },
    verifyOpts(env)
  );
  if (bad) {
    console.error('apple notification: rejected', bad);
    return json({ error: '驗證失敗' }, 401);
  }

  const uuid = String(p.notificationUUID || '');
  const type = String(p.notificationType || '');
  const subtype = String(p.subtype || '');

  if (uuid) {
    const seen = await env.DB.prepare(
      'SELECT id FROM plan_events WHERE notification_uuid = ?'
    ).bind(uuid).first();
    if (seen) return json({ ok: true, duplicate: true });
  }

  // 內層又是一個 JWS，同一套驗。沒有交易資訊的型別（例如純狀態變更）也要記事件。
  const txn = data.signedTransactionInfo
    ? await verifySubscriptionTransaction(data.signedTransactionInfo, verifyOpts(env))
    : { ok: false, reason: 'no_transaction' };

  const action = NOTIFY_ACTION[type];
  const originalTxn = txn.ok ? txn.originalTransactionId : null;

  // DID_CHANGE_RENEWAL_STATUS（取消自動續訂）**不改任何欄位**，只記事件：
  // 已經付掉的那一期到到期日之前仍然是 Pro。把它當成立即到期是在沒收已付的錢。
  if (!action || !txn.ok) {
    await recordPlanEvent(env, {
      userId: null, source: 'apple_notification', kind: type || 'unknown',
      originalTxn, notificationUuid: uuid, detail: subtype || (txn.ok ? '' : txn.reason),
    });
    return json({ ok: true, recorded: true });
  }

  const row = await env.DB.prepare(
    'SELECT id, plan_source, plan_expires_at FROM users WHERE apple_original_txn = ?'
  ).bind(originalTxn).first();

  // 找不到帳號**不是錯誤**：可能是使用者先在 App Store 訂了、還沒在 app 裡註冊。
  // 仍然要記，否則那筆錢在系統裡完全沒有痕跡。
  if (!row) {
    await recordPlanEvent(env, {
      userId: null, source: 'apple_notification', kind: action,
      originalTxn, notificationUuid: uuid,
      expiresAt: txn.revocationDate ?? txn.expiresDate,
      detail: '找不到對應帳號',
    });
    return json({ ok: true, unmatched: true });
  }

  // 到期／退款／撤銷：把到期日設成通知裡的時間（可以往前，同退款）。
  const ended = action === 'expired' || action === 'refunded' || action === 'revoked';
  const effective = ended
    ? { ...txn, revocationDate: txn.revocationDate ?? txn.expiresDate }
    : txn;

  await applyEntitlement(env, row, effective, {
    source: 'apple_notification', kind: action, notificationUuid: uuid,
  });
  return json({ ok: true });
}
