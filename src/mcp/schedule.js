/**
 * MCP 工具對排程資料（user_state 那一份 JSON）的純函式操作。
 *
 * **形狀必須與前端 `normalizeItems()` 的輸出逐字相同。** 三方合併以 stableStringify
 * 比對整個項目，欄位集差一個，「沒改過」就會被判成「兩邊都改過」，使用者會看到一個
 * 根本不存在的衝突對話框。tests/mcp.test.mjs 把這裡做出來的項目丟進 index.html 真正的
 * normalizeItems 跑一次，斷言前後逐字相同——同〈方案與上限〉前後端 PLAN_LIMITS 那一條：
 * 只要「兩邊必須一致」，就要有東西去比。
 *
 * 全部是純函式：輸入一份 state、輸出新的 state 與「改了什麼」，不碰資料庫。
 */

export const TYPES = ['work', 'meeting', 'assignment'];
/** 與 index.html 的 TASK_STATUSES 同一份清單（測試比對兩邊）。 */
export const TASK_STATUSES = ['todo', 'doing', 'blocked', 'waiting', 'review'];
/** 項目欄位的白名單（server.js 的 itemFields 是同一份 key，測試比對）。 */
export const ITEM_KEYS = ['title', 'date', 'type', 'endDate', 'meetingTime', 'majorProjectId', 'link', 'noticeOnly', 'tags', 'recurrence'];
const MAX_NOTE = 200, MAX_TODO_TEXT = 500, MAX_TODOS = 200, MAX_LOG = 2000;
const FREQS = ['monthly', 'quarterly', 'weekly', 'biweekly', 'yearly'];
const MAX_TITLE = 200;
const MAX_TAGS = 12, MAX_TAG_LEN = 24;

export const isYmd = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
const isHm = v => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

export class ToolError extends Error {}
const fail = (msg) => { throw new ToolError(msg); };

/** 與 index.html 的 uid() 同一種形狀：前綴＋8 個字元。 */
export function uid(prefix) {
  return prefix + '_' + crypto.randomUUID().slice(0, 8);
}

/** index.html 的 normalizeRecurrence 的逐行移植（測試比對兩邊的輸出）。 */
export function normalizeRecurrence(r) {
  if (!r || !FREQS.includes(r.freq)) return null;
  const byWeek = (r.freq === 'weekly' || r.freq === 'biweekly');
  const nthMode = (r.freq === 'monthly' && r.mode === 'nthWeekday');
  const c = parseInt(r.count);
  return {
    freq: r.freq,
    day: Math.max(1, Math.min(31, parseInt(r.day) || 1)),
    holidayRule: ['none', 'postpone', 'advance'].includes(r.holidayRule) ? r.holidayRule : 'none',
    until: isYmd(r.until) ? r.until : null,
    count: (Number.isInteger(c) && c >= 1) ? Math.min(500, c) : null,
    weekdays: byWeek && Array.isArray(r.weekdays) && r.weekdays.length
      ? [...new Set(r.weekdays.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      : null,
    mode: nthMode ? 'nthWeekday' : 'day',
    nth: nthMode ? (r.nth === -1 ? -1 : Math.max(1, Math.min(5, parseInt(r.nth) || 1))) : null,
    weekday: nthMode ? Math.max(0, Math.min(6, parseInt(r.weekday) || 0)) : null,
  };
}

function normalizeTags(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(t => String(t == null ? '' : t).trim().slice(0, MAX_TAG_LEN)).filter(Boolean))]
    .sort().slice(0, MAX_TAGS);
}

function cleanTitle(v) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TITLE);
  if (!s) fail('title 不可以是空的');
  return s;
}

function cleanLink(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^https?:\/\//.test(v)) fail('link 只接受 http:// 或 https:// 開頭的網址');
  return v.slice(0, 500);
}

/** 一個項目的 occKey 該長什麼樣子（與 occurrence 引擎的格式一致）。 */
export function validOccKey(item, key) {
  if (!item.recurrence) return key === 'single';
  const f = item.recurrence.freq;
  if (f === 'weekly' || f === 'biweekly') return /^W\d{4}-\d{2}-\d{2}$/.test(key);
  if (f === 'monthly') return /^\d{4}-\d{2}$/.test(key);
  if (f === 'quarterly') return /^\d{4}-Q[1-4]$/.test(key);
  if (f === 'yearly') return /^Y\d{4}$/.test(key);
  return false;
}

