/**
 * 自助密碼重設：寄一封含一次性連結的信。
 *
 * 為什麼需要這條路徑
 * ---------------------------------------------------------------------------
 * `ADMIN_EMAILS` 名單內的帳號連管理者都不能重設密碼（handlers/admin.js 的
 * handleResetPassword 會回 403）——那是防止另一位管理者橫向接管帳號的最後保險。
 * 但那道保險把「本人忘記密碼」也一起擋死了，四條路全部封閉：
 *
 *   1. 管理者按「重設密碼」   → 403「這是設定檔指定的管理者」
 *   2. 自己用「變更密碼」     → 要先輸入舊密碼（都忘了還怎麼輸入）
 *   3. 登入頁的「忘記密碼」   → 在這個檔案存在之前，根本沒有這個功能
 *   4. 手機還登著的那台裝置   → 一樣走 2，一樣要舊密碼
 *
 * 剩下唯一的救法是去 Cloudflare 改環境變數，而那個繞路本身也有地雷：把人從名單
 * 拿掉之後忘記加回去，防線就靜靜消失，而畫面上完全看不出來。
 *
 * 這條路徑刻意**不檢查 ADMIN_EMAILS**，而且那不是在保險上打洞
 * ---------------------------------------------------------------------------
 * 名單防的是「另一個管理者」的**橫向**接管——攻擊者已經在系統裡，想跨過去拿別人
 * 的帳號。而收得到寄到該帳號信箱的信，等於**證明自己就是本人**，是直向的。兩者
 * 擋的東西不同，所以自助重設對名單要防的情境沒有影響。
 *
 * 代價要說清楚：帳號安全從此綁在信箱安全上。信箱被盜就等於帳號被盜——原本的設計
 * 沒有這個弱點（代價是忘記密碼就永遠打不開）。這是取捨，不是純好處。
 *
 * 原本 handlers/admin.js 寫著「不做 email 寄信重設是刻意的：系統沒有寄信基礎設施」，
 * 那句話在接上 AgentMail 寄逾期提醒之後就過期了——寄信能力早就有了。
 */
import { hashPassword, generateToken, sha256 } from '../crypto.js';
import { destroyAllSessions } from '../session.js';
import { verifyTurnstile } from '../turnstile.js';
import { sendMail, escHtml } from '../mail.js';
import { json } from './auth.js';

const MIN_PASSWORD = 10;

/** 連結有效期。夠久到使用者去信箱翻一翻，短到撿到舊信也用不了。 */
const TTL_MS = 60 * 60 * 1000;

/** 同一個帳號兩次索取之間的最短間隔，避免這個端點被當成寄信機打別人的信箱。 */
const COOLDOWN_MS = 60 * 1000;

/**
 * POST /api/auth/forgot  { email, turnstileToken }
 *
 * **無論結果如何都回同一個 200。** 回「查無此 email」等於把這個端點變成帳號
 * 列舉工具——任何人都能逐一試出哪些 email 註冊過。登入失敗訊息刻意模糊也是
 * 同一個理由，這裡不能自己開一個後門。
 */
