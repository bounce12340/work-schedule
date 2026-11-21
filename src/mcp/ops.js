/**
 * 寫入工具的「狀態變更」：每一個都是純函式 (state, args, ctx) => { state, changes[] }。
 *
 * 為什麼單獨一個檔案：同一份邏輯有三個呼叫端——
 *   1. direct 模式：工具直接執行
 *   2. review 模式：工具先**乾跑**一次驗證參數（行不通就當場回錯，不留一份套不上去的提案）
 *   3. 同意提案：在**當下的資料**上把存下來的 ops 依序重新套一次
 * 三處共用同一張表，規則只有一份（同 applyItemFields：新增與修改共用）。
 * 存進提案的是「要做什麼」（tool＋args），不是算好的結果——同意的當下資料可能已經變了，
 * 存結果的話同意＝把這段時間使用者自己的修改蓋掉。
 */
import * as S from './schedule.js';

const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && k in o).map(k => [k, o[k]]));
// events：要寫進進展日誌的系統紀錄（例如預測改了）；notices：給呼叫的 agent 的提醒。兩者都不是 state 的一部分
const one = r => ({ state: r.state, changes: [r.change], ...(r.events ? { events: r.events } : {}), ...(r.notices ? { notices: r.notices } : {}) });

/** 會改 user_state 的工具。review 模式下它們不寫入、改成長出提案。 */
export const STATE_OPS = {
  create_item: (st, a) => one(S.createItem(st, pick(a, S.ITEM_KEYS))),
  update_item: (st, a) => one(S.updateItem(st, a.itemId, pick(a, S.ITEM_KEYS))),
  set_done: (st, a, c) => one(S.setDone(st, a.itemId, a.occurrenceKey, !!a.done, c.now)),
  delete_item: (st, a) => one(S.deleteItem(st, a.itemId)),
  create_major_project: (st, a) => one(S.createMajorProject(st, a.name)),
  create_gantt_project: (st, a) => one(S.createGanttProject(st, a.name)),
  add_gantt_task: (st, a) => one(S.addGanttTask(st, a.projectId, pick(a, ['name', 'start', 'end']))),
  update_gantt_task: (st, a, c) => one(S.updateGanttTask(st, a.projectId, a.taskId,
    pick(a, ['name', 'start', 'end', 'progress', 'done', 'status', 'blockedNote', 'links']), c)),
  upsert_task_todo: (st, a, c) => one(S.upsertTaskTodo(st, a.projectId, a.taskId, pick(a, ['todoId', 'text', 'done']), c)),
  // 第二批。set_task_estimate 的白名單**沒有 start／end**：結構上就碰不到計畫日期
  set_task_estimate: (st, a, c) => one(S.setTaskEstimate(st, a.projectId, a.taskId, pick(a, ['estimateHours', 'actualHours', 'forecastEnd']), c)),
  upsert_milestone: (st, a, c) => one(S.upsertMilestone(st, a.projectId, pick(a, ['id', 'name', 'date', 'remove']), c)),
  claim_task: (st, a, c) => one(S.claimTask(st, a.projectId, a.taskId, pick(a, ['release']), c)),
  write_daily_log: (st, a, c) => one(S.writeDailyLog(st, a.text, c.today)),
};

export const STATE_OP_NAMES = Object.keys(STATE_OPS);

/** 某一個操作套不上去：帶著是第幾個、哪個工具，同意提案時回給使用者（整份不套，並說出是哪一個）。 */
export class OpError extends S.ToolError {
  constructor(index, tool, message) {
    super(`第 ${index + 1} 個操作（${tool}）套不上去：${message}`);
    this.index = index; this.tool = tool; this.reason = message;
  }
}

/** 依序在同一份 state 上套 ops；任何一個丟 ToolError 就整批丟出（呼叫端什麼都不寫）。 */
export function applyOps(state, ops, ctx) {
  let st = state;
  const changes = [], events = [], notices = [];
  ops.forEach((op, i) => {
    const def = STATE_OPS[op.tool];
    if (!def) throw new OpError(i, op.tool, '不認得這個工具');
    try {
      const r = def(st, op.args || {}, ctx);
      st = r.state;
      for (const c of r.changes) changes.push({ ...c, tool: op.tool });
      if (r.events) events.push(...r.events);
      if (r.notices) notices.push(...r.notices);
    } catch (e) {
      if (e instanceof S.ToolError && !(e instanceof OpError)) throw new OpError(i, op.tool, e.message);
      throw e;
    }
  });
  return { state: st, changes, events, notices };
}
