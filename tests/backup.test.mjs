/**
 * 每日備份、過期清理、管理者操作記錄。
 *
 * 備份的測試重點不是「有沒有跑完」，而是**內容對不對**：
 *   - 密碼雜湊絕對不能出現在備份裡（那是刻意的取捨，要有東西守著）
 *   - 空的備份要當成失敗，而不是成功寫入一份空檔案蓋掉輪替空間
 *   - 輪替真的會刪掉最舊的那幾份，而不是隨便刪
 *
 * R2 用一個記憶體版的假物件——這裡要驗的是**我們寫進去什麼**，不是 R2 本身
 * 會不會存。與 d1.mjs 用真 SQLite 的理由剛好相反：那裡要驗的是 SQL 語意，
 * 假物件會把答案寫成期望值；這裡要驗的是傳給 put() 的內容，假物件剛好夠。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBackup, purgeExpired, logAdminAction } from '../src/handlers/backup.js';
import { makeEnv, addUser, seedState } from './d1.mjs';

/** 最小的 R2 外殼：put / list / delete，list 依 key 排序（真的 R2 也是字典序） */
function fakeR2() {
  const store = new Map();
  return {
    store,
    async put(key, body, opts) { store.set(key, { body, opts }); },
    async delete(key) { store.delete(key); },
    async list({ prefix = '', limit = 1000 } = {}) {
      const objects = [...store.keys()]
        .filter(k => k.startsWith(prefix)).sort().slice(0, limit)
        .map(key => ({ key }));
      return { objects };
    },
  };
}

function envWithR2() {
  const env = makeEnv();
  env.BACKUPS = fakeR2();
  return env;
}

const AUG21 = Date.parse('2026-08-21T02:00:00Z');   // 台北時間當天上午

test('備份：把排程、帳號、分享關係都寫進去', async () => {
  const env = envWithR2();
  addUser(env, 'u1', 'a@x.test');
  addUser(env, 'u2', 'b@x.test', 'admin');
  seedState(env, 'u1', { version: 1, items: [{ id: 'i1' }] }, 111);

  const r = await runBackup(env, AUG21);

  assert.equal(r.key, 'backup/2026-08-21.json', '檔名用台北時間的日期');
  assert.equal(r.users, 2);
  assert.equal(r.states, 1);

  const saved = JSON.parse(env.BACKUPS.store.get(r.key).body);
  assert.equal(saved.users.length, 2);
  assert.deepEqual(JSON.parse(saved.userState[0].state).items, [{ id: 'i1' }]);
});

test('備份：絕對不含 password_hash', async () => {
  const env = envWithR2();
  addUser(env, 'u1', 'a@x.test');
  env.DB.prepare("UPDATE users SET password_hash = 'pbkdf2$100000$SECRETSALT$SECRETHASH'").bind().run();

  const r = await runBackup(env, AUG21);
  const raw = env.BACKUPS.store.get(r.key).body;

  assert.ok(!raw.includes('SECRETHASH'), '雜湊不能出現在備份裡');
  assert.ok(!raw.includes('password_hash'), '連欄位名都不該出現');
  assert.ok(raw.includes('a@x.test'), '但帳號本身要備到，否則還原不了');
});

test('備份：一筆使用者都沒有時當成失敗，不寫出空檔案', async () => {
  const env = envWithR2();
  await assert.rejects(() => runBackup(env, AUG21), /users 一筆都沒讀到/);
  assert.equal(env.BACKUPS.store.size, 0, '失敗就不該留下任何檔案');
});

test('備份：只留最近 14 份，刪掉的是最舊的', async () => {
  const env = envWithR2();
  addUser(env, 'u1', 'a@x.test');

  // 先塞 20 份舊備份（日期字典序＝時間序，這正是選這個檔名格式的理由）
  for (let d = 1; d <= 20; d++) {
    env.BACKUPS.store.set(`backup/2026-07-${String(d).padStart(2, '0')}.json`, { body: '{}' });
  }
  const r = await runBackup(env, AUG21);

  const keys = [...env.BACKUPS.store.keys()].sort();
  assert.equal(keys.length, 14);
  assert.equal(keys[keys.length - 1], r.key, '今天這份要留著');
  assert.ok(!keys.includes('backup/2026-07-01.json'), '最舊的要被刪掉');
  assert.ok(keys.includes('backup/2026-07-20.json'), '次新的要留著');
});

