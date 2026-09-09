/**
 * 前置作業（`item.dependsOn`）與「不在」（`awayDates`）。
 *
 * 這兩件事都會被誤以為「改變了逾期的定義」，而它們**刻意都沒有**：
 *
 * - 前置作業只顯示狀態，不順延、不阻擋。自動順延等於在使用者沒看的時候改掉
 *   一個日期，與「AI 把日期改錯一天」是同一種失敗模式——畫面看起來完全正常，
 *   只是那個日期默默地不對了。
 * - 「不在」只是一個事實的標記。使用者定的規則是「不在就是不在，逾期就照樣
 *   逾期」：那件事本來就排在那天，人不在不改變它的後果。
 *
 * 所以這份測試守的東西有一半是**「什麼都沒發生」**。那種性質的規格特別容易在
 * 之後被「順手做得更聰明一點」而破掉，而且破掉的當下畫面看起來還是對的。
 *
 * 與其他前端測試同一個作法：從 public/index.html 抽出真正的原始碼求值，不複製
 * 一份出來測——測副本等於測一個沒有人在跑的程式。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function section(name) {
  const head = `  // ================= ${name}`;
  const start = HTML.indexOf(head);
  assert.notEqual(start, -1, `找不到區段「${name}」——區段註解是否被改名？`);
  const eol = HTML.indexOf('\n', start);
  const next = HTML.indexOf('  // ================= ', eol);
  assert.notEqual(next, -1, `區段「${name}」之後找不到下一個區段標記`);
  return HTML.slice(eol, next);
}

// 正規化那一組（與 normalizeTags / normalizeSubtasks 同一個區段）。
// 富文字要一起帶進來：normalizeGanttProjects 會呼叫 rtSanitize。
const N = new Function(`
  ${section('富文字')}
  ${section('持久化（單一儲存層）')}
  return { normalizeDependsOn, normalizeItems, MAX_DEPS };
`)();

/**
 * 引擎那一組。`items` / `awayDates` 是它在主程式裡依賴的 module-scoped 變數，
 * 這裡以同樣的形狀提供。
 */
function makeEngine() {
  const build = new Function(`
    let customHolidays = new Set();
    let customWorkdays = new Set();
    let awayDates = new Set();
    let majorProjects = [];
    let items = [];
    ${section('date helpers')}
    ${section('occurrence engine')}
    return {
      occDoneOf, latestOccOnOrBefore, depPending, depWouldCycle,
      isAway, isHoliday, adjustForHoliday, ymd, parseYMD,
      setItems(list){ items = list; },
      setAway(list){ awayDates = new Set(list); },
      setHolidays(list){ customHolidays = new Set(list); }
    };
  `);
  return build();
}
const E = makeEngine();

/** 建立一個項目，只填測試關心的欄位 */
function item(extra = {}) {
  return {
    id: 'i1', title: '項目', type: 'work', parentId: null, date: '2026-03-02',
    recurrence: null, dependsOn: [], done: false, doneMap: {}, overrides: {}, skipped: {},
    ...extra
  };
}
const occOf = (it, date, occKey = 'single') => ({ item: it, date, occKey, done: false });

// ============================================================ normalizeDependsOn

test('dependsOn 一律排序——canonical 形狀是三方合併的前提', () => {
  // 三方合併以 stableStringify 比對整個項目。同一組前置、順序不同，會被誤判成
  // 「兩邊都改過」而跳出一個根本不存在的衝突。理由與 normalizeTags 排序相同。
  assert.deepEqual(N.normalizeDependsOn(['c', 'a', 'b'], 'self'), ['a', 'b', 'c']);
  assert.deepEqual(N.normalizeDependsOn(['b', 'c', 'a'], 'self'), ['a', 'b', 'c']);
});

test('自己不能當自己的前置', () => {
  assert.deepEqual(N.normalizeDependsOn(['a', 'me', 'b'], 'me'), ['a', 'b']);
});

test('重複的前置只留一個', () => {
  assert.deepEqual(N.normalizeDependsOn(['a', 'a', 'a'], 'me'), ['a']);
});

test('超過上限就截斷', () => {
  const many = Array.from({ length: N.MAX_DEPS + 3 }, (_, i) => 'id' + i);
  assert.equal(N.normalizeDependsOn(many, 'me').length, N.MAX_DEPS);
});

test('不是陣列一律回空陣列，不讓壞資料流進去', () => {
  [null, undefined, 'a', 42, {}].forEach(v =>
    assert.deepEqual(N.normalizeDependsOn(v, 'me'), []));
});

test('指不到東西的前置會被剪掉，不留孤兒 id', () => {
  // 執行時有「找不到就當作沒有前置」的守衛，所以畫面不會壞——正因為不會壞，
  // 不剪就會靜靜地一直留在存檔裡，而且永遠不會被發現。
  assert.deepEqual(N.normalizeDependsOn(['a', 'gone'], 'me', new Set(['a', 'me'])), ['a']);
});

test('沒有給 validIds 時不剪——動到 items 的路徑不只 applySnapshot 一條', () => {
  assert.deepEqual(N.normalizeDependsOn(['whatever'], 'me'), ['whatever']);
});

