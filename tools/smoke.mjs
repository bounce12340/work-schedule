/**
 * 冒煙測試：把使用者實際會走的路徑全部走一次，斷言**零錯誤**。
 *
 * 為什麼需要這個
 * ---------------------------------------------------------------------------
 * 已經連續兩次上線後才由使用者回報「某個區塊不見了／同步壞了」，而兩次的
 * `npm test`、`node --check`、Worker 與 D1 全部是綠的：
 *
 *   1. 逾期提醒的前端區段整段沒進檔案 → `reminderEnabled is not defined`
 *      → 被 `initCloudSync` 的 catch 吞掉 → 同步降級、共享頁顯示單機模式
 *   2. 代辦項目的列元素叫 `tr`，遮蔽了翻譯函式 `tr()`
 *      → 未捕捉的 TypeError → 甘特頁的任務表整段沒有渲染
 *
 * 兩者的機制完全不同，但症狀同一類：**某條 render 路徑丟了例外，畫面少了東西，
 * 而沒有任何自動化檢查會知道。** 針對「遮蔽」寫的靜態檢查（tests/shadow.test.mjs）
 * 只擋得住第二種。
 *
 * 這支腳本擋的是這一整類：不管例外的成因是什麼，只要它出現在 pageerror 或
 * console.error 裡就是紅的。第二次事故是未捕捉的例外（條件 a），第一次是被
 * 吞掉的例外——現在那個 catch 有 `console.error` 了（條件 b）。
 *
 * 兩種後端狀態都要跑
 * ---------------------------------------------------------------------------
 * 第一次事故只在**登入之後**才會踩到（`runCloudSync` 才會呼叫到缺失的函式）。
 * 只測單檔開啟會整條漏掉，所以這裡跑「單檔」與「已登入」兩種，各配中英文。
 *
 * 依賴 Playwright，而 Playwright **不是**本專案的相依套件——零相依是專案前提，
 * 所以這支腳本刻意留在 tools/ 而不是 tests/：
 *
 *     npx playwright install chromium     # 或設定 PLAYWRIGHT_CHROMIUM 指向現成的
 *     node tools/smoke.mjs
 *
 * 沒裝也不影響 `npm test`。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const PORT = Number(process.env.PORT || 8963);

const ME = { email: 'smoke@example.com', role: 'user', status: 'approved' };
/** app 外殼那一輪用的假 token；server 對它不做任何檢查，檢查的是它有沒有被帶上 */
const APP_TOKEN = 'smoke-app-token-0123456789abcdef';
/** index.html 在 app 裡打的線上網址；那一輪用 page.route 把它轉回本機伺服器 */
const APP_API_ORIGIN = 'https://work-schedule.bounceto12340.workers.dev';

/** 有循環、有跨多天、有子代辦、有筆記——讓每條 render 分支都有東西可畫 */
function seed() {
  const items = [];
  const types = ['work', 'meeting', 'assignment'];
  const recs = [
    null,
    { freq: 'weekly', days: [1, 4], interval: 1 },
    { freq: 'monthly', day: 15 },
    { freq: 'quarterly', month: 1, day: 10 },
    { freq: 'yearly', month: 6, day: 1 }
  ];
  for (let i = 0; i < 24; i++) {
    items.push({
      id: 'i' + i, title: `項目 ${i}`, type: types[i % 3],
      parentId: i % 4 === 0 ? 'mp1' : null,
      meetingTime: i % 3 === 1 ? '14:30' : null,
      link: i % 5 === 0 ? 'https://example.com' : null,
      date: `2026-0${1 + (i % 9)}-1${i % 9}`,
      endDate: i % 7 === 0 ? `2026-0${1 + (i % 9)}-2${i % 8}` : null,
      recurrence: recs[i % recs.length],
      done: i % 6 === 0, doneMap: {}, overrides: {}, skipped: {}
    });
  }
  return {
    version: 2,
    majorProjects: [{ id: 'mp1', name: '年度大型專案' }],
    items,
    ganttProjects: [{
      id: 'g1', name: '官網改版專案', notes: '<p>會議紀要：<b>第一次</b>討論</p>',
      tasks: [
        { id: 't1', name: '需求訪談', start: '2026-06-01', end: '2026-08-20', progress: 50, done: false,
          todos: [{ id: 'd1', text: '訪談業務單位', done: true }, { id: 'd2', text: '整理需求', done: false }] },
        { id: 't2', name: '視覺設計', start: '2026-08-15', end: '2027-02-10', progress: 0, done: false, todos: [] }
      ]
    }],
    dailyLogs: { '2026-07-15': '<p>今天的記錄</p>' },
    customHolidays: ['2026-10-09'], customWorkdays: [],
    selectedGanttProjectId: 'g1', availableYears: [2026, 2027]
  };
}

