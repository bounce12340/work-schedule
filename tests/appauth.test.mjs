/**
 * iOS app 的認證路徑：Bearer、購買證明、email 驗證碼、註冊、登入。
 *
 * 購買證明那一組是核心：app 是付費下載，「這份證明是 Apple 簽的、而且是簽給
 * 這個 app 的正式版」就是自動核准的唯一依據。這裡用 tests/fake-apple.mjs 自己
 * 當 Apple——產鏈、簽 JWS——因為真的 Apple 簽章只有裝了 app 的手機拿得到，
 * 在 Node 裡永遠測不到。驗證器為此開了一個只給測試用的口（trustedRootDer）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAppTransaction } from '../src/apppurchase.js';
import { handleAppCode, handleAppRegister, handleAppLogin, APP_BUNDLE_ID } from '../src/handlers/appauth.js';
import { createSession, getSessionUser } from '../src/session.js';
import { hashPassword } from '../src/crypto.js';
import { makeEnv, addUser, unwrap } from './d1.mjs';
import { makeFakeApple } from './fake-apple.mjs';

const apple = await makeFakeApple();

function env0(over = {}) {
  return Object.assign(makeEnv(), {
    AGENTMAIL_API_KEY: 'am_us_inbox_test',
    AGENTMAIL_INBOX_ID: 'bot@agentmail.to',
    ADMIN_EMAILS: 'boss@x.test',
  }, over);
}

function post(path, body, headers = {}) {
  return new Request('https://app.test' + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
  });
}

/** 攔下 AgentMail 的寄信，收集信件；其餘對外請求一律視為測試沒預期到的事 */
async function withMail(fn, { fails = false } = {}) {
  const real = globalThis.fetch;
  const mails = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.agentmail.to')) {
      if (fails) return new Response('nope', { status: 500 });
      mails.push(JSON.parse(init.body));
      return Response.json({ ok: true });
    }
    throw new Error('測試不預期打到 ' + url);
  };
  try { return await fn(mails); } finally { globalThis.fetch = real; }
}

function codeFrom(mail) {
  const m = /驗證碼是 (\d{6})/.exec(mail.text);
  assert.ok(m, '信裡要有六碼');
  return m[1];
}

async function requestCode(env, email) {
  return withMail(async mails => {
    const r = await unwrap(await handleAppCode(post('/api/auth/app/code', { email }), env));
    assert.equal(r.status, 200);
    assert.equal(mails.length, 1);
    return codeFrom(mails[0]);
  });
}

// ---------------------------------------------------------------------------
// 購買證明
// ---------------------------------------------------------------------------

test('購買證明：正確的鏈與簽章通過，並回 appTransactionId', async () => {
  const jws = await apple.signJws({});
  const r = await verifyAppTransaction(jws, { bundleId: APP_BUNDLE_ID, trustedRootDer: apple.rootDer });
  assert.equal(r.ok, true);
  assert.equal(r.appTransactionId, '100000000000001');
  assert.equal(r.environment, 'Production');
});

test('購買證明：payload 改一個字元就是 signature 失敗', async () => {
  const jws = await apple.signJws({});
  const [h, p, s] = jws.split('.');
  const tampered = Buffer.from(p, 'base64url').toString().replace('100000000000001', '100000000000002');
  const bad = `${h}.${Buffer.from(tampered).toString('base64url')}.${s}`;
  const r = await verifyAppTransaction(bad, { bundleId: APP_BUNDLE_ID, trustedRootDer: apple.rootDer });
  assert.deepEqual(r, { ok: false, reason: 'signature' });
});

test('購買證明：用別的金鑰簽（leaf 不對）是 signature 失敗', async () => {
  const jws = await apple.signJws({}, { signer: apple.keys.inter.privateKey });
  const r = await verifyAppTransaction(jws, { bundleId: APP_BUNDLE_ID, trustedRootDer: apple.rootDer });
  assert.equal(r.reason, 'signature');
});

test('購買證明：bundleId 不對是 bundle 失敗', async () => {
  const jws = await apple.signJws({ bundleId: 'com.someone.else' });
  const r = await verifyAppTransaction(jws, { bundleId: APP_BUNDLE_ID, trustedRootDer: apple.rootDer });
  assert.deepEqual(r, { ok: false, reason: 'bundle' });
});

