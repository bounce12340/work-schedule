/**
 * 登入失敗節流。
 *
 * 兩個最重要的性質，兩者都不是「功能」而是**不能有的洞**：
 *
 *   1. 帳號不存在時也要計數。只在帳號存在時計數的話，「這次有沒有被擋」就成了
 *      「這個 email 有沒有註冊」的旁通道——登入訊息刻意模糊的用心會整個白費。
 *   2. 計數要用單句 UPSERT。「先讀再寫」在兩次併發失敗之間有空窗，後寫的會把
 *      前一次蓋掉，攻擊者開兩條連線就能讓計數永遠停在 1。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkThrottle, recordFailure, clearFailures, throttleKeys } from '../src/throttle.js';
import { handleLogin } from '../src/handlers/auth.js';
import { makeEnv, addUser, unwrap } from './d1.mjs';
import { hashPassword } from '../src/crypto.js';

const TURNSTILE = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const NOW = Date.parse('2026-08-21T00:00:00Z');

async function withTurnstile(fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async url => String(url) === TURNSTILE
    ? Response.json({ success: true, hostname: 'app.test' })
    : (() => { throw new Error('不預期的請求 ' + url); })();
  try { return await fn(); } finally { globalThis.fetch = real; }
}

/** makeEnv() 只給 DB；登入還需要 TURNSTILE_SECRET，否則一律回 403 不配置 */
function loginEnv() {
  return Object.assign(makeEnv(), { TURNSTILE_SECRET: 'test-secret' });
}

function loginReq(email, password, ip = '1.2.3.4') {
  return new Request('https://app.test/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password, turnstileToken: 't' }),
  });
}

test('累積到門檻才擋，門檻之前一律放行', async () => {
  const env = makeEnv();
  const keys = throttleKeys('a@x.test', null);

  for (let i = 0; i < 4; i++) {
    assert.equal((await checkThrottle(env, keys, NOW)).blocked, false, `第 ${i + 1} 次前還不該擋`);
    await recordFailure(env, keys, NOW);
  }
  assert.equal((await checkThrottle(env, keys, NOW)).blocked, false, '第 5 次之前還可以試');
  await recordFailure(env, keys, NOW);
  assert.equal((await checkThrottle(env, keys, NOW)).blocked, true, '第 5 次失敗後擋下');
});

test('窗口過了自動恢復——不需要任何人來解鎖', async () => {
  const env = makeEnv();
  const keys = throttleKeys('a@x.test', null);
  for (let i = 0; i < 5; i++) await recordFailure(env, keys, NOW);
  assert.equal((await checkThrottle(env, keys, NOW)).blocked, true);

  const later = NOW + 15 * 60 * 1000 + 1;
  assert.equal((await checkThrottle(env, keys, later)).blocked, false, '15 分鐘後恢復');

  // 恢復之後是「從頭算起」，不是「接著上次繼續」
  await recordFailure(env, keys, later);
  const row = env.DB.prepare('SELECT fails FROM login_attempts WHERE key = ?')
    .bind('email:a@x.test').first();
  assert.equal(row.fails, 1, '新窗口要重新計數');
});

test('IP 的門檻比 email 寬——同一間辦公室的人不該互相牽連到動彈不得', async () => {
  const env = makeEnv();
  const ipOnly = throttleKeys(null, '1.2.3.4');
  for (let i = 0; i < 5; i++) await recordFailure(env, ipOnly, NOW);
  assert.equal((await checkThrottle(env, ipOnly, NOW)).blocked, false, 'IP 到 5 次還不擋');

  for (let i = 0; i < 15; i++) await recordFailure(env, ipOnly, NOW);
  assert.equal((await checkThrottle(env, ipOnly, NOW)).blocked, true, '到 20 次才擋');
});

test('任一維度超限就擋：email 沒超但 IP 超了，一樣要擋', async () => {
  const env = makeEnv();
  const ip = throttleKeys(null, '9.9.9.9');
  for (let i = 0; i < 20; i++) await recordFailure(env, ip, NOW);

  const both = throttleKeys('fresh@x.test', '9.9.9.9');
  assert.equal((await checkThrottle(env, both, NOW)).blocked, true);
});

test('成功登入清掉計數，先前的失手不會累積到下一次', async () => {
  const env = makeEnv();
  const keys = throttleKeys('a@x.test', '1.2.3.4');
  for (let i = 0; i < 4; i++) await recordFailure(env, keys, NOW);
  await clearFailures(env, keys);
  assert.equal((await checkThrottle(env, keys, NOW)).blocked, false);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts').bind().first().n, 0);
});

// ------------------------------------------------------- 接上真正的登入端點

test('登入端點：連續打錯會拿到 429，而且帶 Retry-After', async () => {
  const env = loginEnv();
  addUser(env, 'u1', 'real@x.test');
  env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(await hashPassword('the-real-password'), 'u1').run();

  await withTurnstile(async () => {
    for (let i = 0; i < 5; i++) {
      const r = await unwrap(await handleLogin(loginReq('real@x.test', 'wrong-one'), env));
      assert.equal(r.status, 401);
    }
    const blocked = await handleLogin(loginReq('real@x.test', 'wrong-one'), env);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('Retry-After')) > 0, '要告訴對方多久之後可以再試');

    // 就算這次密碼是對的也一樣擋——否則節流可以被「猜對就放行」繞過去
    const evenCorrect = await handleLogin(loginReq('real@x.test', 'the-real-password'), env);
    assert.equal(evenCorrect.status, 429);
  });
});

test('登入端點：不存在的帳號也要計數，否則就成了帳號存在與否的旁通道', async () => {
  const env = loginEnv();

  await withTurnstile(async () => {
    for (let i = 0; i < 5; i++) {
      await handleLogin(loginReq('nobody@x.test', 'whatever'), env);
    }
  });

  const row = env.DB.prepare('SELECT fails FROM login_attempts WHERE key = ?')
    .bind('email:nobody@x.test').first();
  assert.ok(row && row.fails >= 5, '查無此人的嘗試一樣要累積');
});

test('登入端點：密碼正確就把計數清乾淨', async () => {
  const env = loginEnv();
  addUser(env, 'u1', 'real@x.test');
  env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(await hashPassword('the-real-password'), 'u1').run();

  await withTurnstile(async () => {
    await handleLogin(loginReq('real@x.test', 'oops'), env);
    await handleLogin(loginReq('real@x.test', 'oops'), env);
    const ok = await handleLogin(loginReq('real@x.test', 'the-real-password'), env);
    assert.equal(ok.status, 200);
  });

  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts').bind().first().n, 0);
});