// ============================================================ normalizeItems

test('dependsOn 進得了 normalizeItems，而且前置被刪掉時那條線一起消失', () => {
  const out = N.normalizeItems([
    { id: 'a', date: '2026-03-01' },
    { id: 'b', date: '2026-03-02', dependsOn: ['a', 'ghost'] }
  ]);
  assert.deepEqual(out.find(x => x.id === 'b').dependsOn, ['a']);
});

test('舊存檔沒有 dependsOn 欄位時補成空陣列，不是 undefined', () => {
  const out = N.normalizeItems([{ id: 'a', date: '2026-03-01' }]);
  assert.deepEqual(out[0].dependsOn, []);
});

// ============================================================ 擋環

test('自己依賴自己是環', () => {
  E.setItems([item({ id: 'a' })]);
  assert.equal(E.depWouldCycle('a', 'a'), true);
});

test('A 已經依賴 B，再讓 B 依賴 A 就是環', () => {
  E.setItems([item({ id: 'a', dependsOn: ['b'] }), item({ id: 'b' })]);
  assert.equal(E.depWouldCycle('b', 'a'), true);
});

test('間接的環也要擋：A→B→C，再讓 C 依賴 A', () => {
  E.setItems([
    item({ id: 'a', dependsOn: ['b'] }),
    item({ id: 'b', dependsOn: ['c'] }),
    item({ id: 'c' })
  ]);
  assert.equal(E.depWouldCycle('c', 'a'), true);
});

test('沒有關係的兩個項目不是環', () => {
  E.setItems([item({ id: 'a' }), item({ id: 'b' })]);
  assert.equal(E.depWouldCycle('a', 'b'), false);
});

test('存檔裡已經有環時仍然要走得完，不能無限迴圈', () => {
  // 這**真的會發生**：本機加了 A→B、另一台加了 B→A，三方合併「兩邊各自新增的
  // 都保留」就把兩條線一起留下來了。UI 擋得住使用者手動繞環，擋不住合併。
  // 少了 seen 這一段會當場卡死整個瀏覽器分頁（而不是回一個錯的答案）。
  E.setItems([
    item({ id: 'a', dependsOn: ['b'] }),
    item({ id: 'b', dependsOn: ['a'] }),
    item({ id: 'x' })
  ]);
  assert.equal(E.depWouldCycle('x', 'a'), false);   // 走遍 a↔b 之後才回 false
});

// ============================================================ 配對規則

test('配對到前置在「這一次的日期或之前」最近的那一次', () => {
  const weekly = item({
    id: 'a', title: '跟催報表', date: '2026-03-02',
    recurrence: { freq: 'weekly', day: 1, holidayRule: 'none', until: null, count: null,
                  weekdays: [1], mode: 'day', nth: null, weekday: null }
  });
  const got = E.latestOccOnOrBefore(weekly, '2026-03-18');
  // 3/2、3/9、3/16 都在 3/18 之前，要拿最近的 3/16
  assert.equal(got.date, '2026-03-16');
});

test('兩邊頻率不同也配對得起來——不要求 occKey 對得上', () => {
  // 那條管制藥品的鏈本來就月／週混用。若改成「occKey 相同才算」，這裡會整條斷掉。
  const weekly = item({
    id: 'a', title: '跟催報表', date: '2026-03-02',
    recurrence: { freq: 'weekly', day: 1, holidayRule: 'none', until: null, count: null,
                  weekdays: [1], mode: 'day', nth: null, weekday: null }
  });
  const monthly = item({ id: 'b', title: '覆核', date: '2026-03-20', dependsOn: ['a'],
    recurrence: { freq: 'monthly', day: 20, holidayRule: 'none', until: null, count: null,
                  weekdays: null, mode: 'day', nth: null, weekday: null } });
  E.setItems([weekly, monthly]);
  const pending = E.depPending(occOf(monthly, '2026-03-20', '2026-03'));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].date, '2026-03-16');
});

test('這一次早於前置的第一次＝沒有前置，不是「有一個沒做完」', () => {
  const a = item({ id: 'a', date: '2026-06-01' });
  const b = item({ id: 'b', date: '2026-03-01', dependsOn: ['a'] });
  E.setItems([a, b]);
  assert.deepEqual(E.depPending(occOf(b, '2026-03-01')), []);
});

test('前置做完了就不再擋著', () => {
  const a = item({ id: 'a', date: '2026-03-01', done: true });
  const b = item({ id: 'b', date: '2026-03-05', dependsOn: ['a'] });
  E.setItems([a, b]);
  assert.deepEqual(E.depPending(occOf(b, '2026-03-05')), []);
});

