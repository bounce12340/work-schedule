/**
 * 勾選的「就地更新」必須與「完整重繪」得到一模一樣的畫面。
 *
 * 為什麼需要這支
 * ---------------------------------------------------------------------------
 * `toggleOccDone()` 在最常見的那一種互動（看板上的一列被勾成完成、已完成區收合）
 * 不重建看板，只把那一列搬走。這是有理由的——實測 3247 列時完整重建會讓主執行緒
 * 卡 2.6 秒，而其中 JS 只佔 130ms，其餘全是瀏覽器對每一列重跑樣式計算與版面配置。
 *
 * 但增量更新等於把 `renderBoard()` 的規則複製了一份出來，而複製出來的規則遲早
 * 會與本尊分歧——那正是「畫面對了但其實不對」這種 bug 的來源。所以這裡不驗
 * 「畫面看起來對不對」，而驗**兩條路徑的結果相同**：動作做完之後切走再切回來
 * （會觸發完整重繪），比對前後的 DOM 簽章。
 *
 * 因此增量路徑刻意只處理一種情況，其餘一律回頭走完整重繪。下面每個情境都在
 * 測那些邊界有沒有真的落回去。
 *
 * 依賴 Playwright，而 Playwright **不是**本專案的相依套件（零相依是專案前提），
 * 所以放在 tools/ 而不是 tests/：
 *
 *     npx playwright install chromium     # 或設定 PLAYWRIGHT_CHROMIUM 指向現成的
 *     node tools/verify-toggle.mjs
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const INDEX = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
const PORT = Number(process.env.PORT || 8964);

function seed(n) {
  const types = ['work', 'meeting', 'assignment'];
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push({
      id: 'i' + i, title: '項目' + i, type: types[i % 3], parentId: null,
      meetingTime: null, link: null, date: '2026-08-' + String(1 + (i % 20)).padStart(2, '0'),
      endDate: null, recurrence: null, done: false, doneMap: {}, overrides: {}, skipped: {}
    });
  }
  return {
    version: 2, majorProjects: [], items, ganttProjects: [], dailyLogs: {},
    customHolidays: [], customWorkdays: [], availableYears: [2026], selectedGanttProjectId: null
  };
}

/** 看板的完整狀態：列的內容與順序、完成計數、各區塊的顯示與否 */
const SIGNATURE = `(()=>{
  const g = id => document.getElementById(id);
  const board = g('board'), doneBoard = g('doneBoard'), doneSection = g('doneSection');
  const rows = el => [...el.querySelectorAll('.occ-row')].map(r =>
    r.querySelector('.occ-title').textContent
    + (r.querySelector('.checkbox').classList.contains('done') ? '#done' : ''));
  return JSON.stringify({
    board: rows(board),
    boardEmpty: (board.querySelector('.empty-state') || {}).textContent || null,
    done: rows(doneBoard),
    doneCount: g('doneCount').textContent,
    doneSectionDisplay: doneSection.style.display,
    doneBoardDisplay: doneBoard.style.display,
    caret: g('doneCaret').textContent,
    filterCount: g('filterCount').textContent
  });
})()`;

const tick = async (p, sel = '#board .checkbox') => {
  await p.locator(sel).first().click();
  await p.waitForTimeout(160);
};

const CASES = [
  ['一般勾選一項（走增量路徑）', async p => { await tick(p); }],
  ['連續勾選三項', async p => { for (let i = 0; i < 3; i++) await tick(p); }],
  ['「只看未完成」開著時勾選（應落回完整重繪）', async p => {
    await p.click('#btnHideDone'); await p.waitForTimeout(200); await tick(p);
  }],
  ['已完成區展開時勾選（應落回完整重繪，維持排序）', async p => {
    await tick(p); await p.click('#doneHead'); await p.waitForTimeout(200); await tick(p);
  }],
  ['取消勾選（應落回完整重繪，插回正確位置）', async p => {
    await tick(p); await p.click('#doneHead'); await p.waitForTimeout(200); await tick(p, '#doneBoard .checkbox');
  }],
  ['把全部勾完（要換成完成畫面）', async p => { for (let i = 0; i < 6; i++) await tick(p); }],
  ['搜尋篩選中勾選', async p => {
    await p.fill('#inputSearch', '項目1'); await p.waitForTimeout(300); await tick(p);
  }],
  ['類型篩選中勾選', async p => {
    const chip = p.locator('#filterTypes button').first();
    if (await chip.count()) { await chip.click(); await p.waitForTimeout(250); }
    await tick(p);
  }]
];

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('需要 Playwright，但它不是本專案的相依套件（零相依是專案前提）。');
  console.error('要跑這個驗證請先安裝：npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const server = createServer((req, res) => {
  if (req.url.startsWith('/api/')) {      // 單檔模式：沒有後端
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end('{}');
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(INDEX);
});
await new Promise(r => server.listen(PORT, r));

const launch = process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {};
const browser = await chromium.launch(launch);
let failed = 0;

for (const [name, act] of CASES) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-TW' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**://fonts.*/**', r => r.abort());
  await page.addInitScript(s => localStorage.setItem('workSchedule.v1', s), JSON.stringify(seed(6)));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  if (await page.locator('#reminderToast.show').count()) await page.click('#reminderClose');

  await act(page);
  await page.waitForTimeout(450);
  const incremental = await page.evaluate(SIGNATURE);

  // 切走再切回來 → renderNav() → renderAll() → renderBoard()，整份重建
  await page.click('#navCalendar'); await page.waitForTimeout(250);
  await page.click('#navSchedule'); await page.waitForTimeout(350);
  const rebuilt = await page.evaluate(SIGNATURE);

  if (incremental === rebuilt && !errors.length) {
    console.log(`✓ ${name}`);
  } else {
    failed++;
    console.log(`✗ ${name}`);
    console.log(`   就地更新後：${incremental}`);
    console.log(`   完整重繪後：${rebuilt}`);
    if (errors.length) console.log(`   錯誤：${errors.join(' | ')}`);
  }
  await ctx.close();
}

await browser.close();
await new Promise(r => server.close(r));

if (failed) {
  console.error(`\n✗ ${failed} 個情境的增量更新與完整重繪不一致`);
  process.exit(1);
}
console.log('\n✓ 所有情境：就地更新與完整重繪的結果完全相同');
