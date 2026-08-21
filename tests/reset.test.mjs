/**
 * 自助密碼重設。
 *
 * 這一組的核心是**最後一個測試**：`ADMIN_EMAILS` 名單內的帳號走不走得通。
 * 那正是這條路徑存在的理由——名單內的帳號原本四條路全部封死（管理者重設 403、
 * 變更密碼要舊密碼、沒有忘記密碼、裝置還登著也一樣），只能去改 Cloudflare 的
 * 環境變數才救得回來。其餘測試守的是這條新路徑本身不要變成另一個洞：
 * 帳號列舉、寄信濫用、連結重複使用、停用帳號復活。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleForgotPassword, handleResetPassword } from '../src/handlers/password-reset.js';
import { verifyPassword, sha256 } from '../src/crypto.js';
import { makeEnv, addUser, unwrap } from './d1.mjs';

const TURNSTILE = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** env 加上這條路徑需要的設定。ADMIN_EMAILS 預設帶著 boss@x.test（名單內的帳號）。 */
function env0(over = {}) {
  const env = makeEnv();
  return Object.assign(env, {
    TURNSTILE_SECRET: 'test-secret',
    AGENTMAIL_API_KEY: 'am_us_inbox_test',
    AGENTMAIL_INBOX_ID: 'bot@agentmail.to',
    APP_URL: 'https://app.test',
    ADMIN_EMAILS: 'boss@x.test',
  }, over);
}

function post(path, body) {
  return new Request('https://app.test' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
}

/**
 * 攔下對外的 fetch：Turnstile 驗證與 AgentMail 寄信都走它。
 * 回傳收集到的信件陣列，讓測試能斷言「有沒有寄」與「寄了什麼」。
 */
async function withNetwork(fn, { turnstileOk = true, mailFails = false } = {}) {
  const real = globalThis.fetch;
  const mails = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u === TURNSTILE) return Response.json({ success: turnstileOk, hostname: 'app.test' });
    if (u.includes('api.agentmail.to')) {
      if (mailFails) return new Response('nope', { status: 500 });
      mails.push({ url: u, ...JSON.parse(init.body) });
      return Response.json({ ok: true });
    }
    throw new Error('測試不預期打到 ' + u);
  };
  try { return await fn(mails); } finally { globalThis.fetch = real; }
}