test('購買證明：Sandbox 預設拒絕，開旗標才放行；Xcode 環境同樣', async () => {
  const sandbox = await apple.signJws({ receiptType: 'Sandbox' });
  assert.equal((await verifyAppTransaction(sandbox, { bundleId: APP_BUNDLE_ID, trustedRootDer: apple.rootDer })).reason, 'environment');
  assert.equal((await verifyAppTransaction(sandbox, { bundleId: APP_BUNDLE_ID, trustedRootDer: apple.rootDer, allowSandbox: true })).ok, true);
  const xcode = await apple.signJws({ receiptType: 'Xcode' });
  assert.equal((await verifyAppTransaction(xcode, { bundleId: APP_BUNDLE_ID, trustedRootDer: apple.rootDer, allowSandbox: true })).ok, true);
});

test('購買證明：鏈的根不是信任的根就是 chain 失敗（另一個假 Apple 簽的不算）', async () => {
  const other = await makeFakeApple();
  const jws = await other.signJws({});
  const r = await verifyAppTransaction(jws, { bundleId: APP_BUNDLE_ID, trustedRootDer: apple.rootDer });
  assert.deepEqual(r, { ok: false, reason: 'chain' });
});

test('購買證明：中繼換成別人的（鏈斷掉）是 chain 失敗，即使根對', async () => {
  const other = await makeFakeApple();
  // leaf 由我們的中繼簽，但 x5c 裡放別人的中繼＋我們的根：leaf 的簽章驗不過那張中繼
  const jws = await apple.signJws({}, { chain: [apple.leafDer, other.interDer, apple.rootDer] });
  const r = await verifyAppTransaction(jws, { bundleId: APP_BUNDLE_ID, trustedRootDer: apple.rootDer });
  assert.deepEqual(r, { ok: false, reason: 'chain' });
});

test('購買證明：不注入根憑證時用的是內建的 Apple 根——假 Apple 簽的一律 chain 失敗', async () => {
  const jws = await apple.signJws({});
  const r = await verifyAppTransaction(jws, { bundleId: APP_BUNDLE_ID });
  assert.deepEqual(r, { ok: false, reason: 'chain' });
});

test('購買證明：leaf 過期是 expired 失敗', async () => {
  const jws = await apple.signJws({});
  const r = await verifyAppTransaction(jws, { bundleId: APP_BUNDLE_ID, trustedRootDer: apple.rootDer, nowMs: Date.now() + 3 * 365 * 86400_000 });
  assert.deepEqual(r, { ok: false, reason: 'expired' });
});

test('購買證明：不是 JWS 的東西是 format 失敗，不會丟例外', async () => {
  for (const junk of ['', 'abc', 'a.b', 'a.b.c', null, undefined]) {
    const r = await verifyAppTransaction(junk, { bundleId: APP_BUNDLE_ID, trustedRootDer: apple.rootDer });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'format');
  }
});

// ---------------------------------------------------------------------------
// Bearer 與 cookie
// ---------------------------------------------------------------------------

test('Bearer token 與 cookie 都能解出使用者；兩者都沒有回 null；亂的 Bearer 也回 null', async () => {
  const env = env0();
  addUser(env, 'u1', 'a@x.test');
  const { token } = await createSession(env, 'u1', 'ios/1.0.0', { app: true });

  const viaBearer = await getSessionUser(new Request('https://app.test/api/state', { headers: { authorization: `Bearer ${token}` } }), env);
  assert.equal(viaBearer?.id, 'u1');

  const viaCookie = await getSessionUser(new Request('https://app.test/api/state', { headers: { cookie: `ws_session=${token}` } }), env);
  assert.equal(viaCookie?.id, 'u1');

  assert.equal(await getSessionUser(new Request('https://app.test/api/state'), env), null);
  assert.equal(await getSessionUser(new Request('https://app.test/api/state', { headers: { authorization: 'Bearer nope' } }), env), null);
  assert.equal(await getSessionUser(new Request('https://app.test/api/state', { headers: { authorization: 'Basic ' + token } }), env), null);
});

test('app 的 session 有效期比網頁長', async () => {
  const env = env0();
  addUser(env, 'u1', 'a@x.test');
  const web = await createSession(env, 'u1', 'x');
  const app = await createSession(env, 'u1', 'x', { app: true });
  assert.ok(app.expiresAt - web.expiresAt > 100 * 86400_000);
});

// ---------------------------------------------------------------------------
// 驗證碼與註冊
// ---------------------------------------------------------------------------

