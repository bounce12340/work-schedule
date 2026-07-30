/**
 * 三方合併的測試。與 occurrence 測試同一套做法：直接從 public/index.html 抽出
 * 「三方合併」區段的原始碼求值——該區段依約定全部是純函式，不引用模組變數。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function section(name) {
  const marker = `  // ================= ${name} =================`;
  const start = HTML.indexOf(marker);
  assert.notEqual(start, -1, `找不到區段「${name}」`);
  const from = start + marker.length;
  const next = HTML.indexOf('  // ================= ', from);
  return HTML.slice(from, next);
}

const M = new Function(`
  ${section('三方合併')}
  return { stableStringify, tmEq, tmMergeList, tmMergeLogs, tmMergeSets, threeWayMerge, resolveConflicts };
`)();

/** 最小可用的 state 形狀 */
function st(over = {}) {
  return {
    version: 1, majorProjects: [], items: [], ganttProjects: [],
    dailyLogs: {}, customHolidays: [], availableYears: [2026],
    selectedGanttProjectId: null, ...over
  };
}
const item = (id, over = {}) => ({ id, title: 't-' + id, type: 'work', parentId: null,
  meetingTime: null, date: '2026-03-10', recurrence: null, done: false, doneMap: {}, overrides: {}, skipped: {}, ...over });
const clone = v => JSON.parse(JSON.stringify(v));

test('stableStringify 不受鍵順序影響', () => {
  assert.equal(M.stableStringify({ a: 1, b: [ { d: 2, c: 3 } ] }),
               M.stableStringify({ b: [ { c: 3, d: 2 } ], a: 1 }));
});

test('只有一邊改過：自動採用改過的那一邊，零衝突', () => {
  const base = st({ items: [item('a'), item('b')] });
  const local = clone(base); local.items[0].done = true;                    // 本機勾了 a
  const remote = clone(base); remote.items[1].title = '遠端改名的 b';        // 遠端改了 b
  const { merged, conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 0);
  assert.equal(merged.items.find(i => i.id === 'a').done, true);
  assert.equal(merged.items.find(i => i.id === 'b').title, '遠端改名的 b');
});

test('兩邊各自新增：都保留', () => {
  const base = st();
  const local = st({ items: [item('L')] });
  const remote = st({ items: [item('R')] });
  const { merged, conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 0);
  assert.deepEqual(merged.items.map(i => i.id).sort(), ['L', 'R']);
});

test('一邊刪除、另一邊沒動：跟著刪', () => {
  const base = st({ items: [item('a'), item('b')] });
  const local = st({ items: [item('a')] });          // 本機刪了 b
  const remote = clone(base);                        // 遠端沒動
  const { merged, conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 0);
  assert.deepEqual(merged.items.map(i => i.id), ['a']);
});

test('兩邊改到同一個項目：列為衝突，預設保留本機，可整批改選遠端', () => {
  const base = st({ items: [item('a')] });
  const local = clone(base); local.items[0].title = '本機的標題';
  const remote = clone(base); remote.items[0].title = '遠端的標題';
  const { merged, conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, 'item');
  assert.equal(merged.items[0].title, '本機的標題');
  M.resolveConflicts(merged, conflicts, 'remote');
  assert.equal(merged.items[0].title, '遠端的標題');
});

test('遠端刪除、本機修改：衝突；選遠端時該項目消失', () => {
  const base = st({ items: [item('a')] });
  const local = clone(base); local.items[0].done = true;
  const remote = st();                               // 遠端刪掉了
  const { merged, conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 1);
  assert.equal(merged.items.length, 1, '預設保留有編輯的那一邊');
  M.resolveConflicts(merged, conflicts, 'remote');
  assert.equal(merged.items.length, 0);
});

test('本機刪除、遠端修改：衝突；選本機時該項目消失', () => {
  const base = st({ items: [item('a')] });
  const local = st();
  const remote = clone(base); remote.items[0].done = true;
  const { merged, conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 1);
  assert.equal(merged.items.length, 1);
  M.resolveConflicts(merged, conflicts, 'local');
  assert.equal(merged.items.length, 0);
});

test('這就是分享的場景：被分享者勾選（遠端）＋擁有者本機編輯其他項目 → 全自動', () => {
  const base = st({ items: [item('shared'), item('mine')] });
  const remote = clone(base); remote.items[0].doneMap = { '2026-08': true };   // Bob 勾了共享項目
  const local = clone(base); local.items[1].title = '我自己改的';               // 擁有者改自己的
  const { merged, conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 0, '不同項目的變更不該打擾使用者');
  assert.deepEqual(merged.items.find(i => i.id === 'shared').doneMap, { '2026-08': true });
  assert.equal(merged.items.find(i => i.id === 'mine').title, '我自己改的');
});

test('每日記錄：不同日期各自保留，同日期兩邊都改列為衝突', () => {
  const base = st({ dailyLogs: { '2026-03-01': '原文' } });
  const local = st({ dailyLogs: { '2026-03-01': '本機版', '2026-03-02': '本機新增' } });
  const remote = st({ dailyLogs: { '2026-03-01': '遠端版', '2026-03-03': '遠端新增' } });
  const { merged, conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, 'log');
  assert.equal(merged.dailyLogs['2026-03-02'], '本機新增');
  assert.equal(merged.dailyLogs['2026-03-03'], '遠端新增');
  M.resolveConflicts(merged, conflicts, 'remote');
  assert.equal(merged.dailyLogs['2026-03-01'], '遠端版');
});

test('自訂假日集合：新增取聯集、刪除只在單邊拿掉時生效', () => {
  const merged = M.tmMergeSets(
    ['2026-01-01', '2026-05-01'],               // base
    ['2026-01-01', '2026-02-16'],               // 本機：刪了 5/1、加了 2/16
    ['2026-01-01', '2026-05-01', '2026-04-03']  // 遠端：加了 4/3
  );
  assert.deepEqual(merged, ['2026-01-01', '2026-02-16', '2026-04-03']);
});

test('甘特專案與大項目也走同一套合併', () => {
  const gp = id => ({ id, name: 'p' + id, notes: '', tasks: [] });
  const base = st({ ganttProjects: [gp('g1')], majorProjects: [{ id: 'm1', name: '分類' }] });
  const local = clone(base); local.ganttProjects[0].notes = '本機筆記';
  const remote = clone(base); remote.majorProjects[0].name = '遠端改名';
  const { merged, conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 0);
  assert.equal(merged.ganttProjects[0].notes, '本機筆記');
  assert.equal(merged.majorProjects[0].name, '遠端改名');
});

test('兩邊內容相同（即使鍵順序不同）不算衝突', () => {
  const base = st({ items: [item('a')] });
  const local = clone(base); local.items[0] = { ...item('a'), done: true };
  const remote = clone(base);
  const reordered = {}; Object.keys(local.items[0]).reverse().forEach(k => reordered[k] = local.items[0][k]);
  remote.items[0] = reordered;
  const { conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 0);
});
