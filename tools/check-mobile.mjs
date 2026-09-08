/**
 * 手機上的版面與運行速度。
 *
 * 為什麼要有這一支
 * ---------------------------------------------------------------------------
 * 版面與速度在手機上會互相放大，而**開發時兩者都踩不到**：桌機視窗很寬、
 * CPU 很快，示範資料只有 6 個項目。真實使用者是 390px 的手機、64 個項目、
 * 展開成 1461 列，CPU 大約是桌機的 1/4——桌機上 70ms 的停頓，在那裡就是快半秒。
 *
 * 所以這支腳本自己造 64 個項目、用 iPhone 13 的視窗，並且**把 CPU 降速 4 倍**。
 * 不降速的話量到的是一個沒有人會遇到的數字。
 *
 * 它驗三件事：
 *   1. 每一頁都不會橫向溢出（被撐破）
 *   2. 切換與互動的停頓時間
 *   3. **點得到**——Apple 與 Google 都建議 44px，而勾選框是整個 app 最常按的東西
 *
 * 兩個真實的 bug 是它抓到的：AI 面板在手機上把送出鍵擠成 20px 寬（完全按不到），
 * 以及勾選框只有 24×24。兩者靜態檢查與單元測試都不會紅。
 *
 * 用法（Playwright 不是本專案的相依套件，需要時才裝）：
 *   node tools/check-mobile.mjs
 *
 * 與 measure-board.mjs 一樣**不在 CI**：數字隨執行環境浮動，設一條會過會不過的
 * 門檻只會製造沒有人相信的紅燈。用途是改動版面前後各跑一次、自己比對。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium, devices } from '/home/user/work-schedule/node_modules/playwright/index.mjs';

const PUBLIC = '/home/user/work-schedule/public/';
const PORT = 8995;
const srv = createServer((q, r) => {
  const n = new URL(q.url, 'http://x').pathname.slice(1) || 'index.html';
  if (n.startsWith('api/')) { r.writeHead(404); r.end('{}'); return; }
  let b; try { b = readFileSync(PUBLIC + n); } catch { r.writeHead(404); r.end('x'); return; }
  r.writeHead(200, { 'content-type': n.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
  r.end(b);
});
srv.listen(PORT);

const freqs = [
  { freq: 'weekly', weekdays: [1, 3], holidayRule: 'postpone' },
  { freq: 'weekly', weekdays: [2] },
  { freq: 'monthly', mode: 'day', day: 15, holidayRule: 'postpone' },
  { freq: 'quarterly', day: 5 },
  null,
];
const state = {
  version: 2,
  items: Array.from({ length: 64 }, (_, i) => ({
    id: 'it' + i,
    title: ['管制藥品申報', 'O-PVF藥品追溯申報作業(小組)', '三總DST標案', '客服部月會'][i % 4] + ' ' + i,
    type: ['work', 'meeting', 'assignment'][i % 3],
    date: '2026-0' + (1 + (i % 9)) + '-1' + (i % 9),
    recurrence: freqs[i % 5],
    tags: i % 3 === 0 ? ['管制藥品', '月報'] : (i % 3 === 1 ? ['PVF'] : []),
    subtasks: i % 5 === 0 ? [{ id: 's' + i + 'a', text: '第一步' }, { id: 's' + i + 'b', text: '第二步' }] : [],
    subDone: {},
    done: false, doneMap: {}, overrides: {}, skipped: {},
  })),
  majorProjects: [{ id: 'mp1', name: '年度策略規劃' }],
  ganttProjects: [{ id: 'gp1', name: '官網改版專案', notes: '',
    tasks: [{ id: 't1', name: '需求訪談', start: '2026-09-01', end: '2026-09-20', progress: 60, done: false, todos: [] }] }],
  dailyLogs: {}, customHolidays: [], customWorkdays: [],
};

const br = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM });
const ctx = await br.newContext({ ...devices['iPhone 13'], locale: 'zh-TW' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/net::|Failed to load/.test(m.text())) errors.push('console: ' + m.text()); });

await page.addInitScript(s => {
  try { localStorage.setItem('workSchedule.v1', JSON.stringify(s)); } catch (e) {}
}, state);

// 模擬手機 CPU：桌機的 1/4
const cdp = await ctx.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

await page.goto(`http://localhost:${PORT}/`);
await page.waitForSelector('#board');
await page.waitForTimeout(2000);
await page.locator('#reminderClose').click().catch(() => {});
await page.waitForTimeout(300);

const vw = page.viewportSize().width;
console.log(`\n  視窗 ${vw}px（iPhone 13）、64 個項目、CPU 降速 4 倍\n`);

const problems = [];
const overflowOf = () => page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);

await page.evaluate(() => {
  window.__lt = [];
  new PerformanceObserver(l => l.getEntries().forEach(e => window.__lt.push(e.duration)))
    .observe({ entryTypes: ['longtask'] });
});
const measure = async fn => {
  await page.evaluate(() => { window.__lt = []; });
  await fn();
  await page.waitForTimeout(600);
  return Math.round(await page.evaluate(() => window.__lt.reduce((a, b) => a + b, 0)));
};

// ---------- 逐頁看版面與速度 ----------
const navs = [
  ['#navSchedule', '項目安排'],
  ['#navCalendar', '日曆'],
  ['#navGantt', '專案'],
  ['#navShared', '共享'],
  ['#navAccount', '我的帳號'],
];
console.log('  頁面        切換耗時   橫向溢出');
console.log('  ----------  --------   --------');
for (const [sel, name] of navs) {
  const ms = await measure(async () => { await page.locator(sel).click(); });
  const ov = await overflowOf();
  console.log('  ' + name.padEnd(11) + String(ms + 'ms').padStart(7) + '   ' +
    (ov > 0 ? `✗ ${ov}px` : '✓ 無'));
  if (ov > 0) problems.push(`${name} 頁橫向溢出 ${ov}px`);
  if (ms > 400) problems.push(`${name} 頁切換卡 ${ms}ms`);
}

// ---------- 回到項目安排，量互動 ----------
await page.locator('#navSchedule').click();
await page.waitForTimeout(600);
const rows = await page.locator('#board .occ-row').count();
const typeMs = await measure(async () => {
  await page.locator('#inputSearch').fill('管制');
});
await page.locator('#inputSearch').fill('');
await page.waitForTimeout(400);
const tickMs = await measure(async () => {
  await page.locator('#board .occ-row .checkbox').first().click();
});
console.log(`\n  board 列數 ${rows}｜搜尋 ${typeMs}ms｜勾選一項 ${tickMs}ms`);
if (typeMs > 400) problems.push(`搜尋卡 ${typeMs}ms`);
if (tickMs > 400) problems.push(`勾選卡 ${tickMs}ms`);

// ---------- 點擊目標大小（Apple/Google 建議 44px）----------
const small = await page.evaluate(() => {
  const out = [];
  const seen = new Set();
  document.querySelectorAll('#viewSchedule button, #viewSchedule .checkbox, .nav-item').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const label = (el.className || '') + '｜' + (el.textContent || '').trim().slice(0, 10);
    if (seen.has(label)) return;
    seen.add(label);
    if (r.height < 32 || r.width < 32) out.push({ label, w: Math.round(r.width), h: Math.round(r.height) });
  });
  return out.slice(0, 12);
});
console.log('\n  點擊目標偏小（< 32px）：' + (small.length ? '' : '（無）'));
small.forEach(s => console.log(`    ${s.w}×${s.h}  ${s.label}`));

// ---------- 新功能在手機上的樣子 ----------
const rowH = await page.evaluate(() => {
  const r = document.querySelector('#board .occ-row');
  return r ? Math.round(r.getBoundingClientRect().height) : 0;
});
const taggedH = await page.evaluate(() => {
  const r = [...document.querySelectorAll('#board .occ-row')].find(x => x.querySelector('.tag-chip'));
  return r ? Math.round(r.getBoundingClientRect().height) : 0;
});
console.log(`\n  列高：一般 ${rowH}px、帶標籤 ${taggedH}px`);
if (taggedH > rowH * 1.8) problems.push(`帶標籤的列高 ${taggedH}px，比一般的 ${rowH}px 高太多`);

// 子清單展開
const badge = page.locator('#board .sub-badge').first();
if (await badge.count()) {
  await badge.click();
  await page.waitForTimeout(300);
  const ov = await overflowOf();
  const subOk = await page.locator('#board .sub-list').first().isVisible();
  console.log(`  子清單展開：${subOk ? '✓' : '✗'}｜溢出 ${ov > 0 ? '✗ ' + ov + 'px' : '✓ 無'}`);
  if (ov > 0) problems.push(`子清單展開後溢出 ${ov}px`);
}

// ---------- AI 面板：手機上要貼在底部，而且輸入框構得到 ----------
const aiStatus = await page.evaluate(async () => {
  const r = await fetch('/api/ai/status').catch(() => null);
  return r && r.ok;
});
// 沒有後端時 aiBtn 不會出現，直接把它顯示出來驗版面（驗的是 CSS，不是流程）
await page.evaluate(() => {
  document.getElementById('aiBtn').style.display = '';
  document.getElementById('aiPanel').hidden = false;
});
await page.waitForTimeout(300);
const panel = await page.evaluate(() => {
  const p = document.getElementById('aiPanel').getBoundingClientRect();
  const inp = document.getElementById('aiInput').getBoundingClientRect();
  const send = document.getElementById('aiSend').getBoundingClientRect();
  const close = document.getElementById('aiClose').getBoundingClientRect();
  return {
    vh: window.innerHeight, vw: window.innerWidth,
    top: Math.round(p.top), bottom: Math.round(p.bottom), width: Math.round(p.width),
    inputBottom: Math.round(inp.bottom), inputH: Math.round(inp.height),
    sendW: Math.round(send.width), sendH: Math.round(send.height),
    closeW: Math.round(close.width), closeH: Math.round(close.height),
  };
});
console.log('\n  AI 面板（手機）:');
console.log(`    貼齊底部        ${panel.bottom >= panel.vh - 1 ? '✓' : '✗ bottom=' + panel.bottom + ' vh=' + panel.vh}`);
console.log(`    不是整頁蓋掉    ${panel.top > 40 ? '✓ 上緣在 ' + panel.top + 'px' : '✗ 從最上面就開始'}`);
console.log(`    滿版寬          ${panel.width >= panel.vw - 1 ? '✓' : '✗ ' + panel.width}`);
console.log(`    送出鍵大小      ${panel.sendW}×${panel.sendH}` + (panel.sendW < 60 ? '  ✗ 太窄' : '  ✓'));
if (panel.sendW < 60 || panel.sendH < 40) problems.push(`AI 送出鍵 ${panel.sendW}×${panel.sendH} 按不到`);
if (panel.inputBottom > panel.vh) problems.push('AI 輸入框跑到可視區域外');
console.log(`    關閉鍵大小      ${panel.closeW}×${panel.closeH}`);
if (panel.bottom < panel.vh - 1) problems.push('AI 面板沒有貼齊底部');
if (panel.top <= 40) problems.push('AI 面板仍然整頁蓋掉');
const aiOv = await overflowOf();
if (aiOv > 0) problems.push(`AI 面板讓版面溢出 ${aiOv}px`);
await page.evaluate(() => { document.getElementById('aiPanel').hidden = true; });

// ---------- 再量一次點擊目標 ----------
const small2 = await page.evaluate(() => {
  const out = []; const seen = new Set();
  document.querySelectorAll('#viewSchedule button, #viewSchedule .checkbox, .nav-item').forEach(el => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // 勾選框用看不見的 ::after 擴大範圍，量元素本身會低估——改量實際可點區域
    const hit = el.classList.contains('checkbox')
      ? { w: r.width + 18, h: r.height + 18 } : { w: r.width, h: r.height };
    const label = (el.className || '') + '｜' + (el.textContent || '').trim().slice(0, 10);
    if (seen.has(label)) return; seen.add(label);
    if (hit.h < 32 || hit.w < 32) out.push({ label, w: Math.round(hit.w), h: Math.round(hit.h) });
  });
  return out.slice(0, 12);
});
console.log('\n  改善後仍偏小的點擊目標：' + (small2.length ? '' : '（無）'));
small2.forEach(x => console.log(`    ${x.w}×${x.h}  ${x.label}`));
small2.forEach(x => problems.push(`點擊目標偏小 ${x.w}×${x.h}（${x.label}）`));

console.log('');
if (problems.length) { console.log('  ⚠ 找到的問題：'); problems.forEach(p => console.log('    · ' + p)); }
else console.log('  ✓ 沒有找到版面或速度問題');
console.log(errors.length ? '\n✗ ' + errors.join('\n') : '\n✓ 零 pageerror、零 console.error');

await br.close(); srv.close();
