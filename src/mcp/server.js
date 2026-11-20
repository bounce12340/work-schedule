/**
 * MCP 伺服器（Streamable HTTP，無狀態）：POST /mcp 收一則 JSON-RPC，回一則 JSON。
 *
 * 不引任何套件（同 Worker 其他部分）：MCP 在這個形狀下就是 initialize／tools/list／
 * tools/call 三個方法，自己寫比帶一整套 SDK 進來好審。
 *
 * 寫入規則（使用者的裁決：agent 可以直接改，但每一筆都留紀錄、可以復原）：
 *   - 只有 Pro 能用（每一次呼叫都重新判斷：訂閱到期的那一刻起金鑰就不能用）
 *   - 每一筆寫入都記一列 mcp_activity（誰、哪個工具、改了哪一個、改前改後）
 *   - 寫回 user_state 用帶條件的單句 UPDATE（同〈樂觀鎖必須是單句 SQL〉），撞到就重讀重算
 *   - 使用者開著的網頁／app 下一次同步會撞 409，走既有的三方合併：只有 agent 改了
 *     那一項，就自動採用，不會跳衝突對話框
 */
import { json } from '../handlers/auth.js';
import { planOf, exceedsPlanCap } from '../plan.js';
import { authenticateMcp, origin } from './auth.js';
import * as S from './schedule.js';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_WRITES_PER_DAY = 500;
const ACTIVITY_KEEP_MS = 90 * 24 * 3600 * 1000;
const MAX_STATE_BYTES = 1_000_000;

const ymdTaipei = (ms = Date.now()) => new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
};

export function mcpPreflight() {
  return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Max-Age': '86400' } });
}

// ------------------------------------------------------------ 工具定義