/** 從寄出的信裡把 token 撈出來——使用者實際拿到的就是這個 */
function tokenFromMail(mail) {
  const m = /[?&]token=([^\s"&<]+)/.exec(mail.text);
  assert.ok(m, '信件內文裡應該要有帶 token 的連結');
  return decodeURIComponent(m[1]);
}

function countTokens(env, userId) {
  return env.DB.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?')
    .bind(userId).first().n;
}

// ---------------------------------------------------------------- 索取連結

test('索取：未註冊的 email 回應與已註冊完全相同，且不留下任何痕跡', async () => {
  const env = env0();
  addUser(env, 'u1', 'real@x.test');

  await withNetwork(async mails => {
    const a = await unwrap(await handleForgotPassword(post('/api/auth/forgot',
      { email: 'real@x.test', turnstileToken: 't' }), env));
    const b = await unwrap(await handleForgotPassword(post('/api/auth/forgot',
      { email: 'nobody@x.test', turnstileToken: 't' }), env));

    // 兩者的狀態碼與訊息必須一模一樣，否則這個端點就是帳號列舉工具
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(a.body, b.body);
    assert.equal(mails.length, 1, '只有真實帳號那一次會寄信');
  });
});

test('索取：停用中的帳號不寄信——能重設密碼的話，停用就形同虛設', async () => {
  const env = env0();
  addUser(env, 'u1', 'gone@x.test');
  env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = 'u1'").bind().run();

  await withNetwork(async mails => {
    const r = await unwrap(await handleForgotPassword(post('/api/auth/forgot',
      { email: 'gone@x.test', turnstileToken: 't' }), env));
    assert.equal(r.status, 200, '回應仍然一樣，不能因此洩漏帳號狀態');
    assert.equal(mails.length, 0);
    assert.equal(countTokens(env, 'u1'), 0);
  });
});

test('索取：真人驗證沒過就擋下，連 token 都不會產生', async () => {
  const env = env0();
  addUser(env, 'u1', 'real@x.test');

  await withNetwork(async mails => {
    const r = await unwrap(await handleForgotPassword(post('/api/auth/forgot',
      { email: 'real@x.test', turnstileToken: 'bad' }), env));
    assert.equal(r.status, 403);
    assert.equal(mails.length, 0);
    assert.equal(countTokens(env, 'u1'), 0);
  }, { turnstileOk: false });
});

test('索取：TURNSTILE_SECRET 未設定時一律擋下，不因為沒設定就放行', async () => {
  const env = env0({ TURNSTILE_SECRET: '' });
  addUser(env, 'u1', 'real@x.test');

  await withNetwork(async mails => {
    const r = await unwrap(await handleForgotPassword(post('/api/auth/forgot',
      { email: 'real@x.test', turnstileToken: 't' }), env));
    assert.equal(r.status, 403);
    assert.equal(mails.length, 0);
  });
});

test('索取：冷卻期內連點兩次只寄一封', async () => {
  const env = env0();
  addUser(env, 'u1', 'real@x.test');

  await withNetwork(async mails => {
    for (let i = 0; i < 3; i++) {
      const r = await unwrap(await handleForgotPassword(post('/api/auth/forgot',
        { email: 'real@x.test', turnstileToken: 't' }), env));
      assert.equal(r.status, 200);
    }
    assert.equal(mails.length, 1, '第二、三次落在冷卻期內');
    assert.equal(countTokens(env, 'u1'), 1);
  });
});

test('索取：冷卻期過後重新索取，舊連結立刻失效', async () => {
  const env = env0();
  addUser(env, 'u1', 'real@x.test');

  await withNetwork(async mails => {
    await handleForgotPassword(post('/api/auth/forgot', { email: 'real@x.test', turnstileToken: 't' }), env);
    const first = tokenFromMail(mails[0]);

    // 把上一次的時間往回撥，跳出冷卻期（不動時鐘，改資料才是確定性的作法）
    env.DB.prepare('UPDATE password_resets SET created_at = 0').bind().run();
    await handleForgotPassword(post('/api/auth/forgot', { email: 'real@x.test', turnstileToken: 't' }), env);

    assert.equal(mails.length, 2);
    assert.equal(countTokens(env, 'u1'), 1, '舊的那一列應該被刪掉');

    const r = await unwrap(await handleResetPassword(post('/api/auth/reset',
      { token: first, password: 'brand-new-password' }), env));
    assert.equal(r.status, 400, '舊連結不能還有效——使用者以為重要了一次，舊的卻還在外面飄');
  });
});

test('索取：寄信失敗不改變回應，但要留下 log（降級可以，沉默不行）', async () => {
  const env = env0();
  addUser(env, 'u1', 'real@x.test');
  const realErr = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));

  try {
    await withNetwork(async () => {
      const r = await unwrap(await handleForgotPassword(post('/api/auth/forgot',
        { email: 'real@x.test', turnstileToken: 't' }), env));
      assert.equal(r.status, 200, '把寄信失敗說出來一樣會洩漏這個 email 存在');
    }, { mailFails: true });
  } finally { console.error = realErr; }

  assert.ok(logged.some(l => l.includes('password reset mail failed')),
    '沒有這行的話，管理者只會看到「我沒收到信」而 log 一片乾淨');
});

// ---------------------------------------------------------------- 使用連結

test('重設：連結有效時換掉密碼、清掉所有裝置的登入', async () => {
  const env = env0();
  addUser(env, 'u1', 'real@x.test');
  env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind('h1', 'u1', 0, Date.now() + 1e9).run();
  env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind('h2', 'u1', 0, Date.now() + 1e9).run();

  await withNetwork(async mails => {
    await handleForgotPassword(post('/api/auth/forgot', { email: 'real@x.test', turnstileToken: 't' }), env);
    const token = tokenFromMail(mails[0]);

    const r = await unwrap(await handleResetPassword(post('/api/auth/reset',
      { token, password: 'a-brand-new-one' }), env));
    assert.equal(r.status, 200);

    const row = env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind('u1').first();
    assert.ok(await verifyPassword('a-brand-new-one', row.password_hash), '新密碼要真的驗得過');

    const left = env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').bind('u1').first().n;
    assert.equal(left, 0, '重設密碼的前提是「我進不去」或「我懷疑被盜」，舊 session 全部要斷');

    const used = env.DB.prepare('SELECT used_at FROM password_resets WHERE user_id = ?').bind('u1').first();
    assert.ok(used.used_at, '要標記成已使用');
  });
});

