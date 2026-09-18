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
  version: 3,
  items: [
    mk({ id: 'prereq', title: '管制藥品申報', date: '2026-09-01' }),
    // 前置在它之前 → 應該標「待前置」
    mk({ id: 'blocked', title: '跟催報表', date: '2026-09-10', dependsOn: ['prereq'] }),
    // 它比前置的第一次還早 → 這一次根本沒有前置，不該標
    mk({ id: 'early', title: '早於前置的事', date: '2026-08-20', dependsOn: ['prereq'] }),
    // 逾期 ＋ 那天不在。兩個標記必須同時出現。
    mk({ id: 'awayOverdue', title: '不在那天到期的事', date: '2026-08-25' }),
    // 逾期 ＋ 那天**休假**。休假同樣不豁免逾期——這是使用者的紅線，
    // 而「調柔一點」的改法不會讓任何東西壞掉，只會讓真的遲交的人付代價。
    mk({ id: 'leaveOverdue', title: '休假那天到期的事', date: '2026-08-26' }),
    // 第二條鏈：專門拿來驗「不阻擋」。第一條鏈會在那之前就被勾完，
    // 而勾完之後就沒有東西擋著了——用同一條會測不到。
    mk({ id: 'prereq2', title: '覆核報表', date: '2026-09-02' }),
    mk({ id: 'blocked2', title: '歸檔', date: '2026-09-12', dependsOn: ['prereq2'] }),
    mk({ id: 'plain', title: '沒有前置也不在的事', date: '2026-09-20' }),
    // 純告知（B）。四種形狀各一個，因為「不算進去」有八個地方，每一個壞掉的
    // 症狀都是「畫面看起來是對的，只是數字不對」。
    mk({ id: 'realToday',   title: '今天真的要做的事', date: TODAY }),
    mk({ id: 'noticeToday', title: '總部政策宣達', date: TODAY, noticeOnly: true }),
    // 日期已過的純告知：**留在看板上**、標「已過」，而且**沒有紅字**
    mk({ id: 'noticePast',  title: '上個月的公告', date: '2026-08-20', noticeOnly: true }),
    // 曾經被勾過、之後才被改成純告知的：不准掉進「已完成」區（那裡找不到它）
    mk({ id: 'noticeDone',  title: '被標成完成的純告知', date: '2026-09-11', noticeOnly: true, done: true }),
  ],
  majorProjects: [], ganttProjects: [], dailyLogs: {},
  customHolidays: [], customWorkdays: [],
  // v2 → v3 的搬家由 tools/check-migrate.mjs 專門驗（它走完整的匯入路徑）。
  // 這裡用新形狀，因為要表達的是「休假」——舊形狀裝不下。
  absences: {
    '2026-08-25': [{ kind: 'away',  from: null, to: null }],
    '2026-08-26': [{ kind: 'leave', from: null, to: null, icon: '🤒' }],
    '2026-09-15': [{ kind: 'away',  from: '09:00', to: '12:00' }],
    '2026-09-16': [{ kind: 'away',  from: null, to: null },
                   { kind: 'leave', from: '13:00', to: '18:00', icon: '🏖️' }],
  },
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

await markSignedIn(page);   // 登入閘門：見 tools/lib/signed-in.mjs
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

console.log('\n── 「不在」與「休假」：標記歸標記，逾期照樣逾期 ──');
const awayRow = row('不在那天到期的事');
ok('那天不在，列上有 🌴 標記', await awayRow.locator('.away-badge').count() === 1);
ok('**而且逾期照樣是逾期**', await awayRow.locator('.occ-date.overdue').count() === 1);

// 休假走完全相同的規則。它是 2026-09-17 新加的，而新加的狀態最容易被「順手」
// 做成豁免——「人家都請假了還算他逾期」聽起來很體貼，實際上是把這個工具存在
// 的理由關掉。所以兩種狀態各有一條一模一樣的斷言。
const leaveRow = row('休假那天到期的事');
ok('那天休假，列上有休假標記', await leaveRow.locator('.leave-badge').count() === 1);
ok('**休假一樣不豁免逾期**', await leaveRow.locator('.occ-date.overdue').count() === 1);
// 先確認有東西再讀文字：元素不在時 innerText() 會 throw，整支腳本崩掉——
// 崩掉也是紅的，但訊息對下一個人毫無幫助（突變驗證時實際遇到）。
ok('休假的標記帶著使用者挑的圖示',
   await leaveRow.locator('.leave-badge').count() === 1
   && /🤒/.test(await leaveRow.locator('.leave-badge').innerText()));

