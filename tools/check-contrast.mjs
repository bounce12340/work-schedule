/**
 * 文字對比度。
 *
 * 為什麼需要這支
 * ---------------------------------------------------------------------------
 * 改配色時最容易壞、而且**眼睛最看不出來**的就是對比度：在自己那台校色良好的
 * 螢幕上「看起來還行」的淺灰字，在別人的筆電、在陽光下的手機上就是讀不到。
 * 它不會拋錯、不會破版，沒有任何一支現有檢查會紅。
 *
 * 這個專案還多一層風險：亮色與暗色是**兩組各自獨立的變數**，改了一組忘了另一組
 * 的症狀正是「白天正常，暗色模式下某一塊變成看不見的低對比」（CLAUDE.md 記過）。
 * 所以這支兩種主題都量。
 *
 * 判準用 WCAG 2.1 的對比公式：一般內文 4.5:1、大字（>=18.66px 或 >=14px 粗體）
 * 3:1。**刻意只擋「正文級」的元素**——徽章、時間戳這類輔助資訊本來就該退到後面，
 * 用同一條線去要求它們只會逼人把整個介面調得死板。
 *
 * 依賴 Playwright，而 Playwright **不是**本專案的相依套件（零相依是專案前提），
 * 所以放在 tools/ 而不是 tests/。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { markSignedIn } from './lib/signed-in.mjs';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('需要 Playwright，但它不是本專案的相依套件（零相依是專案前提）。');
  console.error('要跑這個驗證請先安裝：npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const PORT = Number(process.env.PORT || 8992);

const srv = createServer((q, r) => {
  const n = new URL(q.url, 'http://x').pathname.slice(1) || 'index.html';
  if (n.startsWith('api/')) { r.writeHead(404); r.end('{}'); return; }
  let b; try { b = readFileSync(PUBLIC + n); } catch { r.writeHead(404); r.end('x'); return; }
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  r.end(b);
});
srv.listen(PORT);

// 量哪些元素。刻意只列「要讀的字」，不列徽章與輔助資訊——理由見檔頭。
const TARGETS = [
  ['.brand-title', '系統標題'],
  ['.occ-title', '項目標題'],
  ['.occ-date', '日期'],
  ['.metric-list-row', '指標卡的列'],
  ['.nav-item', '頁籤'],
  ['.chip-name', '大項目名稱'],
  ['.qbtn', '篩選鈕'],
  ['.brand-eyebrow', '招呼語'],
  ['.daylog-label', '每日記錄標題'],
  ['.notice-badge', '純告知的小標'],
];

/**
 * 要按幾下才看得到的元素。
 *
 * 「不在」的按鈕帶了一個**新的顏色 token**（`--away`），而這支腳本存在的理由
 * 正是「新顏色在其中一個主題下靜靜地變成看不見」。它預設不在畫面上，所以
 * 不能只靠上面那份清單——不量等於這個 token 完全沒有被守到。
 */
const AFTER_CLICKS = [
  ['#btnToggleAway', '「不在」按鈕'],
];

/**
 * 帳號頁的取消訂閱區。**新的一塊 UI，而且刻意做得比旁邊醒目**——
 * 正因為「醒目」是它的重點，讀不讀得清楚就不能靠感覺。
 *
 * 它預設不在畫面上（要先切到「我的帳號」），所以不能只靠 TARGETS——
 * 不量等於這一塊完全沒有被守到（同〈永遠不會執行的斷言〉）。
 */
const IN_ACCOUNT = [
  ['.acct-unsub .acct-sub', '取消訂閱的說明'],
  ['#btnUnsubAll', '「全部都不要了」按鈕'],
];