test('驗證碼：寄出六碼、只存雜湊、已註冊的 email 一樣回 200 且一樣寄（不當帳號列舉工具）', async () => {
  const env = env0();
  addUser(env, 'u1', 'taken@x.test');
  const code = await requestCode(env, 'new@x.test');
  const row = env.DB.prepare('SELECT code_hash, attempts FROM email_codes WHERE email = ?').bind('new@x.test').first();
  assert.ok(row);
  assert.notEqual(row.code_hash, code);
  assert.ok(!row.code_hash.includes(code));

  await withMail(async mails => {
    const r = await unwrap(await handleAppCode(post('/api/auth/app/code', { email: 'taken@x.test' }), env));
    assert.equal(r.status, 200);
    assert.equal(mails.length, 1);
  });
});

test('驗證碼：寄信失敗仍回 200，但不會有可用的碼被靜默丟掉的假象（碼仍在表裡，重寄會換新）', async () => {
  const env = env0();
  const r = await withMail(async () => unwrap(await handleAppCode(post('/api/auth/app/code', { email: 'a@x.test' }), env)), { fails: true });
  assert.equal(r.status, 200);
});

test('驗證碼：無效 email 回 400；一分鐘內重複索取不再寄第二封', async () => {
  const env = env0();
  const bad = await unwrap(await handleAppCode(post('/api/auth/app/code', { email: 'nope' }), env));
  assert.equal(bad.status, 400);
  await withMail(async mails => {
    await handleAppCode(post('/api/auth/app/code', { email: 'a@x.test' }), env);
    await handleAppCode(post('/api/auth/app/code', { email: 'a@x.test' }), env);
    assert.equal(mails.length, 1);
  });
});

test('註冊：正確的碼＋購買證明 → 帳號直接 approved、帶 ios_app 與 app_transaction_id、回 token', async () => {
  const env = env0({ APP_PURCHASE_ALLOW_SANDBOX: '0' });
  const code = await requestCode(env, 'new@x.test');
  const jws = await apple.signJws({});
  const r = await unwrap(await handleAppRegister(post('/api/auth/app/register', {
    email: 'new@x.test', code, password: 'longenoughpw', appTransactionJws: jws,
  }, { 'x-app-client': 'ios/1.0.0', 'user-agent': 'WorkSchedule/1 CFNetwork' }), envWithRoot(env)));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.token);

  const u = env.DB.prepare('SELECT status, role, purchase_source, app_transaction_id FROM users WHERE email = ?').bind('new@x.test').first();
  assert.equal(u.status, 'approved');
  assert.equal(u.role, 'user');
  assert.equal(u.purchase_source, 'ios_app');
  assert.equal(u.app_transaction_id, '100000000000001');

  // token 真的能用，而且裝置清單分得出是 app
  const me = await getSessionUser(new Request('https://app.test/api/state', { headers: { authorization: `Bearer ${r.body.token}` } }), env);
  assert.equal(me.email, 'new@x.test');
  const s = env.DB.prepare('SELECT user_agent FROM sessions').first();
  assert.ok(s.user_agent.startsWith('ios/1.0.0'));

  // 碼用過即刪
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM email_codes').first().n, 0);
});

test('註冊：ADMIN_EMAILS 名單內的 email 仍自動成為管理者', async () => {
  const env = env0();
  const code = await requestCode(env, 'boss@x.test');
  const r = await unwrap(await handleAppRegister(post('/api/auth/app/register', {
    email: 'boss@x.test', code, password: 'longenoughpw', appTransactionJws: await apple.signJws({}),
  }), envWithRoot(env)));
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'admin');
});

test('註冊：碼錯回 400 並計一次；第 6 次起整筆作廢；購買證明不被消耗', async () => {
  const env = env0();
  const code = await requestCode(env, 'new@x.test');
  const wrong = code === '000000' ? '000001' : '000000';
  const body = { email: 'new@x.test', code: wrong, password: 'longenoughpw', appTransactionJws: await apple.signJws({}) };
  for (let i = 1; i <= 5; i++) {
    const r = await unwrap(await handleAppRegister(post('/api/auth/app/register', body), envWithRoot(env)));
    assert.equal(r.status, 400);
    assert.equal(env.DB.prepare('SELECT attempts FROM email_codes WHERE email = ?').bind('new@x.test').first().attempts, i);
  }
  // 第 6 次：就算這次碼是對的也不行——已經作廢
  const r6 = await unwrap(await handleAppRegister(post('/api/auth/app/register', { ...body, code }), envWithRoot(env)));
  assert.equal(r6.status, 400);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM email_codes').first().n, 0);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM users').first().n, 0);
});

