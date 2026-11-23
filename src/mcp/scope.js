/**
 * 權限分級的鑰匙（第三批 3A）：每一把金鑰／OAuth 連線可以是
 *   - scope 'read'：只能讀。**WRITE_TOOLS 裡的每一個工具都擋**（含預演：讀取鑰匙不碰任何寫入工具，沒有例外）
 *   - project_id 不為空：只能碰那一個甘特專案
 *
 * 檢查每一次 `tools/call` 都做（同 Pro 檢查、同暫停）：撤銷之外的第三種煞車，而且不必等 token 換新。
 * 既有的金鑰與連線 scope 預設 'write'、沒有 project_id＝行為與以前完全相同（migration 的預設值）。
 *
 * 專案範圍的規則（「不確定就擋」）：
 *   - 帶 projectId 的工具：projectId 必須就是那一個專案
 *   - apply_changes／propose_changes：**每一個**操作都必須是專案內的工具、而且 projectId 相符
 *   - 沒有專案概念的工具（項目、大項目、每日記錄、建立專案、排程、修改紀錄、復原）：**整個擋掉**。
 *     項目不屬於任何甘特專案，放行就等於讓一把「只能碰這個專案」的鑰匙讀到別的東西；
 *     修改紀錄與復原跨專案（summary 裡有別的專案的名字），所以也擋
 *   - 讀整個專案清單的 get_overview／list_gantt_projects：不擋，但回應**只剩那一個專案**（filterForScope）
 *   - unlink_pr：用 prId 查那一列屬於哪個專案；查不到就放行讓原本的「找不到」處理（不洩漏別人的 PR 存不存在）
 */

/** 專案範圍內可以用的工具。其餘一律擋。 */
export const PROJECT_TOOLS = new Set([
  'get_project_brief', 'list_project_events', 'add_project_event', 'list_project_prs', 'upsert_pr', 'unlink_pr',
  'add_gantt_task', 'update_gantt_task', 'upsert_task_todo', 'set_task_estimate', 'upsert_milestone', 'claim_task',
  // 清單類：回應會被濾成只剩那個專案
  'get_overview', 'list_gantt_projects',
  // 提案／批次：每一個操作另外檢查；withdraw 只能撤自己這條連線提的案（本來就是）
  'apply_changes', 'propose_changes', 'withdraw_proposal',
]);

/** 批次／提案裡的操作可以是哪些工具（專案內、而且帶 projectId）。 */
const OP_TOOLS = new Set(['add_gantt_task', 'update_gantt_task', 'upsert_task_todo', 'set_task_estimate', 'upsert_milestone', 'claim_task']);

const OUT = '這把鑰匙只能碰指定的那一個專案，不能做這件事。';

/**
 * 回 null（放行）或一句給 agent 看的拒絕原因。
 * writeTools 由呼叫端傳入（server.js 的 WRITE_TOOLS）：寫在這裡另存一份遲早走鐘，測試斷言「讀取鑰匙擋掉的集合＝WRITE_TOOLS」。
 */
export async function checkScope(env, auth, name, args, writeTools) {
  const scope = auth.scope === 'read' ? 'read' : 'write';
  if (scope === 'read' && writeTools.has(name)) return '這是一把「只能讀」的鑰匙，不能呼叫會寫入的工具（日誌、提問、提案、復原也一樣）。';
  const pid = auth.projectId || null;
  if (!pid) return null;
  if (!PROJECT_TOOLS.has(name)) return OUT;
  const a = args || {};
  if (name === 'get_overview' || name === 'list_gantt_projects' || name === 'withdraw_proposal') return null;
  if (name === 'apply_changes' || name === 'propose_changes') {
    const ops = Array.isArray(a.ops) ? a.ops : [];
    for (const op of ops) {
      if (!op || !OP_TOOLS.has(op.tool) || !op.args || op.args.projectId !== pid) return OUT;
    }
    return null;
  }
  if (name === 'unlink_pr') {
    const row = await env.DB.prepare('SELECT project_id FROM project_prs WHERE id = ? AND user_id = ?')
      .bind(String(a.prId || ''), auth.user.id).first();
    return row && row.project_id !== pid ? OUT : null;
  }
  return a.projectId === pid ? null : OUT;
}

/** 專案範圍的鑰匙：總覽與專案清單只回它那一個專案（其餘看不到存在）。 */
export function filterForScope(auth, name, out) {
  const pid = auth.projectId || null;
  if (!pid || !out || typeof out !== 'object') return out;
  if (name === 'get_overview') {
    return { ...out, majorProjects: [], itemCount: 0, ganttProjects: (out.ganttProjects || []).filter(g => g.id === pid) };
  }
  if (name === 'list_gantt_projects') return { ...out, projects: (out.projects || []).filter(g => g.id === pid) };
  return out;
}