test('循環前置只看「配對到的那一次」有沒有做完，不是整條循環', () => {
  const a = item({
    id: 'a', title: '申報', date: '2026-03-02',
    doneMap: { 'W2026-03-02': true },   // 只有第一次做完
    recurrence: { freq: 'weekly', day: 1, holidayRule: 'none', until: null, count: null,
                  weekdays: [1], mode: 'day', nth: null, weekday: null }
  });
  const b = item({ id: 'b', date: '2026-03-05', dependsOn: ['a'] });
  E.setItems([a, b]);
  // 3/5 配對到 3/2，那一次做完了
  assert.deepEqual(E.depPending(occOf(b, '2026-03-05')), []);
  // 3/12 配對到 3/9，那一次沒做完
  const later = E.depPending(occOf(b, '2026-03-12'));
  assert.equal(later.length, 1);
  assert.equal(later[0].date, '2026-03-09');
});

test('前置被刪掉時當作沒有前置，不是永遠擋著', () => {
  const b = item({ id: 'b', date: '2026-03-05', dependsOn: ['已經不存在'] });
  E.setItems([b]);
  assert.deepEqual(E.depPending(occOf(b, '2026-03-05')), []);
});

test('holidayRule=advance 讓第一次落在錨點之前，仍然找得到', () => {
  // 展開的起點若剛好從錨點當日算起，往前挪的那一次會被區間判斷濾掉，
  // 症狀是「明明有前置卻標不出來」。起點刻意多留 45 天就是為了這個。
  E.setHolidays([]);
  const a = item({
    id: 'a', title: '申報', date: '2026-03-01',   // 週日
    recurrence: { freq: 'monthly', day: 1, holidayRule: 'advance', until: null, count: null,
                  weekdays: null, mode: 'day', nth: null, weekday: null }
  });
  const got = E.latestOccOnOrBefore(a, '2026-03-03');
  assert.equal(got.date, '2026-02-27');   // 3/1 是週日，往前推到週五
});

// ============================================================ 「不在」什麼都不做

test('「不在」不進 isHoliday()——它不是假日', () => {
  E.setHolidays([]);
  E.setAway(['2026-03-04']);              // 週三
  assert.equal(E.isAway('2026-03-04'), true);
  assert.equal(E.isHoliday(E.parseYMD('2026-03-04')), false);
});

test('「不在」不會讓循環順延——那天到期就是那天到期', () => {
  // 假日順延是**事前規則**（使用者明確選過 holidayRule、國定假日全年已知）；
  // 「不在」是事後才知道的事實。拿它回頭移動日期會讓歷史紀錄變成假的。
  E.setHolidays([]);
  E.setAway(['2026-03-04']);
  const d = E.adjustForHoliday(E.parseYMD('2026-03-04'), 'postpone');
  assert.equal(E.ymd(d), '2026-03-04');
});

test('「不在」也不影響 advance 方向', () => {
  E.setHolidays([]);
  E.setAway(['2026-03-04']);
  const d = E.adjustForHoliday(E.parseYMD('2026-03-04'), 'advance');
  assert.equal(E.ymd(d), '2026-03-04');
});

test('前置作業不改變任何 occurrence 的日期', () => {
  // depPending 只回答狀態。若哪天有人「順手」讓它去推日期，這一條會紅。
  const a = item({ id: 'a', date: '2026-03-01' });
  const b = item({ id: 'b', date: '2026-03-05', dependsOn: ['a'] });
  E.setItems([a, b]);
  const before = JSON.stringify([a, b]);
  E.depPending(occOf(b, '2026-03-05'));
  assert.equal(JSON.stringify([a, b]), before);
});

// ============================================================ 展開窗口的收斂

test('三年前開始的每週前置仍然配對得到最近的那一次', () => {
  // 展開窗口為了成本往前只留 400 天。收斂過頭的話症狀是「明明有前置卻標不出來」，
  // 而那在畫面上與「本來就沒有前置」一模一樣。
  const a = item({
    id: 'a', title: '老循環', date: '2023-01-02',
    recurrence: { freq: 'weekly', day: 1, holidayRule: 'none', until: null, count: null,
                  weekdays: [1], mode: 'day', nth: null, weekday: null }
  });
  assert.equal(E.latestOccOnOrBefore(a, '2026-03-18').date, '2026-03-16');
});

test('每年一次的前置也還在窗口內——400 天 > 365 天', () => {
  const a = item({
    id: 'a', title: '年度盤點', date: '2020-05-04',
    recurrence: { freq: 'yearly', day: 4, holidayRule: 'none', until: null, count: null,
                  weekdays: null, mode: 'day', nth: null, weekday: null }
  });
  assert.equal(E.latestOccOnOrBefore(a, '2026-03-18').date, '2025-05-04');
});

test('非循環的前置不套 400 天下限——它只有一次，五年前那次仍然是它', () => {
  // 套下去的話，一件很久以前做過的事就會被當成「沒有前置」，而那正好與
  // 「前置已完成」長得一樣，永遠不會有人發現。
  const a = item({ id: 'a', title: '一次性的前置', date: '2020-05-04' });
  const b = item({ id: 'b', title: '後續', date: '2026-03-18', dependsOn: ['a'] });
  E.setItems([a, b]);
  assert.equal(E.latestOccOnOrBefore(a, '2026-03-18').date, '2020-05-04');
  assert.equal(E.depPending(occOf(b, '2026-03-18')).length, 1);
});