const itemFields = {
  title: { type: 'string', description: '標題（最多 200 字）' },
  date: { type: 'string', description: '日期 YYYY-MM-DD（循環項目是第一次的日期）' },
  type: { type: 'string', enum: S.TYPES, description: 'work＝工作、meeting＝會議、assignment＝作業' },
  endDate: { type: ['string', 'null'], description: '跨多天事項的結束日 YYYY-MM-DD（只限不循環的項目）' },
  meetingTime: { type: ['string', 'null'], description: '時間 HH:MM（24 小時制）' },
  majorProjectId: { type: ['string', 'null'], description: '歸在哪一個大項目底下（get_overview 查得到 id）' },
  link: { type: ['string', 'null'], description: '相關連結（http/https）' },
  noticeOnly: { type: 'boolean', description: '純告知：只是提醒有這件事，不需要做、不會逾期' },
  tags: { type: 'array', items: { type: 'string' } },
  recurrence: {
    type: ['object', 'null'],
    description: '循環規則；null＝不循環。freq：weekly／biweekly 用 weekdays（0＝週日…6＝週六）；monthly 用 day（每月幾號），或 mode="nthWeekday" 加 nth（1～5，-1＝最後一個）與 weekday；quarterly／yearly 用 date 的那一天。holidayRule：none／postpone（遇假日延後）／advance（提前）。until（YYYY-MM-DD）或 count（次數）擇一可選',
    properties: {
      freq: { type: 'string', enum: ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'] },
      day: { type: 'integer' }, weekdays: { type: 'array', items: { type: 'integer' } },
      mode: { type: 'string', enum: ['day', 'nthWeekday'] }, nth: { type: 'integer' }, weekday: { type: 'integer' },
      holidayRule: { type: 'string', enum: ['none', 'postpone', 'advance'] },
      until: { type: 'string' }, count: { type: 'integer' },
    },
  },
};

const TOOLS = [
  {
    name: 'get_overview',
    description: '先呼叫這個：列出所有大項目與甘特專案（含 id）、項目總數、今天的日期（台北時間）與排程資料的更新時間。',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_items',
    description: '列出項目（排程的「定義」：日期、循環規則）。要看某一段時間實際有哪些事、哪些逾期，用 get_schedule。',
    inputSchema: { type: 'object', properties: {
      majorProjectId: { type: 'string' }, type: { type: 'string', enum: S.TYPES },
      query: { type: 'string', description: '標題關鍵字' }, limit: { type: 'integer', description: '最多幾筆（預設 100，上限 200）' },
    } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_schedule',
    description: '某段日期內實際要做的每一件事（循環項目已展開、假日已順延），含是否完成、是否逾期，以及勾完成要用的 itemId／occurrenceKey。資料是使用者上一次打開 app 或網頁時算好的（範圍：過去一年到未來三個月）。',
    inputSchema: { type: 'object', required: ['from', 'to'], properties: {
      from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD（最多 92 天）' },
      includeDone: { type: 'boolean', description: '也列出已完成的（預設不列）' },
    } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_item',
    description: '新增一個項目。',
    inputSchema: { type: 'object', required: ['title', 'date'], properties: itemFields },
  },
  {
    name: 'update_item',
    description: '修改一個項目，只改有給的欄位。注意：改循環頻率會清掉這個項目過去的完成紀錄（格式不同，留著會對不上）。',
    inputSchema: { type: 'object', required: ['itemId'], properties: { itemId: { type: 'string' }, ...itemFields } },
  },
  {
    name: 'set_done',
    description: '勾選或取消完成。循環項目要帶 occurrenceKey（從 get_schedule 拿）；不循環的不用帶。',
    inputSchema: { type: 'object', required: ['itemId', 'done'], properties: {
      itemId: { type: 'string' }, occurrenceKey: { type: 'string' }, done: { type: 'boolean' },
    } },
  },
  {
    name: 'delete_item',
    description: '刪除一個項目（會留下紀錄，使用者或你都可以用 undo_change 救回來）。',
    inputSchema: { type: 'object', required: ['itemId'], properties: { itemId: { type: 'string' } } },
    annotations: { destructiveHint: true },
  },
  {
    name: 'create_major_project',
    description: '新增一個大項目（分類用的標籤，項目可以歸在底下）。',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  },
  {
    name: 'list_gantt_projects',
    description: '列出甘特專案與它們的任務（含進度、子項目）。',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add_gantt_task',
    description: '在甘特專案裡新增一個任務。',
    inputSchema: { type: 'object', required: ['projectId', 'name', 'start', 'end'], properties: {
      projectId: { type: 'string' }, name: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
    } },
  },
  {
    name: 'update_gantt_task',
    description: '修改甘特任務的名稱、日期或進度（有子項目的任務，進度由子項目決定，不能直接改）。',
    inputSchema: { type: 'object', required: ['projectId', 'taskId'], properties: {
      projectId: { type: 'string' }, taskId: { type: 'string' }, name: { type: 'string' },
      start: { type: 'string' }, end: { type: 'string' }, progress: { type: 'integer', description: '0～100' }, done: { type: 'boolean' },
    } },
  },
  {
    name: 'list_recent_changes',
    description: '列出 agent 最近做過的修改（含 changeId），可以拿來 undo_change。',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', description: '預設 20，上限 50' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'undo_change',
    description: '把一筆 agent 做過的修改倒回去。若那一項之後又被改過，為了不蓋掉後來的修改，不會動它。',
    inputSchema: { type: 'object', required: ['changeId'], properties: { changeId: { type: 'string' } } },
  },
];

const INSTRUCTIONS = [
  '這是使用者的「工作排程確認系統」：項目（工作／會議／作業，可循環）、大項目（分類）、甘特專案。',
  '先呼叫 get_overview。看「這段時間要做什麼、哪些逾期」用 get_schedule；改項目本身用 list_items 找 id。',
  '你做的每一個修改都會記錄下來，使用者可以在「我的帳號」裡一鍵復原；改錯了也可以自己用 undo_change。',
  '逾期就是逾期：不要為了讓畫面好看而改日期，除非使用者明確要你這樣做。',
].join('\n');

// ------------------------------------------------------------ 資料存取

async function readState(env, userId) {
  const row = await env.DB.prepare('SELECT state, updated_at FROM user_state WHERE user_id = ?').bind(userId).first();
  if (!row) return { state: null, updatedAt: null };
  return { state: JSON.parse(row.state), updatedAt: row.updated_at };
}

async function readDigest(env, userId) {
  const row = await env.DB.prepare('SELECT digest, updated_at FROM reminder_feed WHERE user_id = ?').bind(userId).first();
  if (!row) return { digest: [], updatedAt: null };
  let digest = [];
  try { digest = JSON.parse(row.digest); } catch { /* 壞掉就當空的 */ }
  return { digest, updatedAt: row.updated_at ?? null };
}

/**
 * 讀 → 算 → 帶條件寫回，撞到別人的寫入就重來（最多三次）。fn 是純函式（同一份輸入
 * 永遠算出同一個結果），所以重算是安全的——同 handleUpdateShared 的重試。
 */
async function mutate(env, user, actor, tool, fn) {
  const since = Date.now() - 24 * 3600 * 1000;
  const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM mcp_activity WHERE user_id = ? AND created_at > ?')
    .bind(user.id, since).first();
  if ((used?.n || 0) >= MAX_WRITES_PER_DAY) throw new S.ToolError(`今天的修改次數已達上限（${MAX_WRITES_PER_DAY} 次）`);

  for (let attempt = 0; attempt < 3; attempt++) {
    const { state, updatedAt } = await readState(env, user.id);
    const { state: next, change } = fn(state);
    const serialized = JSON.stringify(next);
    if (serialized.length > MAX_STATE_BYTES) throw new S.ToolError('資料太大了，存不進去');
    const over = exceedsPlanCap(state, next, planOf(user));
    if (over) throw new S.ToolError('超過方案的上限');
    const now = Date.now();
    const res = await env.DB.prepare('UPDATE user_state SET state = ?, updated_at = ? WHERE user_id = ? AND updated_at = ?')
      .bind(serialized, now, user.id, updatedAt).run();
    if (res.meta?.changes === 1) {
      const changeId = crypto.randomUUID();
      // 紀錄寫在**寫入成功之後**：寫不進去也不能讓已經生效的修改變成錯誤（同 share_activity），
      // 但要出聲——沒有紀錄就沒有復原，這是這個功能的前提
      try {
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO mcp_activity (id, user_id, actor, tool, entity_kind, entity_id, summary, before, after, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(changeId, user.id, actor, tool, change.kind, change.id, change.summary,
            change.before == null ? null : JSON.stringify(change.before),
            change.after == null ? null : JSON.stringify(change.after), now),
          env.DB.prepare('DELETE FROM mcp_activity WHERE user_id = ? AND created_at < ?').bind(user.id, now - ACTIVITY_KEEP_MS),
        ]);
      } catch (e) {
        console.error('mcp_activity write failed — 這一筆無法復原', e?.stack || String(e));
        return { changeId: null, change };
      }
      return { changeId, change };
    }
  }
  throw new S.ToolError('資料剛好同時被別的裝置修改，請再試一次');
}

async function listActivity(env, userId, limit) {
  const rows = await env.DB.prepare(
    `SELECT id, actor, tool, summary, created_at, undone_at FROM mcp_activity
      WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
  ).bind(userId, limit).all();
  return (rows.results || []).map(r => ({
    changeId: r.id, by: r.actor, tool: r.tool, summary: r.summary,
    at: new Date(r.created_at).toISOString(), undone: !!r.undone_at,
  }));
}

/** 復原一筆紀錄。工具與「我的帳號」頁共用這一支，規則只有一份。 */
export async function undoChange(env, user, changeId, actor) {
  const row = await env.DB.prepare('SELECT * FROM mcp_activity WHERE id = ? AND user_id = ?').bind(changeId, user.id).first();
  if (!row) throw new S.ToolError('找不到這筆紀錄');
  if (row.undone_at) throw new S.ToolError('這筆已經復原過了');
  const change = {
    kind: row.entity_kind, id: row.entity_id,
    before: row.before == null ? null : JSON.parse(row.before),
    after: row.after == null ? null : JSON.parse(row.after),
  };
  const res = await mutate(env, user, actor, 'undo_change', state => ({
    state: S.revertChange(state, change),
    change: { kind: change.kind, id: change.id, before: change.after, after: change.before, summary: `復原：${row.summary}` },
  }));
  await env.DB.prepare('UPDATE mcp_activity SET undone_at = ? WHERE id = ?').bind(Date.now(), changeId).run();
  return res;
}

// ------------------------------------------------------------ 工具實作

const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && k in o).map(k => [k, o[k]]));
const ITEM_KEYS = Object.keys(itemFields);

async function callTool(env, ctx, name, args) {
  const { user, actor } = ctx;
  const a = args || {};
  switch (name) {
    case 'get_overview': {
      const { state, updatedAt } = await readState(env, user.id);
      const d = await readDigest(env, user.id);
      return {
        today: ymdTaipei(), plan: planOf(user),
        ...(state ? S.overview(state) : { majorProjects: [], ganttProjects: [], itemCount: 0, note: '雲端還沒有資料' }),
        dataUpdatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
        scheduleComputedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
      };
    }
    case 'list_items': return S.listItems((await readState(env, user.id)).state, a);
    case 'get_schedule': {
      const d = await readDigest(env, user.id);
      return {
        computedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
        occurrences: S.scheduleFromDigest(d.digest, a, ymdTaipei()),
      };
    }
    case 'list_gantt_projects': return { projects: S.listGantt((await readState(env, user.id)).state) };
    case 'list_recent_changes':
      return { changes: await listActivity(env, user.id, Math.max(1, Math.min(50, parseInt(a.limit) || 20))) };

    case 'create_item': {
      const r = await mutate(env, user, actor, name, st => S.createItem(st, pick(a, ITEM_KEYS)));
      return { changeId: r.changeId, item: S.summarizeItem(r.change.after) };
    }
    case 'update_item': {
      const r = await mutate(env, user, actor, name, st => S.updateItem(st, a.itemId, pick(a, ITEM_KEYS)));
      return { changeId: r.changeId, item: S.summarizeItem(r.change.after) };
    }
    case 'set_done': {
      const r = await mutate(env, user, actor, name, st => S.setDone(st, a.itemId, a.occurrenceKey, !!a.done));
      return { changeId: r.changeId, summary: r.change.summary };
    }
    case 'delete_item': {
      const r = await mutate(env, user, actor, name, st => S.deleteItem(st, a.itemId));
      return { changeId: r.changeId, summary: r.change.summary };
    }
    case 'create_major_project': {
      const r = await mutate(env, user, actor, name, st => S.createMajorProject(st, a.name));
      return { changeId: r.changeId, majorProject: r.change.after };
    }
    case 'add_gantt_task': {
      const r = await mutate(env, user, actor, name, st => S.addGanttTask(st, a.projectId, pick(a, ['name', 'start', 'end'])));
      return { changeId: r.changeId, task: r.change.after };
    }
    case 'update_gantt_task': {
      const r = await mutate(env, user, actor, name,
        st => S.updateGanttTask(st, a.projectId, a.taskId, pick(a, ['name', 'start', 'end', 'progress', 'done'])));
      return { changeId: r.changeId, task: r.change.after };
    }
    case 'undo_change': {
      const r = await undoChange(env, user, String(a.changeId || ''), actor);
      return { changeId: r.changeId, summary: r.change.summary };
    }
    default:
      throw new S.ToolError(`沒有這個工具：${name}`);
  }
}

// ------------------------------------------------------------ JSON-RPC

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function unauthorized(request, message) {
  return json({ error: message }, 401, {
    ...CORS,
    'WWW-Authenticate': `Bearer resource_metadata="${origin(request)}/.well-known/oauth-protected-resource"`,
  });
}

/** POST /mcp（GET 回 405：這個伺服器不推送事件，沒有 SSE 串流可開）。 */
export async function handleMcp(request, env) {
  if (request.method === 'OPTIONS') return mcpPreflight();
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405, { ...CORS, Allow: 'POST' });

  const auth = await authenticateMcp(request, env);
  if (!auth) return unauthorized(request, '需要登入（OAuth 或個人金鑰）');

  let msg;
  try { msg = await request.json(); } catch { return json(rpcError(null, -32700, 'Parse error'), 400, CORS); }
  if (Array.isArray(msg)) return json(rpcError(null, -32600, '不支援批次請求'), 400, CORS);
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return json(rpcError(msg?.id, -32600, 'Invalid Request'), 400, CORS);
  }
  // 通知（沒有 id）：收下就好
  if (msg.id === undefined) return new Response(null, { status: 202, headers: CORS });

  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      const asked = params?.protocolVersion;
      return json(rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'work-schedule', title: '工作排程確認系統', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      }), 200, CORS);
    }
    if (method === 'ping') return json(rpcResult(id, {}), 200, CORS);
    if (method === 'tools/list') return json(rpcResult(id, { tools: TOOLS }), 200, CORS);
    if (method === 'tools/call') {
      // 方案每一次都重新判斷：訂閱到期的那一刻起，金鑰與 OAuth 連線就不能再讀寫
      if (planOf(auth.user) !== 'pro') {
        return json(rpcResult(id, toolText({ error: '連接 AI agent 是 Pro 功能，這個帳號目前不是 Pro。' }, true)), 200, CORS);
      }
      const name = params?.name;
      if (!TOOLS.some(t => t.name === name)) return json(rpcError(id, -32602, `沒有這個工具：${name}`), 200, CORS);
      try {
        const out = await callTool(env, { user: auth.user, actor: auth.actor }, name, params?.arguments);
        return json(rpcResult(id, toolText(out, false)), 200, CORS);
      } catch (e) {
        if (e instanceof S.ToolError) return json(rpcResult(id, toolText({ error: e.message }, true)), 200, CORS);
        throw e;
      }
    }
    return json(rpcError(id, -32601, `Method not found: ${method}`), 200, CORS);
  } catch (e) {
    // 細節只進 log，不回給 agent（同 AI 端點：錯誤原文是最容易漏東西的一條路）
    console.error('mcp internal error', method, e?.stack || String(e));
    return json(rpcError(id, -32603, '伺服器發生錯誤，請稍後再試'), 200, CORS);
  }
}

function toolText(obj, isError) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], structuredContent: obj, isError };
}

// ------------------------------------------------------------ 「我的帳號」頁

export async function handleActivityList(env, user) {
  return json({ changes: await listActivity(env, user.id, 20) });
}

export async function handleActivityUndo(env, user, changeId) {
  try {
    await undoChange(env, user, changeId, '我的帳號頁');
    return json({ ok: true });
  } catch (e) {
    if (e instanceof S.ToolError) return json({ error: e.message }, 409);
    throw e;
  }
}

export { TOOLS };
