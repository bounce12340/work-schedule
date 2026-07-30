import { json } from './auth.js';
import { uuid } from '../crypto.js';

/**
 * 跨帳號分享。
 *
 * 設計上只分享「指標」不複製內容：資源本身永遠只有一份，存在擁有者的
 * user_state JSON 裡。若改成複製一份到對方帳號，兩邊會立刻各自漂移，
 * 而分享的語意就是雙方看的是同一個東西。
 *
 * 代價是被分享者的讀寫都必須繞到擁有者那一列去：
 *   讀 → 從擁有者的 state 取出該資源
 *   寫 → 只換掉擁有者 state 裡的那一個元素，其餘原樣寫回
 * 這讓寫入的影響範圍縮到單一資源，不會像整包覆蓋那樣波及擁有者的其他資料。
 */

const KINDS = { item: 'items', gantt: 'ganttProjects' };
const PERMISSIONS = ['view', 'edit'];

function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}

/** 從整包 state 取出單一資源。找不到回 null（資源可能已被擁有者刪除） */
function findResource(state, kind, resourceId) {
  const listKey = KINDS[kind];
  if (!listKey || !state || !Array.isArray(state[listKey])) return null;
  return state[listKey].find(r => r && r.id === resourceId) || null;
}

async function loadState(env, userId) {
  const row = await env.DB
    .prepare('SELECT state, updated_at FROM user_state WHERE user_id = ?')
    .bind(userId).first();
  if (!row) return null;
  try {
    return { state: JSON.parse(row.state), updatedAt: row.updated_at };
  } catch {
    return null;   // 損毀的資料當作沒有，不讓它連累分享功能
  }
}

/**
 * 我分享出去的 + 別人分享給我的。
 *
 * outgoing 不附資源內容：擁有者的前端本來就有自己的完整資料，用 resource_id
 * 在本地解析名稱即可，沒必要讓伺服器再算一次。
 */
export async function handleListShares(env, user) {
  const outgoing = await env.DB.prepare(
    `SELECT s.id, s.resource_kind, s.resource_id, s.permission, s.created_at, u.email AS target_email
       FROM shares s JOIN users u ON u.id = s.target_id
      WHERE s.owner_id = ?
      ORDER BY s.created_at DESC`
  ).bind(user.id).all();

  const incoming = await env.DB.prepare(
    `SELECT s.id, s.resource_kind, s.resource_id, s.permission, s.created_at,
            s.owner_id, u.email AS owner_email
       FROM shares s JOIN users u ON u.id = s.owner_id
      WHERE s.target_id = ?
      ORDER BY s.created_at DESC`
  ).bind(user.id).all();

  // 逐位擁有者只讀一次 state，避免同一人分享多筆時重複查詢
  const cache = new Map();
  const items = [];
  for (const row of incoming.results || []) {
    if (!cache.has(row.owner_id)) cache.set(row.owner_id, await loadState(env, row.owner_id));
    const owned = cache.get(row.owner_id);
    const resource = owned ? findResource(owned.state, row.resource_kind, row.resource_id) : null;
    items.push({
      id: row.id,
      kind: row.resource_kind,
      permission: row.permission,
      ownerEmail: row.owner_email,
      // 擁有者刪掉資源後分享列仍在，這裡回 null 讓前端顯示「已被移除」而不是憑空消失
      resource
    });
  }

  return json({
    outgoing: (outgoing.results || []).map(r => ({
      id: r.id, kind: r.resource_kind, resourceId: r.resource_id,
      permission: r.permission, targetEmail: r.target_email
    })),
    incoming: items
  });
}

