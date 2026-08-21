/**
 * 破窗鎚（tools/reset-password.mjs）的 SQL 組裝。
 *
 * 只測純函式的部分。`wrangler d1 execute` 只收 --command、沒有參數化介面，
 * 所以字串是自己拼的——拼字串的地方就是要有測試的地方。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlQuote, buildSql } from '../tools/reset-password.mjs';

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
