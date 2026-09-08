/**
 * 量「切換檢視／篩選／打字搜尋」在不同資料量下真正卡住主執行緒多久。
 *
 * 為什麼要有這支腳本
 * ---------------------------------------------------------------------------
 * CLAUDE.md 的〈響應速度〉整節都是實測數字，而那些數字原本沒有辦法重跑——
 * 於是「這次改動有沒有讓它變慢」只能靠感覺。感覺在這裡特別不可靠：開發時的
 * 示範資料只有 6 個項目，而真實使用者有 64 個，展開成 1461 列。**開發者永遠
 * 踩不到使用者踩得到的那個卡頓。**
 *
 * 量的是 PerformanceObserver 的 longtask，不是「函式回來得多快」。兩者差了一個
 * 數量級：JS 只佔約 5%，其餘是瀏覽器對數千列重跑樣式計算與版面配置。量錯對象
 * 會把人帶去優化那 5%。
 *
 * 用法（Playwright 不是本專案的相依套件，需要時才裝）：
 *   node tools/measure-board.mjs
 *   PLAYWRIGHT_CHROMIUM=/path/to/chrome node tools/measure-board.mjs
 *
 * 它不是 CI 的一部分：數字會隨執行環境浮動，設一條會過會不過的門檻只會製造
 * 沒有人相信的紅燈。它的用途是**改動前後各跑一次、自己比對**。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from '/home/user/work-schedule/node_modules/playwright/index.mjs';

const PORT = 8981;
const PUBLIC = '/home/user/work-schedule/public/';
const server = createServer((req, res) => {
  const name = new URL(req.url, 'http://x').pathname.slice(1) || 'index.html';
  if (name.startsWith('api/')) { res.writeHead(404); res.end('{}'); return; }
  let buf; try { buf = readFileSync(PUBLIC + name); } catch { res.writeHead(404); res.end('x'); return; }
  res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
  res.end(buf);
});
server.listen(PORT);

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

// 產生 n 個項目：混合週期，貼近真實排程（helen 的 64 項裡有大量每週／每月循環）
function makeState(n) {
  const types = ['work', 'meeting', 'assignment'];
  // 欄位名必須完全對上 normalizeRecurrence，否則會被過濾成 null（＝不循環），
  // 展開出來的列數就完全不對——第一次量到「只有 8 列」就是這個原因
  const freqs = [
    { freq: 'weekly', weekdays: [1, 3], holidayRule: 'postpone' },
    { freq: 'weekly', weekdays: [2] },
    { freq: 'monthly', mode: 'day', day: 15, holidayRule: 'postpone' },
    { freq: 'quarterly', day: 5 },
    null,
  ];
  return {
    version: 2,
    items: Array.from({ length: n }, (_, i) => ({
      id: 'it' + i,
      title: '項目 ' + i + ' 的名稱',
      type: types[i % 3],
      date: '2026-0' + (1 + (i % 9)) + '-1' + (i % 9),
      recurrence: freqs[i % freqs.length],
      done: false, doneMap: {}, overrides: {}, skipped: {},
    })),
    majorProjects: [], ganttProjects: [], dailyLogs: {},
    customHolidays: [], customWorkdays: [],
  };
}

const results = [];
for (const n of [64, 150, 300]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(state => {
    try { localStorage.setItem('workSchedule.v1', JSON.stringify(state)); } catch (e) {}
  }, makeState(n));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('#board');
  await page.waitForTimeout(700);

  await page.evaluate(() => {
    window.__lt = [];
    new PerformanceObserver(l => l.getEntries().forEach(e => window.__lt.push(e.duration)))
      .observe({ entryTypes: ['longtask'] });
  });

  const rows = await page.locator('#board > *').count();

  // ① 切換 mode 頁籤（年 → 季 → 年）
  const measure = async fn => {
    await page.evaluate(() => { window.__lt = []; });
    await fn();
    await page.waitForTimeout(400);
    const lt = await page.evaluate(() => window.__lt.reduce((a, b) => a + b, 0));
    return Math.round(lt);
  };

  const tabs = page.locator('#modeTabs .mode-tab, #modeTabs button');
  const tabCount = await tabs.count();
  const switchMs = tabCount >= 2 ? await measure(async () => {
    await tabs.nth(1).click(); await page.waitForTimeout(250);
    await tabs.nth(0).click();
  }) : -1;

  // ② 在搜尋框打五個字（每個字元都會 renderBoard()）
  const search = page.locator('#inputSearch');
  const typeMs = await measure(async () => {
    await search.click();
    for (const ch of '項目 12') { await search.type(ch, { delay: 0 }); await page.waitForTimeout(120); }
  });
  await search.fill('');

  // ③ 「只看未完成」開關
  const hideMs = await measure(async () => { await page.locator('#btnHideDone').click(); });
  await page.locator('#btnHideDone').click();

  results.push({ n, rows, switchMs, typeMs, hideMs });
  await page.close();
}

console.log('\n  項目數 | board 列數 |  切換頁籤 | 搜尋打 5 個字 | 切換「只看未完成」');
console.log('  ------ | ---------- | --------- | ------------- | -----------------');
for (const r of results) {
  console.log('  ' + String(r.n).padStart(6) + ' | ' + String(r.rows).padStart(10) + ' | ' +
    String(r.switchMs + 'ms').padStart(9) + ' | ' + String(r.typeMs + 'ms').padStart(13) + ' | ' +
    String(r.hideMs + 'ms').padStart(17));
}
console.log('\n  （longtask 總和＝主執行緒實際被卡住的時間；> 50ms 就是一次可感知的停頓）\n');

await browser.close(); server.close();
