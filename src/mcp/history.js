/**
 * 排程的版本歷史（第三批 3A，設計文件「甲 2」）：留版本、清舊版、整個清掉、兩份 state 的比較。
 *
 * 存哪裡：整份 state 放 R2（`BACKUPS` 儲存桶的 `history/<userId>/<id>.json`），D1 的
 * `state_versions` 只存索引。整份 state 放 D1 會讓它變成最大的一張表。每日備份只碰 `backup/`
 * 這個 prefix，所以歷史不會被備份帶走，備份的輪替也不會刪到歷史。
 *
 * 這個檔案是**低層**：只碰 D1 與 R2，不 import store.js（store.js 的 casWrite 要用它，
 * 反過來引用會繞成環）。「退回」那種要走樂觀鎖的動作在 handlers/history.js。
 *
 * 不能拿掉的判斷：
 *   - **留版本失敗永遠只 console.warn，不讓寫入變成錯誤。** 版本是安全網，不是寫入的一部分；
 *     R2 掛掉就讓 agent 寫不進去，等於安全網把人絆倒。同 mcp_activity／share_activity。
 *   - **沒綁 R2（env.BACKUPS）就安靜略過**——正式環境一定有（wrangler.jsonc），測試環境多半沒有。
 *     綁了卻寫失敗才會出聲。
 *   - **與最新一版內容相同就不留**（sha）：agent 的空寫入、每日留存、退回之後再退回，都不該灌版本數
 *     （上限 300 版，灌滿了真正有用的舊版會被擠掉）。
 *   - **先寫 R2、再寫索引**：反過來的話索引指向一個不存在的檔案，使用者按「退回」才發現。
 *     索引寫失敗只會留下一個沒人指到的檔案（刪帳號時整個 prefix 會清掉）。
 *   - **所有查詢都帶 user_id**：版本 id 只是定位，不是授權。
 */
import { sha256 } from '../crypto.js';
import { stableStringify } from './schedule.js';

export const VERSION_KEEP_MS = 30 * 24 * 3600 * 1000;
export const VERSION_MAX_PER_USER = 300;
/** 使用者自己的修改最多每小時留一版。 */
export const USER_VERSION_GAP_MS = 3600 * 1000;
const PREFIX = 'history/';

export const versionPrefix = userId => `${PREFIX}${userId}/`;
export const versionKey = (userId, id) => `${PREFIX}${userId}/${id}.json`;
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);

/**
 * 把一份 state（原文字串）留成一版。回 { id }（留了）、{ id:null, same:true }（跟最新一版相同，不重複留）或 null（沒綁 R2／失敗）。
 * rawState 一律用資料庫裡的原文，不重新序列化：留下來的要與當時寫在那裡的一個位元都不差。
 */
export async function takeVersion(env, userId, rawState, { actor, summary, nowMs = Date.now() }) {
  if (!env.BACKUPS || typeof rawState !== 'string' || !rawState) return null;
  try {
    const sha = await sha256(rawState);
    const last = await env.DB.prepare(
      'SELECT sha FROM state_versions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
    ).bind(userId).first();
    if (last && last.sha === sha) return { id: null, same: true };
    const id = crypto.randomUUID();
    await env.BACKUPS.put(versionKey(userId, id), rawState, { httpMetadata: { contentType: 'application/json' } });
    await env.DB.prepare(
      'INSERT INTO state_versions (id, user_id, created_at, actor, summary, bytes, sha) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, userId, nowMs, clip(actor, 60) || 'system', clip(summary, 200), rawState.length, sha).run();
    await pruneVersions(env, userId, nowMs);
    return { id };
  } catch (e) {
    console.warn('state version failed — 這一版沒有留下來', userId, e?.stack || String(e));
    return null;
  }
}

/**
 * 清這個帳號過期的與超過 300 版的（最舊的先走）。R2 的檔案先刪、索引後刪：
 * 檔案刪失敗就留著那一列，下次再清（反過來會留下永遠沒人清的檔案）。
 */
export async function pruneVersions(env, userId, nowMs = Date.now()) {
  if (!env.BACKUPS) return 0;
  const doomed = await env.DB.prepare(
    `SELECT id FROM state_versions
      WHERE user_id = ? AND (created_at < ? OR id NOT IN (
        SELECT id FROM state_versions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?))`
  ).bind(userId, nowMs - VERSION_KEEP_MS, userId, VERSION_MAX_PER_USER).all();
  let n = 0;
  for (const r of doomed.results || []) {
    try {
      await env.BACKUPS.delete(versionKey(userId, r.id));
      await env.DB.prepare('DELETE FROM state_versions WHERE id = ? AND user_id = ?').bind(r.id, userId).run();
      n++;
    } catch (e) { console.warn('state version prune failed', r.id, e?.message || String(e)); }
  }
  return n;
}

/** 這個帳號最新一版的時間（沒有就 0）。 */
export async function latestVersionAt(env, userId) {
  const r = await env.DB.prepare('SELECT MAX(created_at) AS t FROM state_versions WHERE user_id = ?').bind(userId).first();
  return r?.t || 0;
}

/** 刪帳號：R2 的整個 prefix 與索引都清掉。R2 失敗只出聲（索引照刪），回刪了幾個檔。 */
export async function deleteAllVersions(env, userId) {
  let removed = 0;
  if (env.BACKUPS) {
    try {
      let cursor;
      for (let guard = 0; guard < 50; guard++) {
        const page = await env.BACKUPS.list({ prefix: versionPrefix(userId), limit: 500, ...(cursor ? { cursor } : {}) });
        for (const o of page.objects || []) { await env.BACKUPS.delete(o.key); removed++; }
        if (!page.truncated) break;
        cursor = page.cursor;
      }
    } catch (e) { console.error('state history R2 cleanup failed — 這個帳號的歷史檔案可能還留著', userId, e?.stack || String(e)); }
  }
  await env.DB.prepare('DELETE FROM state_versions WHERE user_id = ?').bind(userId).run();
  return removed;
}

/** 讀一版的內容（R2 原文）。檔案不在了回 null。 */
export async function readVersionBody(env, userId, id) {
  if (!env.BACKUPS) return null;
  const obj = await env.BACKUPS.get(versionKey(userId, id));
  if (!obj) return null;
  return typeof obj.text === 'function' ? obj.text() : String(obj.body ?? '');
}

// ------------------------------------------------------------ 比較（以「東西」為單位）

const MAX_DIFF_ROWS = 300;
const shortVal = v => {
  if (v === undefined || v === null) return null;
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  return t.length > 200 ? t.slice(0, 200) + '…' : t;
};
const same = (a, b) => stableStringify(a ?? null) === stableStringify(b ?? null);
const byId = list => new Map((Array.isArray(list) ? list : []).filter(x => x && x.id != null).map(x => [x.id, x]));

function fieldRows(entity, id, name, a, b, skip = []) {
  const rows = [];
  const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].filter(k => !skip.includes(k)).sort();
  for (const k of keys) {
    if (!same((a || {})[k], (b || {})[k])) rows.push({ entity, id, name, field: k, before: shortVal((a || {})[k]), after: shortVal((b || {})[k]) });
  }
  return rows;
}

