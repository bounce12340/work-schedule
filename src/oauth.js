/**
 * App OAuth 驗證與 Apple credential 撤銷。
 *
 * OAuth provider 只負責證明「這個人是誰」；帳號與方案仍然是 D1 的 user_id。
 * StoreKit 的交易也必須帶同一個 user_id 作為 appAccountToken，避免把 Pro
 * 綁在某一台手機或某一個 Apple ID 的暫時 session 上。
 */
import { uuid } from './crypto.js';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';
const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';

let appleKeysCache = null;
let appleKeysCachedAt = 0;
const APPLE_KEYS_TTL = 6 * 3600 * 1000;

export async function verifyAppOAuth(body, env) {
  const provider = body?.provider === 'apple' || body?.provider === 'google'
    ? body.provider : null;
  if (!provider) return { ok: false, reason: 'provider' };

  if (provider === 'google') {
    return verifyGoogle(body, env);
  }
  return verifyApple(body, env);
}

async function verifyGoogle(body, env) {
  const clientId = String(env.GOOGLE_IOS_CLIENT_ID || '');
  if (!clientId) return { ok: false, reason: 'not_configured' };

  let idToken = String(body.idToken || '');
  if (body.authorizationCode) {
    const redirectUri = String(body.redirectUri || env.GOOGLE_IOS_REDIRECT_URI || '');
    const verifier = String(body.codeVerifier || '');
    if (!redirectUri || !verifier) return { ok: false, reason: 'oauth_parameters' };
    const form = new URLSearchParams({
      code: String(body.authorizationCode),
      client_id: clientId,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    });
    const exchanged = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (!exchanged.ok) return { ok: false, reason: 'token_exchange' };
    const data = await exchanged.json().catch(() => ({}));
    idToken = String(data.id_token || '');
  }
  if (!idToken) return { ok: false, reason: 'token' };

  // tokeninfo 會由 Google 驗證簽章與 issuer；仍然要比對 aud、issuer、email_verified，
  // 不能只相信前端送來的 email。
  const res = await fetch(`${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(idToken)}`);
  if (!res.ok) return { ok: false, reason: 'token' };
  const p = await res.json().catch(() => ({}));
  if (String(p.aud || '') !== clientId
      || !['accounts.google.com', 'https://accounts.google.com'].includes(String(p.iss || ''))
      || String(p.email_verified) !== 'true'
      || !p.sub || !p.email) {
    return { ok: false, reason: 'claims' };
  }
  if (Number(p.exp) * 1000 <= Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, provider: 'google', subject: String(p.sub), email: String(p.email).toLowerCase() };
}

async function verifyApple(body, env) {
  const token = String(body.idToken || '');
  if (!token) return { ok: false, reason: 'token' };
  const verified = await verifyAppleJwt(token, env);
  if (!verified.ok) return verified;
  if (body.nonce && verified.payload.nonce && verified.payload.nonce !== body.nonce) {
    return { ok: false, reason: 'nonce' };
  }

  let refreshToken = null;
  const code = String(body.authorizationCode || '');
  if (code && appleOAuthConfigured(env)) {
    refreshToken = await exchangeAppleCode(code, env);
  }
  return {
    ok: true,
    provider: 'apple',
    subject: String(verified.payload.sub),
    email: verified.payload.email ? String(verified.payload.email).toLowerCase() : null,
    appleRefreshToken: refreshToken,
  };
}

export async function revokeAppleCredential(refreshToken, env) {
  if (!refreshToken || !appleOAuthConfigured(env)) {
    if (refreshToken) console.warn('Apple credential could not be revoked: OAuth secrets are not configured');
    return false;
  }
  const form = new URLSearchParams({
    client_id: String(env.APPLE_SIGN_IN_CLIENT_ID),
    client_secret: await appleClientSecret(env),
    token: String(refreshToken),
    token_type_hint: 'refresh_token',
  });
  const res = await fetch('https://appleid.apple.com/auth/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!res.ok) {
    console.error('Apple credential revoke failed', res.status, await res.text());
    return false;
  }
  return true;
}

