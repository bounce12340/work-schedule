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
const AGENTMAIL_SEND = inbox =>
  `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inbox)}/messages/send`;

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
export async function sendMail(env, to, mail) {
  const key = env.AGENTMAIL_API_KEY;
  const inbox = env.AGENTMAIL_INBOX_ID;
  if (!key) throw new Error('AGENTMAIL_API_KEY 未設定（帳號層級憑證，形如 am_us_inbox_…）');
  if (!inbox) throw new Error('AGENTMAIL_INBOX_ID 未設定（寄件信箱，email 位址形式）');

  const r = await fetch(AGENTMAIL_SEND(inbox), {
    method: 'POST',
    headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
    // to 接受單一位址或陣列；其餘欄位規格上都是選填，但沒有內文的信沒有意義
    body: JSON.stringify({ to, subject: mail.subject, text: mail.text, html: mail.html })
  });
  if (!r.ok) {
    // 規格定義了 400/403/404/409 四種錯誤回應，訊息在 body 裡——
    // 只記狀態碼的話，「inbox 不存在」與「key 無效」看起來會一模一樣
    throw new Error(`AgentMail ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
  return true;
}

/** 信件內文用。與 reminder.js 的 esc 同一份職責，抽在這裡讓兩邊共用。 */
export function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