function ensureState(state) {
  if (!state || typeof state !== 'object') fail('雲端還沒有資料：請先在 app 或網頁上打開一次，讓資料同步上來');
  state.items = Array.isArray(state.items) ? state.items : [];
  state.majorProjects = Array.isArray(state.majorProjects) ? state.majorProjects : [];
  state.ganttProjects = Array.isArray(state.ganttProjects) ? state.ganttProjects : [];
  return state;
}

const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));

/** 套用使用者可改的欄位到一個項目上（新增與修改共用，規則只寫一份）。 */
function applyItemFields(it, f, state) {
  if ('title' in f) it.title = cleanTitle(f.title);
  if ('type' in f) {
    if (!TYPES.includes(f.type)) fail(`type 只能是 ${TYPES.join(' / ')}`);
    it.type = f.type;
  }
  if ('date' in f) { if (!isYmd(f.date)) fail('date 要是 YYYY-MM-DD'); it.date = f.date; }
  if ('meetingTime' in f) {
    if (f.meetingTime != null && f.meetingTime !== '' && !isHm(f.meetingTime)) fail('meetingTime 要是 HH:MM（24 小時制）');
    it.meetingTime = f.meetingTime || null;
  }
  if ('link' in f) it.link = cleanLink(f.link);
  if ('noticeOnly' in f) it.noticeOnly = !!f.noticeOnly;
  if ('tags' in f) it.tags = normalizeTags(f.tags);
  if ('majorProjectId' in f) {
    const pid = f.majorProjectId || null;
    if (pid && !state.majorProjects.some(mp => mp.id === pid)) fail('找不到這個 majorProjectId（先用 get_overview 看有哪些大項目）');
    it.parentId = pid;
  }
  if ('recurrence' in f) {
    const before = it.recurrence ? it.recurrence.freq : null;
    if (f.recurrence != null && !FREQS.includes(f.recurrence.freq)) fail(`recurrence.freq 只能是 ${FREQS.join(' / ')}`);
    it.recurrence = normalizeRecurrence(f.recurrence);
    const after = it.recurrence ? it.recurrence.freq : null;
    // 頻率一改，occKey 的格式就全變了：舊的完成／覆寫／略過紀錄要一起清掉，
    // 否則改回原頻率時它們會整批「復活」（同 index.html 的 btnConfirmItem）
    if (before !== after) {
      it.done = false; it.doneMap = {}; it.doneAt = {}; it.overrides = {}; it.skipped = {}; it.subDone = {};
    }
  }
  if ('endDate' in f) {
    if (f.endDate != null && f.endDate !== '' && !isYmd(f.endDate)) fail('endDate 要是 YYYY-MM-DD');
    it.endDate = f.endDate || null;
  }
  // 結束日只對非循環項目有意義，且要晚於開始日（同 normalizeItems）
  if (it.recurrence || !(isYmd(it.endDate) && it.endDate > it.date)) it.endDate = null;
}

// ------------------------------------------------------------ 讀

export function overview(state) {
  const s = ensureState(clone(state));
  return {
    majorProjects: s.majorProjects.map(mp => ({
      id: mp.id, name: mp.name, itemCount: s.items.filter(it => it.parentId === mp.id).length,
    })),
    ganttProjects: s.ganttProjects.map(gp => ({
      id: gp.id, name: gp.name, taskCount: (gp.tasks || []).length,
    })),
    itemCount: s.items.length,
  };
}

export function summarizeItem(it) {
  return {
    id: it.id, title: it.title, type: it.type, date: it.date, endDate: it.endDate || null,
    meetingTime: it.meetingTime || null, majorProjectId: it.parentId || null,
    recurrence: it.recurrence || null, noticeOnly: !!it.noticeOnly, tags: it.tags || [],
    link: it.link || null, done: it.recurrence ? undefined : !!it.done,
  };
}