/**
 * 休假格子的日期。它用的是**新的顏色 token**（`--leave`），而且壓在一層玻璃紙上
 * （`.cal-cell.leave::before`）——那層不是任何元素的祖先，`bgOf()` 看不到它，
 * 量到的會是「沒有玻璃紙」的漂亮數字。解法同光暈（見 measure 裡的 leaveWorst）。
 *
 * **只量非今天的格子**：今天那一格的日期本來就是琥珀色（那是「今天在哪裡」的
 * 標記，與這層玻璃紙無關）。
 *
 * 格子裡的**項目文字**現在也量得到了（見 `IN_LEAVE_TODAY`）。先前量不了的理由是
 * `bgOf()` 遇到半透明的祖先會直接跳過——示範資料在這個月只有今天那一格有項目，
 * 而 `.cal-cell.today` 的背景 alpha 只有 0.09，於是量到的是光暈而不是實際底色
 * （1.5:1 的假紅燈）。那個盲點已經補掉：半透明的祖先現在會由外往內疊起來。
 */
const IN_LEAVE_CELL = [
  ['.cal-cell.leave:not(.today) .cal-daynum', '休假格子的日期'],
];

/**
 * 「休假格子裡的項目文字」量過了，**而且量出一個這支腳本修不掉的問題**，所以
 * 先不放進會讓 CI 變紅的清單——但數字要寫下來，不要變成一句「以後再說」。
 *
 * 量到的（亮色，今天＋休假那一格，底色合成後是 rgb(219,217,203)）：
 *
 *   · 還沒做的作業類項目  `--amber` #C9822E     **2.2:1**（需要 4.5:1）
 *   · 已完成的項目        `--text-dim` #A2A099  **1.84:1**
 *   · 換成 `--amber-ink` #8A5716 也只有         **4.29:1**——仍然不夠
 *   · 工作類的 `--teal` #1F8C68 在同一格是      **2.96:1**
 *
 * 這是〈顏色不只要好看，要量得出來〉那個 bug class 的第四次（頁籤、篩選鈕、
 * 空狀態之後），但這一次**換一個 token 解決不了**：`.cal-item-text` 的顏色
 * 就是型別的編碼（teal＝工作、amber＝作業、violet＝會議），把它們一起壓深到
 * 4.5:1 等於改掉整個日曆的顏色語言。那是產品決定，不是一支檢查腳本該順手做的
 * ——同 `--amber` 當初沒有被直接改掉、而是另開 `--amber-ink` 的理由。
 *
 * 要做的時候有三條路，都要先看過畫面：型別改用**形狀或圖示**而不是顏色、
 * 把每一種顏色各自做一個 `-ink` 版本、或是把格子裡的文字改成 `--text` 而讓
 * 顏色只留在左邊那顆點上。
 */

/**
 * 純告知（B）帶了一個**新的顏色 token**（`--notice`），而它的兩種狀態要分開量：
 *
 *   · `.notice-badge` 在示範資料裡本來就看得到（seed 有一件在兩天後）
 *   · `.notice-past` **要自己造**——示範那一件在未來，而「畫面上沒有這個元素，
 *     略過」是一條永遠不會執行的斷言（那一節抓到過兩個已經上線很久的問題）
 *
 * 過期的淡化**必須靠字級**，不是把顏色調到讀不了。所以這兩條量的就是「淡下去
 * 之後仍然讀得到」——量不過就表示淡化的方式選錯了。
 */
const NOTICE_PAST = [
  ['.occ-row.notice-past .occ-title', '過期純告知的標題'],
  ['.occ-row.notice-past .occ-date', '過期純告知的日期'],
];

/**
 * 空狀態原本掛在上面那份清單裡，但示範資料一定有項目，所以它每次都印
 * 「畫面上沒有這個元素，略過」——**一條永遠不會執行的斷言，與沒有這條一樣**，
 * 而且還會給出「已經量過了」的錯覺。空白時刻現在是這個介面刻意做柔的地方
 * （宋體、放鬆的行高），更不能靠運氣。所以改成主動把畫面逼成空的：
 * 搜尋一個不存在的字，篩選後的空狀態就會出現。
 */
const AFTER_SEARCH = [
  ['.empty-state', '空狀態'],
  ['.empty-state .empty-line2', '空狀態的第二行'],
  ['.empty-state span:not(.empty-line2)', '空狀態裡的強調字'],
];

