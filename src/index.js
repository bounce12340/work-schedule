import { authenticate } from './auth.js';

/**
 * 工作排程確認系統 — Worker 入口
 *
 * 路由規則：
 *   /api/*  → 由此 Worker 處理
 *   其他     → 交給靜態資產（public/），根路徑即 index.html
 *
 * 靜態資產在 Workers 預設優先於 Worker script 服務，因此 /api/* 這種
 * 不存在於 public/ 的路徑才會落到這裡，不需要 run_worker_first。
 */

const MAX_STATE_BYTES = 1_000_000;   // 1 MB，遠高於實際用量（示範資料約 1.8 KB）

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === '/api/health') {
      return json({ ok: true });
    }

    if (url.pathname === '/api/state') {
      const auth = await authenticate(request, env);
      if (auth.error) return json({ error: auth.error }, auth.status);

      if (request.method === 'GET')  return getState(env, auth.email);
      if (request.method === 'PUT')  return putState(request, env, auth.email);
      return json({ error: 'Method not allowed' }, 405);
    }

    return json({ error: 'Not found' }, 404);
  }
};

async function getState(env, email) {
  const row = await env.DB
    .prepare('SELECT state, updated_at FROM user_state WHERE user_id = ?')
    .bind(email)
    .first();

  // 沒有雲端資料不是錯誤：代表這個使用者還沒同步過，前端應沿用本地資料
  if (!row) return json({ state: null, updatedAt: null });

  return json({ state: JSON.parse(row.state), updatedAt: row.updated_at });
}

async function putState(request, env, email) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!body || typeof body.state !== 'object' || body.state === null) {
    return json({ error: 'Missing state object' }, 400);
  }

  const serialized = JSON.stringify(body.state);
  if (serialized.length > MAX_STATE_BYTES) {
    return json({ error: 'State too large' }, 413);
  }

  const now = Date.now();
  const existing = await env.DB
    .prepare('SELECT updated_at FROM user_state WHERE user_id = ?')
    .bind(email)
    .first();

  if (existing) {
    // 樂觀鎖：前端送出它讀到的 updatedAt，若雲端已被其他裝置改過就拒絕，
    // 由前端提示使用者選擇要保留哪一份。純 last-write-wins 會靜默吃掉資料。
    if (body.baseUpdatedAt !== existing.updated_at) {
      const row = await env.DB
        .prepare('SELECT state, updated_at FROM user_state WHERE user_id = ?')
        .bind(email)
        .first();
      return json({
        error: 'Conflict: state was modified on another device',
        remote: { state: JSON.parse(row.state), updatedAt: row.updated_at }
      }, 409);
    }
    await env.DB
      .prepare('UPDATE user_state SET state = ?, updated_at = ? WHERE user_id = ?')
      .bind(serialized, now, email)
      .run();
  } else {
    await env.DB
      .prepare('INSERT INTO user_state (user_id, state, updated_at, created_at) VALUES (?, ?, ?, ?)')
      .bind(email, serialized, now, now)
      .run();
  }

  return json({ ok: true, updatedAt: now });
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  });
}
