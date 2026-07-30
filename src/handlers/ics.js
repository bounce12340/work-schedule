import { json } from './auth.js';
import { generateToken, sha256 } from '../crypto.js';

/**
 * 行事曆訂閱（ICS feed）。
 *
 * 內容由前端產生、同步時推上來，這裡只保存與供應。occurrence 引擎（含假日
 * 順延）只存在於前端單檔內，在 Worker 重新實作一份等於維護兩套必然分歧的
 * 邏輯；而且順延規則本來就無法用 RRULE 表達，展開成靜態事件才是正確的。
 *
 * token 是唯讀憑證：知道 URL 就能看到排程標題。因此 DB 只存雜湊、URL 只在
 * 產生當下回傳一次；重新產生會讓舊 URL 立即失效。
 */

const MAX_ICS_BYTES = 512_000;

export async function handleIcsStatus(env, user) {
  const row = await env.DB.prepare('SELECT updated_at FROM ics_feed WHERE user_id = ?')
    .bind(user.id).first();
  return json({ enabled: !!row, updatedAt: row ? row.updated_at : null });
}

/** 建立或重新產生 token。重新產生＝舊連結立即失效（URL 外流時的自救手段）。 */
export async function handleIcsEnable(request, env, user) {
  const token = generateToken();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO ics_feed (user_id, token_hash, ics, updated_at) VALUES (?, ?, '', ?)
     ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, updated_at = excluded.updated_at`
  ).bind(user.id, await sha256(token), now).run();

  const origin = new URL(request.url).origin;
  return json({ ok: true, url: `${origin}/ics/${token}` });
}

export async function handleIcsDisable(env, user) {
  await env.DB.prepare('DELETE FROM ics_feed WHERE user_id = ?').bind(user.id).run();
  return json({ ok: true });
}

/** 前端在每次成功同步後把展開好的 ICS 推上來 */
export async function handleIcsPut(request, env, user) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '請求格式錯誤' }, 400); }
  const ics = String(body?.ics || '');
  if (!ics.startsWith('BEGIN:VCALENDAR')) return json({ error: '不是有效的 ICS 內容' }, 400);
  if (ics.length > MAX_ICS_BYTES) return json({ error: 'ICS 內容過大' }, 413);

  const r = await env.DB.prepare(
    'UPDATE ics_feed SET ics = ?, updated_at = ? WHERE user_id = ?'
  ).bind(ics, Date.now(), user.id).run();
  // 未啟用訂閱時的推送不是錯誤：靜默忽略即可，前端不必先查狀態再推
  return json({ ok: true, stored: (r.meta?.changes || 0) > 0 });
}

/** 公開端點：行事曆軟體以 token 取得 feed。token 即憑證，不看 session。 */
export async function handleIcsFeed(env, token) {
  const row = await env.DB.prepare('SELECT ics FROM ics_feed WHERE token_hash = ?')
    .bind(await sha256(token)).first();
  if (!row || !row.ics) {
    return new Response('Not found', { status: 404 });
  }
  return new Response(row.ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      // 行事曆軟體輪詢頻率不一，短快取避免壓力又不至於太舊
      'Cache-Control': 'private, max-age=300'
    }
  });
}
