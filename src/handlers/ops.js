/**
 * 維運可見度：cron 的執行記錄，以及「哪些功能真的有人在用」。
 *
 * 為什麼這兩件事放在一起
 * ---------------------------------------------------------------------------
 * 它們回答的是同一類問題——**這個系統現在到底是什麼狀態**——而那類問題目前
 * 只有一個答法：直接連進 D1 下 SQL。那不是每天想確認一次的人做得到的事。
 *
 * 這個檔案的存在理由，就是把「我得手動查資料庫才知道」變成「打開管理頁就看到」。
 * 與備份清單（handlers/backup.js 的 listBackups）是同一個決定的延伸：
 * **看得見的備份才是備份**，而看不見的 cron 同樣不算在跑。
 *
 * 真實案例：提醒信整整兩週沒有寄出，而 `reminder_feed.enabled` 是 1、帳號是
 * approved、digest 裡也確實有即將到期的項目——條件全部成立。畫面上沒有任何
 * 徵兆，因為寄信失敗只留了一行 `console.warn`，而那行字在 Cloudflare 後台。
 * 這個檔案就是為了讓那種情況第二天早上就被看見。
 */
import { uuid } from '../crypto.js';
import { json } from './auth.js';
import { aiUsageSummary, aiConfigured } from './ai.js';

/** 執行記錄保留幾天。一天三列，量極小；價值只存在於事發後的短期內。 */
const KEEP_DAYS = 30;

/** 一次回幾筆給管理頁。三個 step × 30 天 = 90 筆，全部給也不多。 */
const LIST_LIMIT = 90;

/** detail 欄位的長度上限。錯誤訊息可能很長，但看不出問題的長度就沒有意義。 */
const MAX_DETAIL = 1000;

/**
 * 記一次 cron 工作的結果。
 *
 * **失敗的那一筆才是重點。** 只記成功等於重蹈 console.log 的覆轍——沒有記錄
 * 與一切正常長得一模一樣。所以 ok = 0 一樣要寫，而且要把錯誤訊息帶進來：
 * 「鬧鐘沒響」與「響了但信寄不出去」需要不同的處理方向，分不出來就查不下去。
 *
 * 寫入失敗只 `console.warn`：記錄寫不進去，不該讓本來已經做完的排程工作
 * 看起來像失敗。理由與 share_activity／admin_activity 一致。
 *
 * 順手清掉過期的舊記錄，同 share_activity 的作法——沒有保留上限的日誌表
 * 遲早會是資料庫裡最大的一張。
 */
export async function recordCronRun(env, run) {
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO cron_runs (id, step, ok, detail, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        uuid(), run.step, run.ok ? 1 : 0,
        run.detail == null ? null : String(run.detail).slice(0, MAX_DETAIL),
        run.startedAt, run.endedAt
      ),
      env.DB.prepare('DELETE FROM cron_runs WHERE started_at < ?')
        .bind(run.endedAt - KEEP_DAYS * 86400_000),
    ]);
  } catch (e) {
    console.warn('cron run log failed', run.step, String(e));
  }
}

/**
 * 這一步的回傳值有沒有在說「其實沒做到」。
 *
 * `step()` 原本只看有沒有丟例外——但 `sendOverdueReminders` **刻意不往上丟**：
 * 一個人的信寄不出去，不該讓其他人的信也跟著不寄，所以它把個別失敗收進
 * `errors[]` 再正常回傳。於是「函式沒有丟例外」與「這一步真的做到了」分家了。
 *
 * 實際後果（2026-09-09 早上）：helen 的提醒信被 AgentMail 以 403
 * `message_rejected` 擋下（她的信箱進了退訂名單），這一步卻被記成成功，
 * `/admin` 顯示「✓ 正常」。**假綠燈正是 cron_runs 這張表存在要防的東西，
 * 不能由它自己製造出來。**
 *
 * 約定：任何 cron 步驟只要回傳值裡的 `errors` 是非空陣列，就不算乾淨的成功。
 * 這是通用約定而不是為提醒寫死的判斷——日後多一個步驟會自動適用，而寫死一份
 * 「哪些步驟要檢查」的清單，漏掉的那一個就會靜靜地繼續發假綠燈。
 *
 * 只認 `errors`，不認 `failed` 這種數字欄位：數字說得出「有幾個」，說不出
 * 「為什麼」，而錯誤原因才是這張表要留住的東西。
 */
export function cronResultErrors(result) {
  const errs = result && result.errors;
  return Array.isArray(errs) ? errs : [];
}

/**
 * 給管理頁的 cron 狀態。
 *
 * 除了原始記錄，另外算出每個 step 的**最後一次成功**——那才是真正要看的數字。
 * 「昨天跑過」與「昨天跑過但失敗了」在一份只有時間戳的清單裡看起來很像，
 * 而它們的意義完全相反。
 */
