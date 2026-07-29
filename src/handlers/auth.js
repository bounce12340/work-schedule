import { hashPassword, verifyPassword, uuid } from '../crypto.js';
import { createSession, destroySession, sessionCookie, clearCookie, readCookie, COOKIE_NAME } from '../session.js';
import { verifyTurnstile } from '../turnstile.js';

const MIN_PASSWORD = 10;

export async function handleRegister(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: '請求格式錯誤' }, 400);

  const email = normalizeEmail(body.email);
  const password = String(body.password || '');

  if (!isValidEmail(email)) return json({ error: '請輸入有效的 email' }, 400);
  if (password.length < MIN_PASSWORD) {
    return json({ error: `密碼至少需要 ${MIN_PASSWORD} 個字元` }, 400);
  }

  const ts = await verifyTurnstile(body.turnstileToken, env, clientIp(request));
  if (!ts.ok) return json({ error: '真人驗證未通過，請重新整理後再試', detail: ts.reason }, 403);

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) {
    // 這裡刻意明說。若比照登入回模糊訊息，使用者會卡在「註冊沒反應」而無從理解。
    return json({ error: '這個 email 已經註冊過了，請直接登入' }, 409);
  }

  // 名單內的 email 直接成為已核准的管理者，否則系統沒有人能核准第一個帳號
  const isBootstrapAdmin = adminEmails(env).includes(email);
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, role, status, created_at, approved_at, approved_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    uuid(), email, await hashPassword(password),
    isBootstrapAdmin ? 'admin' : 'user',
    isBootstrapAdmin ? 'approved' : 'pending',
    now, isBootstrapAdmin ? now : null, isBootstrapAdmin ? 'bootstrap' : null
  ).run();

  return json({
    ok: true,
    status: isBootstrapAdmin ? 'approved' : 'pending',
    message: isBootstrapAdmin ? '管理者帳號已建立，請登入' : '註冊成功，請等待管理者核准'
  });
}

export async function handleLogin(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: '請求格式錯誤' }, 400);

  const email = normalizeEmail(body.email);
  const password = String(body.password || '');

  const ts = await verifyTurnstile(body.turnstileToken, env, clientIp(request));
  if (!ts.ok) return json({ error: '真人驗證未通過，請重新整理後再試', detail: ts.reason }, 403);

  const user = await env.DB.prepare(
    'SELECT id, email, password_hash, role, status FROM users WHERE email = ?'
  ).bind(email).first();

  // 帳號不存在與密碼錯誤回相同訊息，避免被用來列舉哪些 email 有註冊。
  // 帳號不存在時仍跑一次雜湊，讓兩條路徑的耗時接近。
  if (!user) {
    await hashPassword(password);
    return json({ error: 'email 或密碼錯誤' }, 401);
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    return json({ error: 'email 或密碼錯誤' }, 401);
  }

  // 密碼正確後才揭露帳號狀態——此時對方已證明自己是帳號持有人
  if (user.status !== 'approved') {
    return json({ error: statusMessage(user.status), status: user.status }, 403);
  }

  const { token, expiresAt } = await createSession(env, user.id);
  return json(
    { ok: true, user: { email: user.email, role: user.role } },
    200,
    { 'Set-Cookie': sessionCookie(token, expiresAt) }
  );
}

export async function handleLogout(request, env) {
  await destroySession(env, readCookie(request, COOKIE_NAME));
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}

export function handleMe(user) {
  return json({ email: user.email, role: user.role, status: user.status });
}

function statusMessage(status) {
  if (status === 'pending') return '帳號尚未核准，請等待管理者處理';
  if (status === 'rejected') return '這個帳號的申請未通過';
  if (status === 'suspended') return '這個帳號已被停用';
  return '帳號無法使用';
}

export function adminEmails(env) {
  return String(env.ADMIN_EMAILS || '')
    .split(',').map(s => normalizeEmail(s)).filter(Boolean);
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

export function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers }
  });
}
