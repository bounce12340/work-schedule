/**
 * 刪除自己的帳號（Apple 5.1.1(v)）。
 *
 * 最重要的一條是「**另一個使用者的每一列都原樣**」：刪帳號的 SQL 若少了 WHERE、
 * 或把 shares 的兩個方向寫反，畫面上看起來一樣是「刪掉了」，但別人的資料跟著
 * 一起沒了——那種錯誤只有拿真的 SQL 對照前後才看得見。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handleDeleteAccount } from '../src/handlers/appauth.js';
import { createSession, getSessionUser } from '../src/session.js';
import { hashPassword } from '../src/crypto.js';
import { makeEnv, seedState, unwrap } from './d1.mjs';
import { fakeR2 } from './fake-r2.mjs';

const TABLES = ['user_state', 'shares', 'sessions', 'ics_feed', 'reminder_feed', 'password_resets', 'email_codes', 'oauth_identities', 'mcp_requests', 'project_events', 'project_absent', 'mcp_proposals', 'mcp_connections', 'agent_notify_state', 'project_prs', 'github_hooks', 'state_versions', 'project_shares', 'users'];

async function setup() {
  const env = makeEnv();
  env.BACKUPS = fakeR2();
  const hash = await hashPassword('correct-horse');
  for (const [id, email] of [['A', 'a@x.test'], ['B', 'b@x.test']]) {
    env.DB.prepare('INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, email, hash, 'user', 'approved', 0).run();
    seedState(env, id, { items: [{ id: id + '-item' }] }, 1);
    await createSession(env, id, 'x');
    await createSession(env, id, 'y', { app: true });
    env.DB.prepare('INSERT INTO ics_feed (user_id, token_hash, ics, updated_at) VALUES (?, ?, ?, ?)').bind(id, 'h' + id, '', 0).run();
    env.DB.prepare('INSERT INTO reminder_feed (user_id, enabled, digest, updated_at) VALUES (?, 1, ?, 0)').bind(id, '[]').run();
    env.DB.prepare('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, 0, 1)').bind('r' + id, id).run();
    env.DB.prepare('INSERT INTO email_codes (email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, 1, 0, 0)').bind(email, 'c').run();
    env.DB.prepare("INSERT INTO mcp_requests (user_id, request_id, fingerprint, result, created_at) VALUES (?, 'req-1', 'f', '{}', 0)").bind(id).run();
    // agent 工作區：日誌、專案消失記錄、提案、連線設定（兩個人各一份，刪 A 不能碰 B 的）
    env.DB.prepare("INSERT INTO project_events (id, user_id, project_id, kind, actor, body, created_at) VALUES (?, ?, 'gp1', 'progress', 'Claude', '進展', 0)").bind('ev-' + id, id).run();
    env.DB.prepare("INSERT INTO project_absent (user_id, project_id, missing_since) VALUES (?, 'gp1', 0)").bind(id).run();
    env.DB.prepare("INSERT INTO mcp_proposals (id, user_id, actor, title, ops, status, created_at) VALUES (?, ?, 'Claude', 't', '[]', 'open', 0)").bind('pr-' + id, id).run();
    env.DB.prepare("INSERT INTO mcp_connections (id, user_id, mode, paused, needs_acceptance, created_at, updated_at) VALUES (?, ?, 'review', 1, 1, 0, 0)").bind('cn-' + id, id).run();
    env.DB.prepare("INSERT INTO agent_notify_state (user_id, project_id, last_sent_at, pending, actor) VALUES (?, 'gp1', 5, 2, 'Claude')").bind(id).run();
    // 第二批：PR 連結與 webhook 密鑰（兩個人各一份，刪 A 不能碰 B 的；同一個 repo＋編號兩個人都有）
    env.DB.prepare("INSERT INTO project_prs (id, user_id, project_id, repo, number, url, source, updated_at) VALUES (?, ?, 'gp1', 'o/r', 7, 'https://github.com/o/r/pull/7', 'agent', 0)").bind('pp-' + id, id).run();
    env.DB.prepare("INSERT INTO github_hooks (user_id, token_hash, secret, created_at) VALUES (?, ?, 'sec', 0)").bind(id, 'th-' + id).run();
    // 第三批 3A：版本歷史（索引＋R2 的檔案）與唯讀分享連結——兩個人各一份，刪 A 不能碰 B 的
    for (const n of [1, 2]) {
      env.DB.prepare("INSERT INTO state_versions (id, user_id, created_at, actor, summary, bytes, sha) VALUES (?, ?, ?, 'x', 's', 2, ?)").bind(`v${n}-${id}`, id, n, `sha${n}${id}`).run();
      await env.BACKUPS.put(`history/${id}/v${n}-${id}.json`, '{}');
    }
    env.DB.prepare("INSERT INTO project_shares (id, user_id, project_id, token_hash, include_json, created_at) VALUES (?, ?, 'gp1', ?, '[]', 0)").bind('ps-' + id, id, 'tok-' + id).run();
    env.DB.prepare(`INSERT INTO oauth_identities
      (id, user_id, provider, subject, email, created_at, updated_at)
      VALUES (?, ?, 'google', ?, ?, 0, 0)`).bind('oauth-' + id, id, 'google-' + id, email).run();
  }
  // 兩個方向的分享都要有：A 分享給 B、B 分享給 A
  env.DB.prepare(`INSERT INTO shares (id, owner_id, target_id, resource_kind, resource_id, permission, created_at)
                  VALUES ('s1', 'A', 'B', 'item', 'A-item', 'view', 0), ('s2', 'B', 'A', 'item', 'B-item', 'edit', 0),
                         ('s3', 'B', 'C', 'item', 'B-item', 'view', 0)`).run();
  return env;
}

function snapshotOf(env, userId, email) {
  const q = sql => env.DB.prepare(sql).bind(userId).all().results;
  return {
    user: env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).all().results,
    state: q('SELECT * FROM user_state WHERE user_id = ?'),
    sessions: q('SELECT * FROM sessions WHERE user_id = ? ORDER BY token_hash'),
    ics: q('SELECT * FROM ics_feed WHERE user_id = ?'),
    reminder: q('SELECT * FROM reminder_feed WHERE user_id = ?'),
    resets: q('SELECT * FROM password_resets WHERE user_id = ?'),
    codes: env.DB.prepare('SELECT * FROM email_codes WHERE email = ?').bind(email).all().results,
    oauth: env.DB.prepare('SELECT * FROM oauth_identities WHERE user_id = ?').bind(userId).all().results,
    mcpRequests: q('SELECT * FROM mcp_requests WHERE user_id = ?'),
    projectEvents: q('SELECT * FROM project_events WHERE user_id = ?'),
    projectAbsent: q('SELECT * FROM project_absent WHERE user_id = ?'),
    mcpProposals: q('SELECT * FROM mcp_proposals WHERE user_id = ?'),
    mcpConnections: q('SELECT * FROM mcp_connections WHERE user_id = ?'),
    agentNotifyState: q('SELECT * FROM agent_notify_state WHERE user_id = ?'),
    projectPrs: q('SELECT * FROM project_prs WHERE user_id = ?'),
    githubHooks: q('SELECT * FROM github_hooks WHERE user_id = ?'),
    stateVersions: q('SELECT * FROM state_versions WHERE user_id = ?'),
    projectShares: q('SELECT * FROM project_shares WHERE user_id = ?'),
    historyFiles: [...env.BACKUPS.store.keys()].filter(k => k.startsWith(`history/${userId}/`)),
  };
}

function deleteRequest(body) {
  return new Request('https://app.test/api/auth/account', {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
}

const del = password => deleteRequest({ password });

const A = { id: 'A', email: 'a@x.test', role: 'user', status: 'approved' };

test('密碼錯回 403，而且每一張表都一列沒少', async () => {
  const env = await setup();
  const before = TABLES.map(t => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first().n);
  const r = await unwrap(await handleDeleteAccount(del('wrong'), env, A));
  assert.equal(r.status, 403);
  const after = TABLES.map(t => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first().n);
  assert.deepEqual(after, before);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM admin_activity').first().n, 0, '失敗不留記錄');
});

test('Google 刪除帳號必須用單次授權碼，驗證後只比對已連結的 subject', async () => {
  const env = await setup();
  env.GOOGLE_IOS_CLIENT_ID = '123.apps.googleusercontent.com';
  const original = globalThis.fetch;
  let exchanges = 0;
  let googleSubject = 'google-B';
  globalThis.fetch = async (url, init) => {
    const endpoint = new URL(url);
    if (endpoint.pathname === '/token') {
      assert.equal(init.body.get('code'), 'new-code');
      assert.equal(init.body.get('code_verifier'), 'pkce-verifier');
      exchanges++;
      return Response.json({ id_token: 'verified-google-token' });
    }
    assert.equal(endpoint.searchParams.get('id_token'), 'verified-google-token');
    return Response.json({
      aud: env.GOOGLE_IOS_CLIENT_ID, iss: 'accounts.google.com', sub: googleSubject,
      email: A.email, email_verified: true, exp: Math.floor(Date.now() / 1000) + 60,
    });
  };
  try {
    const tokenOnly = deleteRequest({ provider: 'google', idToken: 'verified-google-token' });
    assert.equal((await handleDeleteAccount(tokenOnly, env, A)).status, 403);
    assert.equal(exchanges, 0);

    const credentials = {
      provider: 'google', authorizationCode: 'new-code', codeVerifier: 'pkce-verifier',
      redirectUri: 'com.googleusercontent.apps.123:/oauth2redirect/google',
    };
    const before = snapshotOf(env, 'A', A.email);
    assert.equal((await handleDeleteAccount(deleteRequest(credentials), env, A)).status, 403);
    assert.deepEqual(snapshotOf(env, 'A', A.email), before, 'email 相同的其他 subject 無法刪除帳號');

    googleSubject = 'google-A';
    assert.equal((await handleDeleteAccount(deleteRequest(credentials), env, A)).status, 200);
    assert.equal(snapshotOf(env, 'A', A.email).user.length, 0);
    assert.equal(snapshotOf(env, 'B', 'b@x.test').user.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('Apple 刪除帳號要讓 nonce 與新授權碼對應同一 Apple 身分，並撤銷取得的 refresh token', async () => {
  const env = await setup();
  const clientKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const der = await crypto.subtle.exportKey('pkcs8', clientKey.privateKey);
  Object.assign(env, {
    APPLE_SIGN_IN_TEAM_ID: 'TEAM123',
    APPLE_SIGN_IN_KEY_ID: 'KEY123',
    APPLE_SIGN_IN_CLIENT_ID: 'com.bounceto.workschedule',
    APPLE_SIGN_IN_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString('base64')}\n-----END PRIVATE KEY-----`,
  });
  const apple = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const jwk = { ...(await crypto.subtle.exportKey('jwk', apple.publicKey)), kid: 'apple-test-key' };
  const rawNonce = 'client-nonce';
  async function tokenFor(subject) {
    const encode = object => Buffer.from(JSON.stringify(object)).toString('base64url');
    const header = encode({ alg: 'RS256', kid: jwk.kid });
    const claims = encode({
      iss: 'https://appleid.apple.com', aud: env.APPLE_SIGN_IN_CLIENT_ID, sub: subject,
      exp: Math.floor(Date.now() / 1000) + 60, nonce: createHash('sha256').update(rawNonce).digest('hex'),
    });
    const input = `${header}.${claims}`;
    const signature = await crypto.subtle.sign(apple.publicKey.algorithm.name, apple.privateKey, Buffer.from(input));
    return `${input}.${Buffer.from(signature).toString('base64url')}`;
  }
  env.DB.prepare(`INSERT INTO oauth_identities
    (id, user_id, provider, subject, apple_refresh_token, created_at, updated_at)
    VALUES ('apple-a', 'A', 'apple', 'apple-sub', 'old-refresh', 0, 0)`).run();
  const credentials = { provider: 'apple', idToken: await tokenFor('apple-sub'), authorizationCode: 'single-use', nonce: rawNonce };
  let exchanged = await tokenFor('another-apple-sub');
  let exchangeCount = 0;
  const revoked = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const endpoint = new URL(url);
    assert.equal(endpoint.host, 'appleid.apple.com');
    if (endpoint.pathname === '/auth/keys') return Response.json({ keys: [jwk] });
    if (endpoint.pathname === '/auth/token') {
      assert.equal(init.body.get('code'), 'single-use');
      exchangeCount++;
      return Response.json({ id_token: exchanged, refresh_token: 'new-refresh' });
    }
    assert.equal(endpoint.pathname, '/auth/revoke');
    revoked.push(init.body.get('token'));
    return new Response(null, { status: 200 });
  };
  try {
    assert.equal((await handleDeleteAccount(deleteRequest({ ...credentials, nonce: 'wrong' }), env, A)).status, 403);
    assert.equal(exchangeCount, 0);
    assert.equal((await handleDeleteAccount(deleteRequest(credentials), env, A)).status, 403);
    assert.equal(revoked.length, 0);
    exchanged = await tokenFor('apple-sub');
    assert.equal((await handleDeleteAccount(deleteRequest(credentials), env, A)).status, 200);
    assert.deepEqual(revoked.sort(), ['new-refresh', 'old-refresh']);
    assert.equal(snapshotOf(env, 'A', A.email).user.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('刪除帳號：Apple refresh token 會送到 revoke，而且第三方身分一併刪除', async () => {
  const env = await setup();
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  let called = null;
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    called = { url: String(url), body: String(init.body) };
    return new Response('', { status: 200 });
  };
  Object.assign(env, {
    APPLE_SIGN_IN_TEAM_ID: 'TEAM123',
    APPLE_SIGN_IN_KEY_ID: 'KEY123',
    APPLE_SIGN_IN_CLIENT_ID: 'com.bounceto.workschedule',
    APPLE_SIGN_IN_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString('base64')}\n-----END PRIVATE KEY-----`,
  });
  env.DB.prepare(`INSERT INTO oauth_identities
    (id, user_id, provider, subject, email, apple_refresh_token, created_at, updated_at)
    VALUES ('apple-a', 'A', 'apple', 'apple-sub', 'a@privaterelay.appleid.com', 'refresh-secret', 0, 0)`).run();
  try {
    const r = await unwrap(await handleDeleteAccount(del('correct-horse'), env, A));
    assert.equal(r.status, 200);
    assert.equal(called.url, 'https://appleid.apple.com/auth/revoke');
    assert.match(called.body, /refresh-secret/);
    assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_identities WHERE user_id = ?').bind('A').first().n, 0);
  } finally {
    globalThis.fetch = real;
  }
});

test('密碼對：A 在每一張表裡都清空、所有 session 失效、留下一筆本人刪除的記錄', async () => {
  const env = await setup();
  const tokenA = (await createSession(env, 'A', 'z', { app: true })).token;

  const r = await unwrap(await handleDeleteAccount(del('correct-horse'), env, A));
  assert.equal(r.status, 200);

  const snap = snapshotOf(env, 'A', 'a@x.test');
  for (const [k, rows] of Object.entries(snap)) assert.equal(rows.length, 0, `${k} 應該清空`);
  // A 分享出去的與別人分享給 A 的都要消失
  assert.equal(env.DB.prepare("SELECT COUNT(*) AS n FROM shares WHERE owner_id = 'A' OR target_id = 'A'").first().n, 0);

  assert.equal(await getSessionUser(new Request('https://app.test/x', { headers: { authorization: `Bearer ${tokenA}` } }), env), null);

  const log = env.DB.prepare('SELECT actor_email, target_email, action FROM admin_activity').all().results;
  assert.equal(log.length, 1);
  assert.equal(log[0].actor_email, 'a@x.test');
  assert.equal(log[0].target_email, 'a@x.test');
  assert.match(log[0].action, /本人刪除/);
});

test('刪 A 之後，B 的每一列（含 B 分享給第三人的）都原樣', async () => {
  const env = await setup();
  const beforeB = snapshotOf(env, 'B', 'b@x.test');
  const beforeS3 = env.DB.prepare("SELECT * FROM shares WHERE id = 's3'").all().results;

  assert.equal((await unwrap(await handleDeleteAccount(del('correct-horse'), env, A))).status, 200);

  assert.deepEqual(snapshotOf(env, 'B', 'b@x.test'), beforeB);
  assert.deepEqual(env.DB.prepare("SELECT * FROM shares WHERE id = 's3'").all().results, beforeS3);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM shares').first().n, 1, '只剩 B→C 那一筆');
});

test('刪掉之後同一個 email 可以再註冊（users 沒有殘留）', async () => {
  const env = await setup();
  assert.equal((await unwrap(await handleDeleteAccount(del('correct-horse'), env, A))).status, 200);
  env.DB.prepare('INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind('A2', 'a@x.test', 'x', 'user', 'approved', 0).run();
  assert.equal(env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'a@x.test'").first().n, 1);
});

// ------------------------------------------------------------ 訂閱中不能刪帳號（Paddle 的扣款停不了）

const DAY = 24 * 3600 * 1000;
const PADDLE_KEY = 'pdl_sdbx_apikey_TEST_ONLY';

/** 讓 A 是某種方案，並攔下 fetch 當假的 Paddle；回傳打過的呼叫。 */
async function withPaddle(env, plan, paddle, fn) {
  env.DB.prepare('UPDATE users SET plan_source = ?, plan_expires_at = ?, paddle_subscription_id = ? WHERE id = ?')
    .bind(plan.source, plan.expiresAt ?? null, plan.subId ?? null, 'A').run();
  if (paddle !== 'no-key') Object.assign(env, { PADDLE_API_KEY: PADDLE_KEY, PADDLE_ENV: 'sandbox' });
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.authorization });
    if (paddle === 'throw') throw new Error('network down: ' + PADDLE_KEY);
    return paddle();
  };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}
