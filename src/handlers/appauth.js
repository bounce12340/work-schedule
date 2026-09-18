/**
 * iOS app 專用的認證路徑：驗證碼、以購買證明註冊、登入、刪除自己的帳號。
 *
 * 為什麼 app 要另一條路
 * ---------------------------------------------------------------------------
 * app 內建的是 public/index.html，網頁來源是 capacitor://localhost。對後端來說那是
 * 另一個網域，cookie 靠不住；Turnstile 在非 http 網域也跑不起來。所以：
 *
 *   - 登入回 token（存 Keychain、每次請求帶 Bearer），不發 cookie
 *   - 真人驗證改用 email 驗證碼：收得到寄到這個信箱的碼，同時證明信箱是本人的
 *   - 註冊附上 Apple 簽過名的購買證明（AppTransaction），驗過就**自動核准**——
 *     app 是付費下載，錢在 App Store 那一刻收完了，「付過錢」就是核准的條件
 *
 * 網頁那一側（handlers/auth.js）一行都沒改：cookie、Turnstile、管理者核准照舊。
 * 兩條路進的是同一張 users 與同一張 sessions。
 */
import { hashPassword, verifyPassword, uuid, sha256, timingSafeEqual } from '../crypto.js';
import { createSession } from '../session.js';
import { checkThrottle, recordFailure, clearFailures, throttleKeys } from '../throttle.js';
import { sendMail, escHtml } from '../mail.js';
import { verifyAppTransaction } from '../apppurchase.js';
import { json, adminEmails } from './auth.js';
import { logAdminAction } from './backup.js';

/** 上架用的 Bundle ID。一旦上架就不能改，所以寫死在這裡而不是環境變數。 */
export const APP_BUNDLE_ID = 'com.bounceto.workschedule';

const MIN_PASSWORD = 10;

/** 驗證碼有效期。夠久到切去信箱再切回來，短到撿到舊信也用不了。 */
const CODE_TTL_MS = 10 * 60 * 1000;
/** 同一筆碼最多試幾次。六碼只有一百萬種，不設上限就能慢慢猜。 */
const CODE_MAX_ATTEMPTS = 5;
/** 同一個 email 兩次索取之間的最短間隔：連點兩次送出鈕不該寄兩封。 */
const CODE_COOLDOWN_MS = 60 * 1000;

/**
 * POST /api/auth/app/code  { email }
 *
 * 寄一組六碼到信箱。**無論這個 email 有沒有註冊過都回同一個 200**：這裡若回
 * 「已註冊」，就變成帳號列舉工具（理由同忘記密碼）。已註冊的人拿著碼去註冊會在
 * 那一步得到 409「請直接登入」——到那時候他已經證明自己收得到那個信箱的信。
 */
export async function handleAppCode(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: '請求格式錯誤' }, 400);

  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) return json({ error: '請輸入有效的 email' }, 400);

  // 這個端點會寄信到別人的信箱，是最典型的濫用目標：email 與 IP 兩個維度都限
  const keys = throttleKeys(email, clientIp(request));
  const throttled = await checkThrottle(env, keys);
  if (throttled.blocked) {
    return json({ error: '嘗試次數過多，請稍後再試' }, 429, { 'Retry-After': String(throttled.retryAfterSec) });
  }

  const sent = { ok: true, message: '驗證碼已寄出，請查看信箱（10 分鐘內有效）' };
  const now = Date.now();

  const recent = await env.DB.prepare('SELECT created_at FROM email_codes WHERE email = ?').bind(email).first();
  if (recent && now - recent.created_at < CODE_COOLDOWN_MS) return json(sent);

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  // 索取新碼就把舊的換掉：一個 email 同時只有一筆有效的碼
  await env.DB.prepare(
    `INSERT INTO email_codes (email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
                                      attempts = 0, created_at = excluded.created_at`
  ).bind(email, await codeHash(email, code), now + CODE_TTL_MS, now).run();

  try {
    await sendMail(env, email, codeMail(code), 'verify');
  } catch (e) {
    // 回應仍是 200（不洩漏帳號存在），但一定要留下痕跡——降級可以，沉默不行
    console.error('app code mail failed', email, e?.stack || String(e));
  }
  // 每次索取都算一次「嘗試」，讓對同一個信箱狂按的人被節流擋下
  await recordFailure(env, keys);
  return json(sent);
}

/**
 * POST /api/auth/app/register  { email, code, password, appTransactionJws }
 *
 * 順序有講究：先做**沒有副作用**的檢查（密碼長度、購買證明驗簽、email 與購買是否
 * 已用過），最後才消費驗證碼——驗證碼用過即刪，若先消費再發現購買證明不對，
 * 使用者得回信箱重新索取一次。
 */