/**
 * 在頁面裡量一份清單。兩份清單（一進頁面就在的、要按幾下才有的）共用同一套
 * 判準——分兩份寫遲早會分歧，而分歧的那一份會給出一個看起來很漂亮的假數字。
 */
const measure = sels => {
  // sRGB → 相對亮度（WCAG 2.1）
  const lum = ([r, g, b]) => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const parse = s => (s.match(/[\d.]+/g) || []).slice(0, 4).map(Number);
  const over = (top, base) => {           // top: [r,g,b,a] 疊在不透明的 base 上
    const a = top.length >= 4 ? top[3] : 1;
    return [0, 1, 2].map(i => Math.round(top[i] * a + base[i] * (1 - a)));
  };
  // 背景要往上找到第一個不透明的祖先——元素自己通常是 transparent，
  // 拿 transparent 去算對比會得到一個漂亮但完全假的數字。
  //
  // **半透明的祖先要疊起來，不能跳過。** 原本遇到 alpha ≤ 0.92 就直接略過、
  // 一路掉到 body，於是 `.cal-cell.today`（--today-bg 的 alpha 只有 0.09）裡面的字
  // 量到的是光暈而不是它實際壓在上面的顏色，數字低到 1.5:1——而畫面上讀得很清楚。
  // 那是工具的**假紅燈**，而假紅燈與假綠燈一樣糟：兩者都會讓人不再相信這一頁。
  //
  // 疊的順序是**由外往內**：最外面那一層先壓在不透明的底上，再一層層往內。
  // 反過來疊出來的顏色不對（alpha 不可交換）。
  const bgOf = (el, baseOverride) => {
    const layers = [];      // 由內往外收集，等一下反過來疊
    let base = null;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c.length < 3) continue;
      const a = c[3] === undefined ? 1 : c[3];
      if (a === 0) continue;                      // 完全透明：沒有貢獻
      if (a > 0.92) { base = c.slice(0, 3); break; }
      layers.push([c[0], c[1], c[2], a]);
    }
    if (base === null) {
      const c = parse(getComputedStyle(document.body).backgroundColor);
      base = baseOverride || (c.length >= 3 ? c.slice(0, 3) : [255, 255, 255]);
    }
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  };
  // 光暈畫在 body::before 上，不是任何元素的祖先，bgOf() 看不到它——所以直接
  // 坐在 body 上的字（招呼語、標題）量到的一直是 --bg，而不是它實際壓在上面的
  // 顏色。這裡改成算**最差情況**：把三團光暈各自以滿 alpha 疊在 --bg 上，取三者
  // 之中對比最低的那一個。任何位置的真實對比都不會比這個更差。
  const root = getComputedStyle(document.documentElement);
  const token = n => parse(root.getPropertyValue(n));
  const ratioOf = (fg, bg) => {
    const L1 = lum(fg), L2 = lum(bg);
    return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
  };
  // **光暈是最底下那一層，不是最上面那一層。** 它畫在 body::before 上，所以任何
  // 半透明的祖先（例如 `.nav-item.active` 的 --amber-dim）都疊在它**上面**。
  // 第一版把它當成疊在合成後的背景之上，算出來的顏色順序是反的——alpha 不可交換，
  // 那個數字看起來像個對比值，其實不對應畫面上任何一個位置。
  const haloWorst = (fg, el) => {
    const bodyBg = parse(getComputedStyle(document.body).backgroundColor).slice(0, 3);
    let worst = Infinity;
    for (const n of ['--halo-a', '--halo-b', '--halo-c']) {
      const h = token(n); if (h.length < 3) continue;
      worst = Math.min(worst, ratioOf(fg, bgOf(el, over(h, bodyBg))));
    }
    return worst;
  };
  // 休假的底色畫在 `.cal-cell.leave::before` 上——**同樣不是任何元素的祖先**，
  // 所以 bgOf() 對格子裡的字量到的是 --panel，不是它實際壓在上面的顏色。
  // 這與光暈是同一個盲點，用同一個解法：把 --leave-dim 疊上去再算一次，取較差的。
  const inLeaveCell = el => !!(el.closest && el.closest('.cal-cell.leave'));
  const leaveWorst = (fg, bg) => {
    const t = token('--leave-dim'); if (t.length < 3) return Infinity;
    const L1 = lum(fg), L2 = lum(over(t, bg));
    return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
  };
  const sitsOnBody = el => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c.length >= 3 && (c[3] === undefined || c[3] > 0.92)) return false;
    }
    return true;
  };
  const out = [];
  for (const [sel, label] of sels) {
    const el = document.querySelector(sel);
    if (!el) { out.push({ sel, label, missing: true }); continue; }
    const cs = getComputedStyle(el);
    const fg = parse(cs.color).slice(0, 3);
    const bg = bgOf(el);
    let ratio = ratioOf(fg, bg);
    if (sitsOnBody(el)) ratio = Math.min(ratio, haloWorst(fg, el));
    if (inLeaveCell(el)) ratio = Math.min(ratio, leaveWorst(fg, bg));
    const px = parseFloat(cs.fontSize);
    const w = parseInt(cs.fontWeight) || 400;
    const large = px >= 18.66 || (px >= 14 && w >= 700);
    out.push({ sel, label, ratio: +ratio.toFixed(2), px, large, need: large ? 3 : 4.5 });
  }
  return out;
};