test('重設：同一個連結不能用第二次，而且訊息要看得出差別', async () => {
  const env = env0();
  addUser(env, 'u1', 'real@x.test');

  await withNetwork(async mails => {
    await handleForgotPassword(post('/api/auth/forgot', { email: 'real@x.test', turnstileToken: 't' }), env);
    const token = tokenFromMail(mails[0]);

    await handleResetPassword(post('/api/auth/reset', { token, password: 'first-password-x' }), env);
    const again = await unwrap(await handleResetPassword(post('/api/auth/reset',
      { token, password: 'second-password-x' }), env));

    assert.equal(again.status, 400);
    assert.match(again.body.error, /使用過/, '「用過」與「查無此連結」要分得出來');

    const row = env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind('u1').first();
    assert.ok(await verifyPassword('first-password-x', row.password_hash), '第二次不能真的改掉密碼');
  });
});

test('重設：過期的連結擋下', async () => {
  const env = env0();
  addUser(env, 'u1', 'real@x.test');

  await withNetwork(async mails => {
    await handleForgotPassword(post('/api/auth/forgot', { email: 'real@x.test', turnstileToken: 't' }), env);
    const token = tokenFromMail(mails[0]);
    env.DB.prepare('UPDATE password_resets SET expires_at = 1').bind().run();

    const r = await unwrap(await handleResetPassword(post('/api/auth/reset',
      { token, password: 'too-late-password' }), env));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /過期/);
  });
});

test('重設：亂編的 token 擋下', async () => {
  const env = env0();
  addUser(env, 'u1', 'real@x.test');
  const r = await unwrap(await handleResetPassword(post('/api/auth/reset',
    { token: 'made-up-token', password: 'whatever-password' }), env));
  assert.equal(r.status, 400);
});

test('重設：密碼太短要退回，而且不能把連結消耗掉', async () => {
  const env = env0();
  addUser(env, 'u1', 'real@x.test');

  await withNetwork(async mails => {
    await handleForgotPassword(post('/api/auth/forgot', { email: 'real@x.test', turnstileToken: 't' }), env);
    const token = tokenFromMail(mails[0]);

    const short = await unwrap(await handleResetPassword(post('/api/auth/reset',
      { token, password: 'short' }), env));
    assert.equal(short.status, 400);

    // 打太短就把連結浪費掉的話，使用者得回信箱重新索取一次，非常惱人
    const ok = await unwrap(await handleResetPassword(post('/api/auth/reset',
      { token, password: 'long-enough-now' }), env));
    assert.equal(ok.status, 200, '退回不該消耗連結');
  });
});

// ---------------------------------------------------------------- 這條路徑存在的理由

test('ADMIN_EMAILS 名單內的帳號也能自助重設——這正是這條路徑要補的洞', async () => {
  const env = env0();                      // ADMIN_EMAILS = 'boss@x.test'
  addUser(env, 'boss', 'boss@x.test', 'admin');

  await withNetwork(async mails => {
    const r = await unwrap(await handleForgotPassword(post('/api/auth/forgot',
      { email: 'boss@x.test', turnstileToken: 't' }), env));
    assert.equal(r.status, 200);
    assert.equal(mails.length, 1, '名單內的帳號一樣要收得到信');

    const token = tokenFromMail(mails[0]);
    const done = await unwrap(await handleResetPassword(post('/api/auth/reset',
      { token, password: 'recovered-at-last' }), env));
    assert.equal(done.status, 200);

    const row = env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind('boss').first();
    assert.ok(await verifyPassword('recovered-at-last', row.password_hash),
      '名單內的管理者忘記密碼時，這是唯一不需要碰 Cloudflare 後台的救法');
  });
});

test('DB 裡存的是 token 的雜湊，不是 token 本身', async () => {
  const env = env0();
  addUser(env, 'u1', 'real@x.test');

  await withNetwork(async mails => {
    await handleForgotPassword(post('/api/auth/forgot', { email: 'real@x.test', turnstileToken: 't' }), env);
    const token = tokenFromMail(mails[0]);
    const row = env.DB.prepare('SELECT token_hash FROM password_resets WHERE user_id = ?').bind('u1').first();

    assert.notEqual(row.token_hash, token, '存原文的話，這張表外洩就等於所有人的帳號都能被重設');
    assert.equal(row.token_hash, await sha256(token));
  });
});
