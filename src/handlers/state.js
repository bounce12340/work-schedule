import { json } from './auth.js';

const MAX_STATE_BYTES = 1_000_000;   // 遠高於實際用量（示範資料約 1.8 KB）

export async function handleGetState(env, userId) {
  const row = await env.DB
    .prepare('SELECT state, updated_at FROM user_state WHERE user_id = ?')
    .bind(userId)
    .first();

  // 沒有雲端資料不是錯誤：代表這個使用者還沒同步過，前端應沿用本地資料
  if (!row) return json({ state: null, updatedAt: null });

  return json({ state: JSON.parse(row.state), updatedAt: row.updated_at });
}

export async function handlePutState(request, env, userId) {
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
    .bind(userId)
    .first();

  if (existing) {
    // 樂觀鎖：前端送出它讀到的 updatedAt，若雲端已被其他裝置改過就拒絕，
    // 由前端提示使用者選擇要保留哪一份。純 last-write-wins 會靜默吃掉資料。
    if (body.baseUpdatedAt !== existing.updated_at) {
      const row = await env.DB
        .prepare('SELECT state, updated_at FROM user_state WHERE user_id = ?')
        .bind(userId)
        .first();
      return json({
        error: 'Conflict: state was modified on another device',
        remote: { state: JSON.parse(row.state), updatedAt: row.updated_at }
      }, 409);
    }
    await env.DB
      .prepare('UPDATE user_state SET state = ?, updated_at = ? WHERE user_id = ?')
      .bind(serialized, now, userId)
      .run();
  } else {
    await env.DB
      .prepare('INSERT INTO user_state (user_id, state, updated_at, created_at) VALUES (?, ?, ?, ?)')
      .bind(userId, serialized, now, now)
      .run();
  }

  return json({ ok: true, updatedAt: now });
}
