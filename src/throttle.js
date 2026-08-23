/**
 * 登入失敗節流。
 *
 * Turnstile 擋得住「一秒鐘一萬次」的機器人，擋不住「一分鐘三次、試一整天」的人。
 * 兩者是不同的攻擊形狀，要分開擋。
 *
 * 刻意不是「鎖定帳號」
 * ---------------------------------------------------------------------------
 * 真的鎖定帳號的話，任何人只要對著別人的 email 一直打錯密碼，就能把對方鎖在
 * 門外——防禦措施本身變成阻斷服務的工具。這裡做的是**滑動窗口內先擋著**：窗口
 * 過了自動恢復，不需要任何人來解鎖。
 *
 * 兩個維度都要擋
 * ---------------------------------------------------------------------------
 * 只擋 email：換一個 email 就能繼續打，對「拿一份外洩密碼表掃一遍」完全無效。
 * 只擋 IP：同一間辦公室（同一個對外 IP）的人會互相牽連，一個人打錯就大家進不去。
 * 兩個都記、任一超限就擋，各自的門檻不同——IP 的門檻較寬，因為它天生會被共用。
 */

/** 窗口長度。夠短到正常使用者去倒杯水回來就恢復，夠長到讓自動化嘗試沒有效率。 */
const WINDOW_MS = 15 * 60 * 1000;

const LIMITS = { email: 5, ip: 20 };

function limitFor(key) {
  return LIMITS[key.split(':', 1)[0]] ?? LIMITS.email;
}

/**
 * 這些 key 現在是不是已經超限？回傳 { blocked, retryAfterSec }。
 *
 * 讀取用單句 SQL 取出全部，不要逐個 key 往返——登入是每個人都會走的路徑，
 * 多一次 D1 往返就是每個人都多等一次。
 */
export async function checkThrottle(env, keys, nowMs = Date.now()) {
  const live = keys.filter(Boolean);
  if (!live.length) return { blocked: false };

  const placeholders = live.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT key, fails, window_start FROM login_attempts WHERE key IN (${placeholders})`
  ).bind(...live).all();

  for (const row of results || []) {
    // 窗口已經過去的紀錄視同不存在——不必先刪再判斷，讓每天的清理去收拾就好
    if (nowMs - row.window_start >= WINDOW_MS) continue;
    if (row.fails >= limitFor(row.key)) {
      return {
        blocked: true,
        retryAfterSec: Math.max(1, Math.ceil((row.window_start + WINDOW_MS - nowMs) / 1000)),
      };
    }
  }
  return { blocked: false };
}

/**
 * 記一次失敗。
 *
 * 窗口過期就從頭算起（把 window_start 推到現在、fails 歸 1），否則累加。這一整段
 * 用**單句 UPSERT** 完成，不是「先讀再寫」：兩次併發的失敗嘗試落在讀與寫之間時，
 * 後寫的會把前一次的計數蓋掉，攻擊者只要開兩條連線就能讓計數永遠停在 1。
 * 樂觀鎖那一節記的是同一件事——讀完到寫入之間的空窗是真的會被踩到的。
 */
export async function recordFailure(env, keys, nowMs = Date.now()) {
  const live = keys.filter(Boolean);
  if (!live.length) return;

  await env.DB.batch(live.map(key => env.DB.prepare(
    `INSERT INTO login_attempts (key, fails, window_start) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       fails = CASE WHEN ? - login_attempts.window_start >= ? THEN 1 ELSE login_attempts.fails + 1 END,
       window_start = CASE WHEN ? - login_attempts.window_start >= ? THEN ? ELSE login_attempts.window_start END`
  ).bind(key, nowMs, nowMs, WINDOW_MS, nowMs, WINDOW_MS, nowMs)));
}

/** 登入成功就把這個人的計數清掉，免得先前的失手累積到下一次真的擋住他 */
export async function clearFailures(env, keys) {
  const live = keys.filter(Boolean);
  if (!live.length) return;
  const placeholders = live.map(() => '?').join(',');
  await env.DB.prepare(`DELETE FROM login_attempts WHERE key IN (${placeholders})`)
    .bind(...live).run();
}

/** email 一律正規化過再當 key，否則大小寫不同會被算成兩個不同的目標 */
export function throttleKeys(email, ip) {
  return [email ? `email:${email}` : null, ip ? `ip:${ip}` : null];
}
