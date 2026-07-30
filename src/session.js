import { generateToken, sha256, uuid } from './crypto.js';

const COOKIE_NAME = 'ws_session';
const SESSION_DAYS = 30;

export async function createSession(env, userId) {
  const token = generateToken();
  const now = Date.now();
  const expiresAt = now + SESSION_DAYS * 86400000;
  await env.DB
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), userId, now, expiresAt)
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

  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.role, u.status, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`
  ).bind(await sha256(token)).first();

  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await destroySession(env, token);
    return null;
  }
  return { id: row.id, email: row.email, role: row.role, status: row.status };
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
