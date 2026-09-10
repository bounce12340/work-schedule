/**
 * 「有人陪著」那幾件事：天空跟著時段變色、每日記錄的提示語每天換、打勾會彈一下、
 * 週一的一句回顧。
 *
 * 為什麼需要這支
 * ---------------------------------------------------------------------------
 * 四件事都**依賴時間**，而依賴時間的東西最容易在開發時看起來對、在別的時段壞掉：
 * 白天寫的程式碼從來沒有在晚上跑過。所以全部用 page.clock 把時間釘死，早上、
 * 下午、傍晚、週一、週二各跑一次——不靠執行當下幾點。
 *
 * 另外三條是「不該發生的事」：
 *   - 打勾的彈跳只能在**被點的那一個**上。掛錯地方（掛在 .done 而不是 .pop）
 *     的話，每次完整重繪幾千個已完成的框會一起彈——畫面看起來只是「有點閃」，
 *     沒有任何檢查會紅。
 *   - 提示語**照日期決定**，同一天重新整理不能跳來跳去。
 *   - 週一的回顧在 N = 0 時不出現：「上週你做完了 0 件事」是一根刺，不是回顧。
 *
 *     npx playwright install chromium     # 或設定 PLAYWRIGHT_CHROMIUM
 *     node tools/check-ambience.mjs
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
const PORT = Number(process.env.PORT || 8998);

const srv = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) { res.writeHead(404); res.end('{}'); return; }
  const name = url.pathname.slice(1) || 'index.html';
  let buf; try { buf = readFileSync(PUBLIC + name); } catch { res.writeHead(404); res.end('x'); return; }
  res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
  res.end(buf);
});
srv.listen(PORT);

const mk = (o) => ({
  type: 'work', parentId: null, meetingTime: null, link: null, endDate: null,
  recurrence: null, tags: [], subtasks: [], subDone: {}, dependsOn: [],
  done: false, doneMap: {}, overrides: {}, skipped: {}, ...o
});
// 2026-09-14 是週一；上一週是 9/7（一）～9/13（日）
const SEED = {
  version: 2,
  items: [
    mk({ id: 'a', title: '上週做完的一', date: '2026-09-08', done: true }),
    mk({ id: 'b', title: '上週做完的二', date: '2026-09-10', done: true }),
    mk({ id: 'c', title: '上週做完的三', date: '2026-09-13', done: true }),
    mk({ id: 'd', title: '上週沒做完的', date: '2026-09-11' }),
    mk({ id: 'e', title: '上上週做完的（不算）', date: '2026-09-04', done: true }),
    mk({ id: 'f', title: '這週的', date: '2026-09-16' }),
    mk({ id: 'g', title: '這週的另一件', date: '2026-09-17' }),
  ],
  majorProjects: [], ganttProjects: [], dailyLogs: {},
  customHolidays: [], customWorkdays: [], awayDates: [], availableYears: [2026],
};

const br = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM });
const errors = [];
const checks = [];
const ok = (n, c) => { checks.push([n, !!c]); console.log((c ? '  ✓ ' : '  ✗ ') + n); };

async function open(fixedTime, seed = SEED) {
  const page = await br.newPage({ viewport: { width: 1280, height: 1000 }, locale: 'zh-TW' });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/net::|Failed to load/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.clock.setFixedTime(new Date(fixedTime));
  await page.addInitScript(s => { try { localStorage.setItem('workSchedule.v1', JSON.stringify(s)); } catch (e) {} }, seed);
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('#board');
  await page.locator('#reminderClose').click().catch(() => {});
  await page.waitForTimeout(300);
  return page;
}
const sky = page => page.evaluate(() => ({
  daypart: document.documentElement.getAttribute('data-daypart'),
  haloA: getComputedStyle(document.documentElement).getPropertyValue('--halo-a').trim(),
  greeting: document.getElementById('brandGreeting').textContent,
}));

console.log('\n── 天空跟著時段變色 ──');
const morning = await open('2026-09-16T08:00:00');
const m = await sky(morning);
ok('早上 8 點：data-daypart = morning', m.daypart === 'morning');
ok('早上的招呼是「早安」', m.greeting === '早安');
await morning.close();

const afternoon = await open('2026-09-16T14:00:00');
const a = await sky(afternoon);
ok('下午 2 點：data-daypart = afternoon', a.daypart === 'afternoon');
ok('下午的招呼是「午安」', a.greeting === '午安');
ok('下午的光暈與早上不同色', a.haloA !== m.haloA);
await afternoon.close();

const evening = await open('2026-09-16T20:30:00');
const e = await sky(evening);
ok('晚上 8 點半：data-daypart = evening', e.daypart === 'evening');
ok('晚上的招呼是「晚安」', e.greeting === '晚安');
ok('傍晚的光暈與早上、下午都不同色', e.haloA !== m.haloA && e.haloA !== a.haloA);
// <head> 開機腳本要在畫面繪製前就把時段寫好，不能等主 IIFE。少了它，晚上打開
// 會先閃一下早上的顏色。用 evaluate 拿不到「首次繪製」，但可以檢查它是不是在
// 主 IIFE 之前就存在——把 tick 停掉之後屬性還在，就是開機腳本寫的。
ok('<head> 開機腳本有先寫時段（不是等 tick）',
   await evening.evaluate(() => /data-daypart/.test(document.querySelector('head script').textContent)));
await evening.close();

console.log('\n── 每日記錄的提示語照日期決定 ──');
const cal = await open('2026-09-16T10:00:00');
await cal.locator('.nav-item', { hasText: '日曆' }).click();
await cal.waitForSelector('#calGrid .cal-cell[data-date]');
const promptOn = async d => {
  await cal.locator(`.cal-cell[data-date="${d}"]`).click();
  await cal.waitForTimeout(250);
  return cal.locator('#daylogSlot .rt-edit').getAttribute('data-placeholder');
};
const p16a = await promptOn('2026-09-16');
const p17 = await promptOn('2026-09-17');
const p16b = await promptOn('2026-09-16');
ok('同一天問同一句（回到 9/16 拿到一樣的提示）', p16a === p16b && !!p16a);
ok('不同的日子問不同的問題（9/16 與 9/17 不同）', p16a !== p17);
ok('不再是那句帶 ✎ 說明的固定文案', !/✎/.test(p16a || ''));
// 十天內至少要出現三種以上不同的問題，否則 hash 分佈壞了
const seen = new Set();
for (let d = 10; d <= 19; d++) seen.add(await promptOn('2026-09-' + d));
ok('十天裡至少換過三種問題', seen.size >= 3);
await cal.close();

console.log('\n── 打勾會彈一下，而且只有被點的那一個 ──');
const board = await open('2026-09-16T10:00:00');
const row = board.locator('.occ-row').filter({ hasText: '這週的另一件' }).first();
// 看的是**計算後的動畫**，不是 class——要防的錯法是「把動畫掛回 .done」，那樣
// class 名稱完全正確，只是幾千個已完成的框每次重繪都會一起彈。只數 .pop 抓不到。
const animOf = (page, sel) => page.evaluate(s =>
  [...document.querySelectorAll(s)].map(el => getComputedStyle(el).animationName), sel);
await row.locator('.checkbox').click();
const justClicked = await animOf(board, '.checkbox.pop');
ok('點下去的那一個框正在跑 check-pop', justClicked.length === 1 && justClicked[0] === 'check-pop');
await board.waitForTimeout(450);
ok('動畫結束後 .pop 拿掉', await board.evaluate(() => document.querySelectorAll('.checkbox.pop').length) === 0);
// 完整重繪（切走再切回）之後，**任何**已完成的框都不能在跑動畫
await board.locator('.nav-item', { hasText: '日曆' }).click();
await board.waitForTimeout(200);
await board.locator('.nav-item', { hasText: '項目安排' }).click();
await board.waitForSelector('#board');
await board.waitForTimeout(200);
// 已完成的列收在「已完成」區裡，先展開才量得到
await board.locator('#doneSection button, #doneSection .done-toggle, #doneSection').first().click().catch(() => {});
await board.waitForTimeout(150);
const afterRender = await animOf(board, '.checkbox.done');
ok('完整重繪之後已完成的框都沒有在跑動畫（動畫不是掛在 .done 上）',
   afterRender.length >= 1 && afterRender.every(n => n === 'none'));
ok('但那一件真的完成了', await board.evaluate(() =>
   JSON.parse(localStorage.getItem('workSchedule.v1')).items.find(x => x.id === 'g').done) === true);
await board.close();

console.log('\n── 週一的一句回顧 ──');
const mon = await open('2026-09-14T09:00:00');
const lb = await mon.evaluate(() => { const el = document.getElementById('brandLookback'); return { hidden: el.hidden, text: el.textContent }; });
ok('週一早上看得到回顧', lb.hidden === false);
ok('數字只算上週做完的（3，不含上上週、不含沒做完）', /3/.test(lb.text) && !/4|5/.test(lb.text));
await mon.close();

const tue = await open('2026-09-15T09:00:00');
ok('週二就收起來', await tue.evaluate(() => document.getElementById('brandLookback').hidden) === true);
await tue.close();

const monEmpty = await open('2026-09-14T09:00:00', { ...SEED, items: SEED.items.filter(x => !x.done) });
ok('上週一件都沒做完時不出現——那會是一根刺，不是回顧',
   await monEmpty.evaluate(() => document.getElementById('brandLookback').hidden) === true);
await monEmpty.close();

console.log('');
let bad = 0;
for (const [n, c] of checks) if (!c) { bad++; console.log('  ✗ 未通過：' + n); }
console.log(errors.length ? '\n✗ ' + errors.join('\n') : '\n✓ 零 pageerror、零 console.error');
await br.close(); srv.close();
process.exit(bad || errors.length ? 1 : 0);
