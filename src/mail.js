/**
 * 寄信。原本這段是 handlers/reminder.js 內的私有函式，因為密碼重設信也要用
 * 同一條路而抽出來——內容原封不動搬過來，只是改成 export。
 *
 * 抽出來而不是讓 auth.js 去 import reminder.js，是因為「怎麼寄信」與「逾期提醒」
 * 是兩件事：提醒是這個能力的第一個使用者，不是它的擁有者。
 *
 * 路徑取自官方 OpenAPI 規格（https://docs.agentmail.to/openapi.json）：
 * servers = https://api.agentmail.to，端點 = POST /v0/inboxes/{inbox_id}/messages/send。
 * **版本前綴 /v0 不可省略**——文件正文與部分範例寫成沒有前綴的形式，照抄會 404，
 * 而 404 在 log 裡看起來像「inbox 不存在」，會往完全錯誤的方向查。
 */
import { uuid } from './crypto.js';

const AGENTMAIL_SEND = inbox =>
  `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inbox)}/messages/send`;

/** 寄信記錄保留幾天。與 cron_runs 一致：價值只存在於事發後的短期內。 */
const MAIL_LOG_KEEP_DAYS = 30;
/** detail 的長度上限。寄信商的錯誤訊息可能很長，但看不出問題的長度就沒有意義。 */
const MAX_DETAIL = 1000;

/**
 * 記一封信的結果。
 *
 * **失敗的那一筆才是重點**，理由與 `recordCronRun` 一字不差：只記成功等於重蹈
 * console.error 的覆轍——沒有記錄與一切正常長得一模一樣。Helen 的密碼重設信
 * 就是這樣消失的：連結真的產生了，信被退訂名單擋掉，而畫面上什麼都沒有。
 *
 * **寫記錄失敗只 console.warn。** 記錄寫不進去，不該讓一封已經寄出去的信
 * 變成一個錯誤——同 cron_runs / share_activity / admin_activity。
 * 也因此 migration 還沒跑時整條寄信的路仍然是通的，只是多一行警告。
 *
 * 順手清掉過期的舊記錄：沒有保留上限的日誌表遲早會是資料庫裡最大的一張。
 */
async function recordMail(env, kind, to, ok, detail, nowMs) {
  try {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO mail_log (id, kind, to_email, ok, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(
        uuid(), kind, String(to), ok ? 1 : 0,
        detail == null ? null : String(detail).slice(0, MAX_DETAIL), nowMs
      ),
      env.DB.prepare('DELETE FROM mail_log WHERE created_at < ?')
        .bind(nowMs - MAIL_LOG_KEEP_DAYS * 86400_000),
    ]);
  } catch (e) {
    console.warn('mail log failed', kind, String(e));
  }
}

/**
 * 寄一封信。
 *
 * 送信端點帶 inbox id，認證用帳號層級的 API key——兩者是不同的東西，而且
 * **極容易搞反**：API key 長得像 `am_us_inbox_b1e2…`（前綴寫著 inbox 卻是 key），
 * inbox id 則是 email 位址形式如 `uic_ai@agentmail.to`。開發時實際搞錯過兩次。
 *
 * 分辨方法：拿那個值當 Bearer 打 GET /v0/inboxes，回 200 就是 API key，
 * 而回應裡的 inboxes[].inbox_id 才是要填進 AGENTMAIL_INBOX_ID 的值。
 */
export async function sendMail(env, to, mail, kind = 'unknown') {
  const key = env.AGENTMAIL_API_KEY;
  const inbox = env.AGENTMAIL_INBOX_ID;
  // 這兩個也要記。「secret 沒設」與「收件人被擋」都會讓信寄不出去，而在
  // 「使用者沒收到信」這個症狀上長得一模一樣——分不出來就查不下去。
  if (!key || !inbox) {
    const why = !key
      ? 'AGENTMAIL_API_KEY 未設定（帳號層級憑證，形如 am_us_inbox_…）'
      : 'AGENTMAIL_INBOX_ID 未設定（寄件信箱，email 位址形式）';
    await recordMail(env, kind, to, false, why, Date.now());
    throw new Error(why);
  }

  let r;
  try {
    r = await fetch(AGENTMAIL_SEND(inbox), {
      method: 'POST',
      headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
      // to 接受單一位址或陣列；其餘欄位規格上都是選填，但沒有內文的信沒有意義
      body: JSON.stringify({ to, subject: mail.subject, text: mail.text, html: mail.html })
    });
  } catch (e) {
    // 連線層的失敗（DNS、TLS、逾時）也要留下來：它與「被退訂名單擋掉」
    // 在「信沒收到」這個症狀上一樣看不出差別
    await recordMail(env, kind, to, false, String((e && e.message) || e), Date.now());
    throw e;
  }
  if (!r.ok) {
    // 規格定義了 400/403/404/409 四種錯誤回應，訊息在 body 裡——
    // 只記狀態碼的話，「inbox 不存在」與「key 無效」看起來會一模一樣
    const detail = `AgentMail ${r.status}: ${(await r.text()).slice(0, 300)}`;
    await recordMail(env, kind, to, false, detail, Date.now());
    throw new Error(detail);
  }
  // 成功不記 detail：信的內容（重設連結、驗證碼、某個人的排程摘要）沒有理由
  // 留在資料庫裡。要回答的只是「有沒有寄成功」。
  await recordMail(env, kind, to, true, null, Date.now());
  return true;
}

/** 信件內文用。與 reminder.js 的 esc 同一份職責，抽在這裡讓兩邊共用。 */
export function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