const paddleSub = (sub) => () => Response.json({ data: { id: 'sub_1', ...sub } });
const live = { source: 'paddle', expiresAt: Date.now() + 20 * DAY, subId: 'sub_1' };

function counts(env) {
  return TABLES.map(t => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first().n);
}

test('刪帳號：網頁訂閱還在續訂 → 409 paddle_active，每一張表原樣、不留記錄、不燒驗證', async () => {
  const env = await setup();
  await withPaddle(env, live, paddleSub({ status: 'active', scheduled_change: null }), async (calls) => {
    const before = snapshotOf(env, 'A', A.email); const n = counts(env);
    const r = await unwrap(await handleDeleteAccount(del('correct-horse'), env, A));
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'paddle_active');
    assert.match(r.body.error, /管理訂閱|取消/);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^https:\/\/sandbox-api\.paddle\.com\/subscriptions\/sub_1$/);
    assert.deepEqual(snapshotOf(env, 'A', A.email), before);
    assert.deepEqual(counts(env), n);
    assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM admin_activity').first().n, 0);
    // 密碼錯也是同一個擋法（擋在驗證之前，Apple 的單次授權碼不會被燒掉）
    assert.equal((await unwrap(await handleDeleteAccount(del('wrong'), env, A))).status, 409);
  });
});

