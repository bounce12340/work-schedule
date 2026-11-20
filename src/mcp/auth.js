/**
 * MCP 的兩種憑證：個人金鑰（`wsk_…`，給 Claude Code／Cursor 這類貼得進金鑰的工具）
 * 與 OAuth（給 Claude.ai、ChatGPT 這類按「連接」就要登入一次的網頁 agent）。
 *
 * 兩種最後都是同一張 `mcp_tokens` 表上的一列：**只存雜湊**，原文只在產生當下出現一次
 * （同 session 與 ICS 的 token）。資料庫外洩時裡面的值拿不去用。
 *
 * 設計文件：docs/superpowers/specs/2026-11-20-mcp-server.md
 */
import { sha256, generateToken } from '../crypto.js';
import { getSessionUser } from '../session.js';
import { json } from '../handlers/auth.js';
import { planOf } from '../plan.js';

export const ACCESS_TTL_MS = 60 * 60 * 1000;          // OAuth access token：1 小時
export const REFRESH_TTL_MS = 60 * 24 * 3600 * 1000;  // refresh token：60 天
export const CODE_TTL_MS = 10 * 60 * 1000;            // 授權碼：10 分鐘、用一次
const MAX_KEYS = 10;
const LAST_USED_THROTTLE_MS = 10 * 60 * 1000;

const now = () => Date.now();

/** 依 Authorization: Bearer 找出是誰。找不到、過期、帳號停用一律 null。 */
export async function authenticateMcp(request, env) {
  const h = request.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const hash = await sha256(m[1]);
  const row = await env.DB.prepare(
    `SELECT t.id AS token_id, t.kind, t.name, t.expires_at, t.last_used_at,
            u.id, u.email, u.role, u.status, u.created_at, u.plan_source, u.plan_expires_at
       FROM mcp_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.kind IN ('key', 'oauth_access')`
  ).bind(hash).first();
  if (!row) return null;
  if (row.expires_at != null && row.expires_at < now()) return null;
  if (row.status !== 'approved') return null;

  // 最後使用時間：同 sessions.last_seen_at，十分鐘才寫一次——每個工具呼叫都寫一次 D1 不值得
  if (!row.last_used_at || now() - row.last_used_at > LAST_USED_THROTTLE_MS) {
    try {
      await env.DB.prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?').bind(now(), row.token_id).run();
    } catch (e) { console.warn('mcp last_used_at write failed', e?.message || e); }
  }
  return {
    actor: row.name || (row.kind === 'key' ? '個人金鑰' : 'OAuth'),
    tokenId: row.token_id,
    user: {
      id: row.id, email: row.email, role: row.role, status: row.status, createdAt: row.created_at,
      planSource: row.plan_source ?? null, planExpiresAt: row.plan_expires_at ?? null,
    },
  };
}

// ------------------------------------------------------------ 個人金鑰（我的帳號頁）

/** GET /api/mcp/connections：我的金鑰與 OAuth 連線。**不回 token 也不回雜湊。** */
export async function handleListConnections(env, user) {
  const rows = await env.DB.prepare(
    `SELECT id, kind, name, client_id, created_at, expires_at, last_used_at
       FROM mcp_tokens WHERE user_id = ? AND kind IN ('key', 'oauth_refresh')
      ORDER BY created_at DESC`
  ).bind(user.id).all();
  return json({
    pro: planOf(user) === 'pro',
    connections: (rows.results || []).map(r => ({
      id: r.id, kind: r.kind === 'key' ? 'key' : 'oauth', name: r.name,
      createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at,
    })),
  });
}