async function loadChromium() {
  try {
    const { chromium } = await import('playwright');
    return chromium;
  } catch {
    console.error('需要 Playwright，但它不是本專案的相依套件（零相依是專案前提）。');
    console.error('要跑這個驗證請先安裝：npm i -D playwright && npx playwright install chromium');
    process.exit(2);
  }
}

/**
 * `loggedIn` 為 false 時 /api/* 一律 404——那是單檔／未部署的情況。
 * 為 true 時回最小可用的 API 回應，讓 runCloudSync 與 fetchShares 真的跑起來。
 */
function makeServer(loggedIn) {
  const assets = new Map();
  for (const f of ['index.html', 'login.html', 'admin.html', 'privacy.html']) {
    assets.set('/' + f, readFileSync(PUBLIC + f, 'utf8'));
  }
  // sw.js 一定要真的供應。擋掉它會讓註冊失敗噴一行 console.error，而把
  // navigator.serviceWorker 偽造成 undefined 更糟——`'serviceWorker' in navigator`
  // 仍然為真，於是 .register 就丟 TypeError。真實瀏覽器不會有那種狀態。
  const SW = readFileSync(PUBLIC + 'sw.js', 'utf8');
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8` });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (url.pathname.startsWith('/api/')) {
      if (!loggedIn) return send(404, { error: 'not found' });
      if (url.pathname === '/api/state') {
        if (req.method === 'PUT') return send(200, { ok: true, updatedAt: 1 });
        return send(200, { user: ME, state: null, updatedAt: null });
      }
      // iOS app 的登入／驗證碼：回一個假 token，讓「app 外殼」那一輪走得完
      if (url.pathname === '/api/auth/app/login') return send(200, { ok: true, token: APP_TOKEN, expiresAt: 9e12, user: ME });
      if (url.pathname === '/api/auth/app/code') return send(200, { ok: true, message: 'sent' });
      if (url.pathname === '/api/shares') return send(200, { outgoing: [], incoming: [] });
      if (url.pathname === '/api/activity') return send(200, { activity: [] });
      if (url.pathname === '/api/reminder') return send(200, { enabled: false, lastSent: null, email: ME.email });
      return send(200, { ok: true });
    }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (path === '/sw.js') return send(200, SW, 'text/javascript');
    if (assets.has(path)) return send(200, assets.get(path), 'text/html');
    return send(404, 'not found', 'text/plain');
  });
}

/** 走完一輪所有頁面與主要互動 */
async function walk(page, log) {
  const checked = [];
  let step = '（尚未開始）';
  const need = async (sel, what) => {
    step = what;
    const n = await page.locator(sel).count();
    if (!n) throw new Error(`${what}：找不到 ${sel}`);
    checked.push(`${what}(${n})`);
  };
  /**
   * 一律先確認看得見再點。用 count() 判斷會踩到隱藏容器裡的按鈕——
   * `#doneSection` 預設 display:none，裡面的 #doneHead 仍然數得到，
   * 點下去就是 30 秒 timeout（我自己第一版就這樣壞的）。
   */
  const clickIfVisible = async (sel, what) => {
    step = what;
    const el = page.locator(sel).first();
    if (await el.count() && await el.isVisible()) { await el.click(); await page.waitForTimeout(250); return true; }
    return false;
  };
  const click = async (sel, what) => { step = what; await page.click(sel); };
  walk.lastStep = () => step;

  await page.waitForTimeout(700);
  await clickIfVisible('#reminderClose', '關閉提醒浮層');

  // ---- 項目安排：四種檢視範圍都要展開一次 ----
  await click('#navSchedule', '切到項目安排頁');
  await page.waitForTimeout(250);
  await need('#viewSchedule.active', '項目安排頁');
  const tabs = await page.locator('#modeTabs .mode-tab').all();
  if (!tabs.length) throw new Error('找不到檢視範圍頁籤');
  for (const tab of tabs) {
    step = `檢視範圍「${(await tab.textContent()).trim()}」`;
    await tab.click();
    await page.waitForTimeout(250);
    await need('#board', '排程看板');
  }
  // 勾一個項目：走 toggleOccDone → commit → renderAll 整條路徑
  await clickIfVisible('#board .checkbox', '勾選項目');
  await page.waitForTimeout(300);
  // 已完成收納區（勾完之後才會出現）
  await clickIfVisible('#doneHead', '展開已完成區');

  // ---- 日曆：點一天、拖一段區間 ----
  await click('#navCalendar', '切到日曆頁');
  await page.waitForTimeout(300);
  await need('#calGrid', '日曆格線');
  await need('.cal-cell:not(.blank)', '日曆格子');
  const cells = page.locator('.cal-cell:not(.blank)');
  step = '點選日期';
  await cells.nth(3).click();
  await page.waitForTimeout(250);
  step = '拖曳選取區間';
  const a = await cells.nth(8).boundingBox(), b = await cells.nth(11).boundingBox();
  if (a && b) {
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  }
  await clickIfVisible('#calNext', '日曆翻到下個月');
  await clickIfVisible('#calToday', '日曆跳回今天');

  // ---- 專案：圖表、任務表、子代辦、時間刻度 ----
  await click('#navGantt', '切到專案頁');
  await page.waitForTimeout(400);
  await need('#viewGantt.active', '專案頁');
  await need('.gantt-wrap', '甘特圖');
  await need('.task-row', '任務列');
  await need('.todo-row', '代辦項目列');       // 第二次事故正是這裡整段消失
  await need('.rt-edit', '專案筆記編輯器');
  for (const z of await page.locator('.gantt-toolbar .qbtn').all()) {
    step = `甘特工具列「${(await z.textContent()).trim()}」`;
    await z.click();
    await page.waitForTimeout(220);
    await need('.gantt-bar', '甘特長條');
  }
  await clickIfVisible('.add-todo-btn', '新增代辦項目');

  // ---- 共享 ----
  await click('#navShared', '切到共享頁');
  await page.waitForTimeout(400);
  await need('#viewShared.active', '共享頁');
  await need('#sharedIncoming', '別人分享給我');
  await need('#sharedOutgoing', '我分享出去的');

  // ---- 我的帳號 ----
  // 這一頁的每一個控制項都是從 header／footer 搬過來的**同一個元素**。搬移最
  // 可能的失敗是「元素被搬走但程式還在找它」——getElementById 回 null、整段
  // render 丟例外。那種錯誤會出現在 pageerror 裡，正是這支腳本要抓的。
  await click('#navAccount', '切到我的帳號頁');
  await page.waitForTimeout(400);
  await need('#viewAccount.active', '我的帳號頁');
  await need('#acctEmail', '帳號資訊');

  // 搬過來的控制項要真的還在。少一個就代表某段程式碼從此找不到它。
  for (const id of ['btnChangePw', 'btnExport', 'btnImport', 'themeBtn', 'langBtn']) {
    await need('#' + id, id);
  }

  // 「刪除我的帳號」（Apple 5.1.1(v)）是雲端區塊：單機隱藏、登入顯示，與帳號資訊那一區同步。
  // 顯示時按下去要開得起對話框（不確認，只按取消）。
  const identityShown = await page.locator('#acctIdentity').isVisible();
  const dangerShown = await page.locator('#acctDanger').isVisible();
  if (identityShown !== dangerShown) throw new Error(`刪除帳號區塊的可見性（${dangerShown}）與帳號資訊（${identityShown}）不一致`);
  checked.push(`刪除帳號區塊(${dangerShown ? '顯示' : '隱藏'})`);
  if (dangerShown) {
    await click('#btnDeleteAccount', '打開刪除帳號對話框');
    await need('#delOverlay.show', '刪除帳號對話框');
    await click('#btnCancelDel', '取消刪除');
    await page.waitForTimeout(100);
    if (await page.locator('#delOverlay.show').count()) throw new Error('刪除帳號對話框取消後沒有關閉');
  }

  // 主題與語言現在只有這一頁能切，所以在這裡按一次——順便確認搬家之後
  // 那兩顆按鈕的事件綁定仍然有效（它們的程式碼一行都沒改）。
  await click('#themeBtn', '切換主題');
  await page.waitForTimeout(150);
  await click('#themeBtn', '切回主題');
  await page.waitForTimeout(150);

  log(`      走過：${checked.join('、')}`);
}

