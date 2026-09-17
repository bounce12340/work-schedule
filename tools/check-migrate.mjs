/**
 * 舊備份檔匯得回來嗎？
 *
 * 為什麼需要這支
 * ---------------------------------------------------------------------------
 * 使用者手上那份半年前匯出的 .json 是**永遠不會再改變的舊格式**，而
 * `STORAGE_VERSION` 每加一版，那條升級路徑就多一階。單元測試證明得了
 * 「migrateSnapshot 這個函式對」，證明不了「它真的被接上了」——
 * 而這兩件事分家的症狀，正是 CLAUDE.md〈儲存層的三個設計約束〉第 4 點寫的：
 * 套用不了的存檔會被示範資料直接蓋掉，畫面上看起來一切正常。
 *
 * 實際踩過的形狀（v3 開發時）：升級原本寫成一串 if，v1 那條直接 return 一個 v2
 * 物件。只有兩個版本時剛好正確，第三版一加，v1 存檔就停在 v2，接著讀不到 v3
 * 才有的欄位——「不在」那幾天**安靜地消失**，沒有任何錯誤訊息。
 *
 * 所以這支走的是真正的使用者路徑：造一個檔案丟進 #importFile，按下確認，
 * 然後去讀 localStorage 看實際存進去的是什麼。
 *
 *     npx playwright install chromium     # 或設定 PLAYWRIGHT_CHROMIUM
 *     node tools/check-migrate.mjs
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
const PORT = Number(process.env.PORT || 8949);

const srv = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) { res.writeHead(404); res.end('{}'); return; }
  const name = url.pathname.slice(1) || 'index.html';
  let buf; try { buf = readFileSync(PUBLIC + name); } catch { res.writeHead(404); res.end('x'); return; }
  res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
  res.end(buf);
});
srv.listen(PORT);

/**
 * 一份 v1 的備份：最舊的格式。純文字筆記（v1→v2 會轉成 HTML）＋ awayDates
 * （v2→v3 會變成 absences）。**兩階都要真的走到**，這正是那個 bug 的形狀。
 */
const V1_BACKUP = {
  version: 1,
  majorProjects: [{ id: 'mp1', name: '年度稽核' }],
  items: [{ id: 'i1', title: '送件', type: 'work', parentId: 'mp1', meetingTime: null,
            date: '2026-09-20', recurrence: null, done: false, doneMap: {}, overrides: {}, skipped: {} }],
  ganttProjects: [{ id: 'g1', name: '官網', tasks: [], notes: '第一行\n第二行' }],
  dailyLogs: { '2026-09-15': '今天\n很忙' },
  customHolidays: [], customWorkdays: [],
  awayDates: ['2026-09-15', '2026-09-16'],
  availableYears: [2026], selectedGanttProjectId: 'g1'
};

let bad = 0;
const ok = (name, cond) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) bad++; };

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const errs = [];
page.on('pageerror', e => errs.push('pageerror: ' + e.message));
// 字型 CDN 在這個臨時 server 上一定 404，那不是這支要驗的東西
page.on('console', m => {
  const t = m.text();
  if (m.type() === 'error' && !/Failed to load resource|ERR_CERT/.test(t)) errs.push('console.error: ' + t);
});
// 匯入前會問「確定要取代目前的資料嗎」——不按確定的話整條路根本不會走，
// 而畫面上仍然是示範資料，看起來就像「匯入成功但沒變」。
page.on('dialog', d => d.accept());

await markSignedIn(page);
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForSelector('#board, .empty-state');

console.log('\n── 匯入一份 v1 的舊備份 ──');
await page.evaluate(b => {
  const dt = new DataTransfer();
  dt.items.add(new File([JSON.stringify(b)], 'backup.json', { type: 'application/json' }));
  const inp = document.getElementById('importFile');
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
}, V1_BACKUP);
await page.waitForTimeout(700);

const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('workSchedule.v1') || 'null'));
ok('存檔升到目前的版本（不是停在中間某一階）', saved && saved.version === 3);
ok('項目沒有被示範資料蓋掉', saved && saved.items.length === 1 && saved.items[0].id === 'i1');
ok('v1 → v2 真的做到了：純文字筆記換行變成 <br>',
   saved && /<br\s*\/?>/.test(saved.dailyLogs['2026-09-15'] || ''));
ok('v1 → v2 也套用到專案筆記',
   saved && /<br\s*\/?>/.test((saved.ganttProjects[0] || {}).notes || ''));
ok('v2 → v3 真的做到了：「不在」那兩天都還在',
   saved && Object.keys(saved.absences || {}).length === 2);
ok('而且形狀是新的（整天不在）',
   saved && (saved.absences['2026-09-15'] || []).some(a => a.kind === 'away' && a.from === null && a.to === null));
ok('舊鍵沒有跟著存回去——兩邊都寫的話，哪個是真的會變成猜謎',
   saved && !('awayDates' in saved));

console.log('\n── 比目前更新的版本要被擋下來，而且不能把現有資料弄掉 ──');
const before = await page.evaluate(() => localStorage.getItem('workSchedule.v1'));
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.items.add(new File([JSON.stringify({ version: 99, items: [] })], 'future.json', { type: 'application/json' }));
  const inp = document.getElementById('importFile');
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(500);
const after = await page.evaluate(() => localStorage.getItem('workSchedule.v1'));
ok('存檔一個字都沒被動到', before === after);

ok('零 pageerror、零 console.error', errs.length === 0);
errs.forEach(e => console.log('     ' + e));

await ctx.close();
await browser.close();
srv.close();

console.log(bad ? `\n✗ ${bad} 條沒過` : '\n✓ 舊備份匯得回來，一筆都沒少');
process.exit(bad ? 1 : 0);