export async function listCronRuns(env, nowMs = Date.now()) {
  const rows = await env.DB.prepare(
    `SELECT step, ok, detail, started_at, ended_at
       FROM cron_runs ORDER BY started_at DESC LIMIT ?`
  ).bind(LIST_LIMIT).all();

  const runs = (rows.results || []).map(r => ({
    step: r.step,
    ok: !!r.ok,
    detail: r.detail,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    ms: r.ended_at - r.started_at,
  }));

  // 每個 step 各自的最後成功時間。步驟名稱從記錄本身取，不寫死一份清單——
  // 日後 cron 多一件事，這裡不必跟著改（漏改的話那件事會靜靜地不被監看）
  const steps = {};
  for (const r of runs) {
    const s = steps[r.step] || (steps[r.step] = { lastRunAt: null, lastOkAt: null, lastError: null });
    if (s.lastRunAt == null) s.lastRunAt = r.startedAt;
    if (s.lastOkAt == null && r.ok) s.lastOkAt = r.startedAt;
    if (s.lastError == null && !r.ok) s.lastError = r.detail;
  }

  return { now: nowMs, keepDays: KEEP_DAYS, steps, runs };
}

/**
 * 功能使用狀況。
 *
 * 為什麼要有這個：系統上線後，行事曆訂閱是 0 筆、跨帳號分享是 0 筆——而這件事
 * 是**直接查資料庫**才發現的。「做好了但沒有人用」是產品訊號，不是技術問題，
 * 但它同樣需要有人看得到才存在。看不到的話，下一個決定只能靠猜。
 *
 * **只回數量與狀態，不回任何排程內容。** 這裡要回答的是「有沒有人在用、正不正常」，
 * 沒有理由為了確認這件事就把全系統所有人的排程送到瀏覽器——與 listBackups
 * 只回 metadata 是同一個判斷。
 *
 * 項目數用 SQL 的 json_array_length 就地算，不把 state 讀進 Worker 再解析：
 * state 是整份排程，兩位使用者現在是 21KB，但這條路不該隨人數線性放大。
 * `json_valid` 的守衛是為了讓一份壞掉的 state 只讓那一列的數字變成 null，
 * 而不是讓整張表查不出來。
 */
export async function usageSummary(env, nowMs = Date.now()) {
  const rows = await env.DB.prepare(
    `SELECT u.id, u.email, u.role, u.status, u.created_at,
            s.updated_at AS synced_at,
            LENGTH(s.state) AS bytes,
            CASE WHEN json_valid(s.state) THEN json_array_length(json_extract(s.state,'$.items')) END AS items,
            CASE WHEN json_valid(s.state) THEN json_array_length(json_extract(s.state,'$.ganttProjects')) END AS gantt,
            r.enabled AS reminder_on, r.lead_days, r.last_sent_ymd,
            CASE WHEN i.user_id IS NULL THEN 0 ELSE 1 END AS ics_on,
            (SELECT COUNT(*) FROM sessions se WHERE se.user_id = u.id AND se.expires_at > ?) AS devices,
            (SELECT COUNT(*) FROM shares sh WHERE sh.owner_id = u.id) AS shared_out
       FROM users u
       LEFT JOIN user_state s ON s.user_id = u.id
       LEFT JOIN reminder_feed r ON r.user_id = u.id
       LEFT JOIN ics_feed i ON i.user_id = u.id
      ORDER BY u.created_at`
  ).bind(nowMs).all();

  const users = (rows.results || []).map(r => ({
    email: r.email,
    role: r.role,
    status: r.status,
    createdAt: r.created_at,
    syncedAt: r.synced_at,
    bytes: r.bytes ?? 0,
    items: r.items ?? 0,
    gantt: r.gantt ?? 0,
    reminderOn: !!r.reminder_on,
    leadDays: r.lead_days,
    lastSentYmd: r.last_sent_ymd,
    icsOn: !!r.ics_on,
    devices: r.devices,
    sharedOut: r.shared_out,
  }));

  const totals = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM shares)         AS shares,
            (SELECT COUNT(*) FROM ics_feed)       AS ics,
            (SELECT COUNT(*) FROM share_activity) AS shareActivity,
            (SELECT COUNT(*) FROM admin_activity) AS adminActivity`
  ).first();

  // AI 是唯一會直接花錢的功能，所以它的用量跟其他統計放在一起——
  // 「有沒有人在用」與「花了多少」在這一頁上是同一個問題
  let ai = null;
  try {
    ai = { configured: aiConfigured(env), ...(await aiUsageSummary(env, nowMs)) };
  } catch (e) {
    // ai_activity 還沒建表（migration 沒跑）不該讓整張使用狀況表消失
    console.warn('ai usage failed', String(e));
  }

  return { now: nowMs, users, totals, ai };
}

/** 路由層：兩支都只給管理者，權限在 index.js 的 /api/admin/ 前綴一次擋掉。 */
export async function handleCronStatus(env) {
  return json(await listCronRuns(env));
}

export async function handleUsage(env) {
  return json(await usageSummary(env));
}