const chromium = await loadChromium();
const failures = [];

for (const loggedIn of [false, true]) {
  for (const lang of ['zh', 'en']) {
    const label = `${loggedIn ? '已登入' : '單檔開啟'} × ${lang === 'zh' ? '中文' : '英文'}`;
    const server = makeServer(loggedIn);
    await new Promise(r => server.listen(PORT, r));

    const launch = process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {};
    const browser = await chromium.launch(launch);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 }, locale: 'zh-TW' });
    const page = await ctx.newPage();

    const errors = [];
    page.on('pageerror', e => errors.push(`未捕捉的例外：${e.message}`));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const t = m.text();
      // 字型／favicon／service worker 的載入噪音與應用程式無關
      if (/favicon|ERR_FAILED|net::ERR|MIME type|Failed to load resource/i.test(t)) return;
      errors.push(`console.error：${t}`);
    });
    await page.route('**://fonts.*/**', r => r.abort());

    await page.addInitScript(([s, l]) => {
      localStorage.setItem('workSchedule.v1', JSON.stringify(s));
      localStorage.setItem('workSchedule.v1.lang', l);
    }, [seed(), lang]);

    console.log(`\n▸ ${label}`);
    try {
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
      await walk(page, console.log);
    } catch (e) {
      // 一定要說是「哪一步」走不完，否則 timeout 訊息只有選擇器，看不出走到哪
      const at = typeof walk.lastStep === 'function' ? walk.lastStep() : '未知';
      errors.push(`路徑走不完（卡在：${at}）：${e.message.split('\n')[0]}`);
    }

    if (errors.length) {
      failures.push({ label, errors });
      console.log(`   ✗ ${errors.length} 個錯誤`);
      errors.forEach(e => console.log(`      - ${e}`));
    } else {
      console.log('   ✓ 零錯誤');
    }

    await browser.close();
    await new Promise(r => server.close(r));
  }
}

