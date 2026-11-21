/**
 * agent 工作區的「擁有者那一側」：「我的帳號」頁與專案頁呼叫的 HTTP 端點（cookie session）。
 *
 * 規則（設計文件 docs/superpowers/specs/2026-11-21-agent-workspace.md）：
 *   - 所有查詢都帶 WHERE user_id = ?（路徑上的 id 只是定位，不是授權）
 *   - 讀日誌、回答問題、處理提案**不要求 Pro**（Pro 到期之後那是使用者自己的資料，同「降級不刪資料」）
 *   - 日誌只能加：沒有改、沒有刪——擁有者只有「遮蔽」（body 清空、留下骨架）
 *   - 遮蔽是擁有者專屬，agent 沒有這個工具（能自己遮的話「不能改」就沒有意義了）
 */
import { json } from './auth.js';
import { planOf } from '../plan.js';
import * as S from '../mcp/schedule.js';
import {
  readState, casWrite, insertEvent, ownerEventView, listOpenProposals, approveProposal, rejectProposal,
  OpError, StoreError, EVENT_MAX_BODY,
} from '../mcp/store.js';

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}
const cleanText = v => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim();

function fromError(e) {
  if (e instanceof OpError) return json({ error: e.message, status: 'stale', failingOp: { index: e.index, tool: e.tool, reason: e.reason } }, 409);
  if (e instanceof StoreError) return json({ error: e.message }, e.status);
  if (e instanceof S.ToolError) return json({ error: e.message }, 409);
  throw e;
}

// ------------------------------------------------------------ 連線設定

/** 路徑上的 id 可以是「我的帳號」頁列表上看到的那個（token 那一列），也可以直接是連線 id。回連線 id 或 null。 */
async function resolveConnId(env, user, id) {
  const tok = await env.DB.prepare('SELECT id, grant_id FROM mcp_tokens WHERE id = ? AND user_id = ?').bind(id, user.id).first();
  if (tok) return tok.grant_id || tok.id;
  const conn = await env.DB.prepare('SELECT id FROM mcp_connections WHERE id = ? AND user_id = ?').bind(id, user.id).first();
  return conn ? conn.id : null;
}

/** POST /api/mcp/connections/:id/settings { mode?, paused?, needsAcceptance? } */
export async function handleConnectionSettings(request, env, user, id) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return json({ error: '格式錯誤' }, 400);
  const connId = await resolveConnId(env, user, id);
  if (!connId) return json({ error: '找不到這個連線' }, 404);
  if ('mode' in body && !['direct', 'review'].includes(body.mode)) return json({ error: 'mode 只能是 direct 或 review' }, 400);
  for (const k of ['paused', 'needsAcceptance']) if (k in body && typeof body[k] !== 'boolean') return json({ error: `${k} 要是 true 或 false` }, 400);
  const now = Date.now();
  // 沒有設定列的舊連線（查不到＝被當成暫停）：擁有者在這裡設定時補一列，等於給他一條修好的路
  await env.DB.prepare(
    `INSERT OR IGNORE INTO mcp_connections (id, user_id, mode, paused, needs_acceptance, created_at, updated_at)
     VALUES (?, ?, 'direct', 0, 0, ?, ?)`
  ).bind(connId, user.id, now, now).run();
  // 欄位名是程式裡寫死的白名單，不是使用者送來的字串
  const sets = [], binds = [];
  if ('mode' in body) { sets.push('mode = ?'); binds.push(body.mode); }
  if ('needsAcceptance' in body) { sets.push('needs_acceptance = ?'); binds.push(body.needsAcceptance ? 1 : 0); }
  if ('paused' in body) { sets.push('paused = ?', 'paused_reason = ?'); binds.push(body.paused ? 1 : 0, body.paused ? 'owner' : null); }
  if (sets.length) {
    await env.DB.prepare(`UPDATE mcp_connections SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND user_id = ?`)
      .bind(...binds, now, connId, user.id).run();
  }
  const row = await env.DB.prepare('SELECT * FROM mcp_connections WHERE id = ? AND user_id = ?').bind(connId, user.id).first();
  return json({ ok: true, connection: { id: row.id, mode: row.mode, paused: !!row.paused, needsAcceptance: !!row.needs_acceptance, pausedReason: row.paused_reason || null } });
}

