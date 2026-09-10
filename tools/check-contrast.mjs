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
  // 背景要往上找到第一個不透明的祖先——元素自己通常是 transparent，
  // 拿 transparent 去算對比會得到一個漂亮但完全假的數字。
  const bgOf = el => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c.length >= 3 && (c[3] === undefined || c[3] > 0.92)) return c.slice(0, 3);
    }
    const c = parse(getComputedStyle(document.body).backgroundColor);
    return c.length >= 3 ? c.slice(0, 3) : [255, 255, 255];
  };
  // 光暈畫在 body::before 上，不是任何元素的祖先，bgOf() 看不到它——所以直接
  // 坐在 body 上的字（招呼語、標題）量到的一直是 --bg，而不是它實際壓在上面的
  // 顏色。這裡改成算**最差情況**：把三團光暈各自以滿 alpha 疊在 --bg 上，取三者
  // 之中對比最低的那一個。任何位置的真實對比都不會比這個更差。
  const root = getComputedStyle(document.documentElement);
  const token = n => parse(root.getPropertyValue(n));
  const over = (top, base) => {           // top: [r,g,b,a] 疊在不透明的 base 上
    const a = top.length >= 4 ? top[3] : 1;
    return [0, 1, 2].map(i => Math.round(top[i] * a + base[i] * (1 - a)));
  };
  const haloWorst = (fg, bg) => {
    const L1 = lum(fg);
    let worst = Infinity;
    for (const n of ['--halo-a', '--halo-b', '--halo-c']) {
      const h = token(n); if (h.length < 3) continue;
      const L2 = lum(over(h, bg));
      worst = Math.min(worst, (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05));
    }
    return worst;
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
    const L1 = lum(fg), L2 = lum(bg);
    let ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    if (sitsOnBody(el)) ratio = Math.min(ratio, haloWorst(fg, bg));
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
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('#board');
  await page.waitForTimeout(800);
  await page.locator('#reminderClose').click().catch(() => {});
  await page.waitForTimeout(200);

  const rows = await page.evaluate(measure, TARGETS);

  // 切到日曆、選一天，才量得到那顆按鈕
  await page.locator('.nav-item', { hasText: '日曆' }).click();
  await page.waitForSelector('#calGrid .cal-cell[data-date]');
  await page.locator('.cal-cell[data-date]').first().click();
  await page.waitForTimeout(300);
  rows.push(...await page.evaluate(measure, AFTER_CLICKS));

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
