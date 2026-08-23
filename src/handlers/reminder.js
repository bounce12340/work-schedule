import { json } from './auth.js';
import { sendMail } from '../mail.js';

/**
 * 逾期提醒。
 *
 * 設計與行事曆訂閱（ICS）同一個模式：**內容由前端產生、同步時推上來**，
 * 這裡只負責「比對日期 → 寄信」。
 *
 * 不在 Worker 展開循環規則，理由與 ICS 相同：occurrence 引擎（含假日順延、
 * 單次覆寫、略過）只存在前端單檔內。在這裡重新實作一份，兩套必然分歧——
 * 而**提醒寄錯日期比沒有提醒更糟**，因為使用者會信任它。
 *
 * 前端推上來的是「已展開的排程」而不是「已經算好的逾期清單」：逾期與否隨日期
 * 改變，今天不逾期的項目後天就逾期了。存展開後的日期讓 cron 每天自己比對，
 * 使用者一段時間沒開 app 也不影響正確性。
 */

const MAX_DIGEST_BYTES = 200_000;
// 一次信裡最多列這麼多筆，其餘用「還有 N 項」帶過——把兩百行倒進信裡沒有人會讀
const MAX_LISTED = 20;

/** 預設提前 3 天。0 代表只在逾期時寄（原本的行為），上限 30 天。 */
export const DEFAULT_LEAD_DAYS = 3;
const MAX_LEAD_DAYS = 30;

/** 回 null 代表「沒有指定」，呼叫端據此決定要不要沿用舊值 */
function normalizeLeadDays(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_LEAD_DAYS, Math.max(0, n));
}

/** 台北時間的今天（UTC+8，台灣自 1980 年起無夏令時間，固定偏移即可） */
export function taipeiYmd(nowMs) {
  const d = new Date(nowMs + 8 * 3600_000);
  return d.toISOString().slice(0, 10);
}

/**
 * 從展開後的排程挑出逾期未完成的項目。純函式，方便直接測。
 * 逾期＝日期早於今天且尚未完成。今天到期的**不算**逾期——那是「今天要做」，
 * 混在一起會讓真正遲交的東西被淹沒。
 */
export function pickOverdue(digest, todayYmd) {
  if (!Array.isArray(digest)) return [];
  return digest
    .filter(r => r && !r.done && typeof r.d === 'string' && r.d < todayYmd)
    .sort((a, b) => a.d.localeCompare(b.d));
}

/**
 * 即將到期：今天（含）之後、leadDays 天之內尚未完成的項目。
 *
 * **包含今天**——與逾期的分界剛好互補：pickOverdue 取 `d < today`，這裡取
 * `today <= d <= 截止`，兩者不重疊也不漏接。今天到期的東西放在「即將」這一段
 * 是對的，它還沒遲到，但確實是今天要做的。
 *
 * leadDays 為 0 代表使用者只想在逾期時被通知，直接回空陣列。
 */
export function pickUpcoming(digest, todayYmd, leadDays) {
  if (!Array.isArray(digest) || !(leadDays > 0)) return [];
  const until = addDays(todayYmd, leadDays);
  return digest
    .filter(r => r && !r.done && typeof r.d === 'string' && r.d >= todayYmd && r.d <= until)
    .sort((a, b) => a.d.localeCompare(b.d));
}

/** YYYY-MM-DD 加上 n 天。用 UTC 的 Date 算，不碰時區——輸入輸出都只是日期字串。 */
export function addDays(ymd, n) {
  const t = Date.parse(ymd + 'T00:00:00Z');
  return new Date(t + n * 86400_000).toISOString().slice(0, 10);
}

export async function handleReminderStatus(env, user) {
  const row = await env.DB
    .prepare('SELECT enabled, last_sent_ymd, lead_days, updated_at FROM reminder_feed WHERE user_id = ?')
    .bind(user.id).first();
  return json({
    enabled: !!(row && row.enabled),
    leadDays: row ? row.lead_days : DEFAULT_LEAD_DAYS,
    lastSent: row ? row.last_sent_ymd : null,
    updatedAt: row ? row.updated_at : null,
    email: user.email
  });
}

