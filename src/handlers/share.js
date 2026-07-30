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

const KINDS = { item: 'items', gantt: 'ganttProjects', major: 'majorProjects' };
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
    let resource = owned ? findResource(owned.state, row.resource_kind, row.resource_id) : null;
    // 大項目是分類標籤，內容＝底下的所有小項目。一併附上，對方才有東西可看。
    if (resource && row.resource_kind === 'major') {
      const children = (Array.isArray(owned.state.items) ? owned.state.items : [])
        .filter(it => it && it.parentId === row.resource_id);
      resource = { ...resource, items: children };
    }
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
  if (share.resource_kind !== 'major' && resource.id !== share.resource_id) {
    return json({ error: '資料與分享對象不符' }, 400);
  }
  if (share.resource_kind === 'major' && !resource.id) return json({ error: '缺少項目識別碼' }, 400);

  const owned = await loadState(env, share.owner_id);
  if (!owned) return json({ error: '擁有者的資料已不存在' }, 404);

  // 大項目分享的寫回對象是「底下的某一個小項目」：resource.id 是子項目 id，
  // 授權依據是它此刻真的隸屬於被分享的大項目——擁有者把項目移出大項目後，
  // 這條授權立即失效。
  const isMajor = share.resource_kind === 'major';
  const listKey = isMajor ? 'items' : KINDS[share.resource_kind];
  const list = Array.isArray(owned.state[listKey]) ? owned.state[listKey] : null;
  if (!list) return json({ error: '擁有者的資料格式不符' }, 409);
  const idx = isMajor
    ? list.findIndex(r => r && r.id === resource.id && r.parentId === share.resource_id)
    : list.findIndex(r => r && r.id === share.resource_id);
  if (idx < 0) return json({ error: '這個項目已被擁有者刪除或移出分享範圍' }, 404);

  const before = list[idx];
  // 白名單合併，不整包替換。UI 沒有提供改名、改日期等操作，但那只是前端沒畫
  // 按鈕——若這裡直接採用送來的整個物件，拿著 edit 權限打 API 就能改掉擁有者
  // 的任何欄位（標題、日期、循環規則、甚至清空子代辦）。權限的邊界必須由
  // 伺服器保證，因此只取出「可操作」允許的欄位，其餘一律以擁有者現有的為準。
  const merged = mergeSharedEdit(isMajor ? 'item' : share.resource_kind, before, resource);
  list[idx] = merged;
  const now = Date.now();
  await env.DB
    .prepare('UPDATE user_state SET state = ?, updated_at = ? WHERE user_id = ?')
    .bind(JSON.stringify(owned.state), now, share.owner_id)
    .run();

  await recordActivity(env, {
    ownerId: share.owner_id, actorId: user.id,
    kind: share.resource_kind, resourceId: share.resource_id,
    name: resourceName(isMajor ? 'item' : share.resource_kind, merged),
    action: describeChange(isMajor ? 'item' : share.resource_kind, before, merged),
    now
  });

  return json({ ok: true, updatedAt: now });
}

/**
 * 「可操作」權限實際允許的欄位：完成狀態、任務進度、子代辦勾選。
 * 任務與子代辦以擁有者的清單為準——被分享者不能增刪，送來多的忽略、少的保留。
 * doneMap 的 key 有長度與數量上限：它會寫進擁有者的 state，不設限等於允許
 * 別人灌爆你的儲存空間。
 */
function mergeSharedEdit(kind, current, incoming) {
  if (kind !== 'gantt') {   // 'item' 與（整組分享時的）子項目共用同一套規則
    return { ...current, done: !!incoming.done, doneMap: sanitizeDoneMap(incoming.doneMap) };
  }
  const incTasks = new Map((Array.isArray(incoming.tasks) ? incoming.tasks : [])
    .filter(t => t && t.id).map(t => [t.id, t]));
  const tasks = (Array.isArray(current.tasks) ? current.tasks : []).map(t => {
    const inc = incTasks.get(t.id);
    if (!inc) return t;
    const curTodos = Array.isArray(t.todos) ? t.todos : [];
    const incTodos = new Map((Array.isArray(inc.todos) ? inc.todos : [])
      .filter(td => td && td.id).map(td => [td.id, td]));
    const todos = curTodos.map(td => {
      const i = incTodos.get(td.id);
      return i ? { ...td, done: !!i.done } : td;
    });
    // 有子代辦時進度是算出來的，不採信對方送來的數字——與前端維持同一條不變量
    const doneCnt = todos.filter(td => td.done).length;
    const progress = todos.length
      ? Math.round(doneCnt / todos.length * 100)
      : Math.max(0, Math.min(100, parseInt(inc.progress) || 0));
    const done = todos.length ? (doneCnt === todos.length && todos.length > 0) : !!inc.done;
    return { ...t, todos, progress, done };
  });
  return { ...current, tasks };
}

