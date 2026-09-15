/**
 * 刪除自己的帳號（Apple 5.1.1(v)）。
 *
 * 最重要的一條是「**另一個使用者的每一列都原樣**」：刪帳號的 SQL 若少了 WHERE、
 * 或把 shares 的兩個方向寫反，畫面上看起來一樣是「刪掉了」，但別人的資料跟著
 * 一起沒了——那種錯誤只有拿真的 SQL 對照前後才看得見。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleDeleteAccount } from '../src/handlers/appauth.js';
import { createSession, getSessionUser } from '../src/session.js';
import { hashPassword } from '../src/crypto.js';
import { makeEnv, seedState, unwrap } from './d1.mjs';

const TABLES = ['user_state', 'shares', 'sessions', 'ics_feed', 'reminder_feed', 'password_resets', 'email_codes', 'users'];

async function setup() {
  const env = makeEnv();
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
  };
}

function del(password) {
  return new Request('https://app.test/api/auth/account', {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password })
  });
}

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
