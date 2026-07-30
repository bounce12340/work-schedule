/**
 * occurrence 引擎的測試。
 *
 * 這是全專案唯一有測試的部分，理由是它同時滿足兩個條件：最容易改壞（循環、
 * 假日調整、單次覆寫的優先順序糾纏在一起），而且近乎純函式、零 DOM 依賴。
 *
 * 測試直接從 public/index.html 抽出真正的原始碼求值，不另外複製一份。複製一份
 * 出來測，測的就是副本而不是實際跑的程式，改動時兩邊會無聲分歧——那比沒有
 * 測試更糟，因為它會給出「已經測過了」的錯覺。
 *
 * 代價是綁定了區段註解的格式。抽取失敗會直接讓測試爆掉（而不是靜默跳過），
 * 所以區段被改名時會立刻知道。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

/** 取出兩個區段註解之間的原始碼 */
function section(name) {
  const marker = `  // ================= ${name} =================`;
  const start = HTML.indexOf(marker);
  assert.notEqual(start, -1, `找不到區段「${name}」——區段註解是否被改名？`);
  const from = start + marker.length;
  const next = HTML.indexOf('  // ================= ', from);
  assert.notEqual(next, -1, `區段「${name}」之後找不到下一個區段標記`);
  return HTML.slice(from, next);
}

/**
 * 在乾淨的作用域內建立引擎。customHolidays / items / majorProjects 是引擎在
 * 主程式裡依賴的 module-scoped 變數，這裡以同樣的形狀提供。
 */
function makeEngine(holidays = []) {
  const build = new Function('initialHolidays', `
    let customHolidays = new Set(initialHolidays);
    let majorProjects = [];
    let items = [];
    ${section('date helpers')}
    ${section('occurrence engine')}
    return {
      getOccurrencesInRange, getAllOccurrences, setOccurrenceDone, skipOccurrence,
      occPeriodLabel, adjustForHoliday, isHoliday, ymd, parseYMD,
      setHolidays(list){ customHolidays = new Set(list); },
      setItems(list){ items = list; }
    };
  `);
  return build(holidays);
}

const E = makeEngine();
const d = s => E.parseYMD(s);
const dates = occs => occs.map(o => o.date);
const keys = occs => occs.map(o => o.occKey);

/** 建立一個項目，只填測試關心的欄位，其餘補上正式程式碼會有的預設值 */
function item(extra = {}) {
  return {
    id: 'i1', title: 't', type: 'work', parentId: null, meetingTime: null,
    date: '2026-01-15', recurrence: null,
    done: false, doneMap: {}, overrides: {}, skipped: {},
    ...extra
  };
}

// ---------------------------------------------------------------- 非循環

test('非循環項目落在區間內時回傳一筆，occKey 固定為 single', () => {
  const occs = E.getOccurrencesInRange(item({ date: '2026-03-10' }), d('2026-03-01'), d('2026-03-31'));
  assert.deepEqual(dates(occs), ['2026-03-10']);
  assert.deepEqual(keys(occs), ['single']);
  assert.equal(occs[0].done, false);
});

test('非循環項目落在區間外時回傳空陣列', () => {
  assert.deepEqual(E.getOccurrencesInRange(item({ date: '2026-04-10' }), d('2026-03-01'), d('2026-03-31')), []);
});

test('非循環項目不套用假日調整——日期原樣使用', () => {
  // 2026-03-07 是週六
  const occs = E.getOccurrencesInRange(item({ date: '2026-03-07' }), d('2026-03-01'), d('2026-03-31'));
  assert.deepEqual(dates(occs), ['2026-03-07']);
});

// ---------------------------------------------------------------- 每月循環

test('每月循環在區間內逐月展開，occKey 為 YYYY-MM', () => {
  const it = item({ date: '2026-01-15', recurrence: { freq: 'monthly', day: 15, holidayRule: 'none', until: null } });
  const occs = E.getOccurrencesInRange(it, d('2026-01-01'), d('2026-04-30'));
  assert.deepEqual(dates(occs), ['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15']);
  assert.deepEqual(keys(occs), ['2026-01', '2026-02', '2026-03', '2026-04']);
});