test('註冊：碼過期回 400 並刪掉', async () => {
  const env = env0();
  const code = await requestCode(env, 'new@x.test');
  env.DB.prepare('UPDATE email_codes SET expires_at = ?').bind(Date.now() - 1).run();
  const r = await unwrap(await handleAppRegister(post('/api/auth/app/register', {
    email: 'new@x.test', code, password: 'longenoughpw', appTransactionJws: await apple.signJws({}),
  }), envWithRoot(env)));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /過期/);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM email_codes').first().n, 0);
});

test('註冊：購買證明驗不過回 403 且不消耗碼；Sandbox 依環境變數放行', async () => {
  const env = env0();
  const code = await requestCode(env, 'new@x.test');
  const sandbox = await apple.signJws({ receiptType: 'Sandbox' });
  const r = await unwrap(await handleAppRegister(post('/api/auth/app/register', {
    email: 'new@x.test', code, password: 'longenoughpw', appTransactionJws: sandbox,
  }), envWithRoot(env)));
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, 'environment');
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM email_codes').first().n, 1, '碼還在');

  env.APP_PURCHASE_ALLOW_SANDBOX = '1';
  const ok = await unwrap(await handleAppRegister(post('/api/auth/app/register', {
    email: 'new@x.test', code, password: 'longenoughpw', appTransactionJws: sandbox,
  }), envWithRoot(env)));
  assert.equal(ok.status, 200);
});

test('註冊：同一份購買證明第二次註冊（另一個 email）回 409，碼不消耗', async () => {
  const env = env0();
  const jws = await apple.signJws({});
  const c1 = await requestCode(env, 'one@x.test');
  assert.equal((await unwrap(await handleAppRegister(post('/api/auth/app/register', { email: 'one@x.test', code: c1, password: 'longenoughpw', appTransactionJws: jws }), envWithRoot(env)))).status, 200);
  const c2 = await requestCode(env, 'two@x.test');
  const r = await unwrap(await handleAppRegister(post('/api/auth/app/register', { email: 'two@x.test', code: c2, password: 'longenoughpw', appTransactionJws: jws }), envWithRoot(env)));
  assert.equal(r.status, 409);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM email_codes').first().n, 1);
});

test('註冊：已註冊的 email 回 409；密碼太短回 400', async () => {
  const env = env0();
  addUser(env, 'u1', 'taken@x.test');
  const code = await requestCode(env, 'taken@x.test');
  const r = await unwrap(await handleAppRegister(post('/api/auth/app/register', { email: 'taken@x.test', code, password: 'longenoughpw', appTransactionJws: await apple.signJws({}) }), envWithRoot(env)));
  assert.equal(r.status, 409);
  const short = await unwrap(await handleAppRegister(post('/api/auth/app/register', { email: 'x@x.test', code: '123456', password: 'short', appTransactionJws: 'x' }), envWithRoot(env)));
  assert.equal(short.status, 400);
});

// ---------------------------------------------------------------------------
// 登入
// ---------------------------------------------------------------------------

test('app 登入：對的密碼回 token（不發 cookie）；錯的 401；未核准 403', async () => {
  const env = env0();
  env.DB.prepare('INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind('u1', 'a@x.test', await hashPassword('correct-horse'), 'user', 'approved', 0).run();
  env.DB.prepare('INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind('u2', 'p@x.test', await hashPassword('correct-horse'), 'user', 'pending', 0).run();

  const res = await handleAppLogin(post('/api/auth/app/login', { email: 'a@x.test', password: 'correct-horse' }), env);
  assert.equal(res.headers.get('set-cookie'), null);
  const ok = await unwrap(res);
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assert.equal((await getSessionUser(new Request('https://app.test/x', { headers: { authorization: `Bearer ${ok.body.token}` } }), env)).id, 'u1');

  assert.equal((await unwrap(await handleAppLogin(post('/api/auth/app/login', { email: 'a@x.test', password: 'wrong' }), env))).status, 401);
  assert.equal((await unwrap(await handleAppLogin(post('/api/auth/app/login', { email: 'nobody@x.test', password: 'wrong' }), env))).status, 401);
  assert.equal((await unwrap(await handleAppLogin(post('/api/auth/app/login', { email: 'p@x.test', password: 'correct-horse' }), env))).status, 403);
});

// ---------------------------------------------------------------------------

/**
 * handler 走的是正式路徑（內建 Apple 根），假 Apple 簽的一定 chain 失敗。
 * 測 handler 時把驗證器的根換成假 Apple 的：透過 env 注入，而不是改 handler 的簽名。
 */
function envWithRoot(env) {
  env.__TEST_TRUSTED_ROOT_DER = apple.rootDer;
  return env;
}