test('備份：其他 key 底下的東西不會被輪替波及', async () => {
  const env = envWithR2();
  addUser(env, 'u1', 'a@x.test');
  env.BACKUPS.store.set('something-else.json', { body: '{}' });
  for (let d = 1; d <= 20; d++) {
    env.BACKUPS.store.set(`backup/2026-07-${String(d).padStart(2, '0')}.json`, { body: '{}' });
  }

  await runBackup(env, AUG21);
  assert.ok(env.BACKUPS.store.has('something-else.json'), 'prefix 之外的不該被碰');
});

test('備份：沒有綁 R2 時明確報錯，不要靜靜地什麼都沒做', async () => {
  const env = makeEnv();
  addUser(env, 'u1', 'a@x.test');
  await assert.rejects(() => runBackup(env, Date.now()), /BACKUPS/);
});

// ---------------------------------------------------------------- 過期清理

test('清理：過期的 session 清掉，還沒過期的留著', async () => {
  const env = makeEnv();
  const now = Date.now();
  addUser(env, 'u1', 'a@x.test');
  const ins = (h, exp) => env.DB
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(h, 'u1', 0, exp).run();
  ins('old', now - 1000);
  ins('live', now + 86400_000);

  const r = await purgeExpired(env, now);
  assert.equal(r.sessions, 1);
  assert.ok(env.DB.prepare("SELECT 1 AS x FROM sessions WHERE token_hash = 'live'").bind().first());
});

test('清理：用過的重設連結保留 7 天才刪——「已經用過」的訊息要撐得過幾天', async () => {
  const env = makeEnv();
  const now = Date.now();
  addUser(env, 'u1', 'a@x.test');
  const ins = (h, exp, used) => env.DB.prepare(
    'INSERT INTO password_resets (token_hash, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(h, 'u1', 0, exp, used).run();

  ins('used-today', now - 1000, now - 1000);          // 剛用過 → 留著
  ins('used-long-ago', now - 1000, now - 30 * 86400_000); // 用過很久 → 刪
  ins('expired-unused', now - 1000, null);            // 過期沒用 → 刪
  ins('still-valid', now + 3600_000, null);           // 還有效 → 留著

  const r = await purgeExpired(env, now);
  assert.equal(r.resets, 2);

  const left = env.DB.prepare('SELECT token_hash FROM password_resets ORDER BY token_hash').bind().all();
  assert.deepEqual(left.results.map(x => x.token_hash), ['still-valid', 'used-today']);
});

// ---------------------------------------------------------------- 操作記錄

test('操作記錄：記下當下的 email 快照，帳號刪掉後仍讀得懂', async () => {
  const env = makeEnv();
  const actor = { id: 'admin1', email: 'boss@x.test' };
  const target = { id: 'u9', email: 'gone@x.test' };

  await logAdminAction(env, actor, target, '刪除帳號');
  env.DB.prepare("DELETE FROM users WHERE id = 'u9'").bind().run();

  const row = env.DB.prepare('SELECT * FROM admin_activity').bind().first();
  assert.equal(row.actor_email, 'boss@x.test');
  assert.equal(row.target_email, 'gone@x.test', '帳號沒了，記錄仍要說得出動的是誰');
  assert.equal(row.action, '刪除帳號');
});

test('操作記錄：寫入失敗不能把已經成功的操作變成錯誤', async () => {
  const env = makeEnv();
  env.DB.prepare("DROP TABLE admin_activity").bind().run();
  const warn = console.warn;
  const seen = [];
  console.warn = (...a) => seen.push(a.join(' '));
  try {
    // 不該丟例外——帳號狀態已經改了，回錯誤會讓管理者重試而重複操作
    await logAdminAction(env, { id: 'a', email: 'a@x' }, { id: 'b', email: 'b@x' }, 'x');
  } finally { console.warn = warn; }
  assert.ok(seen.some(l => l.includes('admin activity log failed')), '但要留下線索');
});