export async function handleAppRegister(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: '請求格式錯誤' }, 400);

  const email = normalizeEmail(body.email);
  const code = String(body.code || '').trim();
  const password = String(body.password || '');
  const jws = String(body.appTransactionJws || '');

  if (!isValidEmail(email)) return json({ error: '請輸入有效的 email' }, 400);
  if (!/^\d{6}$/.test(code)) return json({ error: '驗證碼是六位數字' }, 400);
  if (password.length < MIN_PASSWORD) return json({ error: `密碼至少需要 ${MIN_PASSWORD} 個字元` }, 400);

  const purchase = await verifyAppTransaction(jws, {
    bundleId: APP_BUNDLE_ID,
    allowSandbox: env.APP_PURCHASE_ALLOW_SANDBOX === '1',
    // 只有測試會設這個：讓 handler 層也能用假 Apple 的鏈跑完整條路。正式環境的
    // env 來自 wrangler，不會有這個鍵；名字刻意醜，讓它永遠不會被當成正式設定。
    trustedRootDer: env.__TEST_TRUSTED_ROOT_DER,
  });
  if (!purchase.ok) {
    // 只回原因類別，不轉發 Apple 的原文（同 AI 端點不轉發上游錯誤的理由）
    console.warn('app purchase proof rejected', purchase.reason);
    return json({ error: purchaseMessage(purchase.reason), reason: purchase.reason }, 403);
  }

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return json({ error: '這個 email 已經註冊過了，請直接登入' }, 409);

  const used = await env.DB.prepare('SELECT id FROM users WHERE app_transaction_id = ?')
    .bind(purchase.appTransactionId).first();
  if (used) return json({ error: '這次購買已經建立過帳號，請直接登入' }, 409);

  const codeOk = await consumeCode(env, email, code);
  if (!codeOk.ok) return json({ error: codeOk.message }, 400);

  const isBootstrapAdmin = adminEmails(env).includes(email);
  const now = Date.now();
  const id = uuid();
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, role, status, created_at, approved_at, approved_by,
                          purchase_source, app_transaction_id, purchased_at)
       VALUES (?, ?, ?, ?, 'approved', ?, ?, 'app_store', 'ios_app', ?, ?)`
    ).bind(
      id, email, await hashPassword(password),
      isBootstrapAdmin ? 'admin' : 'user',
      now, now, purchase.appTransactionId, purchase.originalPurchaseDate ?? now
    ).run();
  } catch (e) {
    // 兩個請求同時用同一份購買證明註冊：UNIQUE 擋下第二個。不能靠上面那次 SELECT，
    // 讀到寫之間有空窗（同〈樂觀鎖必須是單句 SQL〉）
    if (/UNIQUE/i.test(String(e?.message))) return json({ error: '這次購買已經建立過帳號，請直接登入' }, 409);
    throw e;
  }

  const session = await createSession(env, id, appUserAgent(request), { app: true });
  return json({ ok: true, token: session.token, expiresAt: session.expiresAt,
                user: { email, role: isBootstrapAdmin ? 'admin' : 'user' } });
}

/**
 * POST /api/auth/app/login  { email, password }
 *
 * 與 handleLogin 只差兩件事：沒有 Turnstile（app 裡跑不起來；節流仍在），
 * 以及回 token 而不是 Set-Cookie。其餘判斷——模糊訊息、帳號不存在也跑雜湊、
 * 兩條路徑都計失敗、狀態只在密碼對了才揭露——一模一樣，理由見 handleLogin。
 */
export async function handleAppLogin(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: '請求格式錯誤' }, 400);

  const email = normalizeEmail(body.email);
  const password = String(body.password || '');

  const keys = throttleKeys(email, clientIp(request));
  const throttled = await checkThrottle(env, keys);
  if (throttled.blocked) {
    return json({ error: '嘗試次數過多，請稍後再試' }, 429, { 'Retry-After': String(throttled.retryAfterSec) });
  }

  const user = await env.DB.prepare(
    'SELECT id, email, password_hash, role, status FROM users WHERE email = ?'
  ).bind(email).first();

  if (!user) {
    await hashPassword(password);
    await recordFailure(env, keys);
    return json({ error: 'email 或密碼錯誤' }, 401);
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    await recordFailure(env, keys);
    return json({ error: 'email 或密碼錯誤' }, 401);
  }
  if (user.status !== 'approved') {
    return json({ error: statusMessage(user.status), status: user.status }, 403);
  }
  await clearFailures(env, keys);

  const session = await createSession(env, user.id, appUserAgent(request), { app: true });
  return json({ ok: true, token: session.token, expiresAt: session.expiresAt,
                user: { email: user.email, role: user.role } });
}

/**
 * DELETE /api/auth/account  { password }
 *
 * Apple 5.1.1(v)：有註冊就要能在 app 裡自己刪。網頁版同一顆按鈕。
 *
 * 先記錄再刪（刪完就沒地方讀 email 了），然後把這個人在每一張表裡的東西都清掉。
 * `ADMIN_EMAILS` 名單內的帳號也能刪自己：名單防的是另一位管理者的**橫向**操作，
 * 本人拿密碼刪自己是直向的（同〈忘記密碼〉那節的判斷）；刪了之後再註冊仍會
 * 自動成為管理者，系統不會死鎖。
 *
 * share_activity 保留：那是別人的紀錄，email 是當下快照，讀得懂。R2 的每日備份
 * 會在 14 天輪替後自然消失，隱私頁寫明。
 */
export async function handleDeleteAccount(request, env, user) {
  const body = await readJson(request);
  if (!body) return json({ error: '請求格式錯誤' }, 400);

  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first();
  if (!row || !(await verifyPassword(String(body.password || ''), row.password_hash))) {
    return json({ error: '密碼不正確' }, 403);
  }

  await logAdminAction(env, user, user, '本人刪除帳號（含其雲端排程資料）');

  const id = user.id;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_state WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM shares WHERE owner_id = ? OR target_id = ?').bind(id, id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM ics_feed WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM reminder_feed WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM device_tokens WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM email_codes WHERE email = ?').bind(user.email),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------

/** 驗證碼比對。成功即刪；失敗計一次，第 5 次之後整筆作廢。 */
async function consumeCode(env, email, code) {
  const row = await env.DB.prepare(
    'SELECT code_hash, expires_at, attempts FROM email_codes WHERE email = ?'
  ).bind(email).first();
  const now = Date.now();
  if (!row) return { ok: false, message: '請先索取驗證碼' };
  if (row.expires_at < now) {
    await env.DB.prepare('DELETE FROM email_codes WHERE email = ?').bind(email).run();
    return { ok: false, message: '驗證碼已過期，請重新索取' };
  }
  if (row.attempts >= CODE_MAX_ATTEMPTS) {
    await env.DB.prepare('DELETE FROM email_codes WHERE email = ?').bind(email).run();
    return { ok: false, message: '嘗試次數過多，請重新索取驗證碼' };
  }
  const enc = new TextEncoder();
  const match = timingSafeEqual(enc.encode(row.code_hash), enc.encode(await codeHash(email, code)));
  if (!match) {
    await env.DB.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?').bind(email).run();
    return { ok: false, message: '驗證碼不正確' };
  }
  await env.DB.prepare('DELETE FROM email_codes WHERE email = ?').bind(email).run();
  return { ok: true };
}

/** 以 email 為鹽：六碼只有一百萬種，光雜湊碼本身等於明文 */
function codeHash(email, code) { return sha256(`${email}:${code}`); }

function codeMail(code) {
  return {
    subject: `【工作排程】驗證碼 ${code}`,
    text: `你的驗證碼是 ${code}，10 分鐘內有效。\n\n如果不是你在 app 裡註冊，忽略這封信即可。`,
    html: `<p>你的驗證碼是</p><p style="font-size:28px;letter-spacing:6px;font-family:monospace"><b>${escHtml(code)}</b></p>` +
          `<p>10 分鐘內有效。如果不是你在 app 裡註冊，忽略這封信即可。</p>`,
  };
}

function purchaseMessage(reason) {
  switch (reason) {
    case 'bundle': return '這份購買證明不屬於這個 app';
    case 'environment': return '目前只接受從 App Store 安裝的版本';
    case 'expired': return '購買證明的憑證已過期，請更新 app 後再試';
    default: return '無法驗證 App Store 的購買證明，請確認是從 App Store 安裝';
  }
}

/** app 帶 X-App-Client（ios/1.0.0）時併進 user agent，裝置清單才分得出是 app */
function appUserAgent(request) {
  const ua = request.headers.get('user-agent') || '';
  const client = request.headers.get('x-app-client') || '';
  return `${client} ${ua}`.trim() || null;
}

function statusMessage(status) {
  if (status === 'pending') return '帳號尚未核准，請等待管理者處理';
  if (status === 'rejected') return '這個帳號的申請未通過';
  if (status === 'suspended') return '這個帳號已被停用';
  return '帳號無法使用';
}

function normalizeEmail(v) { return String(v || '').trim().toLowerCase(); }
function isValidEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254; }
function clientIp(request) { return request.headers.get('cf-connecting-ip') || null; }
async function readJson(request) { try { return await request.json(); } catch { return null; } }