export async function handleCreateShare(request, env, user) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '請求格式錯誤' }, 400); }

  const kind = String(body?.kind || '');
  const resourceId = String(body?.resourceId || '');
  const permission = String(body?.permission || '');
  const email = normalizeEmail(body?.email);

  if (!KINDS[kind]) return json({ error: '不支援的分享類型' }, 400);
  if (!resourceId) return json({ error: '缺少項目識別碼' }, 400);
  if (!PERMISSIONS.includes(permission)) return json({ error: '權限必須是 view 或 edit' }, 400);
  if (!email) return json({ error: '請輸入對方的帳號 email' }, 400);
  if (email === user.email) return json({ error: '不需要分享給自己' }, 400);

  const target = await env.DB
    .prepare('SELECT id, email, status FROM users WHERE email = ?')
    .bind(email).first();
  // 對方帳號存不存在本來就查得出來（分享一定要指名對象），這裡不必模糊化
  if (!target) return json({ error: '找不到這個帳號，請確認對方已註冊' }, 404);
  if (target.status !== 'approved') return json({ error: '這個帳號尚未通過管理者核准' }, 400);

  // 確認資源真的存在，否則會留下永遠解析不到的孤兒分享
  const owned = await loadState(env, user.id);
  if (!owned) return json({ error: '你的資料尚未同步到雲端，請稍候再試' }, 409);
  const resource = findResource(owned.state, kind, resourceId);
  if (!resource) return json({ error: '找不到要分享的項目' }, 404);

  await env.DB.prepare(
    `INSERT INTO shares (id, owner_id, target_id, resource_kind, resource_id, permission, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, resource_kind, resource_id, target_id)
     DO UPDATE SET permission = excluded.permission`
  ).bind(uuid(), user.id, target.id, kind, resourceId, permission, Date.now()).run();

  return json({ ok: true, targetEmail: target.email, permission });
}

/**
 * 取消分享。擁有者可以收回，被分享者也可以自行移除——後者只是把別人推給他的
 * 東西從自己的畫面拿掉，不影響擁有者的資料，沒有理由不讓他做。
 */
export async function handleDeleteShare(env, user, shareId) {
  const row = await env.DB
    .prepare('SELECT owner_id, target_id FROM shares WHERE id = ?')
    .bind(shareId).first();
  if (!row) return json({ error: '找不到這筆分享' }, 404);
  if (row.owner_id !== user.id && row.target_id !== user.id) {
    return json({ error: '沒有權限' }, 403);
  }
  await env.DB.prepare('DELETE FROM shares WHERE id = ?').bind(shareId).run();
  return json({ ok: true });
}

/**
 * 被分享者寫回擁有者的資料。
 *
 * 只換掉 state 裡的那一個元素，其他一律原樣保留——這是「別人能改我的東西」
 * 這件事可以被接受的前提：影響範圍限於他被授權的那一個資源。
 *
 * 另外驗證送回來的 id 與分享指定的一致，避免有人拿一張合法的分享單去改
 * 擁有者的其他資源。
 */
export async function handleUpdateShared(request, env, user, shareId) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '請求格式錯誤' }, 400); }
  const resource = body?.resource;
  if (!resource || typeof resource !== 'object') return json({ error: '缺少資料' }, 400);

  const share = await env.DB
    .prepare('SELECT owner_id, target_id, resource_kind, resource_id, permission FROM shares WHERE id = ?')
    .bind(shareId).first();
  if (!share) return json({ error: '找不到這筆分享' }, 404);
  if (share.target_id !== user.id) return json({ error: '沒有權限' }, 403);
  if (share.permission !== 'edit') return json({ error: '你只有檢視權限' }, 403);
  if (resource.id !== share.resource_id) return json({ error: '資料與分享對象不符' }, 400);

  const owned = await loadState(env, share.owner_id);
  if (!owned) return json({ error: '擁有者的資料已不存在' }, 404);

  const listKey = KINDS[share.resource_kind];
  const list = Array.isArray(owned.state[listKey]) ? owned.state[listKey] : null;
  if (!list) return json({ error: '擁有者的資料格式不符' }, 409);
  const idx = list.findIndex(r => r && r.id === share.resource_id);
  if (idx < 0) return json({ error: '這個項目已被擁有者刪除' }, 404);

  list[idx] = resource;
  const now = Date.now();
  await env.DB
    .prepare('UPDATE user_state SET state = ?, updated_at = ? WHERE user_id = ?')
    .bind(JSON.stringify(owned.state), now, share.owner_id)
    .run();

  return json({ ok: true, updatedAt: now });
}
