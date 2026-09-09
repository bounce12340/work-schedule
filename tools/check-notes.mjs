/**
 * 每日記錄與專案筆記：格式與內容不能在離開後消失。
 *
 * 為什麼需要這支
 * ---------------------------------------------------------------------------
 * 使用者回報「打過的東西跳出去再回來就跑掉」。實測重現出兩個獨立的原因，兩個都
 * 是**單元測試全綠、語法檢查也過**的那一類：
 *
 * 1. **醒目提示被過濾器丟掉。** 我們傳給 execCommand 的是 `#FFF3A3`，但瀏覽器
 *    把行內樣式序列化成 `rgb(255, 243, 163)`——白名單只認十六進位，比對不到就
 *    整條丟掉。按下當下畫面是對的，失焦重寫 DOM 的那一刻才消失。
 *    單元測試餵的是我們自己寫的十六進位值，永遠測不到這件事。
 *
 * 2. **最後打的字還在 debounce 裡就被帶走。** 存檔是 400ms debounce、雲端再
 *    1500ms，所以關掉分頁或重新整理時，最後將近兩秒的輸入只存在記憶體裡。
 *
 * 兩者的共通點是「畫面上完全看不出來」——使用者只知道東西不見了。
 *
 * 依賴 Playwright，而 Playwright **不是**本專案的相依套件（零相依是專案前提），
 * 所以放在 tools/ 而不是 tests/：
 *
 *     npx playwright install chromium     # 或設定 PLAYWRIGHT_CHROMIUM 指向現成的
 *     node tools/check-notes.mjs
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
const PORT = Number(process.env.PORT || 8996);

const srv = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) { res.writeHead(404); res.end('{}'); return; }
  const name = url.pathname.slice(1) || 'index.html';
  let buf; try { buf = readFileSync(PUBLIC + name); } catch { res.writeHead(404); res.end('x'); return; }
  res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
  res.end(buf);
});
srv.listen(PORT);

const br = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM });
const page = await br.newPage({ viewport: { width: 1400, height: 1000 }, locale: 'zh-TW' });

const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/net::|Failed to load/.test(m.text())) errors.push('console: ' + m.text()); });

const checks = [];
// 邊跑邊印，不要只在最後印。
// 遇到當掉（例如 Playwright 嚴格模式一次撈到多個元素）時，最後那段總結根本
// 跑不到——先前累積的每一條結果會一起消失，只剩一段看不出脈絡的堆疊。
// 用突變驗證時實際踩到：斷言明明紅了，畫面上卻什麼都看不到。
const ok = (n, c, extra) => {
  const label = n + (extra ? '（' + extra + '）' : '');
  checks.push([label, !!c]);
  console.log((c ? '  \u2713 ' : '  \u2717 ') + label);
};
const nav = t => page.locator('.nav-item', { hasText: t }).click();
const rtEmptyish = h => String(h || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim() === '';

async function boot() {
  await page.waitForSelector('#board');
  await page.locator('#reminderClose').click().catch(() => {});
  await page.waitForTimeout(300);
}

await page.goto(`http://localhost:${PORT}/`);
await boot();
// 工具列預設收起，把它打開才點得到顏色鈕
await page.keyboard.press('Control+Shift+X');
await page.waitForTimeout(200);

await nav('日曆');
await page.waitForSelector('#calGrid .cal-cell[data-date]');
const cell = page.locator('.cal-cell[data-date]').nth(9);
const dateStr = await cell.getAttribute('data-date');
await cell.click();
await page.waitForTimeout(300);

const dayEd = () => page.locator('#daylogSlot .rt-edit');
const storedLog = () => page.evaluate(
  d => (JSON.parse(localStorage.getItem('workSchedule.v1')).dailyLogs || {})[d] || '', dateStr);

async function retype(ed, text) {
  await ed.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type(text);
}

// ---------- 1. 醒目提示：瀏覽器吐 rgb()，過濾器必須認得 ----------
await retype(dayEd(), '這句要加螢光筆');
await page.keyboard.press('Control+a');
await page.locator('#daylogSlot .rt-btn', { hasText: '✎' }).click();
await page.waitForTimeout(150);
await page.locator('#daylogSlot .rt-pop .rt-swatch').first().click();
await page.waitForTimeout(200);

const painted = await dayEd().innerHTML();
ok('按下醒目提示，瀏覽器確實用 rgb() 寫樣式（這正是坑的來源）',
   /background-color:\s*rgb\(/i.test(painted));

// 切走再切回來 = 走過 blur 重寫 DOM 與整段重建兩條路
await nav('專案'); await page.waitForTimeout(300);
await nav('日曆'); await page.waitForTimeout(400);

const afterNav = await dayEd().innerHTML();
ok('切走再回來，醒目提示還在', /background-color:\s*#FFF3A3/i.test(afterNav), afterNav.slice(0, 60));
ok('存檔裡也是十六進位（不是被丟掉的空 span）',
   /background-color:\s*#FFF3A3/i.test(await storedLog()));
ok('文字本身沒有被弄丟', /這句要加螢光筆/.test(afterNav));

// ---------- 2. 文字顏色與字級 ----------
await retype(dayEd(), '顏色與字級');
await page.keyboard.press('Control+a');
await page.locator('#daylogSlot .rt-btn.rt-fg').click();
await page.waitForTimeout(150);
await page.locator('#daylogSlot .rt-pop .rt-swatch').first().click();
await page.waitForTimeout(150);
await page.keyboard.press('Control+a');
await page.locator('#daylogSlot .rt-btn', { hasText: 'AA' }).click();
await page.waitForTimeout(150);
await page.locator('#daylogSlot .rt-pop .rt-sizebtn').last().click();
await page.waitForTimeout(200);
await nav('專案'); await page.waitForTimeout(300);
await nav('日曆'); await page.waitForTimeout(400);
const colored = await dayEd().innerHTML();
ok('文字顏色留得住', /color:\s*#C0392B/i.test(colored), colored.slice(0, 70));
ok('字級留得住', /font-size:\s*1\.28em/i.test(colored));

// ---------- 3. 打完字立刻離開：debounce 必須被結帳 ----------
// 存檔是 400ms debounce、雲端再 1500ms，所以打完最後一個字就關掉分頁的話，
// 那幾個字只存在記憶體裡。
//
// **這裡刻意不用「打完字然後 page.reload()」來測。** 第一版是那樣寫的，結果拿掉
// 修正之後測試照樣綠——Playwright 送出 reload 本身就要好幾十毫秒，跟 400ms 的
// debounce 賽跑，誰快誰慢看當天的機器。賭時間的斷言不是測試，是擲骰子。
//
// 改成直接驗機制：在同一次 evaluate 裡發出 pagehide 再讀 localStorage，中間沒有
// 任何非同步空隙可以讓 debounce 偷偷跑完。而 debounce 是**每一個字元都重新計時**
// 的，所以最後一次按鍵之後必定還有完整的 400ms。
async function flushProbe(text) {
  return page.evaluate(({ d, ev }) => {
    const read = () => {
      try { return (JSON.parse(localStorage.getItem('workSchedule.v1')).dailyLogs || {})[d] || ''; }
      catch (e) { return ''; }
    };
    const before = read();
    window.dispatchEvent(new Event(ev));
    return { before, after: read() };
  }, { d: dateStr, ev: text });
}

await retype(dayEd(), '關掉分頁前打的字');
const hide = await flushProbe('pagehide');
ok('pagehide（關分頁／重新整理）會把還在等的存檔寫進去',
   /關掉分頁前打的字/.test(hide.after));
ok('而且那一刻確實還沒寫進去——證明測到的是結帳，不是 debounce 剛好跑完',
   !/關掉分頁前打的字/.test(hide.before));

// 失焦：點去別的地方（例如按頁籤）也算「我打完了」
await retype(dayEd(), '點去別處前打的字');
const beforeBlur = await storedLog();
await page.locator('#calTitle').click();
await page.waitForTimeout(120);       // 只等 blur 事件跑完，遠小於 400ms
ok('失焦會把還在等的存檔寫進去', /點去別處前打的字/.test(await storedLog()));
ok('失焦前確實還沒寫進去', !/點去別處前打的字/.test(beforeBlur));

// 真的重新整理一次，確認整條路（pagehide → localStorage → 啟動載入）接得起來
await page.reload();
await boot();
await nav('日曆');
await page.waitForSelector('#calGrid .cal-cell[data-date]');
await page.locator(`.cal-cell[data-date="${dateStr}"]`).click();
await page.waitForTimeout(400);
ok('重新整理之後讀得回來', /點去別處前打的字/.test(await dayEd().innerHTML()));

// 切頁籤（不重新整理）也要留得住
await retype(dayEd(), '切頁籤前打的字');
await nav('專案');                    // 完全不等 debounce
await page.waitForTimeout(300);
await nav('日曆'); await page.waitForTimeout(400);
ok('打完字立刻切頁籤，內容還在', /切頁籤前打的字/.test(await dayEd().innerHTML()));

// ---------- 4. 專案筆記走同一條路，也要一起驗 ----------
await nav('專案');
await page.waitForTimeout(400);
const noteEd = () => page.locator('#viewGantt .daylog-box .rt-edit').first();
ok('找得到專案筆記編輯器', await noteEd().count() === 1);

await retype(noteEd(), '專案筆記的字');
await page.keyboard.press('Control+a');
await page.locator('#viewGantt .rt-btn', { hasText: '✎' }).first().click();
await page.waitForTimeout(150);
await page.locator('#viewGantt .rt-pop .rt-swatch').first().click();
await page.waitForTimeout(200);
await nav('日曆'); await page.waitForTimeout(300);
await nav('專案'); await page.waitForTimeout(500);
const noteAfter = await noteEd().innerHTML();
ok('專案筆記的醒目提示也留得住', /background-color:\s*#FFF3A3/i.test(noteAfter), noteAfter.slice(0, 60));
ok('專案筆記的內容還在', /專案筆記的字/.test(noteAfter));

// 專案筆記走的是同一個 persistSoon()，這裡驗它也真的被結帳到
await retype(noteEd(), '筆記打完立刻走');
const noteProbe = await page.evaluate(() => {
  const read = () => {
    try {
      const gp = JSON.parse(localStorage.getItem('workSchedule.v1')).ganttProjects || [];
      return gp.map(p => p.notes || '').join('|');
    } catch (e) { return ''; }
  };
  const before = read();
  window.dispatchEvent(new Event('pagehide'));
  return { before, after: read() };
});
ok('專案筆記：pagehide 也會結帳', /筆記打完立刻走/.test(noteProbe.after));
ok('專案筆記：那一刻確實還沒寫進去', !/筆記打完立刻走/.test(noteProbe.before));

// ---------- 5.「今天先不寫」：給使用者一個不做事的出口 ----------
//
// 它**什麼都不寫入**——只是把編輯器收起來換成一句話。刻意不存狀態：存了就變成
// 另一種要求（「你今天已經表態過了」），而這顆按鈕的用意剛好相反。
//
// **順序很重要。** 第一版是「按下按鈕 → 換一天 → 檢查按鈕不見了」，那三條斷言
// 全部會過，但**過的理由是錯的**：按鈕在點擊當下就被 remove() 了，所以不管它
// 掛在哪一層都測不到。用突變驗過才發現（把按鈕掛回父層，測試照樣綠）。
// 現在改成「**不要按**它，直接換一天」——那才測得到跨重繪的存活問題。
await nav('日曆');
await page.waitForSelector('#calGrid .cal-cell[data-date]');
const blankCell = page.locator('.cal-cell[data-date]').nth(20);
const blankDate = await blankCell.getAttribute('data-date');
const otherCell = page.locator('.cal-cell[data-date]').nth(22);

await blankCell.click();
await page.waitForTimeout(400);
ok('空白的日子會出現「今天先不寫」', await page.locator('.daylog-skip button').count() === 1);

// 不按它，直接換一天：按鈕必須跟著那一次的重繪一起消失
await otherCell.click();
await page.waitForTimeout(400);
ok('換一天之後不會留下前一天的按鈕（只能有一顆）',
   await page.locator('.daylog-skip').count() === 1);

// 有內容的日子根本不該問——那時候該問的不是「要不要寫」
await page.locator(`.cal-cell[data-date="${dateStr}"]`).click();
await page.waitForTimeout(400);
ok('寫過的日子完全不出現那顆按鈕', await page.locator('.daylog-skip').count() === 0);

// 真的按下去的行為
await blankCell.click();
await page.waitForTimeout(400);
await page.locator('.daylog-skip button').click();
await page.waitForTimeout(300);
ok('按下去編輯器收起來', await page.locator('#daylogSlot .rt-edit').count() === 0);
ok('換成一句軟話', /今天先這樣/.test(await page.locator('.daylog-rest').innerText()));

// 離開再回來：**沒有留下任何東西**。只讀 localStorage 不夠——記憶體裡被寫髒
// 但還沒存檔的話讀不到，所以也看畫面：編輯器要是空的、格子上不能長出 ✎。
await otherCell.click();
await page.waitForTimeout(300);
await blankCell.click();
await page.waitForTimeout(400);
ok('回來之後編輯器還是空的', rtEmptyish(await page.locator('#daylogSlot .rt-edit').innerHTML()));
ok('格子上沒有長出 ✎ 記號',
   await page.locator(`.cal-cell[data-date="${blankDate}"] .cal-log-mark`).count() === 0);
const afterSkip = await page.evaluate(
  d => ((JSON.parse(localStorage.getItem('workSchedule.v1')).dailyLogs || {})[d] || ''), blankDate);
ok('存檔裡也沒有這一天', rtEmptyish(afterSkip));

// ---------- 6. 工具列的收合偏好跨頁籤一致 ----------
const barHidden = async sel => ((await page.locator(sel).first().getAttribute('class')) || '')
  .includes('rt-bar-hidden');
ok('專案筆記的工具列維持展開', !(await barHidden('#viewGantt .daylog-box .rt-wrap')));
await nav('日曆');
await page.waitForSelector('#calGrid .cal-cell[data-date]');
await page.locator(`.cal-cell[data-date="${dateStr}"]`).click();
await page.waitForTimeout(400);
ok('每日記錄的工具列也維持展開', !(await barHidden('#daylogSlot .rt-wrap')));

console.log('');
let bad = 0;
for (const [n, c] of checks) if (!c) { bad++; console.log('  ✗ 未通過：' + n); }
console.log(errors.length ? '\n✗ ' + errors.join('\n') : '\n✓ 零 pageerror、零 console.error');
await br.close(); srv.close();
process.exit(bad || errors.length ? 1 : 0);