test('刪帳號：Paddle 說已排定取消、或已經取消 → 照舊可以刪', async () => {
  for (const sub of [{ status: 'active', scheduled_change: { action: 'cancel', effective_at: new Date(Date.now() + 5 * DAY).toISOString() } }, { status: 'canceled' }]) {
    const env = await setup();
    await withPaddle(env, live, paddleSub(sub), async (calls) => {
      assert.equal((await unwrap(await handleDeleteAccount(del('correct-horse'), env, A))).status, 200, JSON.stringify(sub));
      assert.equal(calls.length, 1, '刪除當下問了一次');
      assert.equal(snapshotOf(env, 'A', A.email).user.length, 0);
    });
  }
});

test('刪帳號：Paddle 問不到（5xx、連線失敗、沒設 API key、回應壞掉）→ 也擋 paddle_unknown，API key 與錯誤原文不外洩', async () => {
  const bad = [
    ['5xx', () => Response.json({ error: { code: 'internal', detail: 'SECRET-UPSTREAM-DETAIL' } }, { status: 500 })],
    ['非 JSON', () => new Response('<html>SECRET-UPSTREAM-DETAIL</html>', { status: 200 })],
    ['連線失敗', 'throw'],
    ['沒設 key', 'no-key'],
  ];
  for (const [name, paddle] of bad) {
    const env = await setup();
    const n = counts(env);
    await withPaddle(env, live, paddle, async (calls) => {
      const r = await unwrap(await handleDeleteAccount(del('correct-horse'), env, A));
      assert.equal(r.status, 409, name);
      assert.equal(r.body.reason, 'paddle_unknown', name);
      const text = JSON.stringify(r.body);
      assert.ok(!text.includes('SECRET-UPSTREAM-DETAIL') && !text.includes(PADDLE_KEY), name + '：不轉發上游');
      assert.deepEqual(counts(env), n, name);
      assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM admin_activity').first().n, 0, name);
      if (paddle === 'no-key') assert.equal(calls.length, 0, '沒有 key 就不該打');
    });
  }
});

test('刪帳號：已過期（超過寬限）的網頁訂閱、Apple 有效訂閱、admin 永久方案、沒有方案 → 照舊可以刪，而且不打 Paddle', async () => {
  const cases = [
    ['paddle 已過期', { source: 'paddle', expiresAt: Date.now() - 10 * DAY, subId: 'sub_1' }],
    ['apple 有效', { source: 'apple', expiresAt: Date.now() + 100 * DAY }],
    ['admin 永久', { source: 'admin', expiresAt: null }],
    ['沒有方案', { source: null, expiresAt: null }],
  ];
  for (const [name, plan] of cases) {
    const env = await setup();
    await withPaddle(env, plan, paddleSub({ status: 'active' }), async (calls) => {
      assert.equal((await unwrap(await handleDeleteAccount(del('correct-horse'), env, A))).status, 200, name);
      assert.equal(calls.length, 0, name + '：不打 Paddle');
      assert.equal(snapshotOf(env, 'A', A.email).user.length, 0, name);
    });
  }
});