/** POST /api/mcp/pause-all { paused }：緊急煞車。暫停不是撤銷，恢復之後不用重新授權。 */
export async function handlePauseAll(request, env, user) {
  const body = await readJson(request);
  if (!body || typeof body.paused !== 'boolean') return json({ error: 'paused 要是 true 或 false' }, 400);
  const r = await env.DB.prepare('UPDATE mcp_connections SET paused = ?, paused_reason = ?, updated_at = ? WHERE user_id = ?')
    .bind(body.paused ? 1 : 0, body.paused ? 'owner' : null, Date.now(), user.id).run();
  return json({ ok: true, paused: body.paused, connections: r.meta?.changes ?? 0 });
}

// ------------------------------------------------------------ 提案

export async function handleListProposals(env, user) {
  return json({ proposals: await listOpenProposals(env, user) });
}

export async function handleApproveProposal(env, user, id) {
  try {
    const r = await approveProposal(env, user, id);
    return json({ ok: true, changeIds: r.changeIds, changes: r.changes.length, held: r.held });
  } catch (e) { return fromError(e); }
}

export async function handleRejectProposal(request, env, user, id) {
  const body = await readJson(request);
  try {
    await rejectProposal(env, user, id, body && body.note);
    return json({ ok: true });
  } catch (e) { return fromError(e); }
}

// ------------------------------------------------------------ 進展日誌、提問

/** GET /api/projects/:pid/events：專案已經不在 state 裡時不顯示（留著 30 天，救回來的專案日誌還在）。 */
export async function handleProjectEvents(env, user, projectId, url) {
  const { state } = await readState(env, user.id);
  const present = !!(state && (state.ganttProjects || []).some(g => g.id === projectId));
  if (!present) return json({ events: [], projectMissing: true });
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit')) || 50));
  const rows = await env.DB.prepare(
    'SELECT * FROM project_events WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
  ).bind(user.id, projectId, limit).all();
  return json({ events: (rows.results || []).map(ownerEventView) });
}

/** GET /api/agent/inbox：要使用者動手的事——等你回覆的問題、等你審的提案、等你驗收的任務。 */
export async function handleAgentInbox(env, user) {
  const { state } = await readState(env, user.id);
  const projects = new Map(((state && state.ganttProjects) || []).map(g => [g.id, g]));
  const qs = await env.DB.prepare(
    "SELECT * FROM project_events WHERE user_id = ? AND kind = 'question' AND status = 'open' ORDER BY created_at, rowid"
  ).bind(user.id).all();
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const questions = (qs.results || []).filter(r => projects.has(r.project_id)).map(r => {
    const gp = projects.get(r.project_id);
    const task = r.task_id ? (gp.tasks || []).find(t => t.id === r.task_id) : null;
    return { ...ownerEventView(r), projectName: gp.name, taskName: task ? task.name : null, pastDeadline: !!(r.default_after && r.default_after < today) };
  });
  const review = [];
  for (const gp of projects.values()) {
    for (const t of gp.tasks || []) {
      if (t.status === 'review' && !S.effectiveDone(t)) {
        review.push({ projectId: gp.id, projectName: gp.name, taskId: t.id, taskName: t.name,
          todosInReview: (t.todos || []).filter(td => td.review && !td.done).map(td => ({ id: td.id, text: td.text })) });
      }
    }
  }
  return json({
    questions, review, proposals: await listOpenProposals(env, user),
    // Pro 到期之後：留著、你可以回答，只是 agent 連不進來（回答它要等回來才讀得到）
    agentAvailable: planOf(user) === 'pro',
  });
}

/**
 * POST /api/projects/events/:id/answer { body }：回答一個問題。
 * 寫一筆 answer，再自動多寫一筆 decision（問題＋答案的快照，三個月後「當初為什麼這樣做」查得到）。
 * **不改任務的狀態**：回答了不代表 agent 已經讀到，waiting 由 agent 讀到答案後自己改回 doing。
 */