/** POST /api/mcp/keys：產生一把金鑰，原文只回這一次。 */
export async function handleCreateKey(request, env, user) {
  if (planOf(user) !== 'pro') return json({ error: '連接 AI agent 是 Pro 功能' }, 402);
  let body = {};
  try { body = await request.json(); } catch { /* 名稱可省略 */ }
  const name = String(body?.name || '').trim().slice(0, 60) || '個人金鑰';
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM mcp_tokens WHERE user_id = ? AND kind = 'key'"
  ).bind(user.id).first();
  if ((count?.n || 0) >= MAX_KEYS) return json({ error: `金鑰最多 ${MAX_KEYS} 把，請先撤銷用不到的` }, 400);
  const token = 'wsk_' + generateToken();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO mcp_tokens (id, user_id, kind, token_hash, name, created_at) VALUES (?, ?, 'key', ?, ?, ?)`
  ).bind(id, user.id, await sha256(token), name, now()).run();
  return json({ id, name, token });
}

/**
 * DELETE /api/mcp/connections/:id：撤銷。OAuth 那一種要連同它的 access token 一起刪
 * （同一個 grant_id），否則撤銷之後那把 access token 還能用一個小時。
 */
export async function handleRevokeConnection(env, user, id) {
  const row = await env.DB.prepare(
    'SELECT id, grant_id FROM mcp_tokens WHERE id = ? AND user_id = ?'
  ).bind(id, user.id).first();
  if (!row) return json({ error: '找不到這個連線' }, 404);
  if (row.grant_id) {
    await env.DB.prepare('DELETE FROM mcp_tokens WHERE grant_id = ? AND user_id = ?').bind(row.grant_id, user.id).run();
  } else {
    await env.DB.prepare('DELETE FROM mcp_tokens WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  }
  return json({ ok: true });
}

// ------------------------------------------------------------ OAuth 2.1（授權碼 + PKCE）

export function origin(request) {
  return new URL(request.url).origin;
}

const corsAny = { 'Access-Control-Allow-Origin': '*' };

export function handleProtectedResourceMetadata(request) {
  const o = origin(request);
  return json({
    resource: o + '/mcp',
    authorization_servers: [o],
    bearer_methods_supported: ['header'],
    resource_name: '工作排程確認系統',
  }, 200, corsAny);
}

export function handleAuthServerMetadata(request) {
  const o = origin(request);
  return json({
    issuer: o,
    authorization_endpoint: o + '/oauth/authorize',
    token_endpoint: o + '/oauth/token',
    registration_endpoint: o + '/oauth/register',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['schedule'],
  }, 200, corsAny);
}

/** redirect_uri 只收 https，或本機開發用的 http://localhost／127.0.0.1。 */
function okRedirect(u) {
  try {
    const x = new URL(u);
    if (x.hash) return false;
    if (x.protocol === 'https:') return true;
    return x.protocol === 'http:' && (x.hostname === 'localhost' || x.hostname === '127.0.0.1');
  } catch { return false; }
}

/** POST /oauth/register：動態註冊（Claude.ai、ChatGPT 的連接器都靠它）。只收公開 client。 */
export async function handleRegister(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_client_metadata' }, 400, corsAny); }
  const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 5 || !uris.every(okRedirect)) {
    return json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris 要是 https（或 localhost）的網址，最多 5 個' }, 400, corsAny);
  }
  const name = String(body?.client_name || 'AI agent').slice(0, 80);
  const clientId = 'mcpc_' + generateToken().slice(0, 24);
  await env.DB.prepare(
    'INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)'
  ).bind(clientId, name, JSON.stringify(uris), now()).run();
  return json({
    client_id: clientId,
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    client_id_issued_at: Math.floor(now() / 1000),
  }, 201, corsAny);
}

async function loadClient(env, clientId) {
  if (!clientId) return null;
  const row = await env.DB.prepare('SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?')
    .bind(String(clientId)).first();
  if (!row) return null;
  let uris = [];
  try { uris = JSON.parse(row.redirect_uris); } catch { /* 壞掉就當沒有 */ }
  return { id: row.client_id, name: row.client_name, redirectUris: uris };
}

function withQuery(base, params) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
  return u.toString();
}

/**
 * GET /oauth/authorize：先驗 client 與 redirect_uri，再把人帶到 /authorize.html 那一頁
 * 讓他按「允許」。
 *
 * **redirect_uri 對不上就絕不轉址**，直接在這裡顯示錯誤：拿一個沒登記過的網址轉過去，
 * 等於讓任何人把授權碼送到自己的網站（OAuth 的 open redirect）。
 */
export async function handleAuthorizeRedirect(request, env) {
  const url = new URL(request.url);
  const p = url.searchParams;
  const client = await loadClient(env, p.get('client_id'));
  const redirectUri = p.get('redirect_uri');
  if (!client || !redirectUri || !client.redirectUris.includes(redirectUri)) {
    return new Response('這個授權請求無效（找不到 client，或 redirect_uri 沒有登記過）。', {
      status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  if (p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) {
    return Response.redirect(withQuery(redirectUri, {
      error: 'invalid_request', error_description: '需要 response_type=code 與 S256 的 PKCE', state: p.get('state'),
    }), 302);
  }
  return Response.redirect(new URL('/authorize.html' + url.search, url).toString(), 302);
}

/** POST /api/oauth/info：授權頁要顯示「誰想要連、你是誰、你能不能連」。要 session。 */
export async function handleAuthorizeInfo(request, env, user) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '格式錯誤' }, 400); }
  const client = await loadClient(env, body?.client_id);
  if (!client || !client.redirectUris.includes(body?.redirect_uri)) return json({ error: '這個授權請求無效' }, 400);
  return json({ clientName: client.name, email: user.email, pro: planOf(user) === 'pro' });
}

/**
 * POST /api/oauth/decision：使用者按了允許或拒絕。回的是**要轉去哪裡**，由伺服器組，
 * 前端照著跳——不讓前端自己拼網址，免得 redirect_uri 的檢查在前端被繞過。
 */
export async function handleAuthorizeDecision(request, env, user) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '格式錯誤' }, 400); }
  const client = await loadClient(env, body?.client_id);
  const redirectUri = body?.redirect_uri;
  if (!client || !client.redirectUris.includes(redirectUri)) return json({ error: '這個授權請求無效' }, 400);
  const state = body?.state || null;
  if (!body?.approve) {
    return json({ redirect: withQuery(redirectUri, { error: 'access_denied', state }) });
  }
  if (planOf(user) !== 'pro') return json({ error: '連接 AI agent 是 Pro 功能' }, 402);
  const challenge = String(body?.code_challenge || '');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return json({ error: 'code_challenge 格式不對' }, 400);

  const code = generateToken();
  await env.DB.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(await sha256(code), client.id, user.id, redirectUri, challenge, now() + CODE_TTL_MS, now()).run();
  return json({ redirect: withQuery(redirectUri, { code, state }) });
}

async function s256(verifier) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  let s = '';
  for (const b of d) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function issueTokens(env, { userId, clientId, clientName, grantId }) {
  const access = 'wsa_' + generateToken();
  const refresh = 'wsr_' + generateToken();
  const t = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO mcp_tokens (id, user_id, kind, token_hash, name, client_id, grant_id, created_at, expires_at)
       VALUES (?, ?, 'oauth_access', ?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), userId, await sha256(access), clientName, clientId, grantId, t, t + ACCESS_TTL_MS),
    env.DB.prepare(
      `INSERT INTO mcp_tokens (id, user_id, kind, token_hash, name, client_id, grant_id, created_at, expires_at)
       VALUES (?, ?, 'oauth_refresh', ?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), userId, await sha256(refresh), clientName, clientId, grantId, t, t + REFRESH_TTL_MS),
  ]);
  return {
    access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000,
    refresh_token: refresh, scope: 'schedule',
  };
}