export function listItems(state, { majorProjectId, type, query, limit } = {}) {
  const s = ensureState(clone(state));
  const q = query ? String(query).toLowerCase() : null;
  const max = Math.max(1, Math.min(200, parseInt(limit) || 100));
  const rows = s.items
    .filter(it => !majorProjectId || it.parentId === majorProjectId)
    .filter(it => !type || it.type === type)
    .filter(it => !q || String(it.title).toLowerCase().includes(q))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { total: rows.length, items: rows.slice(0, max).map(summarizeItem) };
}

/**
 * 排程（每一次發生）。occurrence 引擎只存在前端，這裡讀的是前端每次同步後推上來的
 * digest（回看一年、前瞻三個月），**不在 Worker 重寫一份**——同 ICS 與逾期提醒的理由：
 * 兩套必然分歧，而「agent 說你沒有逾期、畫面說有」比沒有這個工具更糟。
 */
export function scheduleFromDigest(digest, { from, to, includeDone }, todayYmd, state = null) {
  if (!isYmd(from) || !isYmd(to)) fail('from 與 to 要是 YYYY-MM-DD');
  if (to < from) fail('to 不可以早於 from');
  const span = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (span > 92) fail('一次最多查 92 天');
  // **完成狀態以當下的 state 為準，不以 digest 為準。** digest 是前端上一次打開時算好的，
  // agent（或另一台裝置）之後勾的不會在裡面——不疊上去的話，agent 勾完再查一次會看到
  // 「沒勾到」，然後再勾一次或回報失敗。日期與循環展開仍然只能信 digest（引擎只在前端）。
  const byId = new Map(((state && state.items) || []).map(it => [it.id, it]));
  const live = r => {
    if (!state || !r.i) return { keep: true, done: !!r.done };      // 舊格式的 digest：沒有 id 可以對
    const it = byId.get(r.i);
    if (!it) return { keep: false };                                 // 算完之後被刪掉了
    if (r.o && it.skipped && it.skipped[r.o]) return { keep: false }; // 算完之後被略過了
    const done = it.recurrence ? !!(it.doneMap && it.doneMap[r.o]) : !!it.done;
    return { keep: true, done };
  };
  return (Array.isArray(digest) ? digest : [])
    .filter(r => r && isYmd(r.d) && r.d >= from && r.d <= to)
    .map(r => ({ r, l: live(r) }))
    .filter(x => x.l.keep && (includeDone || !x.l.done))
    .map(({ r, l }) => ({
      itemId: r.i || null, occurrenceKey: r.o || null, title: r.t, type: r.k, date: r.d,
      done: l.done, overdue: !l.done && r.d < todayYmd,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ------------------------------------------------------------ 寫
//
// 每一個寫入都回 { state, change }。change 記下 before／after（只記那一個實體），
// 復原時拿它比對與還原——不存整份 state：整份還原會把這段時間使用者自己的編輯也一起蓋掉。

export function createItem(state, f) {
  const s = ensureState(clone(state));
  if (!('title' in f)) fail('缺 title');
  if (!('date' in f)) fail('缺 date');
  const id = uid('item');
  const it = {
    id, title: '', type: 'work', parentId: null, meetingTime: null, link: null, endDate: null,
    date: f.date, recurrence: null, tags: [], subtasks: [], subDone: {}, dependsOn: [],
    noticeOnly: false, done: false, doneMap: {}, doneAt: {}, overrides: {}, skipped: {},
  };
  applyItemFields(it, f, s);
  s.items.push(it);
  return { state: s, change: { kind: 'item', id, before: null, after: clone(it), summary: `新增「${it.title}」（${it.date}）` } };
}

function findItem(s, id) {
  const it = s.items.find(x => x.id === id);
  if (!it) fail('找不到這個 itemId（先用 list_items 查）');
  return it;
}

export function updateItem(state, itemId, f) {
  const s = ensureState(clone(state));
  const it = findItem(s, itemId);
  const before = clone(it);
  applyItemFields(it, f, s);
  return { state: s, change: { kind: 'item', id: itemId, before, after: clone(it), summary: `修改「${it.title}」` } };
}

export function setDone(state, itemId, occurrenceKey, done, nowMs = Date.now()) {
  const s = ensureState(clone(state));
  const it = findItem(s, itemId);
  const before = clone(it);
  const key = it.recurrence ? occurrenceKey : 'single';
  if (!key || !validOccKey(it, key)) {
    fail(it.recurrence
      ? '這是循環項目：要帶 occurrenceKey（用 get_schedule 查到的那一個）'
      : 'occurrenceKey 不對');
  }
  // 與 index.html 的 setOccurrenceDone 同一個寫法：完成時間戳只在這裡寫，取消勾選就拿掉
  if (key === 'single') it.done = !!done;
  else { it.doneMap = it.doneMap || {}; it.doneMap[key] = !!done; }
  it.doneAt = it.doneAt || {};
  if (done) it.doneAt[key] = nowMs; else delete it.doneAt[key];
  return {
    state: s,
    change: { kind: 'item', id: itemId, before, after: clone(it), summary: `${done ? '勾完成' : '取消完成'}「${it.title}」${key === 'single' ? '' : `（${key}）`}` },
  };
}

export function deleteItem(state, itemId) {
  const s = ensureState(clone(state));
  const it = findItem(s, itemId);
  s.items = s.items.filter(x => x.id !== itemId);
  return { state: s, change: { kind: 'item', id: itemId, before: clone(it), after: null, summary: `刪除「${it.title}」` } };
}

export function createMajorProject(state, name) {
  const s = ensureState(clone(state));
  const mp = { id: uid('mp'), name: cleanTitle(name) };
  s.majorProjects.push(mp);
  return { state: s, change: { kind: 'majorProject', id: mp.id, before: null, after: clone(mp), summary: `新增大項目「${mp.name}」` } };
}

export function listGantt(state) {
  const s = ensureState(clone(state));
  return s.ganttProjects.map(gp => ({
    id: gp.id, name: gp.name,
    tasks: (gp.tasks || []).map(t => ({
      id: t.id, name: t.name, start: t.start, end: t.end, progress: t.progress, done: !!t.done,
      status: TASK_STATUSES.includes(t.status) ? t.status : 'todo', blockedNote: t.blockedNote || '',
      todos: (t.todos || []).map(td => ({ id: td.id, text: td.text, done: !!td.done, review: !!td.review && !td.done })),
    })),
  }));
}

function findGantt(s, projectId) {
  const gp = s.ganttProjects.find(g => g.id === projectId);
  if (!gp) fail('找不到這個 projectId（先用 list_gantt_projects 查）');
  gp.tasks = Array.isArray(gp.tasks) ? gp.tasks : [];
  return gp;
}

/** 甘特任務的「實體 id」帶著專案：復原時才知道要放回哪裡。 */
const taskRef = (gpId, taskId) => `${gpId}/${taskId}`;

export function addGanttTask(state, projectId, f) {
  const s = ensureState(clone(state));
  const gp = findGantt(s, projectId);
  if (!isYmd(f.start) || !isYmd(f.end)) fail('start 與 end 要是 YYYY-MM-DD');
  if (f.end < f.start) fail('end 不可以早於 start');
  const t = { id: uid('task'), name: cleanTitle(f.name), start: f.start, end: f.end, progress: 0, done: false, todos: [], status: 'todo', blockedNote: '' };
  gp.tasks.push(t);
  return { state: s, change: { kind: 'ganttTask', id: taskRef(gp.id, t.id), before: null, after: clone(t), summary: `在「${gp.name}」新增任務「${t.name}」` } };
}

/** 舊存檔的任務沒有新欄位：改它之前先補齊（補在 before 快照之前，復原時不會把補的欄位當成「這一筆改的」）。 */
function ensureTaskShape(t) {
  if (!TASK_STATUSES.includes(t.status)) t.status = 'todo';
  if (typeof t.blockedNote !== 'string') t.blockedNote = '';
  t.todos = Array.isArray(t.todos) ? t.todos : [];
  for (const td of t.todos) td.review = !!td.review && !td.done;
}

function cleanNote(v) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_NOTE);
}

/** 與 index.html 的 todoProgress／syncTaskFromTodos 同一個算法。 */
const todoProgress = todos => (todos.length ? Math.round(todos.filter(td => td.done).length / todos.length * 100) : 0);
function syncTaskFromTodos(t) {
  if (!t.todos.length) return;
  t.progress = todoProgress(t.todos);
  t.done = t.todos.every(td => td.done);
}
/** 有效的完成：有子待辦時由子待辦算（同前端），否則看 done。 */
export const effectiveDone = t => (Array.isArray(t.todos) && t.todos.length ? t.todos.every(td => td.done) : !!t.done);

export function updateGanttTask(state, projectId, taskId, f) {
  const s = ensureState(clone(state));
  const gp = findGantt(s, projectId);
  const t = gp.tasks.find(x => x.id === taskId);
  if (!t) fail('找不到這個 taskId');
  ensureTaskShape(t);
  const before = clone(t);
  if ('name' in f) t.name = cleanTitle(f.name);
  if ('start' in f) { if (!isYmd(f.start)) fail('start 要是 YYYY-MM-DD'); t.start = f.start; }
  if ('end' in f) { if (!isYmd(f.end)) fail('end 要是 YYYY-MM-DD'); t.end = f.end; }
  if (t.end < t.start) fail('end 不可以早於 start');
  const hasTodos = t.todos.length > 0;
  // 有子項目時進度由子項目算出（同 normalizeGanttProjects），兩個來源並存必定不一致
  if (('progress' in f || 'done' in f) && hasTodos) fail('這個任務有子項目：進度由子項目決定，不能直接改');
  if ('progress' in f) {
    const p = Math.max(0, Math.min(100, parseInt(f.progress) || 0));
    t.progress = p; t.done = p === 100;
  }
  if ('done' in f) { t.done = !!f.done; if (t.done) t.progress = 100; }
  // 狀態只是另一欄：不動 done 與進度，也**不豁免逾期**（卡住的事照樣會遲交）
  if ('status' in f) {
    if (!TASK_STATUSES.includes(f.status)) fail(`status 只能是 ${TASK_STATUSES.join(' / ')}`);
    t.status = f.status;
    // 換成別的狀態時，上一個狀態留下的原因不該留著（blocked／waiting 才有原因）
    if (!('blockedNote' in f) && f.status !== 'blocked' && f.status !== 'waiting') t.blockedNote = '';
  }
  if ('blockedNote' in f) t.blockedNote = cleanNote(f.blockedNote);
  if (t.status === 'blocked' && !t.blockedNote) fail('blocked 一定要帶一句原因（blockedNote）：「卡住了」沒有原因等於沒說');
  return { state: s, change: { kind: 'ganttTask', id: taskRef(gp.id, t.id), before, after: clone(t), summary: `修改任務「${t.name}」` } };
}

/** 新增或修改任務底下的一個子待辦；有子待辦時任務的進度與完成由它們算出（同前端）。 */
export function upsertTaskTodo(state, projectId, taskId, f) {
  const s = ensureState(clone(state));
  const gp = findGantt(s, projectId);
  const t = gp.tasks.find(x => x.id === taskId);
  if (!t) fail('找不到這個 taskId');
  ensureTaskShape(t);
  const before = clone(t);
  const cleanText = v => {
    const x = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TODO_TEXT);
    if (!x) fail('text 不可以是空的');
    return x;
  };
  let todo;
  if (f.todoId) {
    todo = t.todos.find(x => x.id === f.todoId);
    if (!todo) fail('找不到這個 todoId');
    if ('text' in f) todo.text = cleanText(f.text);
    if ('done' in f) todo.done = !!f.done;
  } else {
    if (!('text' in f)) fail('新增子待辦要帶 text');
    if (t.todos.length >= MAX_TODOS) fail(`一個任務最多 ${MAX_TODOS} 個子待辦`);
    todo = { id: uid('todo'), text: cleanText(f.text), done: !!f.done, review: false };
    t.todos.push(todo);
  }
  if (todo.done) todo.review = false;
  syncTaskFromTodos(t);
  return { state: s, change: { kind: 'ganttTask', id: taskRef(gp.id, t.id), before, after: clone(t), summary: `${f.todoId ? '修改' : '新增'}任務「${t.name}」的子待辦「${todo.text}」` } };
}

export function createGanttProject(state, name) {
  const s = ensureState(clone(state));
  const gp = { id: uid('gp'), name: cleanTitle(name), notes: '', pet: null, brief: '', tasks: [] };
  s.ganttProjects.push(gp);
  return { state: s, change: { kind: 'ganttProject', id: gp.id, before: null, after: clone(gp), summary: `新增專案「${gp.name}」` } };
}

const escHtml = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 每日記錄：**只能附加**在當天既有內容後面，不能蓋掉使用者寫的（內容是 HTML，所以逐行跳脫後包成 <p>）。 */
export function writeDailyLog(state, text, todayYmd) {
  const s = ensureState(clone(state));
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .split('\n').map(x => x.trim()).filter(Boolean);
  const joined = lines.join('\n');
  if (!joined) fail('text 不可以是空的');
  if (joined.length > MAX_LOG) fail(`text 最多 ${MAX_LOG} 字`);
  s.dailyLogs = (s.dailyLogs && typeof s.dailyLogs === 'object') ? s.dailyLogs : {};
  const before = typeof s.dailyLogs[todayYmd] === 'string' ? s.dailyLogs[todayYmd] : null;
  const after = (before || '') + lines.map(l => `<p>${escHtml(l)}</p>`).join('');
  s.dailyLogs[todayYmd] = after;
  return { state: s, change: { kind: 'dailyLog', id: todayYmd, before, after, summary: `在 ${todayYmd} 的每日記錄後面附加一段` } };
}

// ------------------------------------------------------------ 待驗收（連線開著「勾完成要我驗收」）

/**
 * 寫入**之後、存檔之前**比一次：這次寫入讓哪些甘特任務的「有效完成」從假變成真？
 * 那些任務一律不准變成完成，改標 status='review'：
 *   - 沒有子待辦：done 維持 false（進度最多 99，免得進度條滿了卻沒完成）
 *   - 有子待辦：done 是由子待辦算出來的，所以只攔 set_done 沒用——把這次寫入新勾完的子待辦裡
 *     最後一個退回未完成、標 review=true（畫面上是一個半勾），任務才不會算成完成
 * 判斷只寫在這一個地方、掛在共用的寫入路徑上，不在每個工具各寫一次（同 isActionable）。
 * 回 { state, changes, events }：changes 裡對應那個任務的 after 改成最終的樣子（復原才對得上），
 * events 是要寫進進展日誌的「請驗收」。
 */
export function applyAcceptance(prevState, nextState, changes) {
  const s = clone(nextState);
  const prevProjects = new Map(((prevState && prevState.ganttProjects) || []).map(g => [g.id, g]));
  const out = changes.map(c => ({ ...c }));
  const events = [];
  for (const gp of s.ganttProjects || []) {
    const prevGp = prevProjects.get(gp.id);
    const prevTasks = new Map(((prevGp && prevGp.tasks) || []).map(t => [t.id, t]));
    for (const t of gp.tasks || []) {
      const prev = prevTasks.get(t.id);
      if (!(!(prev && effectiveDone(prev)) && effectiveDone(t))) continue;
      t.todos = Array.isArray(t.todos) ? t.todos : [];
      if (t.todos.length) {
        const prevDone = new Set(((prev && prev.todos) || []).filter(td => td.done).map(td => td.id));
        const newly = t.todos.filter(td => td.done && !prevDone.has(td.id));
        const hold = newly.length ? newly[newly.length - 1] : t.todos[t.todos.length - 1];
        hold.done = false; hold.review = true;
        t.progress = todoProgress(t.todos);
        t.done = false;
      } else {
        t.done = false;
        t.progress = Math.min(parseInt(t.progress) || 0, 99);
      }
      t.status = 'review';
      const id = taskRef(gp.id, t.id);
      let idx = -1;
      out.forEach((c, i) => { if (c.kind === 'ganttTask' && c.id === id) idx = i; });
      if (idx >= 0) out[idx].after = clone(t);
      else out.push({ kind: 'ganttTask', id, before: prev ? clone(prev) : null, after: clone(t), summary: `待驗收「${t.name}」` });
      events.push({ projectId: gp.id, taskId: t.id, body: `請驗收：「${t.name}」（agent 說做完了，要你確認才算數）` });
    }
  }
  return { state: s, changes: out, events };
}

/** 擁有者按「驗收通過」：真的完成。待驗收的子待辦勾起來；沒有被標記的（agent 手動標 review）就整個任務完成。 */
export function acceptTask(state, projectId, taskId) {
  const s = ensureState(clone(state));
  const gp = findGantt(s, projectId);
  const t = gp.tasks.find(x => x.id === taskId);
  if (!t) fail('找不到這個任務');
  ensureTaskShape(t);
  if (t.status !== 'review') fail('這個任務不在待驗收');
  if (t.todos.length) {
    const flagged = t.todos.filter(td => td.review);
    for (const td of (flagged.length ? flagged : t.todos)) { td.done = true; td.review = false; }
    syncTaskFromTodos(t);
  } else { t.done = true; t.progress = 100; }
  t.status = 'todo';
  return { state: s, taskName: t.name };
}

/** 退回：變回進行中，待驗收的旗標清掉（子待辦維持未完成）。 */
export function rejectTask(state, projectId, taskId) {
  const s = ensureState(clone(state));
  const gp = findGantt(s, projectId);
  const t = gp.tasks.find(x => x.id === taskId);
  if (!t) fail('找不到這個任務');
  ensureTaskShape(t);
  if (t.status !== 'review') fail('這個任務不在待驗收');
  for (const td of t.todos) td.review = false;
  t.status = 'doing';
  return { state: s, taskName: t.name };
}

/** 專案與任務存不存在（寫進展日誌前的檢查：沒有外鍵可擋，不檢查會留下永遠解析不到的孤兒）。 */
export function lookupProject(state, projectId, taskId) {
  const gp = state && Array.isArray(state.ganttProjects) ? state.ganttProjects.find(g => g.id === projectId) : null;
  if (!gp) fail('找不到這個 projectId（先用 list_gantt_projects 查）');
  let task = null;
  if (taskId != null && taskId !== '') {
    task = (gp.tasks || []).find(t => t.id === taskId);
    if (!task) fail('這個專案裡找不到這個 taskId');
  }
  return { project: gp, task };
}

// ------------------------------------------------------------ 提案的前後對照

const FIELD_LABELS = {
  title: '標題', date: '日期', type: '類型', endDate: '結束日', meetingTime: '時間', parentId: '大項目', link: '連結',
  noticeOnly: '純告知', tags: '標籤', recurrence: '循環', done: '完成', name: '名稱', start: '開始', end: '結束',
  progress: '進度', status: '狀態', blockedNote: '原因', todos: '子待辦',
};
const shortVal = v => {
  if (v === undefined || v === null) return null;
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  return t.length > 200 ? t.slice(0, 200) + '…' : t;
};

function entityLabel(change, ...states) {
  const e = change.after || change.before || {};
  if (change.kind === 'item') return `項目「${e.title}」`;
  if (change.kind === 'majorProject') return `大項目「${e.name}」`;
  if (change.kind === 'ganttProject') return `專案「${e.name}」`;
  if (change.kind === 'dailyLog') return `每日記錄 ${change.id}`;
  if (change.kind === 'ganttTask') {
    const gpId = String(change.id).split('/')[0];
    for (const st of states) {
      const gp = st && (st.ganttProjects || []).find(g => g.id === gpId);
      if (gp) return `專案「${gp.name}」的任務「${e.name}」`;
    }
    return `任務「${e.name}」`;
  }
  return String(change.id);
}

/** 把一批 change 攤成使用者看得懂的對照：{ entity, field, before, after }（不是 JSON 整包）。 */
export function describeChanges(changes, ...states) {
  const rows = [];
  for (const c of changes) {
    const entity = entityLabel(c, ...states);
    if (c.before == null && c.after == null) continue;
    if (c.kind === 'dailyLog') { rows.push({ entity, field: '內容', before: shortVal(c.before), after: shortVal(c.after) }); continue; }
    if (c.before == null) { rows.push({ entity, field: '新增', before: null, after: c.summary }); continue; }
    if (c.after == null) { rows.push({ entity, field: '刪除', before: c.summary, after: null }); continue; }
    const keys = [...new Set([...Object.keys(c.before), ...Object.keys(c.after)])]
      .filter(k => stableStringify(c.before[k]) !== stableStringify(c.after[k]));
    for (const k of keys) rows.push({ entity, field: FIELD_LABELS[k] || k, before: shortVal(c.before[k]), after: shortVal(c.after[k]) });
  }
  return rows;
}

// ------------------------------------------------------------ 復原

/** stableStringify：鍵排序後序列化（與 index.html 的三方合併比對方式一致）。 */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function locate(s, change) {
  if (change.kind === 'item') return { list: s.items, id: change.id };
  if (change.kind === 'majorProject') return { list: s.majorProjects, id: change.id };
  if (change.kind === 'ganttProject') return { list: s.ganttProjects, id: change.id };
  if (change.kind === 'ganttTask') {
    const [gpId, taskId] = change.id.split('/');
    const gp = s.ganttProjects.find(g => g.id === gpId);
    if (!gp) fail('那個甘特專案已經不在了，無法復原');
    gp.tasks = Array.isArray(gp.tasks) ? gp.tasks : [];
    return { list: gp.tasks, id: taskId };
  }
  fail('不認得的紀錄');
}

/**
 * 把一筆變更倒回去。**只看「這一筆改了哪幾欄」**，而不是整個實體還是不是改完的樣子：
 * agent 對同一個任務連寫三次（狀態、預測、進度），整個實體比對會讓前兩筆再也復原不了；
 * 使用者改了同一個任務的別的欄位，也不該讓這一筆不能復原。
 *
 * 規則：
 *  - 更新（before、after 都有）：算出 before／after 之間變了哪些頂層欄位；那幾欄現在若仍是
 *    after 的值就只把那幾欄倒回 before（before 沒有這欄就刪掉），其餘欄位保持現狀；
 *    **任何一個變過的欄位現在已經不是 after 的值**（使用者或後來的寫入又動過）就拒絕——
 *    倒回去等於在他沒看的時候把他的編輯蓋掉（同〈為什麼前置作業不自動順延〉）。
 *  - 建立（before 為空）：整個實體比對，現在跟 after 有任何差別就拒絕——使用者在新東西上
 *    動過任何一欄，刪掉它都會連他的修改一起丟。
 *  - 刪除（after 為空）：放回去；同一個 id 現在已經有東西就拒絕。
 *  - 實體現在不見了（更新的情況）：拒絕。
 */
export function revertChange(state, change) {
  const s = ensureState(clone(state));
  if (change.kind === 'dailyLog') {                      // 每日記錄是一個 ymd → HTML 的地圖，不是清單
    s.dailyLogs = (s.dailyLogs && typeof s.dailyLogs === 'object') ? s.dailyLogs : {};
    const cur = typeof s.dailyLogs[change.id] === 'string' ? s.dailyLogs[change.id] : null;
    if (cur !== change.after) fail('這一天的每日記錄之後又被改過了，自動復原會蓋掉後來的修改，所以沒有動它');
    if (change.before == null) delete s.dailyLogs[change.id]; else s.dailyLogs[change.id] = change.before;
    return s;
  }
  const { list, id } = locate(s, change);
  const idx = list.findIndex(x => x.id === id);
  const current = idx >= 0 ? list[idx] : null;
  const { before, after } = change;

  if (before == null) {                                  // 建立 → 刪掉
    if (stableStringify(current) !== stableStringify(after)) {
      fail('這一筆之後又被改過了，自動復原會蓋掉後來的修改，所以沒有動它');
    }
    list.splice(idx, 1);
    return s;
  }
  if (after == null) {                                   // 刪除 → 放回去
    if (current) fail('同一個編號現在已經有東西了，自動復原會蓋掉它，所以沒有動它');
    list.push(clone(before));
    return s;
  }
  if (!current) fail('這一筆改的東西現在已經不在了，沒有東西可以復原');
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(k => stableStringify(before[k]) !== stableStringify(after[k]));
  for (const k of changed) {
    if (stableStringify(current[k]) !== stableStringify(after[k])) {
      fail(`「${k}」這一欄之後又被改過了，自動復原會蓋掉後來的修改，所以沒有動它`);
    }
  }
  for (const k of changed) {
    if (k in before) current[k] = clone(before[k]);
    else delete current[k];
  }
  return s;
}
