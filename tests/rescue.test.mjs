/**
 * 破窗鎚（tools/reset-password.mjs）的 SQL 組裝。
 *
 * 只測純函式的部分。`wrangler d1 execute` 只收 --command、沒有參數化介面，
 * 所以字串是自己拼的——拼字串的地方就是要有測試的地方。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlQuote, buildSql } from '../tools/reset-password.mjs';
import { handleListUsers } from '../src/handlers/admin.js';
import { makeEnv, addUser, unwrap } from './d1.mjs';

test('單引號要跳脫，否則帶引號的 email 會把語句拆開', () => {
  assert.equal(sqlQuote("o'brien@x.test"), "'o''brien@x.test'");
  assert.equal(sqlQuote('plain@x.test'), "'plain@x.test'");
});

test('base64 雜湊裡的 + / = $ 不需要跳脫，但要原封不動留著', () => {
  const hash = 'pbkdf2$100000$aB+/cD==$eF+/gH==';
  assert.equal(sqlQuote(hash), `'${hash}'`);
});

test('組出來的是兩句：換密碼，以及清掉該帳號所有 session', () => {
  const sql = buildSql('a@x.test', 'pbkdf2$100000$s$h');
  assert.match(sql, /UPDATE users SET password_hash = 'pbkdf2\$100000\$s\$h' WHERE email = 'a@x\.test';/);
  assert.match(sql, /DELETE FROM sessions WHERE user_id IN \(SELECT id FROM users WHERE email = 'a@x\.test'\);/);
});

test('注入嘗試被關在字串常值裡，不會變成第三句 SQL', () => {
  const evil = "x@x.test'; DROP TABLE users; --";
  const sql = buildSql(evil, 'h');

  // 整段惡意輸入必須原封不動地以「已跳脫的字串常值」出現，而不是散在語句中間
  assert.ok(sql.includes(sqlQuote(evil)), '應該整段被包成一個字串常值');

  // 語句結尾的分號只有兩個（UPDATE 一個、DELETE 一個）。多出來的分號就代表
  // 有人的輸入變成了第三句 SQL。
  const outsideStrings = sql.replace(/'(?:[^']|'')*'/g, "''");
  assert.equal((outsideStrings.match(/;/g) || []).length, 2, '字串之外只能有兩個分號');
  assert.ok(!/DROP\s+TABLE/i.test(outsideStrings), 'DROP TABLE 只能待在字串裡');
});

/**
 * 管理頁要看得出哪些帳號是 ADMIN_EMAILS 名單釘住的。
 *
 * 這不是新的權限——那四個操作（停用、降級、重設密碼、刪除）本來就會被
 * handleUpdateUser / handleResetPassword / handleDeleteUser 回 403。守的是
 * 「畫面上看不看得出來」：看不出來的時候，管理者按下去、看到紅字、以為系統壞了，
 * 然後想到的解法是去 Cloudflare 把 email 從名單拿掉——而那正是
 * tools/reset-password.mjs 檔頭寫著的地雷（拿掉之後忘記加回去，保護就永遠沒了）。
 *
 * 突變驗證：把 configAdmin 那一行拿掉 → 這支紅。
 */
test('使用者清單要標出 ADMIN_EMAILS 名單內的帳號，而且比對不分大小寫', async () => {
  const env = { ...makeEnv(), ADMIN_EMAILS: ' Boss@X.test , ops@x.test ' };
  addUser(env, 'u1', 'boss@x.test', 'admin');
  addUser(env, 'u2', 'ops@x.test', 'admin');
  addUser(env, 'u3', 'normal@x.test', 'user');

  const res = await unwrap(await handleListUsers(env));
  const by = Object.fromEntries(res.body.users.map(u => [u.id, u]));

  assert.equal(by.u1.configAdmin, true, '名單裡有（大小寫與空白都要正規化過）');
  assert.equal(by.u2.configAdmin, true);
  assert.equal(by.u3.configAdmin, false, '一般帳號不能被標成釘住的——標錯會讓管理者放棄一條本來走得通的路');
});

test('沒有設 ADMIN_EMAILS 時所有帳號都不是釘住的', async () => {
  const env = makeEnv();
  addUser(env, 'u1', 'a@x.test', 'admin');
  const res = await unwrap(await handleListUsers(env));
  assert.equal(res.body.users[0].configAdmin, false);
});

test('這個旗標不帶出任何額外的欄位', async () => {
  const env = { ...makeEnv(), ADMIN_EMAILS: 'a@x.test' };
  addUser(env, 'u1', 'a@x.test', 'admin');
  const res = await unwrap(await handleListUsers(env));
  const u = res.body.users[0];
  assert.equal('password_hash' in u, false);
  assert.equal('plan_source' in u, false, '方案仍然回算好的形狀');
});
