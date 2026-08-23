/**
 * 登入中的裝置清單。
 *
 * 三條不能破的性質：
 *
 *   1. **只看得到自己的裝置。** 不是靠權限判斷擋住，而是這條路徑根本沒有參數
 *      可以指定別人——但那件事要有測試守著，否則哪天有人「順手」加一個
 *      userId 參數進來，就沒有東西會紅。
 *   2. **「登出其他裝置」不能把自己也登出。** 這顆按鈕的使用情境是「我在別人的
 *      電腦上忘記登出」，把自己踢掉只會讓按下去的人當場被登出。
 *   3. **last_seen_at 不能每個請求都寫。** 那等於每個人的每個操作都多一次 D1
 *      寫入，而畫面顯示的是「2 小時前」這種精度。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, getSessionUser, listSessions, destroyOtherSessions } from '../src/session.js';
import { handleListSessions, handleLogoutOtherSessions } from '../src/handlers/auth.js';
import { sha256 } from '../src/crypto.js';
import { makeEnv, addUser, unwrap } from './d1.mjs';

const HOUR = 60 * 60 * 1000;

/** 帶著 session cookie 的請求——handler 從 cookie 認出「當下這一台」 */
function req(token, method = 'GET') {
  return new Request('https://app.test/api/auth/sessions', {
    method,
    headers: token ? { cookie: `ws_session=${token}` } : {},
  });
}

function countSessions(env, userId) {
  return env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').bind(userId).first().n;
}

test('建立 session 會記下裝置與最後使用時間', async () => {
  const env = makeEnv();
  addUser(env, 'u1', 'a@x.test');
  const { token } = await createSession(env, 'u1', 'Mozilla/5.0 (Windows NT 10.0) Chrome/120');

  const row = env.DB.prepare('SELECT user_agent, last_seen_at FROM sessions WHERE token_hash = ?')
    .bind(await sha256(token)).first();
  assert.match(row.user_agent, /Chrome/);
  assert.ok(row.last_seen_at > 0, '剛建立就算「剛用過」');
});

test('超長的 user agent 會被截斷，不變成塞任意內容的欄位', async () => {
  const env = makeEnv();
  addUser(env, 'u1', 'a@x.test');
  const { token } = await createSession(env, 'u1', 'x'.repeat(5000));

  const row = env.DB.prepare('SELECT user_agent FROM sessions WHERE token_hash = ?')
    .bind(await sha256(token)).first();
  assert.equal(row.user_agent.length, 300);
});

test('沒有 user agent 時存 NULL，不要塞假字串', async () => {
  const env = makeEnv();
  addUser(env, 'u1', 'a@x.test');
  const { token } = await createSession(env, 'u1', null);

  const row = env.DB.prepare('SELECT user_agent FROM sessions WHERE token_hash = ?')
    .bind(await sha256(token)).first();
  assert.equal(row.user_agent, null, '前端會顯示為「未知裝置」，那是誠實的');
});

// ---------------------------------------------------------------- 隔離

test('只看得到自己的裝置', async () => {
  const env = makeEnv();
  addUser(env, 'u1', 'a@x.test');
  addUser(env, 'u2', 'b@x.test');
  const mine = await createSession(env, 'u1', 'MyBrowser');
  await createSession(env, 'u2', 'OtherPersonBrowser');
  await createSession(env, 'u2', 'OtherPersonPhone');

  const list = await listSessions(env, 'u1', mine.token);
  assert.equal(list.length, 1);
  assert.equal(list[0].userAgent, 'MyBrowser');
  assert.ok(!JSON.stringify(list).includes('OtherPerson'), '別人的裝置一個字都不該出現');
});

test('清單標出「這一台」，而且不外洩任何可用來指認的憑證', async () => {
  const env = makeEnv();
  addUser(env, 'u1', 'a@x.test');
  const a = await createSession(env, 'u1', 'DeviceA');
  const b = await createSession(env, 'u1', 'DeviceB');

  const list = await listSessions(env, 'u1', b.token);
  const current = list.filter(s => s.current);
  assert.equal(current.length, 1, '只有一台是「這一台」');
  assert.equal(current[0].userAgent, 'DeviceB');

  const raw = JSON.stringify(list);
  assert.ok(!raw.includes(a.token) && !raw.includes(b.token), 'token 原文不能出現');
  assert.ok(!raw.includes('token_hash'), '雜湊也不必送到前端——前端只需要知道是不是這一台');
});

test('已過期的 session 不列出來', async () => {
  const env = makeEnv();
  addUser(env, 'u1', 'a@x.test');
  const live = await createSession(env, 'u1', 'Live');
  env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?,?,?,?,?)')
    .bind('dead-hash', 'u1', 0, Date.now() - 1000, 'Expired').run();

  const list = await listSessions(env, 'u1', live.token);
  assert.deepEqual(list.map(s => s.userAgent), ['Live']);
});