export async function handleAnswerEvent(request, env, user, id) {
  const body = await readJson(request);
  const text = cleanText(body && body.body);
  if (!text) return json({ error: '請寫下你的回答' }, 400);
  if (text.length > EVENT_MAX_BODY) return json({ error: `回答最多 ${EVENT_MAX_BODY} 字` }, 400);
  const q = await env.DB.prepare("SELECT * FROM project_events WHERE id = ? AND user_id = ? AND kind = 'question'").bind(id, user.id).first();
  if (!q) return json({ error: '找不到這個問題' }, 404);
  // 先領走（單句帶條件的 UPDATE）：兩個裝置同時回答，只有一個領得到
  const claim = await env.DB.prepare("UPDATE project_events SET status = 'answered' WHERE id = ? AND user_id = ? AND kind = 'question' AND status = 'open'")
    .bind(id, user.id).run();
  if (claim.meta?.changes !== 1) return json({ error: '這個問題已經不是「等你回覆」的狀態了（已回答，或 agent 已經撤回）' }, 409);
  const now = Date.now();
  const answerId = await insertEvent(env, { userId: user.id, projectId: q.project_id, taskId: q.task_id, kind: 'answer', actor: 'user', body: text, refId: q.id, createdAt: now });
  const qText = q.redacted_at ? '（問題內容已被遮蔽）' : q.body;
  await insertEvent(env, {
    userId: user.id, projectId: q.project_id, taskId: q.task_id, kind: 'decision', actor: 'user', refId: q.id, createdAt: now,
    body: `問題：${qText}\n決定：${text}`,
  });
  return json({ ok: true, answerId });
}

/** POST /api/projects/events/:id/redact：遮掉一筆（body 清空，骨架留著）。只有擁有者能做。 */
export async function handleRedactEvent(env, user, id) {
  const r = await env.DB.prepare('UPDATE project_events SET body = ?, options = NULL, redacted_at = ? WHERE id = ? AND user_id = ? AND redacted_at IS NULL')
    .bind('', Date.now(), id, user.id).run();
  if (r.meta?.changes !== 1) return json({ error: '找不到這一筆，或已經遮蔽過了' }, 404);
  return json({ ok: true });
}

// ------------------------------------------------------------ 開著的頁面要跟上（設計文件第二次檢討 15）

/**
 * GET /api/state/version → { updatedAt, latestEventAt }：一個很小的端點，只回兩個數字，
 * 前端在專案頁／項目安排看得見的時候每 30 秒問一次，變了才真的拉（agent 改了資料、寫了日誌）。
 *
 * - updatedAt：user_state 的版本號（前端拿它跟自己知道的 cloudUpdatedAt 比）
 * - latestEventAt：agent 那一側最新的動靜——**不是使用者自己的**（actor != 'user'：回答、驗收、退回
 *   是使用者自己做的，用它們觸發「agent 剛更新了」會是自己打自己），而且把新提案也算進去
 *   （提案不改 state 也不寫日誌，不算進去的話「等你回覆」會等到下次回前景才更新）。
 * 只回數字，不回任何內容；永遠只看自己的列（WHERE user_id = ?）。
 */
export async function handleStateVersion(env, user) {
  const [st, ev, pr] = await Promise.all([
    env.DB.prepare('SELECT updated_at FROM user_state WHERE user_id = ?').bind(user.id).first(),
    env.DB.prepare("SELECT MAX(created_at) AS t FROM project_events WHERE user_id = ? AND actor != 'user'").bind(user.id).first(),
    env.DB.prepare('SELECT MAX(created_at) AS t FROM mcp_proposals WHERE user_id = ?').bind(user.id).first(),
  ]);
  const latest = Math.max(ev?.t || 0, pr?.t || 0);
  return json({ updatedAt: st ? st.updated_at : null, latestEventAt: latest || null });
}

/**
 * GET /api/agent/events/export：「匯出備份檔」那一欄要的——這個帳號全部的進展日誌（擁有者的檢視：
 * 被遮蔽的內容是空的）。**只讀、只回自己的**。上限 5000 筆（舊→新）：日誌每天每專案 200 筆封頂，
 * 這個上限只是不讓一個失控的帳號把匯出撐爆。
 */
export async function handleAgentEventsExport(env, user) {
  const rows = await env.DB.prepare(
    'SELECT * FROM project_events WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 5000'
  ).bind(user.id).all();
  const events = (rows.results || []).map(ownerEventView).reverse();
  return json({ events });
}

// ------------------------------------------------------------ 驗收

/** POST /api/projects/:pid/tasks/:tid/accept：驗收通過，才真的完成。擁有者自己的寫入，不進 agent 的修改紀錄。 */
export async function handleAcceptTask(env, user, projectId, taskId) {
  try {
    const r = await casWrite(env, user, state => S.acceptTask(state, projectId, taskId));
    await insertEvent(env, { userId: user.id, projectId, taskId, kind: 'progress', actor: 'user', body: `驗收通過：「${r.taskName}」` })
      .catch(e => console.warn('accept event write failed', e?.message || String(e)));
    return json({ ok: true });
  } catch (e) { return fromError(e); }
}

