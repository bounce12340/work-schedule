/**
 * 富文字過濾器的**整條管線**驗證（含 DOM 走訪），在真的瀏覽器裡跑。
 *
 * 為什麼不放進 `npm test`
 * ---------------------------------------------------------------------------
 * `rtSanitize()` 需要 `DOMParser`，Node 沒有內建。`tests/richtext.test.mjs` 因此
 * 只測**安全決策**（標籤政策、URL 白名單、style 值白名單、<font> 折算）——那些是
 * 純字串函式，零相依、跑得快。
 *
 * 但決策正確不等於管線正確：unwrap 有沒有把子節點接回去、屬性清空後有沒有漏放、
 * 標籤正規化時有沒有丟掉內容——這些都在走訪裡。CLAUDE.md 明文要求這一段必須在
 * 瀏覽器裡實測，這個腳本就是那件事的工具。
 *
 * 刻意**不**在 Node 裡造一個假 DOM 來湊：假 DOM 的解析行為與真瀏覽器不同
 * （`<svg>` 內的 `<script>`、`<table>` 的 foster parenting、屬性大小寫……），
 * 測過了也不代表安全。
 *
 * 依賴 Playwright，而 Playwright **不是**本專案的相依套件——零相依是這個專案的
 * 前提，所以這支腳本刻意留在 tools/ 而不是 tests/，需要時才自行安裝：
 *
 *     npx playwright install chromium     # 或設定 PLAYWRIGHT_CHROMIUM 指向現成的
 *     node tools/verify-richtext.mjs
 *
 * 沒裝也不影響 `npm test`。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const INDEX = fileURLToPath(new URL('../public/index.html', import.meta.url));
const PORT = Number(process.env.PORT || 8951);

/**
 * 攻擊向量。每一條都設法設定 window.__pwned——腳本結束時檢查它有沒有被動到。
 * 最後一條刻意是「正常內容」：過濾器把所有東西都丟掉也能讓上面全部通過，
 * 那不是安全，是壞掉。
 */
const ATTACKS = [
  ['script 標籤',        '<script>window.__pwned=1</script>安全的文字'],
  ['img onerror',        '<img src=x onerror="window.__pwned=1">圖片'],
  ['svg 內的 script',    '<svg><script>window.__pwned=1</script></svg>'],
  ['javascript: 連結',   '<a href="javascript:window.__pwned=1">點我</a>'],
  ['大小寫變形',         '<a href="JaVaScRiPt:window.__pwned=1">大小寫</a>'],
  ['內嵌控制字元',       '<a href="java&#9;script:window.__pwned=1">跳脫</a>'],
  ['事件屬性',           '<div onclick="window.__pwned=1" onmouseover="window.__pwned=1">事件屬性</div>'],
  ['iframe',             '<iframe src="javascript:window.__pwned=1"></iframe>'],
  ['style 內的 url()',   '<style>body{background:url("javascript:window.__pwned=1")}</style>'],
  ['body onload',        '<body onload="window.__pwned=1">'],
  ['form + formaction',  '<form><button formaction="javascript:window.__pwned=1">送出</button></form>'],
  ['全螢幕蓋版',         '<span style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999">蓋版</span>'],
  ['object data',        '<object data="javascript:window.__pwned=1"></object>'],
  ['meta refresh',       '<meta http-equiv="refresh" content="0;url=javascript:window.__pwned=1">'],
  ['data: URI',          '<a href="data:text/html;base64,PHNjcmlwdD53aW5kb3cuX19wd25lZD0xPC9zY3JpcHQ+">data</a>'],
  ['正常內容要留著',     '<b>粗體</b><i>斜體</i><a href="https://example.com">連結</a><ul><li>清單</li></ul>']
];

const state = (dailyLogs, notes) => ({
  version: 2, majorProjects: [],
  items: [{ id: 'i1', title: '測試項目', type: 'work', parentId: null, meetingTime: null, link: null,
            date: '2026-07-15', endDate: null, recurrence: null,
            done: false, doneMap: {}, overrides: {}, skipped: {} }],
  ganttProjects: [{ id: 'g1', name: '測試專案', notes, tasks: [] }],
  dailyLogs, customHolidays: [], customWorkdays: [],
  selectedGanttProjectId: 'g1', availableYears: [2026]
});

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

