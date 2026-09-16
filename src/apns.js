/**
 * APNs（Apple Push Notification service）：簽 JWT、送一則推播。
 *
 * 設計文件：docs/superpowers/specs/2026-09-17-push-design.md
 *
 * 為什麼可以在 Worker 裡做
 * ---------------------------------------------------------------------------
 * APNs 的 token 認證是一段 **ES256 的 JWT**，用 App Store Connect 下載的 `.p8`
 * 金鑰簽。WebCrypto 直接做得到（`importKey('pkcs8', …)` + `sign`）——與
 * `src/apppurchase.js` 驗 Apple 簽章用的是同一套 API，不必引進任何套件。
 *
 * 唯一沒有辦法在開發環境證明的一件事
 * ---------------------------------------------------------------------------
 * **APNs 只收 HTTP/2。** Workers 的 `fetch()` 由 Cloudflare 自己協商協定，而它支援
 * HTTP/2 到來源，所以這條路應該通——但要真的 `.p8` 與真的 device token 才驗得到。
 * 因此這件事不靠祈禱：`/api/admin/push-test` 讓管理者設定完當天就能證明它通不通，
 * 而 cron 的推播那一步會把結果寫進 `cron_runs`（同〈看得見的備份才是備份〉）。
 */

/** 正式與 sandbox 是兩台不同的伺服器。搞錯的症狀是 400 BadDeviceToken——
 *  而那看起來像「token 壞了」，會往完全錯誤的方向查。 */
const HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

/**
 * JWT 的快取。Apple 要求同一把金鑰的 token **至少 20 分鐘**才換一次，上限 60 分鐘，
 * 換太勤會被擋（TooManyProviderTokenUpdates）。50 分鐘是中間偏上的安全值。
 *
 * 存在模組變數裡：Worker 的隔離區會重用，重建就重簽——沒有正確性問題，只是多簽一次。
 */
let cachedJwt = null;
let cachedJwtAt = 0;
const JWT_TTL_MS = 50 * 60 * 1000;

/** 測試用：清掉快取，好驗「第二次呼叫不重簽」與「過期會重簽」兩條路。 */
export function _resetApnsJwtCache() { cachedJwt = null; cachedJwtAt = 0; }

/** 三個 secret 都在才算設定好。少一個就是「還沒開這個功能」，不是失敗。 */
export function apnsConfigured(env) {
  return !!(env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_P8);
}

function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PEM（含 BEGIN/END 那兩行）→ DER。secret 是整個檔案的內容，不是只有中間那段。 */
function pemToDer(pem) {
  const body = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 簽（或從快取拿）APNs 的 provider token。
 *
 * @param {object} env
 * @param {number} [nowMs]
 */
export async function apnsJwt(env, nowMs = Date.now()) {
  if (cachedJwt && nowMs - cachedJwtAt < JWT_TTL_MS) return cachedJwt;

  const header = { alg: 'ES256', kid: String(env.APNS_KEY_ID) };
  const payload = { iss: String(env.APNS_TEAM_ID), iat: Math.floor(nowMs / 1000) };
  const enc = new TextEncoder();
  const signingInput = b64url(enc.encode(JSON.stringify(header))) + '.' + b64url(enc.encode(JSON.stringify(payload)));

  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(env.APNS_P8),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput)
  ));

  cachedJwt = signingInput + '.' + b64url(sig);
  cachedJwtAt = nowMs;
  return cachedJwt;
}

/**
 * 送一則推播。
 *
 * @param {object} env
 * @param {object} msg
 * @param {string} msg.token        device token（hex）
 * @param {string} [msg.environment] 'production'（預設）| 'sandbox'
 * @param {string} msg.title
 * @param {string} msg.body
 * @param {string} msg.collapseId   同一種通知只留最新一則
 * @returns {Promise<{ok:boolean, status:number, reason:string, gone:boolean}>}
 *
 * `gone` 為真代表**這個 token 該從資料庫刪掉**：那支手機上已經沒有這個 app 了
 * （410），或 token 根本不對（400 BadDeviceToken，通常是環境搞錯）。不刪的話這張
 * 表會慢慢長滿再也送不到的 token，而每天都會為它們各打一次 API。
 */
export async function apnsSend(env, msg) {
  const host = HOSTS[msg.environment === 'sandbox' ? 'sandbox' : 'production'];
  const jwt = await apnsJwt(env);
  const res = await fetch(`${host}/3/device/${msg.token}`, {
    method: 'POST',
    headers: {
      authorization: 'bearer ' + jwt,
      'apns-topic': env.APNS_TOPIC || 'com.bounceto.workschedule',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-collapse-id': String(msg.collapseId || 'default').slice(0, 64),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      aps: { alert: { title: msg.title, body: msg.body }, sound: 'default' },
    }),
  });

  if (res.status === 200) return { ok: true, status: 200, reason: '', gone: false };

  // 失敗時**一定要把 body 讀出來**：APNs 把原因放在 body 的 reason 欄位，只記狀態碼
  // 的話「金鑰不對」與「token 不對」看起來一模一樣（同 AgentMail 那條）。
  let reason = '';
  try { reason = String((await res.json()).reason || ''); } catch { reason = ''; }
  const gone = res.status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered';
  return { ok: false, status: res.status, reason, gone };
}