/** POST /api/projects/:pid/tasks/:tid/reject { reason }：退回，理由寫進日誌（agent 下次開工會讀到）。 */
export async function handleRejectTask(request, env, user, projectId, taskId) {
  const body = await readJson(request);
  const reason = cleanText(body && body.reason);
  if (!reason) return json({ error: '請寫下退回的理由（agent 要靠它知道哪裡不對）' }, 400);
  if (reason.length > EVENT_MAX_BODY) return json({ error: `理由最多 ${EVENT_MAX_BODY} 字` }, 400);
  try {
    const r = await casWrite(env, user, state => S.rejectTask(state, projectId, taskId));
    await insertEvent(env, { userId: user.id, projectId, taskId, kind: 'progress', actor: 'user', body: `退回「${r.taskName}」：${reason}` })
      .catch(e => console.warn('reject event write failed', e?.message || String(e)));
    return json({ ok: true });
  } catch (e) { return fromError(e); }
}

// ------------------------------------------------------------ 每日 cron：清掉消失太久的專案的日誌

const ABSENT_KEEP_MS = 30 * 24 * 3600 * 1000;
const PROPOSAL_KEEP_MS = 90 * 24 * 3600 * 1000;

/**
 * 專案不在使用者的 state 裡超過 30 天，它的日誌才清掉（刪除有 6 秒復原、三方合併可能救回來、
 * 之後還有版本歷史可以退回——一看到專案不見就刪日誌的話，救回來的專案是空的）。
 * 「消失多久」記在 project_absent：每天跑一次，專案在 → 刪掉那一列；不在 → 補一列（只補不覆蓋）。
 * **讀不到、解析不了某個使用者的 state 時整個跳過他**：把「讀不到」當成「專案不見了」會讓一次
 * 資料庫的小故障變成 30 天後的資料遺失。順手把決定過超過 90 天的提案清掉（同其他日誌表的保留）。
 */
export async function purgeAgentData(env, nowMs = Date.now()) {
  const pairs = await env.DB.prepare('SELECT DISTINCT user_id, project_id FROM project_events').all();
  const byUser = new Map();
  for (const r of pairs.results || []) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r.project_id);
  }
  let marked = 0, cleared = 0, purged = 0, skippedUsers = 0;
  for (const [userId, projectIds] of byUser) {
    let present;
    try {
      const row = await env.DB.prepare('SELECT state FROM user_state WHERE user_id = ?').bind(userId).first();
      const st = row ? JSON.parse(row.state) : null;
      if (!st || !Array.isArray(st.ganttProjects)) { skippedUsers++; continue; }
      present = new Set(st.ganttProjects.map(g => g && g.id));
    } catch (e) {
      console.warn('agent purge: 讀不到 state，跳過', userId, e?.message || String(e));
      skippedUsers++;
      continue;
    }
    for (const pid of projectIds) {
      if (present.has(pid)) {
        const d = await env.DB.prepare('DELETE FROM project_absent WHERE user_id = ? AND project_id = ?').bind(userId, pid).run();
        cleared += d.meta?.changes ?? 0;
        continue;
      }
      const ins = await env.DB.prepare('INSERT OR IGNORE INTO project_absent (user_id, project_id, missing_since) VALUES (?, ?, ?)')
        .bind(userId, pid, nowMs).run();
      marked += ins.meta?.changes ?? 0;
      const row = await env.DB.prepare('SELECT missing_since FROM project_absent WHERE user_id = ? AND project_id = ?').bind(userId, pid).first();
      if (row && row.missing_since < nowMs - ABSENT_KEEP_MS) {
        const d = await env.DB.prepare('DELETE FROM project_events WHERE user_id = ? AND project_id = ?').bind(userId, pid).run();
        purged += d.meta?.changes ?? 0;
        await env.DB.prepare('DELETE FROM project_absent WHERE user_id = ? AND project_id = ?').bind(userId, pid).run();
      }
    }
  }
  const props = await env.DB.prepare("DELETE FROM mcp_proposals WHERE status != 'open' AND decided_at IS NOT NULL AND decided_at < ?")
    .bind(nowMs - PROPOSAL_KEEP_MS).run();
  return { projectsChecked: [...byUser.values()].reduce((n, a) => n + a.length, 0), marked, cleared, eventsPurged: purged, skippedUsers, proposalsPurged: props.meta?.changes ?? 0 };
}
