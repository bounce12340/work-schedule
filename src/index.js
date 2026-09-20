import { handleRegister, handleLogin, handleLogout, handleMe, handleChangePassword, handleListSessions, handleLogoutOtherSessions, json } from './handlers/auth.js';
import { handleGetState, handlePutState } from './handlers/state.js';
import { handleListUsers, handleUpdateUser, handleDeleteUser, handleResetPassword, handleAdminActivity } from './handlers/admin.js';
import { runBackup, purgeExpired, listBackups } from './handlers/backup.js';
import { recordCronRun, cronResultErrors, handleCronStatus, handleUsage, handleMailLog } from './handlers/ops.js';
import { handleAiStatus, handleAiAsk, handleAiPlan } from './handlers/ai.js';
import { handleListShares, handleCreateShare, handleDeleteShare, handleUpdateShared, handleListActivity } from './handlers/share.js';
import { handleIcsStatus, handleIcsEnable, handleIcsDisable, handleIcsPut, handleIcsFeed } from './handlers/ics.js';
import { handleReminderStatus, handleReminderEnable, handleReminderPut, handleUnsubscribe, handleUnsubscribeOneClick, sendOverdueReminders, sendStreakBroken } from './handlers/reminder.js';
import { handleForgotPassword, handleResetPassword as handleSelfResetPassword } from './handlers/password-reset.js';
import { handleAppCode, handleAppRegister, handleAppLogin, handleDeleteAccount } from './handlers/appauth.js';
import { handlePlanApple, handleAppleNotification } from './handlers/planapple.js';
import { handlePushRegister, handlePushUnregister, handlePushTest, sendPushes } from './handlers/push.js';
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
   *
   * 三件事各自獨立 try/catch，**不能串在一起**：備份失敗不該連帶讓當天的提醒
   * 不寄，反過來也一樣。它們只是剛好在同一個時間點跑，彼此沒有依賴。
   *
   * 例外一律吞掉並記 log：排程失敗不該讓 Cloudflare 反覆重試而放大寄信量，
   * 而寄信本身在 sendOverdueReminders 內就已經是逐人容錯的。
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await step(env, 'reminder', () => sendOverdueReminders(env));
      await step(env, 'streak', () => sendStreakBroken(env));
      // 推播（子專案 B）。與兩封信各自獨立的一步：APNs 掛掉不該讓信也不寄，
      // 反過來也一樣。沒設 secret 時它自己記成「未設定」並跳過，不算失敗。
      await step(env, 'push', () => sendPushes(env));
      await step(env, 'backup', () => runBackup(env));
      await step(env, 'purge', () => purgeExpired(env));
    })());
  },

  async fetch(request, env, ctx) {
    const origin = corsOrigin(request);
    const isApi = new URL(request.url).pathname.startsWith('/api/');
    if (request.method === 'OPTIONS' && origin && isApi) return corsPreflight(origin);

    let res;
    try {
      res = await route(request, env, ctx);
    } catch (err) {
      // 例外若直接往上拋，Cloudflare 會回一頁 HTML 錯誤頁（Error 1101）。前端對
      // /api/* 一律走 res.json()，解析失敗就只剩「發生錯誤，請稍後再試」——真正的
      // 原因在瀏覽器這端完全看不到。因此這裡一律轉成 JSON，並附上 Ray ID，
      // 好讓畫面上的錯誤能直接對到 Workers Logs 裡的那一筆。
      const ref = request.headers.get('cf-ray') || 'local';
      console.error('unhandled exception', ref, request.method, new URL(request.url).pathname, err?.stack || String(err));
      res = json({ error: '伺服器發生錯誤，請稍後再試', ref }, 500);
    }
    // 錯誤回應也要帶：少了標頭，app 看到的不是「伺服器錯誤」而是「連線失敗」
    return isApi ? withCors(res, origin) : res;
  }
};

/**
 * iOS app 的跨來源請求（CORS）。
 *
 * app 內建的 index.html 跑在 capacitor://localhost，打 https://…workers.dev/api/*
 * 對 WKWebView 而言是跨網域：帶 JSON 與 Authorization 的請求會先送 OPTIONS 預檢，
 * 回應少了 Access-Control-Allow-Origin 就整個被瀏覽器丟掉——前端只拿到 TypeError，
 * 畫面上是「連線失敗，請確認網路後再試」，Worker 這邊連一筆請求都沒有。TestFlight
 * 第一次打開就是這樣，登入與註冊都進不去。
 *
 * - 只放行 app 自己的來源，不是 `*`。網頁版同源，根本不會帶 Origin 進到這裡。
 * - **刻意不開 Access-Control-Allow-Credentials**：app 走 Bearer，不需要 cookie；
 *   不開的話，就算哪天有別的頁面被塞進 app 的 WebView，它也帶不動網頁版的 session。
 * - tools/smoke.mjs 抓不到這一類錯誤：它用 page.route 在瀏覽器送出前就攔下了那些
 *   請求，預檢根本不會發生。所以由 tests/cors.test.mjs 守著。
 */