const tokenError = (error, description, status = 400) =>
  json({ error, error_description: description }, status, { ...corsAny, 'Cache-Control': 'no-store' });

/** POST /oauth/token：授權碼換 token、refresh token 換新的一組（舊的當場作廢）。 */
export async function handleToken(request, env) {
  const ct = request.headers.get('content-type') || '';
  let p;
  try {
    p = ct.includes('application/json')
      ? new URLSearchParams(Object.entries(await request.json()).map(([k, v]) => [k, String(v)]))
      : new URLSearchParams(await request.text());
  } catch { return tokenError('invalid_request', '無法解析'); }

  const grant = p.get('grant_type');
  if (grant === 'authorization_code') {
    const code = p.get('code'), verifier = p.get('code_verifier');
    if (!code || !verifier) return tokenError('invalid_request', '缺 code 或 code_verifier');
    const hash = await sha256(code);
    // 先把那一列「領走」（單句 UPDATE），再看內容：兩個請求同時拿同一個 code 來換，
    // 只會有一個改得到那一列——同〈樂觀鎖必須是單句 SQL〉
    const claimed = await env.DB.prepare(
      'UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL'
    ).bind(now(), hash).run();
    const row = await env.DB.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').bind(hash).first();
    if (!claimed.meta?.changes || !row) return tokenError('invalid_grant', '授權碼無效或已經用過');
    if (row.expires_at < now()) return tokenError('invalid_grant', '授權碼已過期');
    if (row.client_id !== p.get('client_id')) return tokenError('invalid_grant', 'client_id 不符');
    if (row.redirect_uri !== p.get('redirect_uri')) return tokenError('invalid_grant', 'redirect_uri 不符');
    if (await s256(verifier) !== row.code_challenge) return tokenError('invalid_grant', 'PKCE 驗證失敗');
    const client = await loadClient(env, row.client_id);
    return json(await issueTokens(env, {
      userId: row.user_id, clientId: row.client_id, clientName: client?.name || 'AI agent', grantId: crypto.randomUUID(),
    }), 200, { ...corsAny, 'Cache-Control': 'no-store' });
  }

  if (grant === 'refresh_token') {
    const rt = p.get('refresh_token');
    if (!rt) return tokenError('invalid_request', '缺 refresh_token');
    const row = await env.DB.prepare(
      "SELECT id, user_id, name, client_id, grant_id, expires_at FROM mcp_tokens WHERE token_hash = ? AND kind = 'oauth_refresh'"
    ).bind(await sha256(rt)).first();
    if (!row || row.expires_at < now()) return tokenError('invalid_grant', 'refresh token 無效或已過期');
    if (p.get('client_id') && p.get('client_id') !== row.client_id) return tokenError('invalid_grant', 'client_id 不符');
    // 輪替：這一組（access + refresh）整組作廢、發新的一組，grant 不變（撤銷時一次刪乾淨）。
    // 刪除也是單句帶條件：兩個請求拿同一把 refresh token 來換，只有一個刪得到
    const del = await env.DB.prepare('DELETE FROM mcp_tokens WHERE id = ?').bind(row.id).run();
    if (!del.meta?.changes) return tokenError('invalid_grant', 'refresh token 已經用過');
    await env.DB.prepare("DELETE FROM mcp_tokens WHERE grant_id = ? AND kind = 'oauth_access'").bind(row.grant_id).run();
    return json(await issueTokens(env, {
      userId: row.user_id, clientId: row.client_id, clientName: row.name, grantId: row.grant_id,
    }), 200, { ...corsAny, 'Cache-Control': 'no-store' });
  }

  return tokenError('unsupported_grant_type', '只支援 authorization_code 與 refresh_token');
}

export { getSessionUser };