const br = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM });
const problems = [];

// 天空會跟著時段變色，而 header 的字（招呼語、標題）直接坐在光暈上——
// 所以除了亮暗兩種主題，傍晚那組光暈也要量一次。時間用 page.clock 釘死，
// 不靠執行當下幾點；不然這個檢查會在白天過、晚上紅，沒有人會相信它。
// ---------- 工具的自我檢查 ----------
//
// `bgOf()` 會不會疊半透明的祖先，**畫面上的元素證明不了**：顏色是產品決定，
// 今天剛好誰過誰不過，跟這條規則對不對無關。所以用一個答案已知的假元素直接問它。
//
// 黑字，外面一層 alpha 0.5 的黑，再外面是不透明的白：
//   疊起來 → 底色 rgb(128,128,128)，黑字對它大約 5.3:1
//   跳過   → 底色 rgb(255,255,255)，黑字對它 21:1
// 兩個差了四倍，不會因為誰調了一個色碼就分不出來。
const SELF_CHECK = async page => {
  const got = await page.evaluate(m => {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:0;top:0;background:#fff;z-index:-9999';
    box.innerHTML = '<div style="background:rgba(0,0,0,0.5)"><span id="__cc" style="color:#000">x</span></div>';
    document.body.appendChild(box);
    const r = (new Function('sels', 'return (' + m + ')(sels)'))([['#__cc', 'self']]);
    box.remove();
    return r[0] && r[0].ratio;
  }, measure.toString());
  if (!(got > 4.8 && got < 6)) {
    throw new Error(`bgOf() 沒有疊半透明的祖先：假元素量到 ${got}:1，疊起來應該是 5.3:1 左右（跳過的話會是 21:1）`);
  }
  console.log(`  ✓ 自我檢查：半透明的祖先有被疊起來（假元素 ${got}:1）`);
};

