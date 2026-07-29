import { json, adminEmails } from './auth.js';
import { destroyAllSessions } from '../session.js';

const VALID_STATUS = ['pending', 'approved', 'rejected', 'suspended'];
const VALID_ROLE = ['user', 'admin'];

/**
 * 使用者清單。刻意只回傳帳號欄位，不含任何排程內容——
 * 管理者的職權範圍是帳號管理，不是看別人的資料。
 */
export async function handleListUsers(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, email, role, status, created_at, approved_at
       FROM users
      ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`
  ).all();
  return json({ users: results || [] });
}

export async function handleUpdateUser(request, env, actingUser, targetId) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '請求格式錯誤' }, 400); }

  const target = await env.DB
    .prepare('SELECT id, email, role, status FROM users WHERE id = ?')
    .bind(targetId).first();
  if (!target) return json({ error: '找不到這個帳號' }, 404);

  const nextStatus = body.status;
  const nextRole = body.role;
  if (nextStatus !== undefined && !VALID_STATUS.includes(nextStatus)) {
    return json({ error: '狀態值不正確' }, 400);
  }
  if (nextRole !== undefined && !VALID_ROLE.includes(nextRole)) {
    return json({ error: '角色值不正確' }, 400);
  }

  // 不能改自己：避免管理者手滑把自己降級或停用，導致沒有人能再管理系統
  if (target.id === actingUser.id) {
    return json({ error: '不能變更自己的角色或狀態' }, 400);
  }

  // ADMIN_EMAILS 名單內的帳號是系統的最後保險，不允許從介面停用或降級
  if (adminEmails(env).includes(target.email)) {
    return json({ error: '這是設定檔指定的管理者，無法從介面變更' }, 403);
  }

  const sets = [];
  const binds = [];
  if (nextStatus !== undefined) {
    sets.push('status = ?'); binds.push(nextStatus);
    if (nextStatus === 'approved' && target.status !== 'approved') {
      sets.push('approved_at = ?', 'approved_by = ?');
      binds.push(Date.now(), actingUser.id);
    }
  }
  if (nextRole !== undefined) { sets.push('role = ?'); binds.push(nextRole); }
  if (!sets.length) return json({ error: '沒有要變更的欄位' }, 400);

  binds.push(targetId);
  await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();

  // 一旦不再是 approved，既有 session 必須立刻失效，否則對方在下次重新登入前
  // 都還能繼續使用——停用等於形同虛設
  if (nextStatus !== undefined && nextStatus !== 'approved') {
    await destroyAllSessions(env, targetId);
  }

  const updated = await env.DB
    .prepare('SELECT id, email, role, status, created_at, approved_at FROM users WHERE id = ?')
    .bind(targetId).first();
  return json({ ok: true, user: updated });
}

export async function handleDeleteUser(env, actingUser, targetId) {
  const target = await env.DB
    .prepare('SELECT id, email FROM users WHERE id = ?').bind(targetId).first();
  if (!target) return json({ error: '找不到這個帳號' }, 404);
  if (target.id === actingUser.id) return json({ error: '不能刪除自己' }, 400);
  if (adminEmails(env).includes(target.email)) {
    return json({ error: '這是設定檔指定的管理者，無法刪除' }, 403);
  }

  await destroyAllSessions(env, targetId);
  await env.DB.prepare('DELETE FROM user_state WHERE user_id = ?').bind(targetId).run();
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(targetId).run();
  return json({ ok: true });
}