const APP_ORIGINS = new Set(['capacitor://localhost']);

function corsOrigin(request) {
  const origin = request.headers.get('origin');
  return origin && APP_ORIGINS.has(origin) ? origin : null;
}

function corsPreflight(origin) {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-App-Client',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    }
  });
}

function withCors(response, origin) {
  if (!origin) return response;
  const res = new Response(response.body, response);
  res.headers.set('Access-Control-Allow-Origin', origin);
  res.headers.append('Vary', 'Origin');
  return res;
}

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

  // 退訂：**公開端點**，憑證是信裡那個連結帶的 token。
  //
  // 會走到這裡的人定義上就是「不想再收信」的人，要求他先登入等於把他推回
  // Gmail 的「取消訂閱」——而那顆按鈕是說給寄信商聽的，一按下去他連密碼重設信
  // 都收不到（helen 2026-09-09 那次的真正成因）。**我們自己的出口一定要比
  // 那顆按鈕好走**，否則這個端點就白做了。
  //
  // GET 刻意不做任何事：`/unsub` 是一頁靜態頁，要按下按鈕才會打這裡。
  // 郵件用戶端與掃描器會預抓連結（同〈用過的重設連結保留 7 天〉那條踩過的坑），
  // 讓 GET 就生效等於「信一進收件匣，提醒自己關掉了」。
  if (path === '/api/unsub') {
    return request.method === 'POST' ? handleUnsubscribe(request, env) : methodNotAllowed();
  }

  // 郵件軟體那顆「取消訂閱」打進來的地方（RFC 8058 的一鍵退訂）。
  //
  // **這是治本的那一層**：有了 List-Unsubscribe 標頭，Gmail 的按鈕會打到這裡，
  // 而不是去跟寄信商說「這個人的信我不要了」——後者會讓整個帳號被封鎖，
  // 連密碼重設信都收不到（helen 2026-09-09 按下去的就是那一顆）。
  //
  // **只認 POST。** 掃描器與預抓會發 GET，讓 GET 生效等於「信一進收件匣，
  // 提醒自己關掉了」。RFC 8058 規定用 POST 正是為了這件事。
  if (path === '/api/unsub/one-click') {
    return request.method === 'POST' ? handleUnsubscribeOneClick(url, env) : methodNotAllowed();
  }

  // iOS app 的公開端點：驗證碼、以購買證明註冊、登入（回 token 不發 cookie）。
  // 網頁的 register/login 一行沒動；兩條路進的是同一張 users 與 sessions。
  if (path === '/api/auth/app/code') {
    return request.method === 'POST' ? handleAppCode(request, env) : methodNotAllowed();
  }
  if (path === '/api/auth/app/register') {
    return request.method === 'POST' ? handleAppRegister(request, env) : methodNotAllowed();
  }
  if (path === '/api/auth/app/login') {
    return request.method === 'POST' ? handleAppLogin(request, env) : methodNotAllowed();
  }

  // Apple 的伺服器通知：**公開端點**，Apple 直接打進來，沒有 session 可言。
  // 憑證是 payload 本身的簽章（同一條 Apple 憑證鏈），不是 cookie 也不是 Bearer。
  if (path === '/api/apple/notifications') {
    return request.method === 'POST' ? handleAppleNotification(request, env) : methodNotAllowed();
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
    if (request.method === 'PUT') return handlePutState(request, env, user);
    return methodNotAllowed();
  }

  // 登入中的裝置。GET 看清單、DELETE 登出其他裝置（保留當下這一台）。
  if (path === '/api/auth/sessions') {
    if (request.method === 'GET') return handleListSessions(request, env, user);
    if (request.method === 'DELETE') return handleLogoutOtherSessions(request, env, user);
    return methodNotAllowed();
  }

  if (path === '/api/auth/password') {
    return request.method === 'POST' ? handleChangePassword(request, env, user) : methodNotAllowed();
  }

  // 刪除自己的帳號（Apple 5.1.1(v)；網頁版同一顆按鈕）。要帶密碼。
  if (path === '/api/auth/account') {
    return request.method === 'DELETE' ? handleDeleteAccount(request, env, user) : methodNotAllowed();
  }

  // 推播：註冊／取消這台裝置的 device token
  if (path === '/api/push/register') {
    if (request.method === 'POST') return handlePushRegister(request, env, user);
    if (request.method === 'DELETE') return handlePushUnregister(request, env, user);
    return methodNotAllowed();
  }

  // app 推上來的訂閱交易（購買成功、啟動時的 currentEntitlements、恢復購買）
  if (path === '/api/plan/apple') {
    return request.method === 'POST' ? handlePlanApple(request, env, user) : methodNotAllowed();
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

  // AI 小幫手。第一階段唯讀：這裡沒有任何會改到 user_state 的路徑。
  if (path === '/api/ai/status') {
    return request.method === 'GET' ? handleAiStatus(env, user) : methodNotAllowed();
  }
  if (path === '/api/ai/ask') {
    return request.method === 'POST' ? handleAiAsk(request, env, user) : methodNotAllowed();
  }
  // 提案。**這裡不寫入任何東西**——它只回一份清單，寫入發生在前端使用者
  // 勾選並按下「加入」的那一刻，走既有的 PUT /api/state 同步路徑。
  if (path === '/api/ai/plan') {
    return request.method === 'POST' ? handleAiPlan(request, env, user) : methodNotAllowed();
  }

  if (path.startsWith('/api/admin/')) {
    if (user.role !== 'admin') return json({ error: '需要管理者權限' }, 403);

    if (path === '/api/admin/users') {
      return request.method === 'GET' ? handleListUsers(env) : methodNotAllowed();
    }
    if (path === '/api/admin/activity') {
      return request.method === 'GET' ? handleAdminActivity(env) : methodNotAllowed();
    }
    // GET 看有哪些備份；POST 立刻跑一次。後者存在的理由是「不必等到明天早上才
    // 知道備份會不會成功」——設定改動或第一次上線時，能當場驗證比什麼都重要。
    // 檔名以日期為 key，所以同一天重跑是覆蓋而不是長出第二份。
    if (path === '/api/admin/backups') {
      if (request.method === 'GET') return json(await listBackups(env));
      if (request.method === 'POST') {
        try {
          return json({ ok: true, result: await runBackup(env) });
        } catch (e) {
          console.error('manual backup failed', e?.stack || String(e));
          return json({ error: '備份失敗：' + String(e?.message || e) }, 500);
        }
      }
      return methodNotAllowed();
    }
    // 立刻送一則測試推播到自己的裝置。理由同上面的手動備份：**設定完當天就要能
    // 證明它通不通**，不必等到隔天早上八點才發現一片安靜。APNs 的回應原樣回去，
    // 因為「金鑰不對」與「token 不對」在只有狀態碼時看起來一模一樣。
    if (path === '/api/admin/push-test') {
      return request.method === 'POST' ? handlePushTest(env, user) : methodNotAllowed();
    }
    // cron 的執行記錄與功能使用狀況。兩者都只回統計與狀態，不回任何排程內容——
    // 要回答的是「系統在不在跑、有沒有人在用」，不需要看見資料本身。
    if (path === '/api/admin/cron') {
      return request.method === 'GET' ? handleCronStatus(env) : methodNotAllowed();
    }
    if (path === '/api/admin/mail-log') {
      return request.method === 'GET' ? handleMailLog(env) : methodNotAllowed();
    }
    if (path === '/api/admin/usage') {
      return request.method === 'GET' ? handleUsage(env) : methodNotAllowed();
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
 * 跑一段 cron 工作並記錄結果。
 *
 * **成功也要印**：只在失敗時印的話，「備份從三週前就沒在跑了」看起來與
 * 「一切正常」一模一樣——log 裡什麼都沒有。備份最可怕的失敗模式正是這種。
 */
export async function step(env, name, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    // 沒有丟例外 ≠ 這一步做到了。回傳值裡有 errors[] 就不算乾淨的成功——
    // 理由與判斷寫在 cronResultErrors() 上面，那是實際發生過的假綠燈。
    const errs = cronResultErrors(result);
    if (errs.length) console.error(`cron ${name} 有 ${errs.length} 筆失敗`, JSON.stringify(errs));
    else console.log(`cron ${name}`, JSON.stringify(result));
    await recordCronRun(env, {
      step: name, ok: errs.length === 0, detail: JSON.stringify(result),
      startedAt, endedAt: Date.now()
    });
  } catch (e) {
    console.error(`cron ${name} failed`, e?.stack || String(e));
    // 錯誤訊息而不是 stack：這一欄是給人在管理頁上讀的，stack 在那裡是雜訊，
    // 真要追行號的話 console.error 仍然留著完整的一份
    await recordCronRun(env, {
      step: name, ok: false, detail: String(e?.message || e),
      startedAt, endedAt: Date.now()
    });
  }
}

/**
 * 靜態頁面的存取控制。只有 wrangler.jsonc 的 run_worker_first 列出的路徑會走到這裡；
 * /login 刻意不在列表內，因此永遠由靜態資產直接服務。
 *
 * 導向只是體驗，不是防線——真正的安全邊界在 API。就算有人直接取得 admin.html，
 * 那也只是一個沒有資料的空殼，/api/admin/* 仍會擋下他。
 */
async function servePage(request, env, url, path) {
  // 隱私權政策不用登入就要看得到：App Store 的審查員與還沒註冊的人都會來看
  if (path === '/privacy' || path === '/privacy.html') return env.ASSETS.fetch(request);
  // 使用條款同理：訂閱畫面與 App Store 的 metadata 都要連得到
  if (path === '/terms' || path === '/terms.html') return env.ASSETS.fetch(request);

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
