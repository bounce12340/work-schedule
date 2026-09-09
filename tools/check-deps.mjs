/**
 * 前置作業（「待前置」徽章）與「不在」的畫面行為。
 *
 * 為什麼需要這支
 * ---------------------------------------------------------------------------
 * 兩個功能的規格有一半是**「什麼都沒發生」**，而「什麼都沒發生」是靜態檢查與
 * 單元測試最看不到的形狀：
 *
 *   1. **「不在」不影響逾期。** 使用者定的：「不在就是不在，逾期就照樣逾期」。
 *      若哪天有人「順手」讓不在的日子不算逾期，畫面看起來會更「體貼」，
 *      而實際上是把這個系統唯一的價值——該緊張的時候讓人緊張——關掉了。
 *   2. **前置作業不阻擋勾選。** 擋下來的版本畫面上也「合理」，但那是攔截式
 *      對話框，擋不住按太快，只擋得住使用者。
 *
 * 另外有一條只有在瀏覽器裡才踩得到：勾掉一個**別人的前置**時，增量路徑
 * （moveOccRowToDone）只搬走被勾的那一列，其他列的「待前置」徽章會停在舊狀態。
 * 那是「畫面看起來完全正常，只是資訊是錯的」——單元測試碰不到。
 *
 *     npx playwright install chromium     # 或設定 PLAYWRIGHT_CHROMIUM
 *     node tools/check-deps.mjs
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
const PORT = Number(process.env.PORT || 8997);

const srv = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) { res.writeHead(404); res.end('{}'); return; }
  const name = url.pathname.slice(1) || 'index.html';
  let buf; try { buf = readFileSync(PUBLIC + name); } catch { res.writeHead(404); res.end('x'); return; }
  res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
  res.end(buf);
});
srv.listen(PORT);

// 時間釘死。逾期是「早於今天」，不釘的話這支測試的對錯會隨執行當天浮動——
// 跨年那幾天甚至會整批掉出年度檢視。
const TODAY = '2026-09-09';

const mk = (o) => ({
  type: 'work', parentId: null, meetingTime: null, link: null, endDate: null,
  recurrence: null, tags: [], subtasks: [], subDone: {}, dependsOn: [],
  done: false, doneMap: {}, overrides: {}, skipped: {}, ...o
});

const SEED = {
  version: 2,
  items: [
    mk({ id: 'prereq', title: '管制藥品申報', date: '2026-09-01' }),
    // 前置在它之前 → 應該標「待前置」
    mk({ id: 'blocked', title: '跟催報表', date: '2026-09-10', dependsOn: ['prereq'] }),
    // 它比前置的第一次還早 → 這一次根本沒有前置，不該標
    mk({ id: 'early', title: '早於前置的事', date: '2026-08-20', dependsOn: ['prereq'] }),
    // 逾期 ＋ 那天不在。兩個標記必須同時出現。
    mk({ id: 'awayOverdue', title: '休假那天到期的事', date: '2026-08-25' }),
    // 第二條鏈：專門拿來驗「不阻擋」。第一條鏈會在那之前就被勾完，
    // 而勾完之後就沒有東西擋著了——用同一條會測不到。
    mk({ id: 'prereq2', title: '覆核報表', date: '2026-09-02' }),
    mk({ id: 'blocked2', title: '歸檔', date: '2026-09-12', dependsOn: ['prereq2'] }),
    mk({ id: 'plain', title: '沒有前置也不在的事', date: '2026-09-20' }),
  ],
  majorProjects: [], ganttProjects: [], dailyLogs: {},
  customHolidays: [], customWorkdays: [],
  awayDates: ['2026-08-25', '2026-09-15', '2026-09-16'],
  availableYears: [2026],
};

const br = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM });
const page = await br.newPage({ viewport: { width: 1400, height: 1100 }, locale: 'zh-TW' });
await page.clock.setFixedTime(new Date(TODAY + 'T09:00:00'));
await page.addInitScript(seed => {
  try { localStorage.setItem('workSchedule.v1', JSON.stringify(seed)); } catch (e) {}
}, SEED);

const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/net::|Failed to load/.test(m.text())) errors.push('console: ' + m.text()); });

await page.goto(`http://localhost:${PORT}/`);
await page.waitForSelector('#board');
await page.locator('#reminderClose').click().catch(() => {});
await page.waitForTimeout(300);

const checks = [];
// 邊跑邊印：當掉時最後那段總結跑不到，先前累積的結果會一起消失。
const ok = (n, c) => { checks.push([n, !!c]); console.log((c ? '  ✓ ' : '  ✗ ') + n); };

const row = t => page.locator('.occ-row').filter({ hasText: t }).first();

console.log('\n── 前置作業：只顯示狀態 ──');

ok('前置沒完成時，那一列標「待前置」', await row('跟催報表').locator('.dep-badge').count() === 1);
ok('徽章講得出是哪一個前置、哪一次',
   /管制藥品申報.*2026-09-01/.test(await row('跟催報表').locator('.dep-badge').getAttribute('title') || ''));
ok('這一次早於前置的第一次＝沒有前置，不標', await row('早於前置的事').locator('.dep-badge').count() === 0);
ok('沒設前置的項目當然不標', await row('沒有前置也不在的事').locator('.dep-badge').count() === 0);

// 不阻擋：勾得下去，只是會講一聲
await row('歸檔').locator('.checkbox').click();
await page.waitForTimeout(200);
ok('前置沒完成仍然勾得下去（不阻擋，只提示）',
   await page.evaluate(() =>
     JSON.parse(localStorage.getItem('workSchedule.v1')).items.find(x => x.id === 'blocked2').done) === true);
ok('而且會跳一句提示', await page.locator('#hintToast.show').count() === 1);
ok('提示講得出還缺什麼', /覆核報表/.test(await page.locator('#hintText').innerText()));

console.log('\n── 勾掉前置之後，別人那幾列要跟著更新 ──');
// 增量路徑（moveOccRowToDone）只搬走被勾的那一列。少了「它是別人的前置就落回
// 完整重繪」那道判斷，下面這條會紅——而畫面上完全看不出來。
await row('管制藥品申報').locator('.checkbox').click();
await page.waitForTimeout(600);
ok('前置做完了，「待前置」就該不見', await row('跟催報表').locator('.dep-badge').count() === 0);

console.log('\n── 「不在」：標記歸標記，逾期照樣逾期 ──');
const awayRow = row('休假那天到期的事');
ok('那天不在，列上有 🌴 標記', await awayRow.locator('.away-badge').count() === 1);
ok('**而且逾期照樣是逾期**', await awayRow.locator('.occ-date.overdue').count() === 1);
ok('不在的標記不影響沒標記的列', await row('沒有前置也不在的事').locator('.away-badge').count() === 0);

console.log('\n── 日曆上的「不在」 ──');
await page.locator('.nav-item', { hasText: '日曆' }).click();
await page.waitForSelector('#calGrid .cal-cell[data-date]');
await page.evaluate(() => {
  const t = document.getElementById('calTitle');
  for (let i = 0; i < 40 && !/2026 年 9 月/.test(t.textContent); i++) document.getElementById('calNext').click();
});
await page.waitForTimeout(300);
const cell = d => page.locator(`.cal-cell[data-date="2026-09-${d}"]`);

ok('不在的格子有 away class', /\baway\b/.test(await cell('15').getAttribute('class') || ''));
ok('而且畫得出 🌴', await cell('15').locator('.cal-away-mark').count() === 1);
ok('沒標記的格子沒有', await cell('17').locator('.cal-away-mark').count() === 0);

// 從日曆上標記一天
await cell('17').click();
await page.waitForTimeout(300);
ok('選了日期就出現「標記為不在」按鈕', await page.locator('#btnToggleAway').isVisible());
ok('按鈕文案是「標記」而不是「取消」', /標記為不在/.test(await page.locator('#btnToggleAway').innerText()));
await page.locator('#btnToggleAway').click();
await page.waitForTimeout(400);
ok('按下去那一格就多了 🌴', await cell('17').locator('.cal-away-mark').count() === 1);
ok('而且真的存進去了', await page.evaluate(() =>
  (JSON.parse(localStorage.getItem('workSchedule.v1')).awayDates || []).includes('2026-09-17')));
ok('已經是「不在」時，按鈕改講「取消不在」', /取消不在/.test(await page.locator('#btnToggleAway').innerText()));
await page.locator('#btnToggleAway').click();
await page.waitForTimeout(400);
ok('再按一次就取消掉', await cell('17').locator('.cal-away-mark').count() === 0);

// 「不在」不會讓日曆上的項目換一天出現
ok('標記「不在」不會移動任何項目的日期', await page.evaluate(() =>
  JSON.parse(localStorage.getItem('workSchedule.v1')).items.every(x => x.date === {
    prereq: '2026-09-01', blocked: '2026-09-10', early: '2026-08-20',
    awayOverdue: '2026-08-25', plain: '2026-09-20',
    prereq2: '2026-09-02', blocked2: '2026-09-12'
  }[x.id])));

console.log('\n── 擋環：候選清單裡不會出現繞得回來的項目 ──');
await page.locator('.nav-item', { hasText: '項目安排' }).click();
await page.waitForTimeout(300);
// 用第二條鏈：「歸檔」依賴「覆核報表」，所以編輯「覆核報表」時不該選得到「歸檔」
await row('覆核報表').locator('button', { hasText: '編輯' }).click();
await page.waitForTimeout(300);
const opts = await page.locator('#selectAddDep option').allInnerTexts();
ok('編輯「覆核報表」時，候選裡沒有它自己', !opts.includes('覆核報表'));
ok('也沒有「歸檔」——它已經依賴我，選了就繞成環', !opts.includes('歸檔'));
ok('不相干的項目仍然選得到', opts.includes('沒有前置也不在的事'));
await page.locator('#btnCancelItem').click();

console.log('');
let bad = 0;
for (const [n, c] of checks) if (!c) { bad++; console.log('  ✗ 未通過：' + n); }
console.log(errors.length ? '\n✗ ' + errors.join('\n') : '\n✓ 零 pageerror、零 console.error');
await br.close(); srv.close();
process.exit(bad || errors.length ? 1 : 0);
