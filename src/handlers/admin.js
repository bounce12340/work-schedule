import { json, adminEmails } from './auth.js';
import { hashPassword, generateToken } from '../crypto.js';
import { destroyAllSessions } from '../session.js';
import { logAdminAction } from './backup.js';
import { planInfo } from '../plan.js';

const VALID_STATUS = ['pending', 'approved', 'rejected', 'suspended'];
const VALID_ROLE = ['user', 'admin'];

/**
 * 使用者清單。刻意只回傳帳號欄位，不含任何排程內容——
 * 管理者的職權範圍是帳號管理，不是看別人的資料。
 *
 * `configAdmin` 標出 ADMIN_EMAILS 名單內的帳號。**它不是新的權限，是把既有的
 * 權限說出來**：那四個操作（停用、降級、重設密碼、刪除）本來就會被擋，但擋在
 * 按下去之後的 403，於是管理者按了、看到紅字、以為系統壞了——實際踩過一次，
 * 當時的結論是「去 Cloudflare 把 email 從名單拿掉」，而那條路正是 tools/
 * reset-password.mjs 的檔頭寫著的地雷（拿掉之後忘記加回去，保護就永遠沒了）。
 *
 * 把這件事寫在畫面上，那一次就不會發生。列出來不算洩漏：這張清單只有管理者
 * 看得到，而名單內的帳號本來就已經顯示為 admin。
 */
export async function handleListUsers(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, email, role, status, created_at, approved_at, plan_source, plan_expires_at
       FROM users
      ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`
  ).all();
  const pinned = adminEmails(env);
  return json({
    users: (results || []).map(r => ({ ...withPlan(r), configAdmin: pinned.includes(r.email) })),
  });
}

/** 方案以算好的 plan 回給管理頁，不讓前端自己重算到期與寬限。 */
function withPlan(row) {
  const { plan_source, plan_expires_at, ...rest } = row;
  return { ...rest, ...planInfo(row) };
}

/**
 * 方案的手動設定：{ source: 'admin' | null, expiresAt: number | null }。
 *   source null            → 免費
 *   'admin' + expiresAt null → Pro 永久（既有的兩個帳號就是這樣設的）
 *   'admin' + expiresAt     → Pro 到那一天
 * 回 null 代表 body 裡沒有 plan；回 { error } 代表格式不對。
 */
function parsePlan(body) {
  if (body.plan === undefined) return null;
  const p = body.plan;
  if (p === null || typeof p !== 'object') return { error: '方案格式不正確' };
  if (p.source !== null && p.source !== 'admin') return { error: '方案來源只能是 admin 或 null' };
  if (p.expiresAt !== null && p.expiresAt !== undefined && !Number.isFinite(p.expiresAt)) {
    return { error: '到期日不正確' };
  }
  if (p.source === null) return { source: null, expiresAt: null };
  return { source: 'admin', expiresAt: p.expiresAt == null ? null : Math.floor(p.expiresAt) };
}

function describePlan(source, expiresAt) {
  if (!source) return 'free';
  if (expiresAt == null) return 'pro（永久）';
  return `pro（至 ${new Date(expiresAt).toISOString().slice(0, 10)}）`;
}

export async function handleUpdateUser(request, env, actingUser, targetId) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '請求格式錯誤' }, 400); }

  const target = await env.DB
    .prepare('SELECT id, email, role, status, plan_source, plan_expires_at FROM users WHERE id = ?')
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
  const nextPlan = parsePlan(body);
  if (nextPlan && nextPlan.error) return json({ error: nextPlan.error }, 400);

  // 底下兩道保險只管角色與狀態：方案是「給東西」，不是停用也不是降級，
  // 而且既有的兩個永久帳號正是 ADMIN_EMAILS 名單內的那兩個、其中一個就是操作者本人。
  const touchesAccount = nextStatus !== undefined || nextRole !== undefined;

  // 不能改自己：避免管理者手滑把自己降級或停用，導致沒有人能再管理系統
  if (touchesAccount && target.id === actingUser.id) {
    return json({ error: '不能變更自己的角色或狀態' }, 400);
  }

  // ADMIN_EMAILS 名單內的帳號是系統的最後保險，不允許從介面停用或降級
  if (touchesAccount && adminEmails(env).includes(target.email)) {
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
  if (nextPlan) {
    sets.push('plan_source = ?', 'plan_expires_at = ?');
    binds.push(nextPlan.source, nextPlan.expiresAt);
  }
  if (!sets.length) return json({ error: '沒有要變更的欄位' }, 400);

  binds.push(targetId);
  await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();

  // 一旦不再是 approved，既有 session 必須立刻失效，否則對方在下次重新登入前
  // 都還能繼續使用——停用等於形同虛設
  if (nextStatus !== undefined && nextStatus !== 'approved') {
    await destroyAllSessions(env, targetId);
  }

  // 描述由伺服器依實際的前後值產生，不採用前端送來的字串——讓操作者自己決定
  // 記錄要寫什麼，記錄就沒有意義了。理由與 share_activity 相同。
  const changes = [];
  if (nextStatus !== undefined && nextStatus !== target.status) {
    changes.push(`狀態 ${target.status} → ${nextStatus}`);
  }
  if (nextRole !== undefined && nextRole !== target.role) {
    changes.push(`角色 ${target.role} → ${nextRole}`);
  }
  if (nextPlan) {
    const before = describePlan(target.plan_source, target.plan_expires_at);
    const after = describePlan(nextPlan.source, nextPlan.expiresAt);
    if (before !== after) changes.push(`方案 ${before} → ${after}`);
  }
  if (changes.length) await logAdminAction(env, actingUser, target, changes.join('、'));

  const updated = await env.DB
    .prepare('SELECT id, email, role, status, created_at, approved_at, plan_source, plan_expires_at FROM users WHERE id = ?')
    .bind(targetId).first();
  return json({ ok: true, user: withPlan(updated) });
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
  await logAdminAction(env, actingUser, target, '重設密碼（所有裝置已登出）');

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

  // 先記錄再刪除：刪完之後 target 的 email 就沒有地方可以讀了，而「當時刪掉的是誰」
  // 正是這種記錄最需要回答的問題
  await logAdminAction(env, actingUser, target, '刪除帳號（含其雲端排程資料）');

  await destroyAllSessions(env, targetId);
  await env.DB.prepare('DELETE FROM user_state WHERE user_id = ?').bind(targetId).run();
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(targetId).run();
  return json({ ok: true });
}

/**
 * 管理者操作記錄。任何管理者都看得到全部——這種記錄的用途就是互相監督，
 * 只讓自己看自己做過什麼等於沒有記錄。
 */
export async function handleAdminActivity(env) {
  const { results } = await env.DB.prepare(
    `SELECT actor_email, target_email, action, created_at
       FROM admin_activity ORDER BY created_at DESC LIMIT 200`
  ).all();
  return json({ activity: results || [] });
}