const PASSES = [
  ['light', '亮色', null],
  ['dark', '暗色', null],
  ['light', '亮色・傍晚', '2026-09-09T20:30:00'],
  ['dark', '暗色・傍晚', '2026-09-09T20:30:00'],
];
for (const [theme, label, fixedTime] of PASSES) {
  const page = await br.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-TW' });
  if (fixedTime) await page.clock.setFixedTime(new Date(fixedTime));
  await page.addInitScript(t => { try { localStorage.setItem('workSchedule.v1.theme', t); } catch (e) {} }, theme);
  await markSignedIn(page);   // 登入閘門：見 tools/lib/signed-in.mjs
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('#board');
  await page.waitForTimeout(800);
  if (label === '亮色') await SELF_CHECK(page);
  await page.locator('#reminderClose').click().catch(() => {});
  await page.waitForTimeout(200);

  const rows = await page.evaluate(measure, TARGETS);

  // 切到日曆、選一天，才量得到那顆按鈕
  await page.locator('.nav-item', { hasText: '日曆' }).click();
  await page.waitForSelector('#calGrid .cal-cell[data-date]');
  await page.locator('.cal-cell[data-date]').first().click();
  await page.waitForTimeout(300);
  rows.push(...await page.evaluate(measure, AFTER_CLICKS));

  // 切到「我的帳號」量取消訂閱那一區
  await page.locator('.nav-item', { hasText: '我的帳號' }).click();
  await page.waitForSelector('#viewAccount.active');
  await page.waitForTimeout(300);
  rows.push(...await page.evaluate(measure, IN_ACCOUNT));

  // 量完切回日曆，後面那幾段還要用到日曆的畫面
  await page.locator('.nav-item', { hasText: '日曆' }).click();
  await page.waitForSelector('#calGrid .cal-cell[data-date]');
  await page.waitForTimeout(200);

  // 造一格休假出來再量。**不能等它自然出現**：示範資料的休假日落在下個月，
  // 而「畫面上沒有這個元素，略過」是一條永遠不會執行的斷言。
  // 走的是應用程式自己的寫入路徑（開面板 → 選休假 → 加上去），不是硬塞 class
  // ——硬塞的話，哪天 renderCalendar 不再畫那個 class 了，這裡還是綠的。
  await page.locator('.cal-cell[data-date]:not(.today)').first().click();
  await page.waitForTimeout(250);
  await page.locator('#btnToggleAway').click();
  await page.waitForTimeout(200);
  await page.locator('#absKindLeave').click();
  await page.locator('#btnAbsAdd').click();
  await page.waitForTimeout(350);
  rows.push(...await page.evaluate(measure, IN_LEAVE_CELL));


  // 造一件**已經過期**的純告知再量。同樣走應用程式自己的寫入路徑（開新增視窗 →
  // 勾「純告知」→ 填一個過去的日期），不是硬塞 class：硬塞的話，哪天 buildOccRow
  // 不再加那個 class 了，這裡還是綠的。
  await page.locator('.nav-item', { hasText: '項目安排' }).click();
  await page.waitForSelector('#board');
  await page.locator('#openItemModal').click();
  await page.waitForTimeout(250);
  await page.fill('#inputItemTitle', '去年的公告');
  await page.locator('#inputNoticeOnly').check();
  await page.fill('#inputItemDate', '2026-01-05');
  await page.locator('#btnConfirmItem').click();
  await page.waitForTimeout(400);
  rows.push(...await page.evaluate(measure, NOTICE_PAST));

  // 逼出空狀態：回到項目安排頁，搜尋一個不會命中的字
  await page.locator('.nav-item', { hasText: '項目安排' }).click();
  await page.waitForSelector('#board');
  await page.fill('#inputSearch', 'zzz不存在的東西zzz');
  await page.waitForTimeout(400);            // 搜尋有 180ms debounce
  rows.push(...await page.evaluate(measure, AFTER_SEARCH));

  console.log(`\n===== ${label} =====`);
  for (const r of rows) {
    if (r.missing) { console.log(`  ?  ${r.label}（畫面上沒有這個元素，略過）`); continue; }
    const ok = r.ratio >= r.need;
    console.log(`  ${ok ? '✓' : '✗'}  ${String(r.ratio).padStart(5)}:1  (需要 ${r.need}:1)  ${r.label}  ${r.px}px`);
    if (!ok) problems.push(`${label}｜${r.label}：${r.ratio}:1，低於 ${r.need}:1`);
  }
  await page.close();
}

console.log('');
if (problems.length) { problems.forEach(p => console.log('  ✗ ' + p)); }
else console.log('✓ 兩種主題的正文級文字都達到 WCAG 標準');
await br.close(); srv.close();
process.exit(problems.length ? 1 : 0);
