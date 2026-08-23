import { json } from './auth.js';

const MAX_STATE_BYTES = 1_000_000;   // 遠高於實際用量（示範資料約 1.8 KB）

/**
 * 一併回傳身分。前端啟動時本來就必須先確認「是誰、有沒有登入」才能決定要不要
 * 清掉別人留下的本地快取，過去是先打 /api/auth/me 再打這裡——兩次串行往返，
 * 而且兩次都各做一遍 session 查詢。這個端點本來就需要有效 session 才進得來，
 * 401 傳達的是同一件事，順手把 user 帶上就能把啟動縮成一次往返。
 * /api/auth/me 仍然保留：admin.html 與其他呼叫端還在用。
 */
export async function handleGetState(env, user) {
  const row = await env.DB
    .prepare('SELECT state, updated_at FROM user_state WHERE user_id = ?')
    .bind(user.id)
    .first();

  const me = { email: user.email, role: user.role, status: user.status, createdAt: user.createdAt };

  // 沒有雲端資料不是錯誤：代表這個使用者還沒同步過，前端應沿用本地資料
  if (!row) return json({ user: me, state: null, updatedAt: null });

  return json({ user: me, state: JSON.parse(row.state), updatedAt: row.updated_at });
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
  // 前端送出它讀到的版本號。undefined 會被 D1 的 bind 拒絕，一律正規化成 null。
  const base = body.baseUpdatedAt ?? null;

  // 樂觀鎖：比對版本與寫入必須是同一句 SQL。
  //
  // 拆成「SELECT updated_at → 比對 → UPDATE」三步的話，讀完到寫入之間有一段
  // 空窗，被分享者的寫回（PUT /api/shared/:id 也會改同一列）剛好落在裡面時，
  // 這裡的 UPDATE 會把它無聲蓋掉——樂觀鎖擋得住看得見的衝突，擋不住自己
  // 製造出來的競態。帶條件的單句 UPDATE 讓比對與寫入原子化，順帶把正常路徑
  // 從兩次 D1 往返降成一次。
  //
  // 沒有 base 代表前端認為雲端還沒有資料，此時走 INSERT OR IGNORE：若其實
  // 已經有一列，它認錯了，該落到底下的衝突分支，而不是覆蓋既有資料。
  const written = base === null
    ? await env.DB
        .prepare('INSERT OR IGNORE INTO user_state (user_id, state, updated_at, created_at) VALUES (?, ?, ?, ?)')
        .bind(userId, serialized, now, now)
        .run()
    : await env.DB
        .prepare('UPDATE user_state SET state = ?, updated_at = ? WHERE user_id = ? AND updated_at = ?')
        .bind(serialized, now, userId, base)
        .run();

  if (written.meta.changes === 1) return json({ ok: true, updatedAt: now });

  // 一列都沒動：版本對不上，或前端以為是首次寫入但雲端已有資料。
  // 兩者都要把遠端內容回給前端做三方合併，此時才需要多讀一次。
  const row = await env.DB
    .prepare('SELECT state, updated_at FROM user_state WHERE user_id = ?')
    .bind(userId)
    .first();

  // 有 base 卻查不到列：擁有者的資料在這期間被刪掉了（例如管理者刪帳號後
  // 重建）。這不是衝突——沒有任何東西會被覆蓋，直接當首次寫入補上。
  if (!row) {
    await env.DB
      .prepare('INSERT OR IGNORE INTO user_state (user_id, state, updated_at, created_at) VALUES (?, ?, ?, ?)')
      .bind(userId, serialized, now, now)
      .run();
    return json({ ok: true, updatedAt: now });
  }

  // 純 last-write-wins 會靜默吃掉資料，因此把遠端整份回給前端自己決定
  return json({
    error: 'Conflict: state was modified on another device',
    remote: { state: JSON.parse(row.state), updatedAt: row.updated_at }
  }, 409);
}