export async function handleReminderEnable(request, env, user) {
  let body = {};
  try { body = await request.json(); } catch { /* 沒有 body 就當成開啟 */ }
  const enabled = body && body.enabled === false ? 0 : 1;
  // 沒有帶 leadDays 就沿用現有值——這支端點也用於單純開關提醒，
  // 不該因為前端少送一個欄位就把使用者設好的提前天數重設掉
  const lead = normalizeLeadDays(body?.leadDays);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO reminder_feed (user_id, enabled, digest, lead_days, updated_at)
     VALUES (?, ?, '[]', ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       enabled = excluded.enabled,
       lead_days = COALESCE(?, reminder_feed.lead_days),
       updated_at = excluded.updated_at`
  ).bind(user.id, enabled, lead ?? DEFAULT_LEAD_DAYS, now, lead).run();
  return json({ ok: true, enabled: !!enabled });
}

/** 前端每次同步後推上來的展開排程 */
export async function handleReminderPut(request, env, user) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '請求格式錯誤' }, 400); }
  if (!Array.isArray(body?.digest)) return json({ error: '缺少 digest 陣列' }, 400);

  // 只留需要的欄位，長度也設上限：這份資料只用來排程寄信，不該變成第二個
  // 可以塞任意內容的儲存空間
  const digest = body.digest.slice(0, 2000).map(r => ({
    t: String(r?.t == null ? '' : r.t).slice(0, 200),
    d: String(r?.d == null ? '' : r.d).slice(0, 10),
    k: ['work', 'meeting', 'assignment'].includes(r?.k) ? r.k : 'work',
    done: r?.done ? 1 : 0
  })).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.d));

  const serialized = JSON.stringify(digest);
  if (serialized.length > MAX_DIGEST_BYTES) return json({ error: 'Digest too large' }, 413);

  const now = Date.now();
  // 兩件事要分清楚：
  //
  //   - **已經存在的列不動 enabled**（DO UPDATE 只改 digest）。推送是同步的副作用，
  //     絕不能把使用者親手關掉的提醒又打開——那是他明確表達過的選擇。
  //   - **新建的列採用預設值（開啟）**。這裡沒有任何「使用者的選擇」可以尊重，
  //     他還沒表達過意見；預設開啟的理由見 schema.sql 的註解。
  //
  // 先前這裡寫死 enabled = 0，等於讓 schema 的預設值永遠用不到——「預設開啟」
  // 只改 schema 是不夠的，因為實際建立這一列的就是這句 SQL。
  await env.DB.prepare(
    `INSERT INTO reminder_feed (user_id, digest, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET digest = excluded.digest, updated_at = excluded.updated_at`
  ).bind(user.id, serialized, now).run();
  return json({ ok: true, count: digest.length });
}

const TYPE_LABEL = { work: '工作項目', meeting: '會議安排', assignment: '作業' };

const esc = s => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 兩個日期字串相差幾天。只算日期，不牽涉時區。 */
function dayDiff(fromYmd, toYmd) {
  return Math.round((Date.parse(toYmd) - Date.parse(fromYmd)) / 86400000);
}

/**
 * 信件內容。逾期與即將到期分成兩段，**逾期永遠排在前面**。
 *
 * 分段而不是混成一張表，是因為兩者要的行動不同：逾期是「已經遲了，現在就處理」，
 * 即將到期是「先看一眼，安排時間」。混在一起會讓真正遲交的東西被淹沒——那正是
 * 原本「今天到期的不算逾期」想避免的事，這裡沿用同一個判斷。
 */
export function buildReminderEmail(overdue, upcoming, todayYmd, appUrl) {
  const parts = [];
  const htmlParts = [];

  if (overdue.length) {
    const shown = overdue.slice(0, MAX_LISTED);
    const rest = overdue.length - shown.length;
    parts.push(
      `【已逾期】${overdue.length} 項`, '',
      ...shown.map(r => `・${r.d}（逾期 ${dayDiff(r.d, todayYmd)} 天）  ${r.t}`),
      ...(rest > 0 ? [`・…還有 ${rest} 項`] : []), ''
    );
    htmlParts.push(section('已逾期', '#C0392B', shown, rest,
      r => `逾期 ${dayDiff(r.d, todayYmd)} 天`));
  }

  if (upcoming.length) {
    const shown = upcoming.slice(0, MAX_LISTED);
    const rest = upcoming.length - shown.length;
    parts.push(
      `【即將到期】${upcoming.length} 項`, '',
      ...shown.map(r => `・${r.d}（${whenLabel(dayDiff(todayYmd, r.d))}）  ${r.t}`),
      ...(rest > 0 ? [`・…還有 ${rest} 項`] : []), ''
    );
    htmlParts.push(section('即將到期', '#C9822E', shown, rest,
      r => whenLabel(dayDiff(todayYmd, r.d))));
  }

  const text = [
    ...parts,
    appUrl ? `開啟系統：${appUrl}` : '',
    '', '— 工作排程確認系統'
  ].join('\n');

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.7;color:#2A2A26">
${htmlParts.join('')}
${appUrl ? `<p style="margin:18px 0 0"><a href="${esc(appUrl)}" style="color:#C9822E">開啟工作排程確認系統 →</a></p>` : ''}
<p style="margin:22px 0 0;color:#A2A099;font-size:12px">沒有逾期、也沒有即將到期的項目時，這封信不會寄出。要調整提前天數或停止接收，可在系統內設定。</p>
</div>`;

  return { subject: buildSubject(overdue.length, upcoming.length), text, html };
}

/** 「今天到期」「明天到期」比「0 天後」「1 天後」好讀太多 */
function whenLabel(days) {
  if (days <= 0) return '今天到期';
  if (days === 1) return '明天到期';
  return `${days} 天後到期`;
}

/**
 * 主旨要一眼看得出嚴重程度。有逾期就讓逾期當主角——收件匣裡通常只看得到主旨，
 * 把「3 個已逾期」藏在「5 個提醒」後面等於把最重要的資訊丟掉。
 */
function buildSubject(overdueN, upcomingN) {
  if (overdueN && upcomingN) return `【工作排程】${overdueN} 個已逾期、${upcomingN} 個即將到期`;
  if (overdueN) return `【逾期提醒】${overdueN} 個項目已過期`;
  return `【即將到期】${upcomingN} 個項目即將到期`;
}

function section(title, color, rows, rest, whenText) {
  return `<p style="margin:0 0 10px"><b style="color:${color}">${title}</b> · ${rows.length + rest} 項</p>
<table style="border-collapse:collapse;width:100%;max-width:560px;margin:0 0 22px">
${rows.map(r => `<tr>
<td style="padding:6px 10px 6px 0;white-space:nowrap;font-family:ui-monospace,monospace;font-size:12px;color:${color};vertical-align:top">${esc(r.d)}</td>
<td style="padding:6px 10px 6px 0;white-space:nowrap;font-size:12px;color:#71706A;vertical-align:top">${esc(whenText(r))}</td>
<td style="padding:6px 0;vertical-align:top">${esc(r.t)}<span style="color:#A2A099;font-size:12px"> · ${esc(TYPE_LABEL[r.k] || '')}</span></td>
</tr>`).join('')}
${rest > 0 ? `<tr><td colspan="3" style="padding:8px 0;color:#A2A099;font-size:12.5px">…還有 ${rest} 項</td></tr>` : ''}
</table>`;
}

/**
 * Cron 進入點：掃出「已開啟提醒、今天還沒寄過、且真的有東西要說」的使用者並寄信。
 *
 * **沒有逾期、也沒有即將到期就完全不寄。** 每天一封「你今天沒事」的信只會訓練
 * 收件者忽略這個寄件人，真的有事時反而看不到。加了事前提醒之後這條更重要，
 * 不是更不重要——會觸發寄信的條件變寬了，那個「沒事就閉嘴」的閘門就更要守住。
 *
 * 提前幾天由每個人自己的 lead_days 決定，0 代表只在逾期時通知（原本的行為）。
 */
export async function sendOverdueReminders(env, nowMs = Date.now()) {
  const today = taipeiYmd(nowMs);
  const rows = await env.DB.prepare(
    `SELECT r.user_id, r.digest, r.last_sent_ymd, r.lead_days, u.email, u.status
       FROM reminder_feed r JOIN users u ON u.id = r.user_id
      WHERE r.enabled = 1`
  ).all();

  const out = { checked: 0, sent: 0, skipped: 0, failed: 0 };
  for (const row of rows.results || []) {
    out.checked++;
    // 停用中的帳號不該繼續收到信
    if (row.status !== 'approved') { out.skipped++; continue; }
    // 同一天不重寄：cron 可能重試，重試不該變成第二封
    if (row.last_sent_ymd === today) { out.skipped++; continue; }

    let digest = [];
    try { digest = JSON.parse(row.digest); } catch { digest = []; }
    const overdue = pickOverdue(digest, today);
    const upcoming = pickUpcoming(digest, today,
      row.lead_days == null ? DEFAULT_LEAD_DAYS : row.lead_days);
    if (!overdue.length && !upcoming.length) { out.skipped++; continue; }

    try {
      await sendMail(env, row.email,
        buildReminderEmail(overdue, upcoming, today, env.APP_URL || ''));
      await env.DB.prepare('UPDATE reminder_feed SET last_sent_ymd = ? WHERE user_id = ?')
        .bind(today, row.user_id).run();
      out.sent++;
    } catch (e) {
      // 一個人寄失敗不該讓整批停下來。也刻意不記 last_sent_ymd：
      // 沒寄成功就不算寄過，下一次排程會再試。
      console.warn('reminder send failed', row.user_id, String(e));
      out.failed++;
    }
  }
  return out;
}