// 逾期不只要「有標記」，還要**看起來就是警告**。
//
// 〈視覺基調〉那條紅線是「氣質可以柔，警示不行」，而每一次視覺改版都是一次
// 順手把它一起調柔的機會——調柔之後畫面會更好看，沒有任何檢查會紅，只有真的
// 遲交的人會付代價。所以把它量出來：顏色要是警示色、字重要比旁邊的日期重。
const redLine = await page.evaluate(() => {
  const od = document.querySelector('.occ-date.overdue');
  const plain = [...document.querySelectorAll('.occ-date')].find(e => !e.classList.contains('overdue'));
  if (!od || !plain) return null;
  const a = getComputedStyle(od), b = getComputedStyle(plain);
  const red = getComputedStyle(document.documentElement).getPropertyValue('--red').trim();
  // --red 是 hex，計算後的 color 是 rgb()。換算過再比，才不是在比兩種寫法。
  const hex = c => '#' + (c.match(/\d+/g) || []).slice(0, 3)
    .map(n => Number(n).toString(16).padStart(2, '0')).join('');
  return {
    isRed: hex(a.color).toLowerCase() === red.toLowerCase(),
    heavier: parseInt(a.fontWeight) >= 700 && parseInt(a.fontWeight) > parseInt(b.fontWeight),
    differs: a.color !== b.color,
    detail: a.color + ' / ' + a.fontWeight + '　vs　' + b.color + ' / ' + b.fontWeight
  };
});
ok('逾期用的是警示色（--red），不是被調柔成別的顏色', !!(redLine && redLine.isRed));
ok('逾期比旁邊的日期重，而且顏色不同', !!(redLine && redLine.heavier && redLine.differs));
if (redLine) console.log('    ' + redLine.detail);
ok('不在的標記不影響沒標記的列', await row('沒有前置也不在的事').locator('.away-badge').count() === 0);
ok('休假的標記也不影響沒標記的列', await row('沒有前置也不在的事').locator('.leave-badge').count() === 0);

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

// 🌴 **在右上角**（2026-09-17 使用者指定從左上搬過來），而且在 ✎ 的左邊。
// 只斷言「畫得出來」的話，搬回左上角不會有任何東西紅——突變驗證抓到的。
const markPos = await page.evaluate(() => {
  const c = document.querySelector('.cal-cell[data-date="2026-09-16"]');
  if (!c) return null;
  const m = c.querySelector('.cal-away-mark');
  if (!m) return null;
  const cs = getComputedStyle(m);
  const cb = c.getBoundingClientRect(), mb = m.getBoundingClientRect();
  return {
    // 絕對定位的元素，getComputedStyle 的 left/right 回的是**用過的值**（px），
    // 不會是 'auto'——所以要問的是 position 與實際落點，不是 left 寫了什麼。
    isAbsolute: cs.position === 'absolute',
    rightSet: parseFloat(cs.right) >= 0 && parseFloat(cs.right) < 60,
    // 真的靠右：記號的中心在格子的右半邊
    onRightHalf: (mb.left + mb.width / 2) > (cb.left + cb.width / 2)
  };
});
ok('🌴 仍然是絕對定位（不能被別的規則蓋成 relative）', !!(markPos && markPos.isAbsolute));
ok('🌴 靠右邊定位', !!(markPos && markPos.rightSet));
ok('🌴 真的落在格子的右半邊', !!(markPos && markPos.onRightHalf));

