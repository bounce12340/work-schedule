/**
 * 每日自動備份到 R2。
 *
 * 為什麼需要
 * ---------------------------------------------------------------------------
 * 在這之前，所有人的排程只存在**一個地方**：D1。資料庫壞掉、誤刪、或誰下錯一句
 * SQL，就沒有任何一份還原得回來——唯一的備份是「每個使用者自己記得按匯出」，
 * 而沒有人會記得。
 *
 * 其他每一種故障都還有救，只有資料沒了是真的沒了。因此這是整份系統裡最先該補的洞。
 *
 * 備份**不含密碼雜湊**，這是刻意的
 * ---------------------------------------------------------------------------
 * 帶著雜湊的備份等於把「所有人的憑證」多複製一份到另一個地方，外洩面積直接放大。
 * 不帶的代價是還原後所有人都要重設密碼——而現在「忘記密碼」是自助的（寄一次性
 * 連結），那個代價從「每個人都要來拜託管理者」變成「每個人自己點一下」。
 *
 * 換句話說：**自助重設讓「不備份密碼」變成負擔得起的選擇。** 兩個功能是一組的。
 *
 * 備的是什麼
 * ---------------------------------------------------------------------------
 * user_state（排程本體）、users 的帳號欄位（不含 password_hash）、shares（分享
 * 關係）。session、重設連結、登入失敗計數都是短命的執行期資料，還原它們沒有意義。
 *
 * ics_feed 與 reminder_feed 也不備：兩者的內容都是前端每次同步時重新推上來的
 * 衍生資料，還原 user_state 之後使用者一開 app 就會自己補回去。
 */
import { uuid } from '../crypto.js';

/** 保留幾份。每天一份、留兩週——足以涵蓋「上週就壞了但今天才發現」。 */
const KEEP = 14;

const KEY_PREFIX = 'backup/';

/** 台北時間的今天。與逾期提醒共用同一個時區基準，兩者的「今天」才會是同一天。 */
function taipeiYmd(nowMs) {
  return new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 跑一次備份。回傳統計，讓 cron 的 log 看得出它到底做了什麼——
 * 「備份成功」而內容是空的，是最糟的一種成功。
 */
export async function runBackup(env, nowMs = Date.now()) {
  if (!env.BACKUPS) throw new Error('BACKUPS（R2 bucket）未綁定');

  const [users, states, shares] = await Promise.all([
    // 明確列出欄位而不是 SELECT *：日後有人在 users 加了敏感欄位，
    // 不會因為「反正是備份」就悄悄跟著被複製出去
    env.DB.prepare(
      'SELECT id, email, role, status, created_at, approved_at, approved_by FROM users'
    ).all(),
    env.DB.prepare('SELECT user_id, state, updated_at, created_at FROM user_state').all(),
    env.DB.prepare('SELECT * FROM shares').all(),
  ]);

  const payload = {
    version: 1,
    takenAt: nowMs,
    // 這句話刻意不寫出那個欄位的英文名：備份檔裡出現該字串，會讓「檢查備份有沒有
    // 洩漏憑證」這件事變得需要判斷上下文，而那種檢查一旦需要判斷就會開始出錯
    note: '本備份不含密碼雜湊。還原後所有人需自行走「忘記密碼」重設。',
    users: users.results || [],
    userState: states.results || [],
    shares: shares.results || [],
  };

  // 空的備份一定是出了問題（至少要有建立備份的那個管理者）。與其存下一份空檔案
  // 蓋掉輪替空間，不如當場失敗——備份最可怕的失敗模式是「以為有、其實沒有」。
  if (!payload.users.length) throw new Error('備份中止：users 一筆都沒讀到');

  const key = `${KEY_PREFIX}${taipeiYmd(nowMs)}.json`;
  const body = JSON.stringify(payload);
  await env.BACKUPS.put(key, body, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      users: String(payload.users.length),
      states: String(payload.userState.length),
    },
  });

  const pruned = await pruneOld(env);
  return {
    key,
    bytes: body.length,
    users: payload.users.length,
    states: payload.userState.length,
    shares: payload.shares.length,
    pruned,
  };
}

/**
 * 只留最近 KEEP 份。
 *
 * 檔名是日期，而 R2 的 list 依 key 字典序回傳——`YYYY-MM-DD` 的字典序等於時間
 * 順序，所以「前面幾個」就是「最舊的幾個」，不需要額外排序或讀 metadata。
 * （這是選這個檔名格式的理由之一，不是巧合。）
 */
async function pruneOld(env) {
  const listed = await env.BACKUPS.list({ prefix: KEY_PREFIX, limit: 1000 });
  const keys = (listed.objects || []).map(o => o.key).sort();
  const extra = keys.slice(0, Math.max(0, keys.length - KEEP));
  for (const k of extra) await env.BACKUPS.delete(k);
  return extra.length;
}

/**
 * 清掉過期的執行期資料。跟備份放在同一個 cron，因為兩者都是「每天固定要做一次
 * 的家事」，而不是使用者觸發的行為。
 *
 * session 原本只有「剛好被碰到」時才刪（getSessionUser 發現過期才 destroy），
 * 沒被碰到的就永遠躺在表裡。password_resets 更徹底：原本完全沒有人清。
 *
 * 用過的重設連結保留 7 天才刪，不是立刻刪：使用者按了上一頁或郵件用戶端預抓時，
 * 「這個連結已經用過了」比「查無此連結」好懂太多——那個訊息要能撐過幾天。
 */
export async function purgeExpired(env, nowMs = Date.now()) {
  const usedGrace = nowMs - 7 * 86400_000;
  const [sessions, resets, attempts] = await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowMs),
    env.DB.prepare('DELETE FROM password_resets WHERE expires_at < ? AND (used_at IS NULL OR used_at < ?)')
      .bind(nowMs, usedGrace),
    // 登入失敗計數的窗口只有幾分鐘，過了就沒有意義
    env.DB.prepare('DELETE FROM login_attempts WHERE window_start < ?').bind(nowMs - 86400_000),
  ]);
  return {
    sessions: sessions.meta.changes,
    resets: resets.meta.changes,
    attempts: attempts.meta.changes,
  };
}

/**
 * 管理者操作記錄的寫入。放在這裡而不是 admin.js，是因為它與「保留多久、怎麼清」
 * 是同一件事——清理邏輯在這個檔案裡。
 *
 * 記錄失敗只留 console.warn，不讓已經成功的操作變成 500：帳號狀態已經改了，
 * 回錯誤會讓管理者重試而重複操作。與 share_activity 的處理方式一致。
 */
export async function logAdminAction(env, actor, target, action) {
  try {
    await env.DB.prepare(
      `INSERT INTO admin_activity (id, actor_id, actor_email, target_id, target_email, action, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(uuid(), actor.id, actor.email, target.id, target.email, action, Date.now()).run();
  } catch (e) {
    console.warn('admin activity log failed', e?.stack || String(e));
  }
}
