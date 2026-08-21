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

export async function handleReminderStatus(env, user) {
  const row = await env.DB
    .prepare('SELECT enabled, last_sent_ymd, updated_at FROM reminder_feed WHERE user_id = ?')
    .bind(user.id).first();
  return json({
    enabled: !!(row && row.enabled),
    lastSent: row ? row.last_sent_ymd : null,
    updatedAt: row ? row.updated_at : null,
    email: user.email
  });
}

export async function handleReminderEnable(request, env, user) {
  let body = {};
  try { body = await request.json(); } catch { /* 沒有 body 就當成開啟 */ }
  const enabled = body && body.enabled === false ? 0 : 1;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO reminder_feed (user_id, enabled, digest, updated_at) VALUES (?, ?, '[]', ?)
     ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
  ).bind(user.id, enabled, now).run();
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
  // 只更新內容，不動 enabled——推送是同步的副作用，不該把使用者關掉的提醒打開
  await env.DB.prepare(
    `INSERT INTO reminder_feed (user_id, enabled, digest, updated_at) VALUES (?, 0, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET digest = excluded.digest, updated_at = excluded.updated_at`
  ).bind(user.id, serialized, now).run();
  return json({ ok: true, count: digest.length });
}

const TYPE_LABEL = { work: '工作項目', meeting: '會議安排', assignment: '作業' };

export function buildReminderEmail(rows, todayYmd, appUrl) {
  const shown = rows.slice(0, MAX_LISTED);
  const rest = rows.length - shown.length;
  const esc = s => String(s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const daysLate = d => Math.round((Date.parse(todayYmd) - Date.parse(d)) / 86400000);

  const textLines = shown.map(r => `・${r.d}（逾期 ${daysLate(r.d)} 天）  ${r.t}`);
  if (rest > 0) textLines.push(`・…還有 ${rest} 項`);

  const text = [
    `你有 ${rows.length} 個逾期未完成的項目：`, '',
    ...textLines, '',
    appUrl ? `開啟系統：${appUrl}` : '',
    '', '— 工作排程確認系統'
  ].filter(l => l !== undefined).join('\n');

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.7;color:#2A2A26">
<p style="margin:0 0 14px">你有 <b style="color:#C0392B">${rows.length}</b> 個逾期未完成的項目：</p>
<table style="border-collapse:collapse;width:100%;max-width:560px">
${shown.map(r => `<tr>
<td style="padding:6px 10px 6px 0;white-space:nowrap;font-family:ui-monospace,monospace;font-size:12px;color:#C0392B;vertical-align:top">${esc(r.d)}</td>
<td style="padding:6px 10px 6px 0;white-space:nowrap;font-size:12px;color:#71706A;vertical-align:top">逾期 ${daysLate(r.d)} 天</td>
<td style="padding:6px 0;vertical-align:top">${esc(r.t)}<span style="color:#A2A099;font-size:12px"> · ${esc(TYPE_LABEL[r.k] || '')}</span></td>
</tr>`).join('')}
${rest > 0 ? `<tr><td colspan="3" style="padding:8px 0;color:#A2A099;font-size:12.5px">…還有 ${rest} 項</td></tr>` : ''}
</table>
${appUrl ? `<p style="margin:18px 0 0"><a href="${esc(appUrl)}" style="color:#C9822E">開啟工作排程確認系統 →</a></p>` : ''}
<p style="margin:22px 0 0;color:#A2A099;font-size:12px">這封信只在有逾期項目時寄出。要停止接收，可在系統內關閉逾期提醒。</p>
</div>`;

  return { subject: `【逾期提醒】${rows.length} 個項目已過期`, text, html };
}

/**
 * Cron 進入點：掃出「已開啟提醒、今天還沒寄過、且真的有逾期項目」的使用者並寄信。
 *
 * 沒有逾期就完全不寄——使用者明確選了這個行為。每天一封「你沒有逾期項目」的信
 * 只會訓練收件者忽略這個寄件人，真的有事時反而看不到。
 */
export async function sendOverdueReminders(env, nowMs = Date.now()) {
  const today = taipeiYmd(nowMs);
  const rows = await env.DB.prepare(
    `SELECT r.user_id, r.digest, r.last_sent_ymd, u.email, u.status
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
    if (!overdue.length) { out.skipped++; continue; }

    try {
      await sendMail(env, row.email, buildReminderEmail(overdue, today, env.APP_URL || ''));
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