// 從日曆上標記一天。**行為 2026-09-17 改過**：按鈕不再是直接切換，而是開面板
// ——因為現在要選種類、時段與圖示，一顆切換按鈕表達不了。
await cell('17').click();
await page.waitForTimeout(300);
ok('選了日期就出現按鈕', await page.locator('#btnToggleAway').isVisible());
await page.locator('#btnToggleAway').click();
await page.waitForTimeout(250);
ok('按下去開的是設定面板', await page.locator('#absenceOverlay.show').count() === 1);
await page.locator('#btnAbsAdd').click();     // 預設就是「整天不在」
await page.waitForTimeout(400);
ok('面板關起來了', await page.locator('#absenceOverlay.show').count() === 0);
ok('那一格多了 🌴', await cell('17').locator('.cal-away-mark').count() === 1);
ok('而且真的存進去了', await page.evaluate(() => {
  const saved = JSON.parse(localStorage.getItem('workSchedule.v1'));
  const day = (saved.absences || {})['2026-09-17'] || [];
  return saved.version === 3 && day.some(a => a.kind === 'away' && a.from === null);
}));
ok('存下去的是新形狀，舊鍵沒有跟著復活', await page.evaluate(() =>
  !('awayDates' in JSON.parse(localStorage.getItem('workSchedule.v1')))));

// 刪掉它：面板裡每一筆旁邊的 ✕。刻意不做「編輯既有的一筆」，刪掉重加一樣快。
await page.locator('#btnToggleAway').click();
await page.waitForTimeout(250);
ok('面板裡看得到剛才那一筆', await page.locator('#absExisting .abs-row').count() === 1);
await page.locator('#absExisting .abs-del').first().click();
await page.waitForTimeout(300);
await page.locator('#btnAbsCancel').click();
await page.waitForTimeout(300);
ok('刪掉之後那一格的 🌴 就不見了', await cell('17').locator('.cal-away-mark').count() === 0);

// 「不在」不會讓日曆上的項目換一天出現
ok('標記「不在」不會移動任何項目的日期', await page.evaluate((TODAY) =>
  JSON.parse(localStorage.getItem('workSchedule.v1')).items.every(x => x.date === {
    prereq: '2026-09-01', blocked: '2026-09-10', early: '2026-08-20',
    awayOverdue: '2026-08-25', leaveOverdue: '2026-08-26', plain: '2026-09-20',
    prereq2: '2026-09-02', blocked2: '2026-09-12',
    // 純告知那幾筆也在這張表裡：漏一個的話 every() 會對 undefined 比較而整條紅，
    // 而那個紅燈長得像「不在把日期移走了」——完全錯誤的方向（實際踩過兩次）
    realToday: TODAY, noticeToday: TODAY, noticePast: '2026-08-20', noticeDone: '2026-09-11'
  }[x.id]), TODAY));

console.log('\n── 日曆上的「休假」 ──');
// 9/16 同一天既「不在」也「休假」——使用者選的形狀，兩種要能並存。
ok('休假的格子有 leave class', /\bleave\b/.test(await cell('16').getAttribute('class') || ''));
ok('同一天也可以同時是「不在」', /\baway\b/.test(await cell('16').getAttribute('class') || ''));
ok('格子中間有浮水印圖示', await cell('16').locator('.cal-leave-icon').count() === 1);
ok('圖示是使用者挑的那一個', /🏖️/.test(await cell('16').locator('.cal-leave-icon').innerText()));

// **休假不搶 background-color。** 這條是整個 C-2 最容易被改壞的一行：
// 直接寫 background 畫面看起來一樣好，但「今天剛好休假」那一格的琥珀色會消失，
// 而「今天在哪裡」是整個日曆最重要的一格。
const bgKept = await page.evaluate(() => {
  const leave = document.querySelector('.cal-cell.leave');
  const plain = [...document.querySelectorAll('.cal-cell[data-date]')]
    .find(c => !c.classList.contains('leave') && !c.classList.contains('away')
             && !c.classList.contains('today') && !c.classList.contains('selected'));
  if (!leave || !plain) return null;
  const overlay = getComputedStyle(leave, '::before').backgroundColor;
  return {
    sameBg: getComputedStyle(leave).backgroundColor === getComputedStyle(plain).backgroundColor,
    hasOverlay: !!overlay && overlay !== 'rgba(0, 0, 0, 0)' && overlay !== 'transparent'
  };
});
ok('休假沒有搶走 background-color', !!(bgKept && bgKept.sameBg));
ok('底色是偽元素疊上去的那一層', !!(bgKept && bgKept.hasOverlay));