function diffList(entity, listA, listB, nameOf, rows, skip = [], children = null) {
  const A = byId(listA), B = byId(listB);
  for (const [id, a] of A) {
    const b = B.get(id);
    if (!b) { rows.push({ entity, id, name: nameOf(a), field: '（刪除）', before: nameOf(a), after: null }); continue; }
    rows.push(...fieldRows(entity, id, nameOf(b), a, b, skip));
    if (children) children(id, a, b, rows);
  }
  for (const [id, b] of B) if (!A.has(id)) rows.push({ entity, id, name: nameOf(b), field: '（新增）', before: null, after: nameOf(b) });
}

/**
 * 兩份 state 差在哪，以「東西」為單位（項目、大項目、甘特專案、任務、每日記錄、其餘設定）：
 * `{ entity, id, name, field, before, after }`。before 是 a（那一版）的值、after 是 b（現在）的值。
 * 用 stableStringify 比，不做文字 diff：鍵的順序不同不算差異。上限 300 列。
 */
export function diffStates(a, b) {
  a = a && typeof a === 'object' ? a : {};
  b = b && typeof b === 'object' ? b : {};
  const rows = [];
  diffList('item', a.items, b.items, x => String(x.title ?? ''), rows);
  diffList('majorProject', a.majorProjects, b.majorProjects, x => String(x.name ?? ''), rows);
  diffList('ganttProject', a.ganttProjects, b.ganttProjects, x => String(x.name ?? ''), rows, ['tasks'], (gpId, gpa, gpb, out) => {
    const tasksA = byId(gpa.tasks), tasksB = byId(gpb.tasks);
    for (const [tid, ta] of tasksA) {
      const tb = tasksB.get(tid);
      const label = `${gpb.name}／`;
      if (!tb) { out.push({ entity: 'ganttTask', id: `${gpId}/${tid}`, name: label + String(ta.name ?? ''), field: '（刪除）', before: String(ta.name ?? ''), after: null }); continue; }
      out.push(...fieldRows('ganttTask', `${gpId}/${tid}`, label + String(tb.name ?? ''), ta, tb));
    }
    for (const [tid, tb] of tasksB) if (!tasksA.has(tid)) out.push({ entity: 'ganttTask', id: `${gpId}/${tid}`, name: `${gpb.name}／${tb.name ?? ''}`, field: '（新增）', before: null, after: String(tb.name ?? '') });
  });
  // 每日記錄：ymd → HTML
  const la = a.dailyLogs && typeof a.dailyLogs === 'object' ? a.dailyLogs : {};
  const lb = b.dailyLogs && typeof b.dailyLogs === 'object' ? b.dailyLogs : {};
  for (const ymd of [...new Set([...Object.keys(la), ...Object.keys(lb)])].sort()) {
    if (!same(la[ymd], lb[ymd])) rows.push({ entity: 'dailyLog', id: ymd, name: ymd, field: '內容', before: shortVal(la[ymd]), after: shortVal(lb[ymd]) });
  }
  // 其餘頂層設定（假日、補班日、不在／休假…）
  const known = new Set(['items', 'majorProjects', 'ganttProjects', 'dailyLogs', 'version']);
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => !known.has(k)).sort()) {
    if (!same(a[k], b[k])) rows.push({ entity: 'setting', id: k, name: k, field: k, before: shortVal(a[k]), after: shortVal(b[k]) });
  }
  return { rows: rows.slice(0, MAX_DIFF_ROWS), total: rows.length, truncated: rows.length > MAX_DIFF_ROWS };
}