export async function handleForgotPassword(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: '請求格式錯誤' }, 400);

  const email = normalizeEmail(body.email);

  // 真人驗證擋在最前面：這個端點會**寄信到別人的信箱**，是最典型的濫用目標。
  // 未設定金鑰時一律擋下，理由同註冊與登入——放行等於驗證形同虛設。
  const ts = await verifyTurnstile(body.turnstileToken, env, clientIp(request));
  if (!ts.ok) return json({ error: '真人驗證未通過，請重新整理後再試', detail: ts.reason }, 403);

  const sent = { ok: true, message: '如果這個 email 有註冊，重設連結已經寄出，請查看信箱' };
  if (!isValidEmail(email)) return json(sent);

  const user = await env.DB
    .prepare('SELECT id, email, status FROM users WHERE email = ?').bind(email).first();

  // 查無此人、或帳號不是 approved（待核准／已拒絕／已停用）就到此為止，但回應
  // 完全一樣。停用中的帳號能重設密碼的話，停用就形同虛設。
  if (!user || user.status !== 'approved') return json(sent);

  const now = Date.now();

  // 冷卻期內重複索取直接略過寄信（回應仍然一樣）。連點兩次送出鈕不該寄兩封。
  const recent = await env.DB.prepare(
    'SELECT created_at FROM password_resets WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(user.id).first();
  if (recent && now - recent.created_at < COOLDOWN_MS) return json(sent);

  // 舊的未使用連結一律作廢。留著的話，先前那封信裡的連結仍然有效——使用者以為
  // 「我重新要了一次」，實際上舊連結還在外面飄。
  await env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(user.id).run();

  const token = generateToken();
  await env.DB.prepare(
    'INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(await sha256(token), user.id, now, now + TTL_MS).run();

  const link = resetLink(env, request, token);
  try {
    await sendMail(env, user.email, buildResetEmail(link));
  } catch (e) {
    // 寄信失敗仍然回同一個 200：把失敗說出來一樣會洩漏「這個 email 存在」。
    // 但一定要留下 stack——降級可以，沉默不行。沒有這行的話，管理者只會看到
    // 使用者說「我沒收到信」，而 log 裡一片乾淨。
    console.error('password reset mail failed', user.id, e?.stack || String(e));
  }
  return json(sent);
}

/**
 * POST /api/auth/reset  { token, password }
 *
 * 這一步**不要求 Turnstile**，是刻意的：token 本身就是憑證，而且是 256 位元的
 * 隨機值，猜不到。反而多一個「Turnstile 載入失敗就無法重設」的故障點——這條路徑
 * 是使用者已經進不去系統時才會走的，不能再多一個會壞的東西。
 *
 * 濫用防線放在索取那一端（會寄信的是那一端），不是這一端。
 */
export async function handleResetPassword(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: '請求格式錯誤' }, 400);

  const token = String(body.token || '');
  const password = String(body.password || '');
  if (!token) return json({ error: '連結不完整，請重新索取' }, 400);
  if (password.length < MIN_PASSWORD) {
    return json({ error: `密碼至少需要 ${MIN_PASSWORD} 個字元` }, 400);
  }

  const row = await env.DB.prepare(
    'SELECT token_hash, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?'
  ).bind(await sha256(token)).first();

  if (!row) return json({ error: '連結無效，請重新索取' }, 400);
  // 用過與過期分開講：使用者按了上一頁、或郵件用戶端先幫他點過，訊息要看得懂
  if (row.used_at) return json({ error: '這個連結已經使用過了，請重新索取' }, 400);
  if (row.expires_at < Date.now()) return json({ error: '連結已過期，請重新索取' }, 400);

  // 標記已使用與寫入新密碼之間有空窗，但這裡刻意不追求原子性：最壞的情況是
  // 同一個人用同一封信重設兩次，結果相同。真正要擋的是「用過的連結還能再用」，
  // 由 used_at 擋住。
  await env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?')
    .bind(Date.now(), row.token_hash).run();
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(await hashPassword(password), row.user_id).run();

  // 重設密碼的前提通常是「我進不去」或「我懷疑被盜」，所有裝置都必須登出。
  // 保留任何一個舊 session，等於重設完了攻擊者還在裡面。
  await destroyAllSessions(env, row.user_id);

  // 刻意不順手發新 session：讓使用者用新密碼真的登入一次，確認它真的能用。
  return json({ ok: true, message: '密碼已更新，請用新密碼登入' });
}

/**
 * 信裡的連結。優先用 APP_URL（與逾期提醒信同一個變數），沒設定就從這次請求的
 * origin 推——自架或改網域的人不必再多設一個變數，而 origin 本來就是使用者
 * 剛剛打進來的位址。
 */
function resetLink(env, request, token) {
  const base = String(env.APP_URL || '').replace(/\/+$/, '') || new URL(request.url).origin;
  return `${base}/reset?token=${encodeURIComponent(token)}`;
}

function buildResetEmail(link) {
  const text = [
    '有人（希望是你）要求重設「工作排程確認系統」的密碼。',
    '',
    '請在一小時內開啟以下連結設定新密碼：',
    link,
    '',
    '這個連結只能使用一次，用過或逾時就會失效。',
    '如果不是你要求的，請忽略這封信——在連結被使用之前，你的密碼不會有任何改變。',
  ].join('\n');

  const html = `<div style="font-family:system-ui,'Noto Sans TC',sans-serif;max-width:520px;color:#2A2A26">
<p style="margin:0 0 16px">有人（希望是你）要求重設「工作排程確認系統」的密碼。</p>
<p style="margin:0 0 20px"><a href="${escHtml(link)}"
  style="display:inline-block;padding:11px 20px;background:#C9822E;color:#FFFDF9;
         border-radius:8px;text-decoration:none;font-weight:600">設定新密碼</a></p>
<p style="margin:0 0 8px;color:#71706A;font-size:13px">這個連結<strong>一小時內有效</strong>，而且只能使用一次。</p>
<p style="margin:0;color:#71706A;font-size:13px">如果不是你要求的，請忽略這封信——在連結被使用之前，你的密碼不會有任何改變。</p>
<p style="margin:22px 0 0;color:#A2A099;font-size:12px;word-break:break-all">按鈕打不開的話，請複製這個網址：${escHtml(link)}</p>
</div>`;

  return { subject: '【工作排程確認系統】重設密碼', text, html };
}

function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || null;
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}