// 「今天剛好休假」——整個 C-2 最容易被改壞的一行的最後一道關卡。
//
// 用**真的那一格今天**（TODAY 釘在 2026-09-09，就在這個月），不要自己加 class：
// `.cal-cell` 帶著 `transition: background .15s ease`，剛加上 class 的那一瞬間
// getComputedStyle 讀到的還是**舊值**——第一版就是這樣紅的，而紅的理由與要驗的
// 東西完全無關。
const todayStillToday = await page.evaluate(() => {
  const today = document.querySelector('.cal-cell.today[data-date]');
  if (!today) return null;                      // 沒有今天就是設定錯了，不是「略過」
  const before = getComputedStyle(today).backgroundColor;
  today.classList.add('leave');
  const after = getComputedStyle(today).backgroundColor;   // 只加 ::before，不碰 background
  const num = getComputedStyle(today.querySelector('.cal-daynum')).color;
  const overlay = getComputedStyle(today, '::before').backgroundColor;
  today.classList.remove('leave');
  const amberVar = getComputedStyle(document.documentElement).getPropertyValue('--amber').trim();
  const hex = x => '#' + (x.match(/\d+/g) || []).slice(0, 3)
    .map(n => Number(n).toString(16).padStart(2, '0')).join('');
  return {
    unchanged: after === before,
    isTodayColour: /rgba\(201, 130, 46/.test(before),
    hasOverlay: !!overlay && overlay !== 'rgba(0, 0, 0, 0)',
    numIsAmber: hex(num).toLowerCase() === amberVar.toLowerCase(),
    detail: before + ' → ' + after
  };
});
ok('日曆上找得到「今天」那一格（找不到就是設定錯了，不是略過）', !!todayStillToday);
if (todayStillToday) console.log('    ' + todayStillToday.detail);
ok('今天那一格本來就是琥珀底', !!(todayStillToday && todayStillToday.isTodayColour));
ok('**加上休假之後，「今天」的底色一個位元都沒被搶走**', !!(todayStillToday && todayStillToday.unchanged));
ok('而休假的玻璃紙仍然疊得上去', !!(todayStillToday && todayStillToday.hasOverlay));
ok('日期數字仍然是琥珀色', !!(todayStillToday && todayStillToday.numIsAmber));

console.log('\n── 不在／休假的設定面板 ──');
await cell('20').click();
await page.waitForTimeout(300);
await page.locator('#btnToggleAway').click();
await page.waitForTimeout(250);
ok('面板打得開', await page.locator('#absenceOverlay.show').count() === 1);
ok('預設是「不在」，不顯示圖示挑選', await page.locator('#absKindAway.active').count() === 1
   && !(await page.locator('#absIconField').isVisible()));
await page.locator('#absKindLeave').click();
await page.waitForTimeout(150);
ok('切到「休假」才出現圖示挑選', await page.locator('#absIconField').isVisible());
await page.locator('.abs-icon').nth(1).click();
await page.locator('#absFrom').fill('09:00');
await page.locator('#absTo').fill('12:30');
await page.locator('#btnAbsAdd').click();
await page.waitForTimeout(400);
ok('加完之後那一格變成休假', /\bleave\b/.test(await cell('20').getAttribute('class') || ''));
ok('存進去的帶著時段與圖示', await page.evaluate(() => {
  const st = JSON.parse(localStorage.getItem('workSchedule.v1'));
  const a = ((st.absences || {})['2026-09-20'] || []).find(x => x.kind === 'leave');
  return !!a && a.from === '09:00' && a.to === '12:30' && a.icon === '✈️';
}));

// **同一天再加一筆「不在」，剛才那筆休假必須留著。** 使用者選的形狀是「兩種
// 可以並存、各自有時段」，而「後者蓋掉前者」在畫面上看起來也很合理——格子還是
// 有底色，只是少了一個標記。突變驗證抓到這條原本沒有人守。
await page.locator('#btnToggleAway').click();
await page.waitForTimeout(250);
await page.locator('#absKindAway').click();
await page.locator('#absFrom').fill('14:00');
await page.locator('#absTo').fill('17:00');
await page.locator('#btnAbsAdd').click();
await page.waitForTimeout(400);
ok('同一天兩種並存：休假那一筆沒有被蓋掉', await page.evaluate(() => {
  const list = (JSON.parse(localStorage.getItem('workSchedule.v1')).absences || {})['2026-09-20'] || [];
  return list.some(a => a.kind === 'leave' && a.from === '09:00')
      && list.some(a => a.kind === 'away'  && a.from === '14:00');
}));
ok('而且那一格同時有兩種樣式', /\bleave\b/.test(await cell('20').getAttribute('class') || '')
   && /\baway\b/.test(await cell('20').getAttribute('class') || ''));

console.log('\n── 純告知：八個「不算進去」──');
await page.locator('.nav-item', { hasText: '項目安排' }).click();
await page.waitForTimeout(300);

const notice = row('總部政策宣達');
ok('純告知不長勾選框', await notice.locator('.checkbox').count() === 0);
// 沒有勾選框那一格仍然要佔位，否則整排欄位會往左跑一格
ok('但仍然佔住勾選框的位置', await notice.locator('.notice-gap').count() === 1);
ok('列上標「純告知」', /純告知/.test(await notice.locator('.notice-badge').innerText()));

// 過期的純告知：留著、換小標、**沒有紅字**。這一條是紅線的另一面——
// 紅字只留給真的遲交的事，而「順手讓純告知也紅一下」不會有任何東西壞掉。
const past = row('上個月的公告');
ok('日期過了的純告知留在看板上', await past.count() === 1);
ok('而且標的是「已過」', /已過/.test(await past.locator('.notice-badge').innerText()));
ok('純告知永遠不逾期：日期欄沒有 .overdue', await past.locator('.occ-date.overdue').count() === 0);
ok('字級降一階（靠字級表達階層，不是把顏色淡到讀不了）',
   parseFloat(await past.locator('.occ-title').evaluate(el => getComputedStyle(el).fontSize))
   < parseFloat(await row('今天真的要做的事').locator('.occ-title').evaluate(el => getComputedStyle(el).fontSize)));
// 對照組：真的逾期的那一列紅字一個字都沒少（紅線不動）
ok('真的逾期的那一列照樣是紅字', await row('不在那天到期的事').locator('.occ-date.overdue').count() === 1);

const dayCard = await page.locator('#metricDayList').innerText();
ok('今日待辦卡不含純告知', !dayCard.includes('總部政策宣達'));
ok('但今天真的要做的事在裡面', dayCard.includes('今天真的要做的事'));
ok('本週待辦卡也不含純告知', !(await page.locator('#metricWeekList').innerText()).includes('總部政策宣達'));
ok('逾期卡不含過期的純告知', !(await page.locator('#metricOverdueList').innerText()).includes('上個月的公告'));
// 會議卡：把純告知那一項改成會議型別也不該進去（它是 type 與 noticeOnly 垂直的證據）
ok('今日會議卡不含純告知', !(await page.locator('#metricMeetingList').innerText()).includes('總部政策宣達'));

// 已完成區：先展開才看得到裡面有什麼
await page.locator('#doneHead').click();
await page.waitForTimeout(300);
ok('被標成完成的純告知不在「已完成」區',
   await page.locator('#doneBoard .occ-row').filter({ hasText: '被標成完成的純告知' }).count() === 0);
ok('它留在上面的清單裡（不然就找不到它了）',
   await page.locator('#board .occ-row').filter({ hasText: '被標成完成的純告知' }).count() === 1);

// 範圍列的三顆數字：純告知不算分母。**不寫死數字**——寫死的話改一次 fixture
// 就要改一次期望值，而那種期望值遲早會被改成「現在算出來是多少」。
const pillTotal = parseInt((await page.locator('#statPills .pill').first().innerText()).replace(/\D/g, ''), 10);
const allRows = await page.locator('#board .occ-row, #doneBoard .occ-row').count();
const noticeRows = await page.locator('#board .occ-row.notice-only, #doneBoard .occ-row.notice-only').count();
ok('看板上真的有純告知（否則下面那條是空的斷言）', noticeRows === 3);
ok('範圍列的「項目」數 = 全部列數 − 純告知', pillTotal === allRows - noticeRows);

// 「只看未完成」是唯一的例外方向：純告知不受它影響、一直都在
await page.locator('#btnHideDone').click();
await page.waitForTimeout(300);
ok('「只看未完成」不會把純告知藏起來',
   await page.locator('#board .occ-row').filter({ hasText: '總部政策宣達' }).count() === 1
   && await page.locator('#board .occ-row').filter({ hasText: '被標成完成的純告知' }).count() === 1);
await page.locator('#btnHideDone').click();
await page.waitForTimeout(300);

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
