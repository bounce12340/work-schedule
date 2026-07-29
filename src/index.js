import { handleRegister, handleLogin, handleLogout, handleMe, json } from './handlers/auth.js';
import { handleGetState, handlePutState } from './handlers/state.js';
import { getSessionUser } from './session.js';

/**
 * 工作排程確認系統 — Worker 入口
 *
 * /api/*  由此處理，其餘交給靜態資產（public/）。
 * 靜態資產在 Workers 預設優先於 Worker script，因此 /api/* 這種不存在於
 * public/ 的路徑才會落到這裡。保護靜態頁面需要 run_worker_first（下一步處理）。
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) return servePage(request, env, url, path);

    if (path === '/api/health') return json({ ok: true });

    // 公開端點：登入前必須能打，否則沒有人進得來
    if (path === '/api/auth/register') {
      return request.method === 'POST' ? handleRegister(request, env) : methodNotAllowed();
    }
    if (path === '/api/auth/login') {
      return request.method === 'POST' ? handleLogin(request, env) : methodNotAllowed();
    }
    if (path === '/api/auth/logout') {
      return request.method === 'POST' ? handleLogout(request, env) : methodNotAllowed();
    }

    // 以下都需要有效 session
    const user = await getSessionUser(request, env);
    if (!user) return json({ error: '尚未登入' }, 401);

    if (path === '/api/auth/me') return handleMe(user);

    // 未核准的帳號可以查自己的身分（前端據此顯示等待畫面），但碰不到任何資料
    if (user.status !== 'approved') {
      return json({ error: '帳號尚未核准', status: user.status }, 403);
    }

    if (path === '/api/state') {
      if (request.method === 'GET') return handleGetState(env, user.id);
      if (request.method === 'PUT') return handlePutState(request, env, user.id);
      return methodNotAllowed();
    }

    return json({ error: 'Not found' }, 404);
  }
};

function methodNotAllowed() {
  return json({ error: 'Method not allowed' }, 405);
}

/**
 * 靜態頁面的存取控制。只有 wrangler.jsonc 的 run_worker_first 列出的路徑會走到這裡；
 * /login 刻意不在列表內，因此永遠由靜態資產直接服務。
 *
 * 導向只是體驗，不是防線——真正的安全邊界在 API。就算有人直接取得 admin.html，
 * 那也只是一個沒有資料的空殼，/api/admin/* 仍會擋下他。
 */
async function servePage(request, env, url, path) {
  const user = await getSessionUser(request, env);

  if (!user || user.status !== 'approved') {
    return Response.redirect(new URL('/login', url).toString(), 302);
  }
  if ((path === '/admin' || path === '/admin.html') && user.role !== 'admin') {
    return Response.redirect(new URL('/', url).toString(), 302);
  }
  return env.ASSETS.fetch(request);
}