export async function linkOAuthIdentity(env, auth, userId) {
  const now = Date.now();
  const existing = await env.DB.prepare(
    'SELECT user_id FROM oauth_identities WHERE provider = ? AND subject = ?'
  ).bind(auth.provider, auth.subject).first();
  if (existing && existing.user_id !== userId) return { ok: false, reason: 'identity_in_use' };

  const current = await env.DB.prepare(
    'SELECT id FROM oauth_identities WHERE user_id = ? AND provider = ?'
  ).bind(userId, auth.provider).first();
  if (current) {
    await env.DB.prepare(
      `UPDATE oauth_identities SET subject = ?, email = ?, apple_refresh_token = ?, updated_at = ?
       WHERE id = ?`
    ).bind(auth.subject, auth.email, auth.appleRefreshToken || null, now, current.id).run();
    return { ok: true };
  }
  await env.DB.prepare(
    `INSERT INTO oauth_identities
      (id, user_id, provider, subject, email, apple_refresh_token, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(uuid(), userId, auth.provider, auth.subject, auth.email,
    auth.appleRefreshToken || null, now, now).run();
  return { ok: true };
}

function appleOAuthConfigured(env) {
  return !!(env.APPLE_SIGN_IN_TEAM_ID && env.APPLE_SIGN_IN_KEY_ID
    && env.APPLE_SIGN_IN_PRIVATE_KEY && env.APPLE_SIGN_IN_CLIENT_ID);
}

async function exchangeAppleCode(code, env) {
  const form = new URLSearchParams({
    client_id: String(env.APPLE_SIGN_IN_CLIENT_ID),
    client_secret: await appleClientSecret(env),
    code,
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://appleid.apple.com/auth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!res.ok) {
    console.error('Apple authorization-code exchange failed', res.status, await res.text());
    return null;
  }
  const data = await res.json().catch(() => ({}));
  return data.refresh_token || null;
}

async function verifyAppleJwt(token, env) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return { ok: false, reason: 'format' };
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[1])));
  } catch {
    return { ok: false, reason: 'format' };
  }
  if (header.alg !== 'RS256' || !header.kid) return { ok: false, reason: 'format' };
  const keys = await appleKeys();
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'key' };
  let key;
  try {
    key = await crypto.subtle.importKey('jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' }, key, b64urlBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!valid) return { ok: false, reason: 'signature' };
  } catch {
    return { ok: false, reason: 'signature' };
  }
  if (payload.iss !== APPLE_ISSUER || payload.aud !== 'com.bounceto.workschedule'
      || !payload.sub || Number(payload.exp) * 1000 <= Date.now()) {
    return { ok: false, reason: 'claims' };
  }
  return { ok: true, payload };
}

async function appleKeys() {
  if (appleKeysCache && Date.now() - appleKeysCachedAt < APPLE_KEYS_TTL) return appleKeysCache;
  const res = await fetch(APPLE_KEYS_URL);
  if (!res.ok) throw new Error(`Apple JWKS ${res.status}`);
  const data = await res.json();
  appleKeysCache = Array.isArray(data.keys) ? data.keys : [];
  appleKeysCachedAt = Date.now();
  return appleKeysCache;
}

async function appleClientSecret(env) {
  const header = { alg: 'ES256', kid: String(env.APPLE_SIGN_IN_KEY_ID) };
  const payload = {
    iss: String(env.APPLE_SIGN_IN_TEAM_ID),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 86400 * 180,
    aud: APPLE_ISSUER,
    sub: String(env.APPLE_SIGN_IN_CLIENT_ID),
  };
  const enc = new TextEncoder();
  const input = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(payload)))}`;
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(env.APPLE_SIGN_IN_PRIVATE_KEY),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(input)
  ));
  return `${input}.${b64url(sig)}`;
}

function pemToDer(pem) {
  const body = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlBytes(s) {
  const raw = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