test('每月 31 日在天數不足的月份落在該月最後一天', () => {
  const it = item({ date: '2026-01-31', recurrence: { freq: 'monthly', day: 31, holidayRule: 'none', until: null } });
  const occs = E.getOccurrencesInRange(it, d('2026-01-01'), d('2026-04-30'));
  // 2026 不是閏年，2 月只有 28 天
  assert.deepEqual(dates(occs), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
});

test('錨點日期之前不產生任何一次', () => {
  const it = item({ date: '2026-06-10', recurrence: { freq: 'monthly', day: 10, holidayRule: 'none', until: null } });
  const occs = E.getOccurrencesInRange(it, d('2026-01-01'), d('2026-12-31'));
  assert.equal(occs[0].date, '2026-06-10');
  assert.equal(occs.length, 7);
});

test('until 之後停止產生', () => {
  const it = item({ date: '2026-01-10', recurrence: { freq: 'monthly', day: 10, holidayRule: 'none', until: '2026-03-31' } });
  assert.deepEqual(dates(E.getOccurrencesInRange(it, d('2026-01-01'), d('2026-12-31'))),
    ['2026-01-10', '2026-02-10', '2026-03-10']);
});

// ---------------------------------------------------------------- 每季循環

test('每季循環每三個月一次，occKey 為 YYYY-QN', () => {
  const it = item({ date: '2026-02-20', recurrence: { freq: 'quarterly', day: 20, holidayRule: 'none', until: null } });
  const occs = E.getOccurrencesInRange(it, d('2026-01-01'), d('2026-12-31'));
  assert.deepEqual(dates(occs), ['2026-02-20', '2026-05-20', '2026-08-20', '2026-11-20']);
  assert.deepEqual(keys(occs), ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']);
});

// ---------------------------------------------------------------- 每週 / 每兩週

test('每週循環每七天一次，星期幾由起始日期決定', () => {
  // 2026-08-05 是週三
  const it = item({ date: '2026-08-05', recurrence: { freq: 'weekly', day: 1, holidayRule: 'none', until: null } });
  const occs = E.getOccurrencesInRange(it, d('2026-08-01'), d('2026-08-31'));
  assert.deepEqual(dates(occs), ['2026-08-05', '2026-08-12', '2026-08-19', '2026-08-26']);
  assert.equal(new Set(occs.map(o => E.parseYMD(o.date).getDay())).size, 1, '每一次都應落在同一個星期幾');
});

test('每週的 occKey 是 W 前綴加日期，與每月／每季的格式不會相撞', () => {
  const it = item({ date: '2026-08-05', recurrence: { freq: 'weekly', day: 1, holidayRule: 'none', until: null } });
  assert.deepEqual(keys(E.getOccurrencesInRange(it, d('2026-08-01'), d('2026-08-20'))),
    ['W2026-08-05', 'W2026-08-12', 'W2026-08-19']);
});

test('每兩週循環每十四天一次', () => {
  const it = item({ date: '2026-08-05', recurrence: { freq: 'biweekly', day: 1, holidayRule: 'none', until: null } });
  assert.deepEqual(dates(E.getOccurrencesInRange(it, d('2026-08-01'), d('2026-09-30'))),
    ['2026-08-05', '2026-08-19', '2026-09-02', '2026-09-16', '2026-09-30']);
});

test('每週的 occKey 不隨假日調整改變（否則加了假日之後舊紀錄會整批對不上）', () => {
  const eng = makeEngine(['2026-08-12']);       // 把其中一次的原始日期設為自訂假日
  const it = item({ date: '2026-08-05', recurrence: { freq: 'weekly', day: 1, holidayRule: 'postpone', until: null } });
  const occs = eng.getOccurrencesInRange(it, eng.parseYMD('2026-08-01'), eng.parseYMD('2026-08-20'));
  assert.deepEqual(occs.map(o => o.date), ['2026-08-05', '2026-08-13', '2026-08-19'], '8/12 應順延到 8/13');
  assert.deepEqual(occs.map(o => o.occKey), ['W2026-08-05', 'W2026-08-12', 'W2026-08-19'],
    'occKey 必須維持未調整前的日期');
});

test('每週：覆寫日期優先於假日規則', () => {
  const eng = makeEngine(['2026-08-12']);
  const it = item({
    date: '2026-08-05',
    recurrence: { freq: 'weekly', day: 1, holidayRule: 'postpone', until: null },
    overrides: { 'W2026-08-12': '2026-08-15' }   // 8/15 是週六，仍必須原樣採用
  });
  const occs = eng.getOccurrencesInRange(it, eng.parseYMD('2026-08-01'), eng.parseYMD('2026-08-20'));
  assert.deepEqual(occs.map(o => o.date), ['2026-08-05', '2026-08-15', '2026-08-19']);
});

test('每週：略過與完成狀態都掛在對應的 occKey 上', () => {
  const it = item({
    date: '2026-08-05',
    recurrence: { freq: 'weekly', day: 1, holidayRule: 'none', until: null },
    skipped: { 'W2026-08-12': true },
    doneMap: { 'W2026-08-19': true }
  });
  const occs = E.getOccurrencesInRange(it, d('2026-08-01'), d('2026-08-31'));
  assert.deepEqual(dates(occs), ['2026-08-05', '2026-08-19', '2026-08-26']);
  assert.deepEqual(occs.map(o => o.done), [false, true, false]);
});

test('每週：until 之後停止', () => {
  const it = item({ date: '2026-08-05', recurrence: { freq: 'weekly', day: 1, holidayRule: 'none', until: '2026-08-20' } });
  assert.deepEqual(dates(E.getOccurrencesInRange(it, d('2026-08-01'), d('2026-12-31'))),
    ['2026-08-05', '2026-08-12', '2026-08-19']);
});

test('每週：錨點遠早於檢視區間時仍算得出來（guard 不能在進入區間前就用完）', () => {
  // 2018 年開始的每週項目，檢視 2026 年 8 月——中間相隔超過 400 週
  const it = item({ date: '2018-01-03', recurrence: { freq: 'weekly', day: 1, holidayRule: 'none', until: null } });
  const occs = E.getOccurrencesInRange(it, d('2026-08-01'), d('2026-08-31'));
  assert.equal(occs.length, 4, '應有四次，而不是因為 guard 用盡回傳空陣列');
  assert.equal(new Set(occs.map(o => E.parseYMD(o.date).getDay())).size, 1);
  assert.equal(E.parseYMD(occs[0].date).getDay(), E.parseYMD('2018-01-03').getDay(), '星期幾必須與錨點一致');
});

test('每兩週：錨點遠早於區間時仍維持正確的雙週節奏', () => {
  const it = item({ date: '2020-01-01', recurrence: { freq: 'biweekly', day: 1, holidayRule: 'none', until: null } });
  const occs = E.getOccurrencesInRange(it, d('2026-08-01'), d('2026-09-30'));
  // 與錨點的間隔必須都是 14 的倍數
  occs.forEach(o => {
    const diff = (E.parseYMD(o.date) - E.parseYMD('2020-01-01')) / 86400000;
    assert.equal(diff % 14, 0, `${o.date} 與錨點相差 ${diff} 天，不是 14 的倍數`);
  });
  assert.ok(occs.length >= 4);
});

test('每週：緊鄰區間起點之前、被順延推進區間內的那一次不能漏掉', () => {
  // 2026-08-01 是週六。錨點設在更早的週六，順延規則會把它推到週一（8/03）
  const it = item({ date: '2026-07-04', recurrence: { freq: 'weekly', day: 1, holidayRule: 'postpone', until: null } });
  const occs = E.getOccurrencesInRange(it, d('2026-08-03'), d('2026-08-31'));
  assert.ok(occs.some(o => o.date === '2026-08-03'),
    '8/01（週六）那次順延後落在 8/03，位於區間內，必須算得到');
});

// ---------------------------------------------------------------- 假日調整

test('順延：落在週六的循環往後推到下一個工作天', () => {
  // 2026-08-15 是週六 → 順延到 08-17（週一）
  const it = item({ date: '2026-08-15', recurrence: { freq: 'monthly', day: 15, holidayRule: 'postpone', until: null } });
  assert.deepEqual(dates(E.getOccurrencesInRange(it, d('2026-08-01'), d('2026-08-31'))), ['2026-08-17']);
});

test('提前：落在週六的循環往前推到前一個工作天', () => {
  const it = item({ date: '2026-08-15', recurrence: { freq: 'monthly', day: 15, holidayRule: 'advance', until: null } });
  assert.deepEqual(dates(E.getOccurrencesInRange(it, d('2026-08-01'), d('2026-08-31'))), ['2026-08-14']);
});

test('自訂假日一併納入判斷', () => {
  const eng = makeEngine(['2026-08-17', '2026-08-18']);
  const it = item({ date: '2026-08-15', recurrence: { freq: 'monthly', day: 15, holidayRule: 'postpone', until: null } });
  // 週六 15 → 16(日) → 17、18 皆為自訂假日 → 19
  assert.deepEqual(eng.getOccurrencesInRange(it, eng.parseYMD('2026-08-01'), eng.parseYMD('2026-08-31')).map(o => o.date),
    ['2026-08-19']);
});

// ---------------------------------------------------------------- 單次狀態

test('覆寫日期優先於假日規則（不變量：有 override 就完全跳過 adjustForHoliday）', () => {
  const it = item({
    date: '2026-08-15',
    recurrence: { freq: 'monthly', day: 15, holidayRule: 'postpone', until: null },
    overrides: { '2026-08': '2026-08-16' }        // 8/16 是週日，仍必須原樣採用
  });
  assert.deepEqual(dates(E.getOccurrencesInRange(it, d('2026-08-01'), d('2026-08-31'))), ['2026-08-16']);
});

test('略過某一次不影響其他週期', () => {
  const it = item({
    date: '2026-01-10',
    recurrence: { freq: 'monthly', day: 10, holidayRule: 'none', until: null },
    skipped: { '2026-02': true }
  });
  assert.deepEqual(keys(E.getOccurrencesInRange(it, d('2026-01-01'), d('2026-04-30'))),
    ['2026-01', '2026-03', '2026-04']);
});

test('doneMap 只影響對應的那一次', () => {
  const it = item({
    date: '2026-01-10',
    recurrence: { freq: 'monthly', day: 10, holidayRule: 'none', until: null },
    doneMap: { '2026-02': true }
  });
  const occs = E.getOccurrencesInRange(it, d('2026-01-01'), d('2026-03-31'));
  assert.deepEqual(occs.map(o => o.done), [false, true, false]);
});

test('setOccurrenceDone 寫回母項目：單次寫 done、循環寫 doneMap[occKey]', () => {
  const single = item({ date: '2026-03-10' });
  const [occ1] = E.getOccurrencesInRange(single, d('2026-03-01'), d('2026-03-31'));
  E.setOccurrenceDone(occ1, true);
  assert.equal(single.done, true);
  assert.deepEqual(single.doneMap, {});

  const rec = item({ date: '2026-01-10', recurrence: { freq: 'monthly', day: 10, holidayRule: 'none', until: null } });
  const occs = E.getOccurrencesInRange(rec, d('2026-01-01'), d('2026-03-31'));
  E.setOccurrenceDone(occs[1], true);
  assert.deepEqual(rec.doneMap, { '2026-02': true });
  assert.equal(rec.done, false);
});

test('skipOccurrence 寫回母項目的 skipped', () => {
  const rec = item({ date: '2026-01-10', recurrence: { freq: 'monthly', day: 10, holidayRule: 'none', until: null } });
  const occs = E.getOccurrencesInRange(rec, d('2026-01-01'), d('2026-03-31'));
  E.skipOccurrence(occs[2]);
  assert.deepEqual(rec.skipped, { '2026-03': true });
});

// ---------------------------------------------------------------- 邊界

test('長區間不會被 guard 上限靜默截斷', () => {
  const it = item({ date: '2026-01-10', recurrence: { freq: 'monthly', day: 10, holidayRule: 'none', until: null } });
  const occs = E.getOccurrencesInRange(it, d('2026-01-01'), d('2030-12-31'));
  assert.equal(occs.length, 60, '五年的每月循環應為 60 次');
});

test('getAllOccurrences 會把所有項目合併展開', () => {
  const eng = makeEngine();
  eng.setItems([
    { ...item({ id: 'a', date: '2026-03-10' }) },
    { ...item({ id: 'b', date: '2026-03-20' }) }
  ]);
  assert.equal(eng.getAllOccurrences(eng.parseYMD('2026-03-01'), eng.parseYMD('2026-03-31')).length, 2);
});
