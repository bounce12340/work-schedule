/**
 * 排程的版本歷史：擁有者那一側（第三批 3A）。列版本、跟現在比、退回、每日留存。
 *
 * 規則：
 *   - 所有查詢都帶 WHERE user_id = ?（路徑上的版本 id 只是定位，不是授權）——別人的版本 id 一律 404
 *   - **不要求 Pro**：Pro 到期之後那是使用者自己的資料（同日誌）。到期只是「停止留新版」，舊的照 30 天自然過期
 *   - **退回是一次新的寫入，不是把歷史倒帶**：先把現在這一份留成一版（force：不看方案），再用樂觀鎖寫入舊的那一份。
 *     所以退回本身也退得回去；你其他裝置上還沒同步的修改，會照平常的三方合併處理（它看到的是「雲端變了」）
 *   - 內容放在 R2：索引在、檔案不在（過期被清、R2 出事）要說得出來，不是 500
 */
import { json } from './auth.js';
import { planOf } from '../plan.js';
import { casWrite, readState, ymdTaipei } from '../mcp/store.js';
import * as S from '../mcp/schedule.js';
import {
  takeVersion, pruneVersions, latestVersionAt, readVersionBody, diffStates, USER_VERSION_GAP_MS,
} from '../mcp/history.js';

const ymdStartMs = ymd => Date.parse(ymd + 'T00:00:00+08:00');

/** GET /api/history/versions：新的在前。只回索引，不回內容。 */
export async function handleListVersions(env, user) {
  const rows = await env.DB.prepare(
    'SELECT id, created_at, actor, summary, bytes FROM state_versions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 300'
  ).bind(user.id).all();
  return json({
    configured: !!env.BACKUPS,
    versions: (rows.results || []).map(r => ({ id: r.id, createdAt: r.created_at, actor: r.actor, summary: r.summary, bytes: r.bytes })),
  });
}

async function loadVersion(env, user, id) {
  const row = await env.DB.prepare('SELECT id, created_at, actor, summary FROM state_versions WHERE id = ? AND user_id = ?').bind(id, user.id).first();
  if (!row) return { error: json({ error: '找不到這個版本' }, 404) };
  let body = null;
  try { body = await readVersionBody(env, user.id, id); } catch (e) { console.error('state version read failed', id, e?.stack || String(e)); }
  if (!body) return { error: json({ error: '這個版本的內容已經不在了（可能已過期被清掉）' }, 410) };
  let state;
  try { state = JSON.parse(body); } catch { return { error: json({ error: '這個版本的內容壞掉了，無法比較或退回' }, 410) }; }
  return { row, state };
}

/** GET /api/history/versions/:id/diff：那一版 → 現在，差在哪（before＝那一版的值、after＝現在的值）。 */
export async function handleDiffVersion(env, user, id) {
  const v = await loadVersion(env, user, id);
  if (v.error) return v.error;
  const { state } = await readState(env, user.id);
  const d = diffStates(v.state, state);
  return json({ version: { id: v.row.id, createdAt: v.row.created_at, actor: v.row.actor, summary: v.row.summary }, ...d });
}

/** POST /api/history/versions/:id/restore */
export async function handleRestoreVersion(env, user, id) {
  const v = await loadVersion(env, user, id);
  if (v.error) return v.error;
  const when = new Date(v.row.created_at + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  try {
    await casWrite(env, user, () => ({ state: v.state }), {
      version: { actor: 'user', force: true, summary: () => `退回到 ${when} 的版本之前` },
    });
  } catch (e) {
    if (e instanceof S.ToolError) return json({ error: e.message }, 409);
    throw e;
  }
  return json({ ok: true });
}

/**
 * 使用者自己的寫入（PUT /api/state 成功之後）：最多每小時留一版，只有 Pro 留。
 * 留的是**剛寫進去的這一份**（時間點的快照）；要的是「每小時一個點」，不是每次同步一版。
 * 失敗永遠只出聲（takeVersion 自己吞掉），不影響那次同步。
 */
export async function maybeUserVersion(env, user, serialized, nowMs = Date.now()) {
  if (!env.BACKUPS || planOf(user, nowMs) !== 'pro') return;
  try {
    if (nowMs - await latestVersionAt(env, user.id) < USER_VERSION_GAP_MS) return;
    await takeVersion(env, user.id, serialized, { actor: 'user', summary: '自動留存（每小時）', nowMs });
  } catch (e) { console.warn('user version check failed', e?.message || String(e)); }
}

/**
 * 每日 cron：①每個 Pro 帳號今天（台北）還沒有版本就留一版（「每天至少一版」）②清掉所有帳號過期與超量的。
 * 回傳含 errors[]：留不下來的帳號不能讓這一步被記成乾淨的成功（同 sendOverdueReminders）。
 */
export async function snapshotDaily(env, nowMs = Date.now()) {
  if (!env.BACKUPS) return { skipped: 'BACKUPS 未綁定', taken: 0, pruned: 0, errors: [] };
  const today = ymdStartMs(ymdTaipei(nowMs));
  const rows = await env.DB.prepare(
    `SELECT s.user_id, s.state, u.plan_source, u.plan_expires_at, u.status
       FROM user_state s JOIN users u ON u.id = s.user_id`
  ).all();
  const out = { checked: 0, taken: 0, skipped: 0, pruned: 0, errors: [] };
  for (const r of rows.results || []) {
    out.checked++;
    if (r.status !== 'approved' || planOf(r, nowMs) !== 'pro') { out.skipped++; continue; }
    if (await latestVersionAt(env, r.user_id) >= today) { out.skipped++; continue; }
    const v = await takeVersion(env, r.user_id, r.state, { actor: 'system', summary: '每日留存', nowMs });
    if (v && v.id) out.taken++;
    else if (v && v.same) out.skipped++;          // 內容跟最新一版相同：正常，不是錯誤
    else out.errors.push({ userId: r.user_id, error: '留不下來' });
  }
  const owners = await env.DB.prepare('SELECT DISTINCT user_id FROM state_versions').all();
  for (const o of owners.results || []) out.pruned += await pruneVersions(env, o.user_id, nowMs);
  return out;
}