const html = readFileSync(INDEX, 'utf8');
const server = createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

const chromium = await loadChromium();
await new Promise(r => server.listen(PORT, r));

const launch = process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {};
const browser = await chromium.launch(launch);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.message)));
// 字型 CDN 與這次驗證無關，擋掉以免拖慢
await page.route('**://fonts.*/**', r => r.abort());

// 把惡意內容當成「雲端同步回來的資料」塞進 localStorage：這正是過濾器要防的來源
const logs = {};
ATTACKS.forEach(([, payload], i) => { logs[`2026-07-${String(i + 1).padStart(2, '0')}`] = payload; });
await page.addInitScript(s => localStorage.setItem('workSchedule.v1', JSON.stringify(s)),
  state(logs, ATTACKS.map(([, p]) => p).join('')));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
if (await page.locator('#reminderToast.show').count()) await page.click('#reminderClose');

// 逐一點開每個日期，逼每段惡意內容都真的被渲染一次
await page.click('#navCalendar');
await page.waitForTimeout(300);
let rendered = 0;
for (let i = 0; i < ATTACKS.length; i++) {
  const cell = page.locator('.cal-cell:not(.blank)').nth(i);
  if (await cell.count()) { await cell.click(); await page.waitForTimeout(80); rendered++; }
}
await page.click('#navGantt');          // 專案筆記那一份也要渲染
await page.waitForTimeout(400);

const pwned = await page.evaluate(() => window.__pwned === 1);
const dom = await page.evaluate(() => {
  const out = { dangerNodes: [], eventAttrs: [], badHrefs: [], styles: [], kept: 0 };
  document.querySelectorAll('.rt-edit').forEach(ed => {
    ed.querySelectorAll('*').forEach(el => {
      if (/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|FORM|INPUT|BUTTON|META|LINK|SVG|IMG|BASE)$/.test(el.tagName)) {
        out.dangerNodes.push(el.tagName);
      }
      if (/^(B|I|U|S|A|UL|OL|LI|CODE|MARK|BLOCKQUOTE)$/.test(el.tagName)) out.kept++;
      for (const a of el.attributes) {
        if (/^on/i.test(a.name)) out.eventAttrs.push(`${el.tagName}[${a.name}]`);
        if (a.name === 'href' && !/^(https?:|mailto:)/i.test(a.value)) out.badHrefs.push(a.value.slice(0, 60));
        if (a.name === 'style') out.styles.push(a.value);
      }
    });
  });
  return out;
});

const fail = [];
if (pwned) fail.push('有攻擊向量成功執行（window.__pwned 被設定）');
if (dom.dangerNodes.length) fail.push(`渲染後仍有危險節點：${dom.dangerNodes.join(', ')}`);
if (dom.eventAttrs.length) fail.push(`殘留事件屬性：${dom.eventAttrs.join(', ')}`);
if (dom.badHrefs.length) fail.push(`不安全的 href：${dom.badHrefs.join(', ')}`);
if (pageErrors.length) fail.push(`頁面錯誤：${pageErrors.join(' | ')}`);
// 全部丟掉也能讓上面通過，那不是安全而是壞掉——正常標籤必須留著
if (dom.kept === 0) fail.push('連正常的排版標籤都被丟掉了，過濾器過度嚴格');

console.log(`渲染了 ${rendered}/${ATTACKS.length} 段惡意內容 + 專案筆記`);
console.log(`window.__pwned      ${pwned ? '✗ 被設定' : '✓ 未被設定'}`);
console.log(`危險節點            ${dom.dangerNodes.length === 0 ? '✓ 0' : '✗ ' + dom.dangerNodes.length}`);
console.log(`on* 事件屬性        ${dom.eventAttrs.length === 0 ? '✓ 0' : '✗ ' + dom.eventAttrs.length}`);
console.log(`不安全的 href       ${dom.badHrefs.length === 0 ? '✓ 0' : '✗ ' + dom.badHrefs.length}`);
console.log(`殘留的 style        ${dom.styles.length ? JSON.stringify(dom.styles) : '（無）'}`);
console.log(`保留的排版標籤      ${dom.kept} 個`);

await browser.close();
server.close();

if (fail.length) {
  console.error('\n✗ 驗證失敗：');
  fail.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('\n✓ 整條過濾管線通過');
