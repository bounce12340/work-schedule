import { json, adminEmails } from './auth.js';
import { hashPassword, generateToken } from '../crypto.js';
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

/**
 * 管理者重設密碼：產生一次性臨時密碼，只在回應中出現一次，之後無從再查。
 *
 * 沒有這條路徑的話，使用者忘記密碼＝帳號報廢——連管理者都救不了，只能刪帳號
 * 重註冊，雲端排程資料就跟著消失。不做 email 寄信重設是刻意的：系統沒有寄信
 * 基礎設施，臨時密碼由管理者透過既有的聯絡管道轉交即可。
 *
 * 不能重設自己（自己用改密碼），也不能重設 ADMIN_EMAILS 名單內的帳號——
 * 重設密碼等於接管帳號，最後保險不能有這個洞。
 */
export async function handleResetPassword(env, actingUser, targetId) {
  const target = await env.DB
    .prepare('SELECT id, email FROM users WHERE id = ?').bind(targetId).first();
  if (!target) return json({ error: '找不到這個帳號' }, 404);
  if (target.id === actingUser.id) return json({ error: '請改用「變更密碼」功能' }, 400);
  if (adminEmails(env).includes(target.email)) {
    return json({ error: '這是設定檔指定的管理者，無法重設其密碼' }, 403);
  }

  // 12 碼、去掉易混淆字元。generateToken 的熵遠超需求，取前段即可
  const tempPassword = generateToken().replace(/[-_]/g, '').slice(0, 12);
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(await hashPassword(tempPassword), targetId).run();
  await destroyAllSessions(env, targetId);

  return json({ ok: true, tempPassword, email: target.email });
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