/**
 * 第五輪：iOS app 外殼。
 *
 * 塞一個假的 window.Capacitor（isNativePlatform 為真、假的 Keychain 與購買證明插件），
 * index.html 就會走〈原生外殼〉那條路：fetch 被改寫成打線上網址並帶 Bearer、沒有
 * token 時顯示 #appAuthView。線上網址用 page.route 轉回本機伺服器，順便記下每一個
 * 請求的標頭——「有沒有帶 Bearer」是這一輪真正要驗的事，只看畫面看不出來。
 *
 * 這一輪**驗不到 CORS**：page.route 在瀏覽器送出前就攔下請求，OPTIONS 預檢根本不會
 * 發生。TestFlight 第一次打開就是這樣紅的（登入與註冊都「連線失敗」），而這裡全綠。
 * CORS 由 tests/cors.test.mjs 直接打 Worker 的 fetch 入口守著。
 */
async function walkNative(page, log, seen) {
  const checked = [];
  const need = async (sel, what) => {
    const n = await page.locator(sel).count();
    if (!n) throw new Error(`${what}：找不到 ${sel}`);
    checked.push(`${what}(${n})`);
  };

  // 沒有 token：登入畫面要蓋在上面
  await page.waitForSelector('#appAuthView.show', { timeout: 5000 });
  checked.push('app 登入畫面(1)');

  // 註冊分頁：寄驗證碼之後才出現密碼欄；再切回登入
  await page.click('#appAuthTabRegister');
  if (await page.locator('#appAuthPwRow').isVisible()) throw new Error('註冊第一步不該就顯示密碼欄');
  await page.fill('#inputAppAuthEmail', ME.email);
  await page.click('#btnAppAuthCode');
  await page.waitForSelector('#appAuthCodeRow', { state: 'visible', timeout: 5000 });
  await need('#appAuthPwHint', '註冊第二步的說明');
  checked.push('寄驗證碼(1)');
  await page.click('#appAuthTabLogin');

  // 登入：成功後 index.html 會 reload，帶著 Keychain 裡的 token 重新啟動
  await page.fill('#inputAppAuthEmail', ME.email);
  await page.fill('#inputAppAuthPw', 'whatever-password');
  // 成功後 index.html 會 location.reload()；等新文件裡的登入畫面是收起來的狀態。
  // 不用 waitForNavigation：它對 reload 的時序很挑，失敗時只剩 timeout 看不出原因。
  await page.click('#btnAppAuthSubmit');
  try {
    // state:'attached'：沒有 .show 的登入畫面是 display:none，預設的 visible 永遠等不到
    await page.waitForSelector('#appAuthView:not(.show)', { state: 'attached', timeout: 8000 });
  } catch {
    const msg = await page.locator('#appAuthMsg').textContent().catch(() => '');
    throw new Error(`登入後登入畫面沒有收起來（畫面訊息：「${(msg || '').trim()}」）`);
  }
  await page.waitForTimeout(800);
  checked.push('登入後進主畫面(1)');

  await page.click('#navAccount');
  await page.waitForTimeout(400);
  const email = (await page.locator('#acctEmail').textContent()).trim();
  if (email !== ME.email) throw new Error(`我的帳號頁應顯示 ${ME.email}，實際是「${email}」`);
  checked.push('帳號資訊(1)');
  if (!(await page.locator('#acctDanger').isVisible())) throw new Error('app 裡登入後應看得到刪除帳號區塊');

  // 這一輪的核心斷言：所有打到線上網址的請求都帶了 Bearer 與 X-App-Client
  const stateCalls = seen.filter(r => r.path === '/api/state');
  if (!stateCalls.length) throw new Error('登入後沒有任何 /api/state 請求打到線上網址——fetch 沒有被改寫');
  for (const r of seen) {
    if (r.path.startsWith('/api/auth/app/')) continue;   // 登入與驗證碼發生在拿到 token 之前
    if (r.auth !== `Bearer ${APP_TOKEN}`) throw new Error(`${r.method} ${r.path} 沒有帶 Bearer（實際：${r.auth || '無'}）`);
    if (!/^ios\//.test(r.client || '')) throw new Error(`${r.method} ${r.path} 沒有帶 X-App-Client`);
  }
  checked.push(`Bearer 請求(${seen.length - seen.filter(r => r.path.startsWith('/api/auth/app/')).length})`);

  // 登出：清 Keychain、reload、回到登入畫面
  await page.click('#btnLogout');
  await page.waitForSelector('#appAuthView.show', { timeout: 8000 });
  const kc = await page.evaluate(() => localStorage.getItem('__kc_sessionToken'));
  if (kc) throw new Error('登出後 Keychain 裡的 token 沒有清掉');
  checked.push('登出回登入畫面(1)');

  log(`      走過：${checked.join('、')}`);
}

{
  const label = 'iOS app 外殼（假 Capacitor）';
  const server = makeServer(true);
  await new Promise(r => server.listen(PORT, r));
  const launch = process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {};
  const browser = await chromium.launch(launch);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 }, locale: 'zh-TW' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`未捕捉的例外：${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/favicon|ERR_FAILED|net::ERR|MIME type|Failed to load resource/i.test(t)) return;
    errors.push(`console.error：${t}`);
  });
  await page.route('**://fonts.*/**', r => r.abort());

  // 線上網址 → 本機伺服器，並記下標頭
  const seen = [];
  await page.route(APP_API_ORIGIN + '/**', async route => {
    const req = route.request();
    const u = new URL(req.url());
    const h = req.headers();
    seen.push({ method: req.method(), path: u.pathname, auth: h['authorization'], client: h['x-app-client'] });
    const r = await fetch(`http://127.0.0.1:${PORT}${u.pathname}${u.search}`, {
      method: req.method(), headers: { 'content-type': h['content-type'] || 'application/json' }, body: req.postData() ?? undefined,
    });
    await route.fulfill({ status: r.status, body: await r.text(), headers: { 'content-type': r.headers.get('content-type') || 'application/json' } });
  });

  // 假的 Capacitor：Keychain 用 localStorage 的一個鍵模擬，reload 之後才拿得回來
  await page.addInitScript(([s, l]) => {
    localStorage.setItem('workSchedule.v1', JSON.stringify(s));
    localStorage.setItem('workSchedule.v1.lang', l);
    window.Capacitor = {
      isNativePlatform: () => true,
      Plugins: { WorkScheduleNative: {
        keychainGet: async ({ key }) => ({ value: localStorage.getItem('__kc_' + key) }),
        keychainSet: async ({ key, value }) => { localStorage.setItem('__kc_' + key, value); },
        keychainDelete: async ({ key }) => { localStorage.removeItem('__kc_' + key); },
        getAppTransaction: async () => ({ jws: 'fake.jws.for-smoke' }),
      } },
    };
  }, [seed(), 'zh']);

  console.log(`\n▸ ${label}`);
  try {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await walkNative(page, console.log, seen);
  } catch (e) {
    errors.push(`路徑走不完：${e.message.split('\n')[0]}`);
  }
  if (errors.length) { failures.push({ label, errors }); console.log(`   ✗ ${errors.length} 個錯誤`); errors.forEach(e => console.log(`      - ${e}`)); }
  else console.log('   ✓ 零錯誤');
  await browser.close();
  await new Promise(r => server.close(r));
}