test('欄位為 NULL 的舊 session 不能讓清單整個壞掉', async () => {
  const env = makeEnv();
  addUser(env, 'u1', 'a@x.test');
  // 模擬加欄位之前就存在的列：user_agent 與 last_seen_at 都是 NULL
  env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .bind('old-hash', 'u1', 111, Date.now() + HOUR).run();

  const list = await listSessions(env, 'u1', null);
  assert.equal(list.length, 1);
  assert.equal(list[0].userAgent, null);
  assert.equal(list[0].lastSeenAt, null);
  assert.equal(list[0].createdAt, 111, '沒有 last_seen_at 時要能退回用建立時間排序');
});

// ---------------------------------------------------------------- 登出其他裝置

test('登出其他裝置會保留當下這一台', async () => {
  const env = makeEnv();
  addUser(env, 'u1', 'a@x.test');
  const keep = await createSession(env, 'u1', 'ThisOne');
  await createSession(env, 'u1', 'Other1');
  await createSession(env, 'u1', 'Other2');
  assert.equal(countSessions(env, 'u1'), 3);

  await destroyOtherSessions(env, 'u1', keep.token);

  assert.equal(countSessions(env, 'u1'), 1);
  const left = await listSessions(env, 'u1', keep.token);
  assert.equal(left[0].userAgent, 'ThisOne');
  assert.equal(left[0].current, true, '按下去的人不該當場把自己登出');
});

test('登出其他裝置不會碰到別人的 session', async () => {
  const env = makeEnv();
  addUser(env, 'u1', 'a@x.test');
  addUser(env, 'u2', 'b@x.test');
  const keep = await createSession(env, 'u1', 'Mine');
  await createSession(env, 'u1', 'MyOther');
  await createSession(env, 'u2', 'Theirs');

  await destroyOtherSessions(env, 'u1', keep.token);

  assert.equal(countSessions(env, 'u1'), 1);
  assert.equal(countSessions(env, 'u2'), 1, '別人的裝置一台都不能少');
});

test('端點層：GET 列出、DELETE 只留自己', async () => {
  const env = makeEnv();
  addUser(env, 'u1', 'a@x.test');
  const me = await createSession(env, 'u1', 'ThisOne');
  await createSession(env, 'u1', 'Other');
  const user = { id: 'u1', email: 'a@x.test', role: 'user', status: 'approved' };

  const before = await unwrap(await handleListSessions(req(me.token), env, user));
  assert.equal(before.body.sessions.length, 2);

  const del = await unwrap(await handleLogoutOtherSessions(req(me.token, 'DELETE'), env, user));
  assert.equal(del.status, 200);

  const after = await unwrap(await handleListSessions(req(me.token), env, user));
  assert.equal(after.body.sessions.length, 1);
  assert.equal(after.body.sessions[0].current, true);
});

// ---------------------------------------------------------------- 寫入節流

test('last_seen_at 一小時內不重複寫', async () => {
  const env = makeEnv();
  addUser(env, 'u1', 'a@x.test');
  const { token } = await createSession(env, 'u1', 'Device');
  const hash = await sha256(token);

  // 計算「有幾句 UPDATE sessions 真的被送出去」
  let updates = 0;
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    if (/^\s*UPDATE sessions SET last_seen_at/.test(sql)) updates++;
    return realPrepare(sql);
  };

  const request = new Request('https://app.test/api/state', { headers: { cookie: `ws_session=${token}` } });
  await getSessionUser(request, env);
  await getSessionUser(request, env);
  await getSessionUser(request, env);
  assert.equal(updates, 0, '剛建立就已經是最新的，三次請求一句 SQL 都不該發');

  // 把時間往回撥超過一小時，下一次請求才該寫
  env.DB.prepare = realPrepare;
  env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
    .bind(Date.now() - 2 * HOUR, hash).run();
  env.DB.prepare = sql => {
    if (/^\s*UPDATE sessions SET last_seen_at/.test(sql)) updates++;
    return realPrepare(sql);
  };

  updates = 0;
  await getSessionUser(request, env);
  assert.equal(updates, 1, '過了間隔就要更新一次');
  await getSessionUser(request, env);
  assert.equal(updates, 1, '更新完之後又回到不必寫的狀態');

  env.DB.prepare = realPrepare;
  const row = env.DB.prepare('SELECT last_seen_at FROM sessions WHERE token_hash = ?').bind(hash).first();
  assert.ok(Date.now() - row.last_seen_at < HOUR, '值真的有被更新');
});

test('getSessionUser 帶出 createdAt——「我的帳號」要顯示加入時間', async () => {
  const env = makeEnv();
  addUser(env, 'u1', 'a@x.test');
  env.DB.prepare('UPDATE users SET created_at = ? WHERE id = ?').bind(1234567, 'u1').run();
  const { token } = await createSession(env, 'u1', 'Device');

  const user = await getSessionUser(
    new Request('https://app.test/', { headers: { cookie: `ws_session=${token}` } }), env);
  assert.equal(user.createdAt, 1234567);
});
