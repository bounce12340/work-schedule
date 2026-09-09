/**
 * 日曆的兩個顯示層功能：每日記錄的標記、跨多天事項的貫穿色條。
 *
 * 為什麼需要這支
 * ---------------------------------------------------------------------------
 * 兩者都是**只有畫出來才看得見**的東西：`npm test` 碰不到前端整合、
 * `node --check` 只驗語法。而色條最關鍵的那條規則——「同一個項目在每一格都必須
 * 落在同一條軌道（lane）上」——錯了之後畫面上完全看不出原因，只覺得「怪怪的」，
 * 是最難靠人眼審 diff 抓到的一類。
 *
 * 開發時實際被它抓到一個 bug：`sp` 是同一個物件被塞進區間內的每一格，拿
 * `sp.from` 判斷起訖會讓四格全部被判成起點——後果是色條斷成四塊、而且長出四個
 * 勾選框。單元測試與語法檢查都不會紅。
 *
 * 依賴 Playwright，而 Playwright **不是**本專案的相依套件（零相依是專案前提），
 * 所以放在 tools/ 而不是 tests/：
 *
 *     npx playwright install chromium     # 或設定 PLAYWRIGHT_CHROMIUM 指向現成的
 *     node tools/check-calendar.mjs
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
const PORT = Number(process.env.PORT || 8995);

const srv = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) { res.writeHead(404); res.end('{}'); return; }
  const name = url.pathname.slice(1) || 'index.html';
  let buf; try { buf = readFileSync(PUBLIC + name); } catch { res.writeHead(404); res.end('x'); return; }
  res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
  res.end(buf);
});
srv.listen(PORT);

// 2026-09：9/1 是週二，所以 9/23 是週三、9/26 是週六（同一個週列，不跨週）
//          9/28（週一）→ 10/2（週五）用來驗跨月，10/1 之後的部分本月看不到
const SEED = {
  version: 2,
  items: [
    { id: 'trip', title: '出國', type: 'work', date: '2026-09-23', endDate: '2026-09-26',
      recurrence: null, tags: [], subtasks: [], subDone: {},
      done: false, doneMap: {}, overrides: {}, skipped: {} },
    // 與「出國」重疊，必須被排到第二條軌道
    { id: 'audit', title: '查廠', type: 'assignment', date: '2026-09-25', endDate: '2026-09-29',
      recurrence: null, tags: [], subtasks: [], subDone: {},
      done: false, doneMap: {}, overrides: {}, skipped: {} },
    // 與「出國」不重疊，應該回到第一條軌道（軌道要能被重複使用）
    { id: 'fair', title: '參展', type: 'meeting', date: '2026-09-15', endDate: '2026-09-17',
      recurrence: null, tags: [], subtasks: [], subDone: {},
      done: false, doneMap: {}, overrides: {}, skipped: {} },
    { id: 'solo', title: '單日的事', type: 'work', date: '2026-09-10',
      recurrence: null, tags: [], subtasks: [], subDone: {},
      done: false, doneMap: {}, overrides: {}, skipped: {} },
  ],
  majorProjects: [], ganttProjects: [],
  dailyLogs: { '2026-09-11': '<div>今天去看牙醫</div>', '2026-09-12': '<div><br></div>' },
  customHolidays: [], customWorkdays: [],
};

const br = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM });
const page = await br.newPage({ viewport: { width: 1280, height: 1000 }, locale: 'zh-TW' });
await page.addInitScript(seed => {
  try { localStorage.setItem('workSchedule.v1', JSON.stringify(seed)); } catch (e) {}
}, SEED);

const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/net::|Failed to load/.test(m.text())) errors.push('console: ' + m.text()); });

await page.goto(`http://localhost:${PORT}/`);
await page.waitForSelector('#board');
await page.locator('#reminderClose').click().catch(() => {});
await page.locator('.nav-item', { hasText: '日曆' }).click();
await page.waitForSelector('#calGrid .cal-cell[data-date]');

// 日曆預設停在今天所在的月份；把它開到 2026-09
await page.evaluate(() => {
  const t = document.getElementById('calTitle');
  for (let i = 0; i < 40 && !/2026 年 9 月/.test(t.textContent); i++) {
    document.getElementById('calNext').click();
  }
});
await page.waitForTimeout(300);

const checks = [];
// 邊跑邊印，不要只在最後印——當掉時最後那段總結跑不到，
// 先前累積的結果會一起消失（用突變驗證時實際踩到）。
const ok = (n, c) => {
  checks.push([n, !!c]);
  console.log((c ? '  \u2713 ' : '  \u2717 ') + n);
};
ok('開到 2026 年 9 月', /2026 年 9 月/.test(await page.locator('#calTitle').innerText()));

const cell = d => page.locator(`.cal-cell[data-date="2026-09-${d}"]`);

// ---------- 1. 每日記錄的標記 ----------
ok('有寫記錄的那天出現 ✎', await cell('11').locator('.cal-log-mark').count() === 1);
ok('只有空的 <br> 不算有寫', await cell('12').locator('.cal-log-mark').count() === 0);
ok('沒寫的那天沒有記號', await cell('13').locator('.cal-log-mark').count() === 0);
ok('記號帶得出內容摘要',
   /今天去看牙醫/.test(await cell('11').locator('.cal-log-mark').getAttribute('title') || ''));

// ---------- 2. 色條 ----------
const bar = (d, title) => page.locator(`.cal-cell[data-date="2026-09-${d}"] .cal-span`)
  .filter({ hasText: title });

ok('9/23–9/26 四天都有「出國」的色條',
   (await Promise.all(['23','24','25','26'].map(d => bar(d, '出國').count()))).every(n => n === 1));
ok('9/22 沒有（區間外）', await bar('22', '出國').count() === 0);
ok('9/27 沒有（區間外）', await bar('27', '出國').count() === 0);

const cls = async (d, t) => (await bar(d, t).first().getAttribute('class')) || '';
ok('起點有 start（左邊收邊切圓角）', /\bstart\b/.test(await cls('23', '出國')));
ok('中間沒有 start／end（保持平的，讀得出還沒結束）',
   !/\b(start|end)\b/.test(await cls('24', '出國')) && !/\b(start|end)\b/.test(await cls('25', '出國')));
ok('終點有 end', /\bend\b/.test(await cls('26', '出國')));
ok('用工作項目的顏色（同色系）', /\bwork\b/.test(await cls('23', '出國')));

// 跨月：9/28 開始的段落在本月只看得到 9/28–9/30，而且 9/30 不能標成 end
ok('跨月的段落本月畫到 9/29（endDate 就在本月內）', await bar('29', '查廠').count() === 1);
ok('9/29 是真的終點所以有 end', /\bend\b/.test(await cls('29', '查廠')));

// ---------- 3. 軌道對齊：整個功能的關鍵 ----------
// 同一個項目在相鄰兩格必須落在同一條軌道上，否則色條會上下錯開
const laneOf = async (d, title) => page.evaluate(({ d, title }) => {
  const c = document.querySelector(`.cal-cell[data-date="2026-09-${d}"] .cal-spans`);
  if (!c) return -1;
  return [...c.children].findIndex(el => el.textContent.includes(title));
}, { d, title });

const tripLanes = await Promise.all(['23','24','25','26'].map(d => laneOf(d, '出國')));
ok('「出國」在四格裡都在同一條軌道上（' + tripLanes.join(',') + '）',
   tripLanes.every(l => l === tripLanes[0] && l >= 0));

const auditLanes = await Promise.all(['25','26','27','28','29'].map(d => laneOf(d, '查廠')));
ok('「查廠」五格也都在同一條軌道上（' + auditLanes.join(',') + '）',
   auditLanes.every(l => l === auditLanes[0] && l >= 0));
ok('重疊的兩段不在同一條軌道', tripLanes[0] !== auditLanes[0]);

// 9/27 只有「查廠」，但它的軌道在 9/26 是 1 —— 那一格必須留一個空位撐住高度
ok('沒有色條的軌道要留空位（否則下面那條會往上跳）',
   await page.locator('.cal-cell[data-date="2026-09-27"] .cal-span.gap').count() >= 1);

// 不重疊的「參展」應該重複使用第一條軌道
ok('不重疊的段落回到第一條軌道', await laneOf('15', '參展') === 0);

// 幾何驗證：相鄰兩格的色條上緣要對齊，而且水平方向不能有斷開
const geo = await page.evaluate(() => {
  const box = (d, title) => {
    const c = document.querySelector(`.cal-cell[data-date="2026-09-${d}"] .cal-spans`);
    const el = c && [...c.children].find(x => x.textContent.includes(title));
    return el ? el.getBoundingClientRect() : null;
  };
  const a = box('24', '出國'), b = box('25', '出國');
  return a && b ? { dy: Math.abs(a.top - b.top), gap: b.left - a.right } : null;
});
ok('相鄰兩格的色條上緣切齊（dy=' + (geo && geo.dy.toFixed(1)) + '）', geo && geo.dy < 0.6);
ok('相鄰兩格的色條接得起來，中間沒有縫（gap=' + (geo && geo.gap.toFixed(1)) + '）',
   geo && geo.gap <= 0.6);

// ---------- 4. 不能同時出現兩種形式 ----------
ok('跨多天的事項不再另外列一行文字',
   await cell('24').locator('.cal-item-row').filter({ hasText: '出國' }).count() === 0);
ok('單日的事項仍然照舊列出來',
   await cell('10').locator('.cal-item-row').filter({ hasText: '單日的事' }).count() === 1);

// ---------- 5. 勾選 ----------
const tripChecks = await Promise.all(['23','24','25','26'].map(async d =>
  await bar(d, '出國').locator('.cal-span-check').count()));
ok('「出國」只有 9/23 那一段有勾選框（' + tripChecks.join(',') + '）',
   tripChecks[0] === 1 && tripChecks.slice(1).every(n => n === 0));

await bar('23', '出國').locator('.cal-span-check').click();
await page.waitForTimeout(600);
const doneState = await page.evaluate(() =>
  JSON.parse(localStorage.getItem('workSchedule.v1')).items.find(x => x.id === 'trip').done);
ok('勾了會真的存進去', doneState === true);
ok('勾完整段都變灰（不是只有第一格）',
   (await Promise.all(['23','24','25','26'].map(d => cls(d, '出國')))).every(c => /\bdone\b/.test(c)));

// 勾選框不能被拖曳選取搶走 —— 點了不該變成「選了那一天」
const selAfter = await page.locator('.cal-cell.selected').count();
ok('點勾選框不會順便選到日期', selAfter === 0);

// ---------- 6. 打字時標記立刻出現，而且編輯器不能被重建 ----------
await cell('13').click();
await page.waitForTimeout(300);
ok('點日期會展開當日詳情', await page.locator('#daylogBox').isVisible());
const ed = page.locator('#daylogSlot [contenteditable]').first();
await ed.click();
await ed.type('#');
await page.waitForTimeout(250);
ok('打一個字，那一格立刻出現 ✎', await cell('13').locator('.cal-log-mark').count() === 1);
ok('編輯器沒有被重建，游標還在裡面',
   await page.evaluate(() => document.activeElement && document.activeElement.isContentEditable));
await ed.press('Backspace');
await page.waitForTimeout(250);
ok('刪掉之後記號也跟著不見', await cell('13').locator('.cal-log-mark').count() === 0);

console.log('');
let bad = 0;
for (const [n, c] of checks) if (!c) { bad++; console.log('  ✗ 未通過：' + n); }
console.log(errors.length ? '\n✗ ' + errors.join('\n') : '\n✓ 零 pageerror、零 console.error');
await br.close(); srv.close();
process.exit(bad || errors.length ? 1 : 0);
