import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAppOAuth, linkOAuthIdentity } from '../src/oauth.js';
import { makeEnv, addUser } from './d1.mjs';

test('Google OAuth：Worker 驗證 audience、issuer、email_verified 後才接受', async () => {
  const env = { GOOGLE_IOS_CLIENT_ID: 'google-client.apps.googleusercontent.com' };
  const real = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    aud: env.GOOGLE_IOS_CLIENT_ID,
    iss: 'https://accounts.google.com',
    sub: 'google-sub-1',
    email: 'Josh@example.com',
    email_verified: 'true',
    exp: String(Math.floor(Date.now() / 1000) + 3600),
  });
  try {
    const result = await verifyAppOAuth({ provider: 'google', idToken: 'server-verified-token' }, env);
    assert.deepEqual(result, {
      ok: true, provider: 'google', subject: 'google-sub-1', email: 'josh@example.com',
    });
  } finally {
    globalThis.fetch = real;
  }
});

test('Google OAuth：audience 或 email_verified 不對就拒絕', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    aud: 'another-client', iss: 'https://accounts.google.com',
    sub: 'google-sub-1', email: 'josh@example.com', email_verified: 'false',
    exp: String(Math.floor(Date.now() / 1000) + 3600),
  });
  try {
    const result = await verifyAppOAuth({
      provider: 'google', idToken: 'bad-token',
    }, { GOOGLE_IOS_CLIENT_ID: 'google-client' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'claims');
  } finally {
    globalThis.fetch = real;
  }
});

test('OAuth identity：同一 provider subject 只能綁一個本地 user', async () => {
  const env = makeEnv();
  addUser(env, 'u1', 'a@example.com');
  addUser(env, 'u2', 'b@example.com');
  const auth = { provider: 'google', subject: 'sub-1', email: 'a@example.com' };
  assert.equal((await linkOAuthIdentity(env, auth, 'u1')).ok, true);
  assert.equal((await linkOAuthIdentity(env, auth, 'u2')).reason, 'identity_in_use');
  assert.equal(env.DB.prepare('SELECT user_id FROM oauth_identities WHERE subject = ?').bind('sub-1').first().user_id, 'u1');
});
