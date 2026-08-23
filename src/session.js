import { generateToken, sha256, uuid } from './crypto.js';

const COOKIE_NAME = 'ws_session';
const SESSION_DAYS = 30;

/** user agent 截斷長度。它只是拿來顯示「哪一種裝置」，不需要完整保存。 */
const MAX_UA = 300;

/**
 * 「最後使用時間」的更新間隔。
 *
 * 每個請求都寫一次等於每個人的每個操作都多一次 D1 寫入，而畫面上顯示的是
 * 「2 小時前」這種精度——本來就不需要秒級準確。
 */
const SEEN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * @param {string|null} userAgent 由 handleLogin 從請求標頭取得後傳入。
 *   session.js 拿不到 request，所以這個值只能由呼叫端給。
 */
export async function createSession(env, userId, userAgent = null) {
  const token = generateToken();
  const now = Date.now();
  const expiresAt = now + SESSION_DAYS * 86400000;
  await env.DB
    .prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, last_seen_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(await sha256(token), userId, now, expiresAt,
          userAgent ? String(userAgent).slice(0, MAX_UA) : null, now)
    .run();
  return { token, expiresAt };
}

/**
 * 解析 cookie 並回傳對應使用者，順便帶出 role/status——授權判斷需要它們，
 * 分兩次查會讓「停用帳號」與「讀取資料」之間出現時間差。
 */
export async function getSessionUser(request, env) {
  const token = readCookie(request, COOKIE_NAME);
  if (!token) return null;

  const hash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.role, u.status, u.created_at, s.expires_at, s.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`
  ).bind(hash).first();

  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now) {
    await destroySession(env, token);
    return null;
  }

  // 這裡刻意**先讀後寫**，與〈樂觀鎖必須是單句 SQL〉並不衝突：那條規則防的是
  // 「讀到寫之間別人改了同一列，導致有意義的變更被無聲蓋掉」。last_seen_at 沒有
  // 這個風險——兩個並發請求寫進去的值幾乎相同，誰贏都一樣。
  //
  // 而先讀後寫在這裡反而更省：上面那個 SELECT 本來就要跑，順手把 last_seen_at
  // 帶出來之後，**新鮮的時候一句 SQL 都不必發**。改成無條件的單句 UPDATE 的話，
  // 每一個請求都會多送一句（即使它一列都改不到）。
  if (row.last_seen_at == null || now - row.last_seen_at >= SEEN_INTERVAL_MS) {
    // 條件仍然留著：兩個並發請求同時判定為過期時，只有一個會真的寫進去
    await env.DB.prepare(
      `UPDATE sessions SET last_seen_at = ?
        WHERE token_hash = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`
    ).bind(now, hash, now - SEEN_INTERVAL_MS).run();
  }

  return {
    id: row.id, email: row.email, role: row.role,
    status: row.status, createdAt: row.created_at,
  };
}

/**
 * 這個使用者目前有效的 session，最近使用的排前面。
 *
 * `WHERE user_id = ?` 綁的是呼叫端從 session 解出來的 user——**沒有任何參數可以
 * 指定別人**。這不是靠權限判斷擋住，是這條路徑根本走不到別人的資料。
 *
 * 回傳的 `current` 標出哪一個是發出這次請求的裝置，讓 UI 能寫「這台」而不是讓
 * 使用者自己猜。比對的是雜湊，不是把 token 送到前端。
 */
export async function listSessions(env, userId, currentToken) {
  const currentHash = currentToken ? await sha256(currentToken) : null;
  const { results } = await env.DB.prepare(
    `SELECT token_hash, created_at, last_seen_at, user_agent, expires_at
       FROM sessions
      WHERE user_id = ? AND expires_at > ?
      ORDER BY COALESCE(last_seen_at, created_at) DESC`
  ).bind(userId, Date.now()).all();

  return (results || []).map(r => ({
    // 不回 token_hash 本身：前端只需要知道「是不是這一台」，不需要能指認任何一列
    current: r.token_hash === currentHash,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    userAgent: r.user_agent,
    expiresAt: r.expires_at,
  }));
}

export async function destroySession(env, token) {
  if (!token) return;
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
    .bind(await sha256(token)).run();
}

/** 改密碼時呼叫：其他裝置全部登出，保留目前這個 session */
export async function destroyOtherSessions(env, userId, keepToken) {
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
    .bind(userId, await sha256(keepToken)).run();
}

/** 停用或刪除帳號時呼叫，讓該使用者所有裝置立即登出 */
export async function destroyAllSessions(env, userId) {
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}

export function readCookie(request, name) {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

export function sessionCookie(token, expiresAt) {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  // SameSite=Lax 讓從外部連結進站仍帶得到 cookie，同時擋掉跨站 POST 的 CSRF
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export { COOKIE_NAME, uuid };