function sanitizeDoneMap(m) {
  const out = {};
  if (!m || typeof m !== 'object') return out;
  for (const k of Object.keys(m).slice(0, 1500)) {
    if (m[k]) out[String(k).slice(0, 16)] = true;
  }
  return out;
}

function resourceName(kind, resource) {
  return String((kind === 'item' ? resource.title : resource.name) || '（未命名）').slice(0, 120);
}

/** 完成數量，同時涵蓋單次（done）與循環（doneMap）兩種形狀 */
function doneCount(item) {
  if (!item) return 0;
  const map = item.doneMap && typeof item.doneMap === 'object' ? item.doneMap : {};
  return (item.done ? 1 : 0) + Object.values(map).filter(Boolean).length;
}

function taskDoneCount(project) {
  const tasks = Array.isArray(project?.tasks) ? project.tasks : [];
  return tasks.reduce((n, t) => {
    const todos = Array.isArray(t?.todos) ? t.todos : [];
    return n + (t?.done ? 1 : 0) + todos.filter(td => td && td.done).length;
  }, 0);
}

/**
 * 由前後兩份資料推出一句人看得懂的描述。
 *
 * 刻意在伺服器端算，不採用前端送來的說明字串——那等於讓被分享者自己決定
 * 記錄裡要寫什麼，記錄就失去意義了。
 */
function describeChange(kind, before, after) {
  const b = kind === 'item' ? doneCount(before) : taskDoneCount(before);
  const a = kind === 'item' ? doneCount(after) : taskDoneCount(after);
  if (a > b) return kind === 'item' ? '標記完成' : `勾選了 ${a - b} 項`;
  if (a < b) return kind === 'item' ? '取消完成' : `取消了 ${b - a} 項`;
  return '更新內容';
}

/**
 * 寫入一筆記錄，順手清掉該擁有者 90 天前的舊資料。
 * 沒有保留上限的日誌表遲早會變成資料庫裡最大的一張表，而這些記錄的價值
 * 幾乎只存在於事發後的短期內。
 */
async function recordActivity(env, a) {
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO share_activity
           (id, owner_id, actor_id, resource_kind, resource_id, resource_name, action, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(uuid(), a.ownerId, a.actorId, a.kind, a.resourceId, a.name, a.action, a.now),
      env.DB.prepare('DELETE FROM share_activity WHERE owner_id = ? AND created_at < ?')
        .bind(a.ownerId, a.now - 90 * 86400000)
    ]);
  } catch (e) {
    // 記錄失敗不該讓已經成功的寫入變成錯誤——資料已經存進去了，
    // 回 500 會讓使用者以為沒存到而重試。
    console.warn('share activity log failed', String(e));
  }
}

/** 與我有關的操作記錄：我的東西被別人改，或我改了別人的東西 */
export async function handleListActivity(env, user) {
  const rows = await env.DB.prepare(
    `SELECT a.resource_kind, a.resource_name, a.action, a.created_at,
            a.owner_id, a.actor_id, o.email AS owner_email, k.email AS actor_email
       FROM share_activity a
       JOIN users o ON o.id = a.owner_id
       JOIN users k ON k.id = a.actor_id
      WHERE a.owner_id = ?1 OR a.actor_id = ?1
      ORDER BY a.created_at DESC
      LIMIT 50`
  ).bind(user.id).all();

  return json({
    activity: (rows.results || []).map(r => ({
      kind: r.resource_kind,
      name: r.resource_name,
      action: r.action,
      at: r.created_at,
      actorEmail: r.actor_email,
      ownerEmail: r.owner_email,
      byMe: r.actor_id === user.id
    }))
  });
}
