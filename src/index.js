import { handleRegister, handleLogin, handleLogout, handleMe, handleChangePassword, json } from './handlers/auth.js';
import { handleGetState, handlePutState } from './handlers/state.js';
import { handleListUsers, handleUpdateUser, handleDeleteUser, handleResetPassword } from './handlers/admin.js';
import { handleListShares, handleCreateShare, handleDeleteShare, handleUpdateShared, handleListActivity } from './handlers/share.js';
import { handleIcsStatus, handleIcsEnable, handleIcsDisable, handleIcsPut, handleIcsFeed } from './handlers/ics.js';
import { handleReminderStatus, handleReminderEnable, handleReminderPut, sendOverdueReminders } from './handlers/reminder.js';
import { handleForgotPassword, handleResetPassword as handleSelfResetPassword } from './handlers/password-reset.js';
import { getSessionUser } from './session.js';

/**
 * 工作排程確認系統 — Worker 入口
 *
 * /api/*  由此處理，其餘交給靜態資產（public/）。
 * 靜態資產在 Workers 預設優先於 Worker script，因此 /api/* 這種不存在於
 * public/ 的路徑才會落到這裡。保護靜態頁面需要 run_worker_first（下一步處理）。
 */
export default {
  /**
   * Cron 進入點（wrangler.jsonc 的 triggers.crons）。
   * 例外一律吞掉並記 log：排程失敗不該讓 Cloudflare 反覆重試而放大寄信量，
   * 而寄信本身在 sendOverdueReminders 內就已經是逐人容錯的。
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const r = await sendOverdueReminders(env);
        console.log('reminder cron', JSON.stringify(r));
      } catch (e) {
        console.error('reminder cron failed', e?.stack || String(e));
      }
    })());
  },

  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      // 例外若直接往上拋，Cloudflare 會回一頁 HTML 錯誤頁（Error 1101）。前端對
      // /api/* 一律走 res.json()，解析失敗就只剩「發生錯誤，請稍後再試」——真正的
      // 原因在瀏覽器這端完全看不到。因此這裡一律轉成 JSON，並附上 Ray ID，
      // 好讓畫面上的錯誤能直接對到 Workers Logs 裡的那一筆。
      const ref = request.headers.get('cf-ray') || 'local';
      console.error('unhandled exception', ref, request.method, new URL(request.url).pathname, err?.stack || String(err));
      return json({ error: '伺服器發生錯誤，請稍後再試', ref }, 500);
    }
  }
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  {
    // 行事曆訂閱的公開端點：token 即憑證，行事曆軟體不會有 session
    const m = path.match(/^\/ics\/([A-Za-z0-9_-]{20,64})$/);
    if (m) {
      return request.method === 'GET' ? handleIcsFeed(env, m[1]) : methodNotAllowed();
    }
  }

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

  // 忘記密碼也是公開端點——會走到這裡的人，定義上就是登不進來的人。
  // 兩支的濫用防線不同：索取會寄信到別人的信箱，所以要真人驗證；
  // 消費那一端的憑證是連結裡的 token 本身，多一道 Turnstile 只是多一個故障點。
  if (path === '/api/auth/forgot') {
    return request.method === 'POST' ? handleForgotPassword(request, env) : methodNotAllowed();
  }
  if (path === '/api/auth/reset') {
    return request.method === 'POST' ? handleSelfResetPassword(request, env) : methodNotAllowed();
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
    // GET 收下整個 user：它順帶回傳身分，讓前端啟動時不必再打一次 /api/auth/me
    if (request.method === 'GET') return handleGetState(env, user);
    if (request.method === 'PUT') return handlePutState(request, env, user.id);
    return methodNotAllowed();
  }

  if (path === '/api/auth/password') {
    return request.method === 'POST' ? handleChangePassword(request, env, user) : methodNotAllowed();
  }

  if (path === '/api/ics/status') {
    return request.method === 'GET' ? handleIcsStatus(env, user) : methodNotAllowed();
  }
  if (path === '/api/ics/enable') {
    return request.method === 'POST' ? handleIcsEnable(request, env, user) : methodNotAllowed();
  }
  if (path === '/api/ics') {
    if (request.method === 'PUT') return handleIcsPut(request, env, user);
    if (request.method === 'DELETE') return handleIcsDisable(env, user);
    return methodNotAllowed();
  }

  if (path === '/api/reminder') {
    if (request.method === 'GET') return handleReminderStatus(env, user);
    if (request.method === 'PUT') return handleReminderPut(request, env, user);
    if (request.method === 'POST') return handleReminderEnable(request, env, user);
    return methodNotAllowed();
  }

  if (path === '/api/activity') {
    return request.method === 'GET' ? handleListActivity(env, user) : methodNotAllowed();
  }

  if (path === '/api/shares') {
    if (request.method === 'GET') return handleListShares(env, user);
    if (request.method === 'POST') return handleCreateShare(request, env, user);
    return methodNotAllowed();
  }
  {
    const m = path.match(/^\/api\/shares\/([^/]+)$/);
    if (m) {
      return request.method === 'DELETE'
        ? handleDeleteShare(env, user, decodeURIComponent(m[1]))
        : methodNotAllowed();
    }
  }
  {
    // 路徑帶的是分享單 id，不是資源 id：可寫的目標與權限都由那筆分享決定，
    // 用資源 id 直接定位的話，任何人只要猜到 id 就能寫別人的資料。
    const m = path.match(/^\/api\/shared\/([^/]+)$/);
    if (m) {
      return request.method === 'PUT'
        ? handleUpdateShared(request, env, user, decodeURIComponent(m[1]), ctx)
        : methodNotAllowed();
    }
  }

  if (path.startsWith('/api/admin/')) {
    if (user.role !== 'admin') return json({ error: '需要管理者權限' }, 403);

    if (path === '/api/admin/users') {
      return request.method === 'GET' ? handleListUsers(env) : methodNotAllowed();
    }
    const mr = path.match(/^\/api\/admin\/users\/([^/]+)\/reset-password$/);
    if (mr) {
      return request.method === 'POST'
        ? handleResetPassword(env, user, decodeURIComponent(mr[1]))
        : methodNotAllowed();
    }
    const m = path.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (m) {
      const targetId = decodeURIComponent(m[1]);
      if (request.method === 'PATCH') return handleUpdateUser(request, env, user, targetId);
      if (request.method === 'DELETE') return handleDeleteUser(env, user, targetId);
      return methodNotAllowed();
    }
  }

  return json({ error: 'Not found' }, 404);
}

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
  // 授權查詢與取出靜態資產彼此沒有依賴，串行做等於讓一次 D1 往返擋在 HTML
  // 的第一個位元組前面——而 run_worker_first 讓 / 一定要經過這裡，所以每次
  // 開啟都在付這筆錢。同時發、未授權時把拿到的資產丟掉即可：擋下來的東西
  // 完全一樣，只是不再排隊。多花的是未授權訪客的一次資產子請求（邊緣快取，
  // 極便宜），換到的是所有正常開啟都少一段等待。
  const [user, asset] = await Promise.all([
    getSessionUser(request, env),
    env.ASSETS.fetch(request)
  ]);

  if (!user || user.status !== 'approved') {
    return Response.redirect(new URL('/login', url).toString(), 302);
  }
  if ((path === '/admin' || path === '/admin.html') && user.role !== 'admin') {
    return Response.redirect(new URL('/', url).toString(), 302);
  }
  return asset;
}
