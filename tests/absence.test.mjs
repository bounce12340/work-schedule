/**
 * 「不在／休假」（`absences`）的資料層。
 *
 * 三件事，每一件壞掉的症狀都是**畫面看起來正常、資料靜靜地不對**：
 *
 *  1. 正規化：白名單、去重、排序。排序不是美觀——三方合併以 stableStringify 比對，
 *     順序不同會讓「其實一樣」被判成衝突，然後跳一個不存在的衝突對話框給使用者。
 *  2. 舊存檔搬家（v1 → v2 → v3）：**逐階往上走**。只認「上一版」的話，一份 v1 存檔
 *     會停在 v2，接著 applySnapshot 讀不到 v3 的欄位，那幾天就消失了。
 *  3. 三方合併：粒度停在「一天」，而且基準／遠端可能還是舊形狀。
 *
 * 做法與 merge.test.mjs 相同：直接從 public/index.html 抽出真正的原始碼求值，
 * 不複製一份出來測——複製出來測的是副本，比沒有測試更糟。
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

// 富文字要一起帶進來：normalizeGanttProjects 會呼叫 rtSanitize，而 migrateSnapshot
// 的 v1 → v2 會呼叫 rtFromPlain。
const A = new Function(`
  ${section('富文字')}
  ${section('持久化（單一儲存層）')}
  ${section('三方合併')}
  return { STORAGE_VERSION, normalizeAbsences, normalizeAbsenceEntry, normalizeAbsenceIcon,
           migrateSnapshot, SNAPSHOT_MIGRATIONS,
           tmMergeAbsences, absencesOfSnapshot, threeWayMerge, resolveConflicts };
`)();

const full = (kind) => ({ kind, from: null, to: null });
const clone = v => JSON.parse(JSON.stringify(v));

// ───────────────────────── 正規化 ─────────────────────────

test('白名單：kind 不認得就整筆丟掉', () => {
  const out = A.normalizeAbsences({ '2026-03-02': [
    { kind: 'away' }, { kind: 'sick' }, { kind: '' }, {}, null, 'away'
  ]});
  assert.deepEqual(out, { '2026-03-02': [ full('away') ] });
});

test('日期鍵不是 YYYY-MM-DD 就丟掉', () => {
  const out = A.normalizeAbsences({ '2026-3-2': [full('away')], 'x': [full('away')], '2026-03-02': [full('away')] });
  assert.deepEqual(Object.keys(out), ['2026-03-02']);
});

test('時間不是 HH:MM 就當作沒填＝整天，不是丟掉整筆', () => {
  const out = A.normalizeAbsences({ '2026-03-02': [{ kind:'away', from:'9:00', to:'25:00' }] });
  assert.deepEqual(out['2026-03-02'], [ { kind:'away', from:null, to:null } ]);
});

test('合法時段留著', () => {
  const out = A.normalizeAbsences({ '2026-03-02': [{ kind:'leave', from:'09:00', to:'12:30' }] });
  assert.deepEqual(out['2026-03-02'], [ { kind:'leave', from:'09:00', to:'12:30' } ]);
});

test('icon 只有 leave 有；away 帶了也不留', () => {
  const out = A.normalizeAbsences({ '2026-03-02': [
    { kind:'away', from:null, to:null, icon:'🏖️' },
    { kind:'leave', from:null, to:null, icon:'🤒' }
  ]});
  assert.equal('icon' in out['2026-03-02'][0], false);
  assert.equal(out['2026-03-02'][1].icon, '🤒');
});

test('icon 擋掉整段文字，但放行合體 emoji', () => {
  assert.equal(A.normalizeAbsenceIcon('🏖️'), '🏖️');
  assert.equal(A.normalizeAbsenceIcon('👨‍👩‍👧‍👦'), '👨‍👩‍👧‍👦');   // 七個碼位
  assert.equal(A.normalizeAbsenceIcon('今天我要去海邊玩水順便曬太陽'), null);
  assert.equal(A.normalizeAbsenceIcon(''), null);
  assert.equal(A.normalizeAbsenceIcon(123), null);
});

test('同一天兩種可以並存', () => {
  const out = A.normalizeAbsences({ '2026-03-02': [
    { kind:'away', from:'09:00', to:'12:00' },
    { kind:'leave', from:'13:00', to:'18:00', icon:'🏖️' }
  ]});
  assert.equal(out['2026-03-02'].length, 2);
});

test('時段重疊刻意不擋——系統不當裁判', () => {
  const out = A.normalizeAbsences({ '2026-03-02': [
    { kind:'away', from:'09:00', to:'12:00' },
    { kind:'leave', from:'10:00', to:'18:00' }
  ]});
  assert.equal(out['2026-03-02'].length, 2, '重疊的兩筆都要留著');
});

test('完全相同的兩筆會去重', () => {
  const out = A.normalizeAbsences({ '2026-03-02': [full('away'), full('away')] });
  assert.equal(out['2026-03-02'].length, 1);
});

test('排序穩定：順序不同的同一份內容，正規化後逐字相同', () => {
  const a = A.normalizeAbsences({ '2026-03-02': [
    { kind:'leave', from:'13:00', to:'18:00' }, { kind:'away', from:'09:00', to:'12:00' } ]});
  const b = A.normalizeAbsences({ '2026-03-02': [
    { kind:'away', from:'09:00', to:'12:00' }, { kind:'leave', from:'13:00', to:'18:00' } ]});
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('空陣列不留——它與「那天沒有記錄」是同一件事', () => {
  const out = A.normalizeAbsences({ '2026-03-02': [], '2026-03-03': [{ kind:'nope' }] });
  assert.deepEqual(out, {});
});

test('不是物件就回空的，不要爆掉', () => {
  [null, undefined, 'x', 3, []].forEach(v => assert.deepEqual(A.normalizeAbsences(v), {}));
});

// ───────────────────────── 舊存檔搬家 ─────────────────────────

const V3 = () => A.STORAGE_VERSION === 3;

test('目前的版本號是 3', () => { assert.equal(A.STORAGE_VERSION, 3); });

test('v2 → v3：每一個 awayDates 都變成「整天不在」', () => {
  const up = A.migrateSnapshot({ version: 2, awayDates: ['2026-03-02', '2026-03-03'], dailyLogs: {}, ganttProjects: [] });
  assert.equal(up.version, 3);
  assert.deepEqual(up.absences, {
    '2026-03-02': [ full('away') ],
    '2026-03-03': [ full('away') ]
  });
});

test('v2 → v3：舊鍵不留下來——兩邊都寫的話，哪個是真的會變成猜謎', () => {
  const up = A.migrateSnapshot({ version: 2, awayDates: ['2026-03-02'], dailyLogs: {}, ganttProjects: [] });
  assert.equal('awayDates' in up, false);
});

test('v2 → v3：壞掉的日期不會被搬過去', () => {
  const up = A.migrateSnapshot({ version: 2, awayDates: ['2026-3-2', null, 7, '2026-03-02'], dailyLogs: {}, ganttProjects: [] });
  assert.deepEqual(Object.keys(up.absences), ['2026-03-02']);
});

test('**v1 → v3 要一路走到底**：只認上一版的話，「不在」會靜靜地消失', () => {
  const up = A.migrateSnapshot({
    version: 1,
    awayDates: ['2026-03-02'],
    dailyLogs: { '2026-03-02': '第一行\n第二行' },
    ganttProjects: [{ id: 'g1', name: 'p', tasks: [], notes: 'a\nb' }]
  });
  assert.equal(up.version, 3, 'v1 必須升到目前的版本，不是停在 v2');
  assert.deepEqual(up.absences, { '2026-03-02': [ full('away') ] });
  // v1 → v2 那一階也要真的做到：純文字換行變成 <br>
  assert.match(up.dailyLogs['2026-03-02'], /<br\s*\/?>/);
  assert.match(up.ganttProjects[0].notes, /<br\s*\/?>/);
});

test('已經是目前版本就原樣回來', () => {
  const s = { version: 3, absences: { '2026-03-02': [full('leave')] } };
  assert.equal(A.migrateSnapshot(s), s);
});

test('比目前新的版本一律拒絕——猜測未來的格式只會把資料弄壞', () => {
  assert.equal(A.migrateSnapshot({ version: 4 }), null);
  assert.equal(A.migrateSnapshot({ version: 99 }), null);
  assert.equal(A.migrateSnapshot({}), null);
  assert.equal(A.migrateSnapshot(null), null);
});

test('升級表上的每一階都只往前一步，而且接得起來', () => {
  const vs = Object.keys(A.SNAPSHOT_MIGRATIONS).map(Number).sort((a, b) => a - b);
  assert.deepEqual(vs, [1, 2], '表上要涵蓋 1 到 STORAGE_VERSION-1，沒有缺口');
});

// ───────────────────────── 三方合併 ─────────────────────────

const snap = (over = {}) => ({
  version: 3, majorProjects: [], items: [], ganttProjects: [], dailyLogs: {},
  customHolidays: [], customWorkdays: [], absences: {}, availableYears: [2026],
  selectedGanttProjectId: null, ...over
});

test('只有本機改過 → 採用本機', () => {
  const r = A.tmMergeAbsences({}, { '2026-03-02': [full('away')] }, {});
  assert.deepEqual(r.merged, { '2026-03-02': [full('away')] });
  assert.equal(r.conflicts.length, 0);
});

test('只有遠端改過 → 採用遠端', () => {
  const base = { '2026-03-02': [full('away')] };
  const r = A.tmMergeAbsences(base, clone(base), { '2026-03-02': [full('leave')] });
  assert.deepEqual(r.merged['2026-03-02'], [full('leave')]);
  assert.equal(r.conflicts.length, 0);
});

test('兩邊改成一樣的東西不算衝突', () => {
  const r = A.tmMergeAbsences({}, { '2026-03-02': [full('away')] }, { '2026-03-02': [full('away')] });
  assert.equal(r.conflicts.length, 0);
});

test('順序不同但內容相同 → 不算衝突（排序是正確性的一部分）', () => {
  const two = [{ kind:'away', from:'09:00', to:'12:00' }, { kind:'leave', from:'13:00', to:'18:00' }];
  const l = A.normalizeAbsences({ '2026-03-02': two });
  const r2 = A.normalizeAbsences({ '2026-03-02': [...two].reverse() });
  const r = A.tmMergeAbsences({}, l, r2);
  assert.equal(r.conflicts.length, 0, '正規化過的同一份內容不該打架');
});

test('兩邊都改到同一天 → 衝突，預設先留本機', () => {
  const base = { '2026-03-02': [full('away')] };
  const r = A.tmMergeAbsences(base, { '2026-03-02': [full('leave')] }, { '2026-03-02': [{ kind:'away', from:'09:00', to:'12:00' }] });
  assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0].id, '2026-03-02');
  assert.deepEqual(r.merged['2026-03-02'], [full('leave')]);
});

test('基準有、單邊拿掉 → 刪除生效', () => {
  const base = { '2026-03-02': [full('away')] };
  const r = A.tmMergeAbsences(base, {}, clone(base));
  assert.equal('2026-03-02' in r.merged, false);
  assert.equal(r.conflicts.length, 0);
});

test('一邊刪掉、另一邊改過 → 衝突，不靜默挑邊', () => {
  const base = { '2026-03-02': [full('away')] };
  const r = A.tmMergeAbsences(base, {}, { '2026-03-02': [full('leave')] });
  assert.equal(r.conflicts.length, 1);
});

test('不同的日子各走各的，不互相影響', () => {
  const r = A.tmMergeAbsences({}, { '2026-03-02': [full('away')] }, { '2026-03-09': [full('leave')] });
  assert.deepEqual(Object.keys(r.merged).sort(), ['2026-03-02', '2026-03-09']);
  assert.equal(r.conflicts.length, 0);
});

test('**基準是舊形狀時不能把資料當成「被刪掉了」**', () => {
  // cloudMeta.baseSnapshot 存的是當時那一份，可能還是 v2
  const base = { version: 2, awayDates: ['2026-03-02'] };
  const local = snap({ absences: { '2026-03-02': [full('away')] } });
  const remote = snap({ absences: { '2026-03-02': [full('away')] } });
  const { merged, conflicts } = A.threeWayMerge(base, local, remote);
  assert.deepEqual(merged.absences, { '2026-03-02': [full('away')] }, '那一天不該消失');
  assert.equal(conflicts.length, 0);
});

test('**遠端還在跑舊 build 時，它的 awayDates 要讀得懂**', () => {
  const base = snap();
  const local = snap();
  const remote = { version: 2, majorProjects: [], items: [], ganttProjects: [], dailyLogs: {},
                   customHolidays: [], customWorkdays: [], awayDates: ['2026-03-02'], availableYears: [2026] };
  const { merged } = A.threeWayMerge(base, local, remote);
  assert.deepEqual(merged.absences, { '2026-03-02': [full('away')] });
});

test('合併結果不留舊鍵', () => {
  const base = { version: 2, awayDates: [] };
  const local = { ...snap(), awayDates: ['2026-03-02'] };   // 假裝 local 也帶著舊鍵
  const { merged } = A.threeWayMerge(base, local, snap());
  assert.equal('awayDates' in merged, false);
});

test('衝突交給使用者選之後，兩個方向都寫得回去', () => {
  const base = snap({ absences: { '2026-03-02': [full('away')] } });
  const local = snap({ absences: { '2026-03-02': [full('leave')] } });
  const remote = snap({ absences: { '2026-03-02': [{ kind:'away', from:'09:00', to:'12:00' }] } });

  const a = A.threeWayMerge(base, local, remote);
  assert.equal(a.conflicts.length, 1);
  assert.equal(a.conflicts[0].kind, 'absence');
  A.resolveConflicts(a.merged, a.conflicts, 'remote');
  assert.deepEqual(a.merged.absences['2026-03-02'], [{ kind:'away', from:'09:00', to:'12:00' }]);

  const b = A.threeWayMerge(base, local, remote);
  A.resolveConflicts(b.merged, b.conflicts, 'local');
  assert.deepEqual(b.merged.absences['2026-03-02'], [full('leave')]);
});

test('選「遠端」而遠端是刪掉 → 那一天真的要不見', () => {
  const base = snap({ absences: { '2026-03-02': [full('away')] } });
  const local = snap({ absences: { '2026-03-02': [full('leave')] } });
  const remote = snap({ absences: {} });
  const { merged, conflicts } = A.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 1);
  A.resolveConflicts(merged, conflicts, 'remote');
  assert.equal('2026-03-02' in merged.absences, false);
});