// 隱私權政策頁：不用登入就要開得起來（App Store 審查員會來看）
{
  const label = '隱私權政策頁';
  const server = makeServer(false);
  await new Promise(r => server.listen(PORT, r));
  const launch = process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {};
  const browser = await chromium.launch(launch);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`未捕捉的例外：${e.message}`));
  console.log(`\n▸ ${label}`);
  try {
    await page.goto(`http://127.0.0.1:${PORT}/privacy.html`, { waitUntil: 'domcontentloaded' });
    const title = await page.title();
    if (!/隱私權/.test(title)) throw new Error(`標題不對：${title}`);
    for (const word of ['刪除我的帳號', '14', 'IP', 'Privacy Policy']) {
      if (!(await page.locator(`text=${word}`).count())) throw new Error(`頁面上找不到「${word}」`);
    }
  } catch (e) { errors.push(e.message); }
  if (errors.length) { failures.push({ label, errors }); console.log(`   ✗ ${errors.length} 個錯誤`); errors.forEach(e => console.log(`      - ${e}`)); }
  else console.log('   ✓ 零錯誤');
  await browser.close();
  await new Promise(r => server.close(r));
}

const TOTAL = 6;
console.log('');
if (failures.length) {
  console.error(`✗ 冒煙測試失敗：${failures.length}/${TOTAL} 個情境有問題`);
  process.exit(1);
}
console.log(`✓ ${TOTAL} 個情境全部走完，零 pageerror、零 console.error`);
