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
/**
 * 休假與「不在」各一天，**都在今天之後**：`buildReminderLeaveDays()` 的窗口是
 * 「回看一年、前瞻三個月」，寫死日期的話某天會掉出窗口，變成一條安靜失效的斷言。
 */
const plusDays = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const LEAVE_DAY = plusDays(21);
const AWAY_DAY = plusDays(22);
// 分享過來的那一筆要落在「最近三個月」那個展開窗口裡，否則共享頁會顯示
// 「最近三個月內沒有安排」而整條斷言變成空的
const SHARED_DAY = plusDays(5);

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
    // v3：帶種類與時段的 absences。**刻意放一天「不在」與一天「休假」**——下面
    // 「休假那幾天閉嘴」那條斷言要靠它們分辨「只列 leave、不列 away」。
    // 這裡不留 v2 的 awayDates 並不會少掉遷移的覆蓋：`tools/check-migrate.mjs`
    // 在真的瀏覽器裡走完整的 v1 → v2 → v3，連 awayDates → absences 都斷言過。
    version: 3,
    // 剛好 3 個：免費版的上限。已登入的中文那一輪靠這個數字撞上限（見 walk 的「上限」段）
    majorProjects: [{ id: 'mp1', name: '年度大型專案' }, { id: 'mp2', name: '第二個' }, { id: 'mp3', name: '第三個' }],
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
    absences: {
      [LEAVE_DAY]: [{ kind: 'leave', from: '13:00', to: '18:00', icon: '🏖️' }],
      [AWAY_DAY]: [{ kind: 'away', from: null, to: null }],
    },
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
function makeServer(loggedIn, plan = 'pro') {
  const assets = new Map();
  // 前端推上來的提醒摘要都收在這裡，讓「休假那幾天閉嘴」那條斷言有東西可看。
  // **這是第 0 條（新增的前端函式一定要在瀏覽器裡真的走一次）在這一張卡的形狀**：
  // `buildReminderLeaveDays()` 只在 cloudPush 成功後 3 秒才被呼叫到，
  // npm test 與 node --check 都證明不了它有沒有被定義。
  const reminderPuts = [];
  for (const f of ['index.html', 'login.html', 'admin.html', 'privacy.html', 'terms.html']) {
    assets.set('/' + f, readFileSync(PUBLIC + f, 'utf8'));
  }
  // sw.js 一定要真的供應。擋掉它會讓註冊失敗噴一行 console.error，而把
  // navigator.serviceWorker 偽造成 undefined 更糟——`'serviceWorker' in navigator`
  // 仍然為真，於是 .register 就丟 TypeError。真實瀏覽器不會有那種狀態。
  const SW = readFileSync(PUBLIC + 'sw.js', 'utf8');
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8` });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (url.pathname.startsWith('/api/')) {
      if (!loggedIn) return send(404, { error: 'not found' });
      if (url.pathname === '/api/state') {
        if (req.method === 'PUT') return send(200, { ok: true, updatedAt: 1 });
        return send(200, { user: { ...ME, plan, planSource: plan === 'pro' ? 'admin' : null, planExpiresAt: null }, state: null, updatedAt: null });
      }
      // iOS app 的登入／驗證碼：回一個假 token，讓「app 外殼」那一輪走得完
      if (url.pathname === '/api/auth/app/login') return send(200, { ok: true, token: APP_TOKEN, expiresAt: 9e12, user: ME });
      if (url.pathname === '/api/auth/app/code') return send(200, { ok: true, message: 'sent' });
      // 別人分享給我的東西裡**放一件純告知**。擁有者標成「不用做」的東西，被分享者
      // 若還勾得動，那一勾會 PUT 回擁有者的雲端資料——那是別人替你決定一件事做完了。
      // 共享頁是**第四條**會長勾選框的建構路徑，而 check-deps 沒有後端、走不到這裡。
      if (url.pathname === '/api/shares') return send(200, {
        outgoing: [],
        incoming: [{
          id: 'sh1', kind: 'item', permission: 'edit', ownerEmail: 'other@x.test',
          resource: {
            id: 'shared-notice', title: '別人分享的純告知', type: 'work', parentId: null,
            meetingTime: null, link: null, endDate: null, recurrence: null,
            tags: [], subtasks: [], subDone: {}, dependsOn: [], noticeOnly: true,
            date: SHARED_DAY, done: false, doneMap: {}, doneAt: {}, overrides: {}, skipped: {},
          },
        }],
      });
      if (url.pathname === '/api/activity') return send(200, { activity: [] });
      if (url.pathname === '/api/reminder') {
        if (req.method === 'PUT') {
          let raw = '';
          req.on('data', c => { raw += c; });
          return req.on('end', () => {
            try { reminderPuts.push(JSON.parse(raw)); } catch { reminderPuts.push(null); }
            send(200, { ok: true });
          });
        }
        return send(200, { enabled: false, lastSent: null, email: ME.email });
      }
      return send(200, { ok: true });
    }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (path === '/sw.js') return send(200, SW, 'text/javascript');
    if (assets.has(path)) return send(200, assets.get(path), 'text/html');
    return send(404, 'not found', 'text/plain');
  });
  server.reminderPuts = reminderPuts;
  return server;
}

/** 走完一輪所有頁面與主要互動 */
async function walk(page, log, plan = 'pro') {
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
  // ---- 方案上限：示範資料剛好 3 個大項目。免費版按「＋ 新增大項目」要開升級說明，
  //      Pro 要開新增表單。兩條路各走一次，靠兩輪不同的方案（見迴圈）。 ----
  await click('#majorChips .add-chip-btn', '按「＋ 新增大項目」');
  await page.waitForTimeout(250);
  if (plan === 'free') {
    await need('#upgradeOverlay.show', '免費版撞上限 → 升級說明');
    if (await page.locator('#majorOverlay.show').count()) throw new Error('免費版撞上限卻還是開了新增表單');
    await click('#btnUpgradeClose', '關掉升級說明');
  } else {
    await need('#majorOverlay.show', 'Pro → 新增大項目表單');
    if (await page.locator('#upgradeOverlay.show').count()) throw new Error('Pro 卻開了升級說明');
    await click('#btnCancelMajor', '關掉新增表單');
  }
  await page.waitForTimeout(200);

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
  // 純告知在共享頁**也不長勾選框**。這一條是突變驗證抓到的：把那個判斷改掉時，
  // check-deps 那一整批照樣綠——它沒有後端，共享頁永遠是空的。
  {
    step = '共享頁的純告知沒有勾選框';
    const shRow = page.locator('#sharedIncoming .share-occ').filter({ hasText: '別人分享的純告知' });
    if (!await shRow.count()) throw new Error('共享頁看不到那一筆——斷言會變成空的');
    if (await shRow.locator('.checkbox').count()) {
      throw new Error('擁有者標成「不用做」的東西，被分享者卻勾得動——那一勾會寫回擁有者的資料');
    }
    if (!await shRow.locator('.notice-gap').count()) throw new Error('佔位的空格不見了');
    checked.push('共享頁的純告知(無勾選框)');
  }

  // ---- 我的帳號 ----
  // 這一頁的每一個控制項都是從 header／footer 搬過來的**同一個元素**。搬移最
  // 可能的失敗是「元素被搬走但程式還在找它」——getElementById 回 null、整段
  // render 丟例外。那種錯誤會出現在 pageerror 裡，正是這支腳本要抓的。
  await click('#navAccount', '切到我的帳號頁');
  await page.waitForTimeout(400);
  await need('#viewAccount.active', '我的帳號頁');
  await need('#acctEmail', '帳號資訊');

  // 搬過來的控制項要真的還在。少一個就代表某段程式碼從此找不到它。
  // btnLogout 在這份清單裡是有代價換來的：它原本只在 header 右上角當一顆 11px 的
  // 小按鈕，使用者實際回報「登入後沒有登出的選項」——沒有人找得到的功能等於不存在。
  for (const id of ['btnChangePw', 'btnLogout', 'btnExport', 'btnImport', 'themeBtn', 'langBtn']) {
    await need('#' + id, id);
  }
  // **選擇器要綁在 #viewAccount 裡面。** 用全文件的 `#btnLogout` 的話，把按鈕搬回
  // header 也照樣是綠的——而那正是這條斷言要擋的那個狀態。看得見也要一起驗：
  // 只存在於 DOM 裡的按鈕沒有人按得到。
  if (!(await page.locator('#viewAccount #btnLogout').isVisible())) {
    throw new Error('「登出」不在我的帳號頁上（或看不見）');
  }
  // 連續斷掉的信（F2）：與逾期提醒各自一顆按鈕
  await need('#btnStreakMail', '櫻花樹的信開關');

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

/**
 * 休假那幾天閉嘴（C-3）：`buildReminderLeaveDays()` 真的被呼叫到，而且**只列 leave**。
 *
 * 這一條守的是〈驗證方式〉第 0 條：那個函式只在 cloudPush 成功後 3 秒才會跑，
 * 少寫一個字母的話 `npm test` 與 `node --check` 一個都不會紅，症狀只是「休假那天
 * 照樣收到信」——沒有人會把它連到某一次前端改版。
 *
 * 斷言分兩半，缺一不可：**休假那天在裡面**（不是永遠回空陣列）、**出差那天不在
 * 裡面**（「不在」的人仍在上班，照寄照推）。只驗前者的話，把 away 一起列進去
 * 仍然是綠的。
 */
async function expectLeaveDaysPushed(page, server, log) {
  // pushReminderSoon 是 3 秒的 debounce；多給一點，慢的機器上不要變成隨機紅燈
  await page.waitForFunction(() => true);
  const deadline = Date.now() + 8000;
  while (!server.reminderPuts.length && Date.now() < deadline) await page.waitForTimeout(250);

  const last = server.reminderPuts[server.reminderPuts.length - 1];
  if (!last) throw new Error('前端從來沒有推送提醒摘要——pushReminderSoon 那條路沒走到');
  if (!Array.isArray(last.leaveDays)) {
    throw new Error(`推上來的 leaveDays 不是陣列（${JSON.stringify(last.leaveDays)}）`
      + '——buildReminderLeaveDays 沒有被定義或沒有被帶進 body');
  }
  if (!last.leaveDays.includes(LEAVE_DAY)) {
    throw new Error(`休假那天（${LEAVE_DAY}）不在 leaveDays 裡：${JSON.stringify(last.leaveDays)}`);
  }
  if (last.leaveDays.includes(AWAY_DAY)) {
    throw new Error(`出差那天（${AWAY_DAY}）被當成休假了——「不在」的人仍在上班，照寄照推`);
  }
  log(`      休假那幾天閉嘴：leaveDays=${JSON.stringify(last.leaveDays)}（出差那天不在裡面）`);
}

const chromium = await loadChromium();
const failures = [];

for (const loggedIn of [false, true]) {
  for (const lang of ['zh', 'en']) {
    // 方案跟著語言走只是為了兩條路都走到：中文＝免費版（撞上限開升級說明）、英文＝Pro（開新增表單）
    const plan = lang === 'zh' ? 'free' : 'pro';
    const label = `${loggedIn ? '已登入（' + plan + '）' : '單檔開啟'} × ${lang === 'zh' ? '中文' : '英文'}`;
    const server = makeServer(loggedIn, plan);
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

    // 「單檔開啟」那兩輪刻意**不塞** workSchedule.v1：要驗的是閘門關著時沒有 seed。
    // （file:// 的 localStorage 與 http 的各自獨立，這裡塞的是 file:// 那一份。）
    await page.addInitScript(([s, l]) => {
      if (s) localStorage.setItem('workSchedule.v1', JSON.stringify(s));
      localStorage.setItem('workSchedule.v1.lang', l);
    }, [loggedIn ? seed() : null, lang]);

    console.log(`\n▸ ${label}`);
    try {
      // 閘門那兩輪真的用 file:// 開：那才是「把檔案存下來雙擊」的實際情況，
      // 也只有 file:// 能在第一次繪製前就關上閘門（http 要等 /api/state 回 404）。
      await page.goto(loggedIn ? `http://127.0.0.1:${PORT}/` : 'file://' + PUBLIC + 'index.html',
        { waitUntil: 'domcontentloaded' });
      if (loggedIn) {
        await walk(page, console.log, plan);
        await expectLeaveDaysPushed(page, server, console.log);
      } else await expectGate(page, console.log);
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
 * 沒有後端、也從來沒登入過：畫面必須是登入閘門，而且什麼都不能 seed。
 *
 * 這兩輪原本走四個頁籤（那時「單檔雙擊開啟」是一種使用方式）。使用者的裁決改成
 * 「必須登入才能使用」之後，這裡要驗的變成三件事：閘門有出現、按鈕在、localStorage
 * 裡沒有示範資料——最後一條證明閘門是在 seed 之前關上的，不是畫完再蓋上去。
 * 頁籤的走訪由「已登入」那兩輪負責。
 */
async function expectGate(page, log) {
  walk.lastStep = () => '登入閘門';
  await page.locator('#loginGate.show').waitFor({ state: 'visible', timeout: 5000 });
  const btn = page.locator('#btnLoginGate');
  if (!(await btn.isVisible())) throw new Error('閘門沒有「前往登入」按鈕');
  const text = (await btn.textContent()).trim();
  const stored = await page.evaluate(() => localStorage.getItem('workSchedule.v1'));
  if (stored !== null) throw new Error('閘門關著卻還是 seed 了示範資料（workSchedule.v1 不該存在）');
  log(`      閘門出現，按鈕「${text}」，沒有 seed`);
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

  // 訂閱（E2）。**Apple 的硬規定，缺一個就退件**，所以這幾條是斷言不是抽查：
  // 價格要從 StoreKit 拿（不是寫死的字串）、自動續訂與取消方式要寫出來、
  // 要有「恢復購買」、要連得到使用條款與隱私權政策。
  // 失敗時要說得出「為什麼」。純 timeout 的訊息（「Timeout 5000ms exceeded」）
  // 對這種斷言完全沒用——探針 1 踩過同一個坑。
  await page.waitForSelector('#acctSub', { state: 'visible', timeout: 5000 })
    .catch(async () => {
      const plan = (await page.locator('#acctPlanName').textContent().catch(() => '')) || '?';
      throw new Error(`訂閱區塊沒有出現在帳號頁（方案顯示為「${plan.trim()}」）。`
        + 'app 裡沒有訂閱入口的話 Apple 3.1.1 會退件，而且使用者付不了錢');
    });
  const prices = await page.locator('#acctSubProducts button').allTextContents();
  if (prices.length !== 2) throw new Error(`訂閱方案應該有兩個，實際 ${prices.length} 個`);
  if (!prices.some(t => t.includes('NT$150')) || !prices.some(t => t.includes('NT$1,490'))) {
    throw new Error(`價格不是從 StoreKit 拿的：${prices.join(' / ')}`);
  }
  const subTerms = (await page.locator('#acctSubTerms').textContent()) || '';
  for (const word of ['自動續訂', '取消']) {
    if (!subTerms.includes(word)) throw new Error(`訂閱說明裡沒有「${word}」（Apple 會退件）：「${subTerms}」`);
  }
  await need('#btnRestorePurchase', '恢復購買按鈕');
  await need('#acctSub a[href="/terms.html"]', '訂閱區的使用條款連結');
  await need('#acctSub a[href="/privacy.html"]', '訂閱區的隱私權政策連結');
  checked.push(`訂閱方案(${prices.length})`);

  // 推播（子專案 B）。三顆開關要在，而且**打開一個要真的去註冊 device token**——
  // 只驗按鈕在不在的話，「按了沒反應」會是綠的。
  await page.waitForSelector('#acctPush', { state: 'visible', timeout: 5000 })
    .catch(() => { throw new Error('app 裡看不到推播設定（#acctPush）'); });
  for (const id of ['btnPushOverdue', 'btnPushStreak', 'btnPushToday']) await need('#' + id, '推播開關 ' + id);
  const beforeText = (await page.locator('#btnPushToday').textContent()) || '';
  await page.click('#btnPushToday');
  await page.waitForTimeout(500);
  const afterText = (await page.locator('#btnPushToday').textContent()) || '';
  if (beforeText === afterText) {
    const msg = (await page.locator('#acctPushMsg').textContent()) || '';
    throw new Error(`按了推播開關卻沒有變（「${beforeText.trim()}」→「${afterText.trim()}」，訊息：「${msg.trim()}」）`);
  }
  if (!seen.some(r => r.path === '/api/push/register')) {
    throw new Error('打開推播卻沒有註冊 device token（沒有打到 /api/push/register）');
  }
  checked.push('推播開關(3)');

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

  // 假的 Capacitor：Keychain 用 localStorage 的一個鍵模擬，reload 之後才拿得回來。
  //
  // 形狀要跟真機上 WKWebView 注入的 native-bridge.js 一樣：**Plugins 裡沒有我們的插件**，
  // 只有底層的 nativePromise(插件, 方法, 參數)。第一版的假物件直接塞了
  // Plugins.WorkScheduleNative，比真的大方——index.html 讀那個欄位在真機上永遠是 null
  // （Keychain 沒存、購買證明「拿不到」），這裡卻全綠。假的東西不能比真的多給。
  await page.addInitScript(([s, l]) => {
    localStorage.setItem('workSchedule.v1', JSON.stringify(s));
    localStorage.setItem('workSchedule.v1.lang', l);
    const impl = {
      keychainGet: async ({ key }) => ({ value: localStorage.getItem('__kc_' + key) }),
      keychainSet: async ({ key, value }) => { localStorage.setItem('__kc_' + key, value); },
      keychainDelete: async ({ key }) => { localStorage.removeItem('__kc_' + key); },
      getAppTransaction: async () => ({ jws: 'fake.jws.for-smoke' }),
      // 訂閱（E2）。真的插件有這四個方法，假的就要有——**假的東西不能比真的少給**，
      // 少給的話「讀不到商品」那條錯誤路徑會在每一輪都跑一次，而那不是要驗的東西。
      getProducts: async () => ({ products: [
        { id: 'com.bounceto.workschedule.pro.monthly', displayPrice: 'NT$150', displayName: 'Pro', description: '', period: 'month' },
        { id: 'com.bounceto.workschedule.pro.yearly', displayPrice: 'NT$1,490', displayName: 'Pro', description: '', period: 'year' },
      ] }),
      purchase: async () => ({ jws: 'fake.subscription.jws' }),
      // 空陣列＝這個 Apple ID 上沒有訂閱。這一輪要驗的是「沒訂閱的人走得完」，
      // 所以不要在這裡假裝有訂閱——那會讓方案那一區顯示成 Pro，蓋掉免費版的路徑。
      currentEntitlements: async () => ({ jws: [] }),
      manageSubscriptions: async () => ({}),
      // 推播（子專案 B）。真的插件有這兩個方法，假的就要有。
      requestPush: async () => ({ granted: true, token: 'f'.repeat(64), environment: 'sandbox' }),
      pushStatus: async () => ({ authorized: true, environment: 'sandbox' }),
    };
    window.Capacitor = {
      isNativePlatform: () => true,
      Plugins: {},
      nativePromise: (plugin, method, opts) => {
        if (plugin !== 'WorkScheduleNative' || !impl[method]) return Promise.reject(new Error(`no such plugin method ${plugin}.${method}`));
        return impl[method](opts || {});
      },
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

// 隱私權政策頁與使用條款頁：不用登入就要開得起來（App Store 審查員會來看；
// 訂閱畫面與 App Store 的 metadata 都要連得到使用條款）
{
  const label = '隱私權政策頁與使用條款頁';
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
    await page.goto(`http://127.0.0.1:${PORT}/terms.html`, { waitUntil: 'domcontentloaded' });
    const title2 = await page.title();
    if (!/使用條款/.test(title2)) throw new Error(`使用條款的標題不對：${title2}`);
    // Apple 對訂閱 app 的硬規定：自動續訂、取消方式、退款由 Apple 處理，都要寫在條款裡
    for (const word of ['自動續訂', '訂閱', '退款', 'Terms of Use', 'Restore purchases']) {
      if (!(await page.locator(`text=${word}`).count())) throw new Error(`使用條款頁上找不到「${word}」`);
    }
  } catch (e) { errors.push(e.message); }
  if (errors.length) { failures.push({ label, errors }); console.log(`   ✗ ${errors.length} 個錯誤`); errors.forEach(e => console.log(`      - ${e}`)); }
  else console.log('   ✓ 零錯誤');
  await browser.close();
  await new Promise(r => server.close(r));
}

/**
 * 第七輪：外殼探針。
 *
 * TestFlight build 7 回報的症狀是「app 安靜地變成單機模式」——沒有紅字、沒有 app 的
 * 登入畫面、畫面上是示範資料。那個狀態有三個各自獨立的成因，而三個**在畫面上長得
 * 一模一樣**，也全部不會讓既有的檢查變紅（第五輪的假 Capacitor 剛好三個都避開了）：
 *
 *   1. 沒認出自己是 app——偵測只問 `Capacitor.isNativePlatform` 一個名字，而真機上的
 *      window.Capacitor 是注入的 native-bridge.js，給的東西與 @capacitor/core 不同
 *      （Plugins 是空的已經踩過一次，見〈iOS app〉）。認錯的後果是整個 app 退回網頁版
 *      那條路：打自己肚子裡的 /api/state、不帶 Bearer、不讀 Keychain
 *   2. 認出來了，但原生插件不在——登入得了、存不住，reload 又回到登入畫面（build 6）
 *   3. `/api/state` 回 404 被當成「這個環境沒有後端」而靜默降級。absent 那條路是為了
 *      單檔／未部署而存在的，在 app 裡永遠是謊話（API_BASE 是線上網址）
 *
 * 九個探針各塞一個**殘缺的** window.Capacitor，每個只驗一件事。刻意不把第五輪的假
 * Capacitor 改殘缺：那一輪要驗的是「正常的 app 走得完」，混在一起哪個壞了都分不出來。
 */
{
  const label = 'iOS app 外殼的九個探針';
  const server = makeServer(true);
  await new Promise(r => server.listen(PORT, r));
  const launch = process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {};
  const browser = await chromium.launch(launch);
  const errors = [];
  const checked = [];
  console.log(`\n▸ ${label}`);

  /** 各自一個乾淨的 context：偵測是在載入當下算一次的，改不了就只能重開 */
  const shell = async (keys, { token = null, state404 = false, stateNoUser = false, stateHang = false, stateSlow = 0 } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 860 }, locale: 'zh-TW' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`未捕捉的例外：${e.message}`));
    await page.route('**://fonts.*/**', r => r.abort());
    await page.route(APP_API_ORIGIN + '/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      // 永遠不回應：模擬「連線掛在那裡，不回也不錯」。這種請求沒有任何事件，
      // 舊的程式會停在那個 await 上，畫面永遠是示範資料。
      if (stateHang && u.pathname === '/api/state') return;   // 不 fulfill、不 abort
      // 慢但會回：留出一段「使用者已經切到帳號頁、但同步還沒完成」的時間差。
      // 那正是探針 9 要重現的形狀，而它在開發機上幾乎快到踩不到。
      // **只延遲 GET**：同步完成後的 PUT 也被延遲的話，它會落在 ctx.close() 之後，
      // 然後對著已經關掉的測試伺服器發 fetch（實際踩過，整支測試當場掛掉）。
      if (stateSlow && u.pathname === '/api/state' && req.method() === 'GET') {
        await new Promise(r => setTimeout(r, stateSlow));
      }
      if (state404 && u.pathname === '/api/state') {
        return route.fulfill({ status: 404, body: '{"error":"not found"}', headers: { 'content-type': 'application/json' } });
      }
      // 200 但 body 裡沒有 user：`!remote.user` 那條分支會 setCloudNote('') 然後靜默降級
      if (stateNoUser && u.pathname === '/api/state' && req.method() === 'GET') {
        return route.fulfill({ status: 200, body: '{"state":null,"updatedAt":null}', headers: { 'content-type': 'application/json' } });
      }
      // 這個 handler 可能在 context 關掉之後才跑完（延遲、或瀏覽器排隊）。那時候
      // 測試伺服器已經收掉，proxy 的 fetch 會丟 ECONNREFUSED 並變成 unhandled
      // rejection，把整支測試一起帶走——而那與被測的程式完全無關。
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}${u.pathname}${u.search}`, {
          method: req.method(), headers: { 'content-type': 'application/json' }, body: req.postData() ?? undefined,
        });
        await route.fulfill({ status: r.status, body: await r.text(), headers: { 'content-type': 'application/json' } });
      } catch { try { await route.abort(); } catch { /* context 已經關了 */ } }
    });
    await page.addInitScript(([ks, tok, l]) => {
      localStorage.setItem('workSchedule.v1.lang', l);
      if (tok) localStorage.setItem('__kc_sessionToken', tok);
      const impl = {
        keychainGet: async ({ key }) => ({ value: localStorage.getItem('__kc_' + key) }),
        keychainSet: async ({ key, value }) => {
          // 「讀得到、寫不進去」是真機上最惡毒的一種：登入會成功，但 token 存不住。
          if (ks.includes('writeFails')) throw new Error('keychain write denied');
          localStorage.setItem('__kc_' + key, value);
        },
        keychainDelete: async ({ key }) => { localStorage.removeItem('__kc_' + key); },
        getAppTransaction: async () => ({ jws: 'fake.jws.for-smoke' }),
        getProducts: async () => ({ products: [] }),
        purchase: async () => ({ cancelled: true }),
        currentEntitlements: async () => ({ jws: [] }),
        manageSubscriptions: async () => ({}),
        requestPush: async () => ({ granted: false, token: null, environment: 'sandbox' }),
        pushStatus: async () => ({ authorized: false, environment: 'sandbox' }),
      };
      const cap = { Plugins: {} };            // 真機上 Plugins 永遠是空的
      if (ks.includes('isNativePlatform')) cap.isNativePlatform = () => true;
      if (ks.includes('getPlatform')) cap.getPlatform = () => 'ios';
      if (ks.includes('nativePromise')) {
        cap.nativePromise = (plugin, method, opts) => {
          if (plugin !== 'WorkScheduleNative' || !impl[method]) return Promise.reject(new Error(`no such plugin method ${plugin}.${method}`));
          return impl[method](opts || {});
        };
      }
      // 「讀 bridge 就爆」的外殼。它代表的是**啟動路徑上的任何一個例外**——那種例外在
      // fire-and-forget 的 async 裡只會變成 unhandledrejection，連 pageerror 都不算，
      // 所以除了看畫面之外沒有別的辦法抓到它。
      // 打得出去、永遠不回話：真機上「插件沒註冊／方法名對不上／Swift 沒走到 resolve」
      // 就是這個形狀。**不是 reject，是完全沒有下文**（TestFlight build 9 的形狀）。
      if (ks.includes('hangPromise')) cap.nativePromise = () => new Promise(()=>{});
      if (ks.includes('throwOnRead')) {
        Object.defineProperty(cap, 'nativePromise', { get(){ throw new Error('bridge exploded'); } });
      }
      window.Capacitor = cap;
    }, [keys, token, 'zh']);
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
    return { ctx, page };
  };
  const noteText = page => page.locator('#cloudNoteText').innerText().catch(() => '');

  try {
    // 探針 1：bridge 只給 nativePromise（沒有 isNativePlatform）。仍然必須認出自己是
    // app —— 認出來的唯一可見證據就是 app 的登入畫面蓋上來（網頁版那條路不會有它）。
    {
      const { ctx, page } = await shell(['nativePromise']);
      await page.waitForSelector('#appAuthView.show', { timeout: 5000 }).catch(async () => {
        // 診斷行就是為了這一刻存在的：它會說出當下看到哪些訊號
        const diag = (await page.locator('#loginGateDiag').innerText().catch(() => '')) || '(閘門沒出現，它當成一般網頁同步了)';
        throw new Error(`探針 1：沒認出自己是 app（app 的登入畫面沒出現）。閘門診斷：${diag}`);
      });
      if (await page.locator('#loginGate.show').count()) throw new Error('探針 1：不該出現網頁版的登入閘門');
      checked.push('只有 nativePromise 也認得自己是 app');
      await ctx.close();
    }
    // 探針 2：認得自己，但插件不在（沒有 nativePromise、Plugins 空）。登入得了卻存不住，
    // 所以要在登入畫面之前就說出來——手機上沒有 console，只能寫在畫面上。
    {
      const { ctx, page } = await shell(['isNativePlatform']);
      await page.waitForFunction(() => /app 啟動異常/.test(document.getElementById('cloudNoteText')?.innerText || ''), null, { timeout: 5000 })
        .catch(async () => { throw new Error(`探針 2：插件不在卻沒說，狀態列是「${await noteText(page)}」`); });
      const t = await noteText(page);
      if (!/signals=/.test(t)) throw new Error(`探針 2：訊息裡沒有附上診斷資訊：「${t}」`);
      checked.push('插件不在會說出來並附診斷');
      await ctx.close();
    }
    // 探針 3：外殼正常、Keychain 有 token，但 /api/state 回 404。app 裡不存在「沒有後端」
    // 這種狀態，所以它必須是紅字的連線失敗，不可以安靜地變成單機模式。
    {
      const { ctx, page } = await shell(['isNativePlatform', 'getPlatform', 'nativePromise'], { token: APP_TOKEN, state404: true });
      await page.waitForSelector('#cloudNoteText .storage-state.err', { timeout: 5000 })
        .catch(async () => { throw new Error(`探針 3：404 被靜默吞掉了，狀態列是「${await noteText(page)}」`); });
      const t = await noteText(page);
      if (!/連線失敗/.test(t)) throw new Error(`探針 3：狀態列不是連線失敗：「${t}」`);
      checked.push('app 裡的 404 是紅字不是單機模式');
      await ctx.close();
    }
    // 探針 4：啟動流程中途丟例外。nativeBoot 是 fire-and-forget 的 async，沒有 .catch
    // 的話那個例外只會變成 unhandledrejection——**連 pageerror 都不算**，畫面就停在
    // 示範資料、狀態列一片乾淨，與正常的單機模式一模一樣（build 7 回報的形狀之一）。
    {
      const { ctx, page } = await shell(['isNativePlatform', 'throwOnRead']);
      await page.waitForFunction(() => /app 啟動異常/.test(document.getElementById('cloudNoteText')?.innerText || ''), null, { timeout: 5000 })
        .catch(async () => { throw new Error(`探針 4：啟動摔倒卻沒人接住，狀態列是「${await noteText(page)}」`); });
      checked.push('啟動摔倒會被接住並說出來');
      await ctx.close();
    }
    // 探針 5：最後一道保險。外殼與網路都正常，只是 /api/state 回 200 卻沒有 user——
    // 那條分支會 setCloudNote('') 然後靜默降級，**連紅字都沒有**（build 8 回報的形狀）。
    // 逐條堵洞永遠會漏掉下一條，所以帳號頁多一格：只要走到單機模式而環境看起來像 app，
    // 就把當下的訊號印出來。這一支守的是那一格，不是某一條路。
    {
      const { ctx, page } = await shell(['isNativePlatform', 'getPlatform', 'nativePromise'], { token: APP_TOKEN, stateNoUser: true });
      await page.click('#navAccount');
      await page.waitForFunction(() => {
        const d = document.getElementById('acctSignedOutDiag');
        return d && d.offsetParent !== null && /signals=/.test(d.textContent || '');
      }, null, { timeout: 5000 }).catch(async () => {
        const t = await page.locator('#acctSignedOutDiag').innerText().catch(() => '(看不到)');
        throw new Error(`探針 5：app 走到單機模式卻沒印診斷，帳號頁那一格是「${t}」`);
      });
      checked.push('單機模式在 app 裡一定帶著診斷');
      await ctx.close();
    }
    // 探針 6：電話打得出去、對面永遠不回話（插件沒註冊／方法名對不上／Swift 沒走到
    // resolve）。**不是 reject，是完全沒有下文**——沒有例外、沒有 rejection、沒有任何
    // 事件，舊的程式就停在那個 await 上（TestFlight build 9 的形狀：五個訊號全中、
    // plugin=yes，卻什麼都沒發生）。時限要把它變成一個會說話的失敗。
    {
      const { ctx, page } = await shell(['isNativePlatform', 'hangPromise']);
      await page.waitForSelector('#appAuthView.show', { timeout: 12000 })
        .catch(async () => { throw new Error(`探針 6：原生電話沒人接，卻沒有回到登入畫面（狀態列「${await noteText(page)}」）`); });
      const msg = await page.locator('#appAuthMsg').innerText().catch(() => '');
      if (!/probe=timeout/.test(msg)) throw new Error(`探針 6：登入畫面沒說出「對面沒接」：「${msg}」`);
      checked.push('原生電話沒人接會超時並說出來');
      await ctx.close();
    }
    // 探針 7：看門狗。外殼完全正常、Keychain 有 token，但 /api/state **永遠不回應**。
    // 這一支守的不是某一條路，是「開機有沒有走到任何一種結局」——任何一個不會 settle
    // 的 await 都會落在這裡，包括我還沒想到的那些。
    {
      const { ctx, page } = await shell(['isNativePlatform', 'getPlatform', 'nativePromise'], { token: APP_TOKEN, stateHang: true });
      await page.waitForFunction(() => /啟動卡住了/.test(document.getElementById('cloudNoteText')?.innerText || ''), null, { timeout: 20000 })
        .catch(async () => { throw new Error(`探針 7：開機卡住卻沒有人開口，狀態列是「${await noteText(page)}」`); });
      checked.push('開機卡住會被看門狗抓到');
      await ctx.close();
    }
    // 探針 8：登入成功，但 Keychain **寫**不進去。這是那個無限輪迴的最後一哩——
    // 前七支守的都是「開機」，而這一條發生在開機之後：登入成功 → reload → Keychain 還是
    // 空的 → 又回到登入畫面，一次又一次，全程沒有任何一句話（build 6～10 的症狀）。
    // 所以斷言有兩條，缺一不可：**不准回到登入畫面**，而且**要說出原因**。
    {
      const { ctx, page } = await shell(['isNativePlatform', 'getPlatform', 'nativePromise', 'writeFails']);
      await page.waitForSelector('#appAuthView.show', { timeout: 15000 });
      await page.fill('#inputAppAuthEmail', ME.email);
      await page.fill('#inputAppAuthPw', 'correct-horse-battery');
      await page.click('#btnAppAuthSubmit');
      await page.waitForFunction(() => /存不住登入狀態/.test(document.getElementById('cloudNoteText')?.innerText || ''), null, { timeout: 15000 })
        .catch(async () => { throw new Error(`探針 8：登入後 token 存不住，卻沒有人說一句話（狀態列「${await noteText(page)}」）`); });
      if (await page.locator('#appAuthView.show').count()) {
        throw new Error('探針 8：存不住卻又退回登入畫面——那正是要擋的無限輪迴');
      }
      const t = await noteText(page);
      if (!/signals=/.test(t)) throw new Error(`探針 8：訊息裡沒有附上診斷資訊：「${t}」`);
      checked.push('登入後存不住會說出來，而且不退回登入畫面');
      await ctx.close();
    }
    // 探針 9：外殼、Keychain、網路全部正常，只是 **/api/state 慢了一拍**，而使用者在
    // 那之前就切到「我的帳號」。前八支守的是「同步真的壞掉」，這一支守的是**同步好好的、
    // 只有那一頁沒跟上**：帳號頁寫「目前為單機模式」，而同一個畫面下方的 footer 寫
    // 「雲端同步啟用中」。兩句話互相矛盾，畫面不會壞、不會報錯，使用者只會以為自己
    // 沒登入（實際回報過）。根因是 cloudEnabled 有五個地方會改，五處都記得更新 footer、
    // 沒有一處記得帳號頁——所以現在一律走 setCloudEnabled()。
    {
      const { ctx, page } = await shell(['isNativePlatform', 'getPlatform', 'nativePromise'], { token: APP_TOKEN, stateSlow: 1500 });
      // **第一次載入不算數**：那一次走的是「這台裝置初次開啟 → 採用雲端」，而那條分支
      // 結尾有一個 renderAll()，會順手把帳號頁重畫，bug 被蓋掉（第一版的探針就是這樣
      // 綠的，突變驗證時才發現它過關的理由是錯的）。要重現的是**另一條**：本機已經有
      // 資料、版本也對得上 → 直接 cloudPush() 就 return，中間沒有任何重繪。
      await page.waitForFunction(() => /雲端同步啟用中/.test(document.getElementById('storageNoteText')?.innerText || ''), null, { timeout: 15000 })
        .catch(() => { throw new Error('探針 9：第一次載入就沒有同步成功，這支測試的前提不成立'); });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#navAccount', { timeout: 10000 });
      await page.click('#navAccount');
      // 先確認這一刻真的還沒同步完——否則這支測試會在跟 1500ms 賽跑，
      // 修正拿掉了也可能照樣綠（同〈驗這件事不能用 page.reload()〉那個坑）。
      const earlyNote = await page.locator('#acctSignedOutNote').isVisible().catch(() => false);
      if (!earlyNote) throw new Error('探針 9：切過去的當下同步就已經完成了，這支測試沒有測到那個時間差');
      await page.waitForFunction(() => /雲端同步啟用中/.test(document.getElementById('storageNoteText')?.innerText || ''), null, { timeout: 15000 })
        .catch(() => { throw new Error('探針 9：同步一直沒有完成，這支測試的前提不成立'); });
      if (await page.locator('#acctSignedOutNote').isVisible()) {
        throw new Error('探針 9：同步已經啟用，帳號頁卻還寫著「目前為單機模式」——兩句話互相矛盾');
      }
      if (!(await page.locator('#acctReminderSub').isVisible())) {
        throw new Error('探針 9：同步已經啟用，帳號頁的雲端區塊卻還是隱藏的');
      }
      checked.push('同步晚一步完成時帳號頁會跟上');
      await ctx.close();
    }
  } catch (e) {
    errors.push(e.message.split('\n')[0]);
  }
  if (checked.length) console.log(`      驗過：${checked.join('、')}`);
  if (errors.length) { failures.push({ label, errors }); console.log(`   ✗ ${errors.length} 個錯誤`); errors.forEach(e => console.log(`      - ${e}`)); }
  else console.log('   ✓ 零錯誤');
  await browser.close();
  await new Promise(r => server.close(r));
}

const TOTAL = 7;
console.log('');
if (failures.length) {
  console.error(`✗ 冒煙測試失敗：${failures.length}/${TOTAL} 個情境有問題`);
  process.exit(1);
}
console.log(`✓ ${TOTAL} 個情境全部走完，零 pageerror、零 console.error`);
