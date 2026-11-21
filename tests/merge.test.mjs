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

// ================= 欄位層級的合併（第零批 0-1）=================

const todo = (id, over = {}) => ({ id, text: '待辦' + id, done: false, ...over });
const task = (id, over = {}) => ({ id, name: '任務' + id, start: '2026-03-01', end: '2026-03-10',
  todos: [], progress: 0, done: false, ...over });
const proj = (id, over = {}) => ({ id, name: '專案' + id, notes: '', pet: null, tasks: [], ...over });
const pick = (arr, id) => arr.find(x => x.id === id);

test('同一個專案：兩邊各改不同任務 → 零衝突，兩邊的修改都在', () => {
  const base = st({ ganttProjects: [proj('g', { tasks: [task('A'), task('B')] })] });
  const local = clone(base); pick(local.ganttProjects[0].tasks, 'A').name = '本機改 A';
  const remote = clone(base); pick(remote.ganttProjects[0].tasks, 'B').name = '遠端改 B';
  const { merged, conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 0);
  const ts = merged.ganttProjects[0].tasks;
  assert.equal(pick(ts, 'A').name, '本機改 A');
  assert.equal(pick(ts, 'B').name, '遠端改 B');
});

test('同一個任務：兩邊改不同欄位 → 零衝突', () => {
  const base = st({ ganttProjects: [proj('g', { tasks: [task('A')] })] });
  const local = clone(base); local.ganttProjects[0].tasks[0].name = '本機改名';
  const remote = clone(base); remote.ganttProjects[0].tasks[0].end = '2026-04-01';
  const { merged, conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 0);
  assert.equal(merged.ganttProjects[0].tasks[0].name, '本機改名');
  assert.equal(merged.ganttProjects[0].tasks[0].end, '2026-04-01');
});

test('同一個欄位改成不同的值 → 衝突，候選帶著其他欄位的合併結果', () => {
  const base = st({ ganttProjects: [proj('g', { notes: '舊', tasks: [task('A'), task('B')] })] });
  const local = clone(base);
  local.ganttProjects[0].tasks[0].name = '本機名';           // 與遠端衝突
  local.ganttProjects[0].notes = '本機筆記';                  // 只有本機改
  const remote = clone(base);
  remote.ganttProjects[0].tasks[0].name = '遠端名';           // 與本機衝突
  remote.ganttProjects[0].tasks[0].end = '2026-05-05';        // 只有遠端改
  remote.ganttProjects[0].tasks[1].name = '遠端改 B';         // 只有遠端改
  const { merged, conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 1);
  const c = conflicts[0];
  assert.equal(c.kind, 'gantt');
  assert.equal(c.id, 'g');
  assert.ok(c.fields.some(f => f.includes('name')));
  for (const [side, nm] of [['local', '本機名'], ['remote', '遠端名']]) {
    const cand = c[side];
    assert.equal(pick(cand.tasks, 'A').name, nm, side + ' 候選的衝突欄位取自己的值');
    assert.equal(pick(cand.tasks, 'A').end, '2026-05-05', side + ' 候選保有對方不衝突的修改');
    assert.equal(pick(cand.tasks, 'B').name, '遠端改 B');
    assert.equal(cand.notes, '本機筆記');
  }
  assert.equal(pick(merged.ganttProjects[0].tasks, 'A').name, '本機名', '預設取本機');
});

test('同一個欄位兩邊改成相同的值 → 不是衝突', () => {
  const base = st({ ganttProjects: [proj('g', { tasks: [task('A')] })] });
  const local = clone(base); local.ganttProjects[0].tasks[0].name = '一樣'; local.ganttProjects[0].notes = 'x';
  const remote = clone(base); remote.ganttProjects[0].tasks[0].name = '一樣'; remote.ganttProjects[0].name = '遠端專案名';
  const { merged, conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 0);
  assert.equal(merged.ganttProjects[0].tasks[0].name, '一樣');
  assert.equal(merged.ganttProjects[0].notes, 'x');
  assert.equal(merged.ganttProjects[0].name, '遠端專案名');
});

test('子待辦：一邊新增、另一邊勾選 → 共存，且 progress／done 不構成衝突', () => {
  const base = st({ ganttProjects: [proj('g', { tasks: [task('A', { todos: [todo('t1'), todo('t2')] })] })] });
  const local = clone(base);                       // 本機勾了 t1（progress 也跟著變）
  local.ganttProjects[0].tasks[0].todos[0].done = true;
  local.ganttProjects[0].tasks[0].progress = 50;
  const remote = clone(base);                      // 遠端勾了 t2、新增 t3（progress 也跟著變，而且跟本機不同）
  remote.ganttProjects[0].tasks[0].todos[1].done = true;
  remote.ganttProjects[0].tasks[0].todos.push(todo('t3'));
  remote.ganttProjects[0].tasks[0].progress = 33;  // 兩邊都改過 progress、值不同：沒有衍生欄位的規則就會被判成衝突
  remote.ganttProjects[0].tasks[0].done = false;
  const { merged, conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 0, '衍生欄位不該被當成衝突');
  const td = merged.ganttProjects[0].tasks[0].todos;
  assert.deepEqual(td.map(t => t.id).sort(), ['t1', 't2', 't3']);
  assert.equal(pick(td, 't1').done, true);
  assert.equal(pick(td, 't3').done, false);
});

test('子待辦：兩邊把同一個待辦改成不同文字 → 衝突（候選保留另一邊新增的待辦）', () => {
  const base = st({ ganttProjects: [proj('g', { tasks: [task('A', { todos: [todo('t1')] })] })] });
  const local = clone(base); local.ganttProjects[0].tasks[0].todos[0].text = '本機字';
  const remote = clone(base); remote.ganttProjects[0].tasks[0].todos[0].text = '遠端字';
  remote.ganttProjects[0].tasks[0].todos.push(todo('t2'));
  const { conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 1);
  assert.equal(pick(conflicts[0].local.tasks[0].todos, 't1').text, '本機字');
  assert.equal(pick(conflicts[0].remote.tasks[0].todos, 't1').text, '遠端字');
  assert.ok(pick(conflicts[0].local.tasks[0].todos, 't2'), '本機候選也有遠端新增的 t2');
});

test('沒有子待辦的任務：progress 是真的使用者欄位，兩邊改不同值要衝突', () => {
  const base = st({ ganttProjects: [proj('g', { tasks: [task('A')] })] });
  const local = clone(base); local.ganttProjects[0].tasks[0].progress = 30;
  const remote = clone(base); remote.ganttProjects[0].tasks[0].progress = 70;
  const { conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 1);
});

test('刪掉任務 vs 另一邊改了它 → 衝突（整個任務）；刪 vs 沒動 → 跟著刪', () => {
  const base = st({ ganttProjects: [proj('g', { tasks: [task('A'), task('B')] })] });
  const local = clone(base); local.ganttProjects[0].tasks = [task('B')];            // 本機刪 A
  const remote = clone(base); remote.ganttProjects[0].tasks[0].name = '遠端改 A';   // 遠端改 A
  remote.ganttProjects[0].tasks[1].name = '遠端改 B';                                // 遠端改 B（本機沒動）
  const { merged, conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].local.tasks.length, 1, '本機候選：A 已刪');
  assert.equal(conflicts[0].remote.tasks.length, 2);
  assert.equal(pick(conflicts[0].local.tasks, 'B').name, '遠端改 B');
  // 刪 vs 沒動
  const l2 = clone(base); l2.ganttProjects[0].tasks = [task('B')];
  const r2 = clone(base); r2.ganttProjects[0].name = '遠端改專案名';
  const res2 = M.threeWayMerge(base, l2, r2);
  assert.equal(res2.conflicts.length, 0);
  assert.deepEqual(res2.merged.ganttProjects[0].tasks.map(t => t.id), ['B']);
  assert.equal(res2.merged.ganttProjects[0].name, '遠端改專案名');
  assert.ok(merged);
});

test('項目：本機改標題、遠端勾某一次 → 零衝突；兩邊勾不同次 → 兩個 key 都在', () => {
  const base = st({ items: [item('a', { doneMap: { '2026-01': true } })] });
  const local = clone(base); local.items[0].title = '本機標題';
  const remote = clone(base); remote.items[0].doneMap['2026-02'] = true;
  let r = M.threeWayMerge(base, local, remote);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.merged.items[0].title, '本機標題');
  assert.deepEqual(r.merged.items[0].doneMap, { '2026-01': true, '2026-02': true });
  const l2 = clone(base); l2.items[0].doneMap['2026-03'] = true; l2.items[0].doneAt = { '2026-03': 1 };
  r = M.threeWayMerge(base, l2, remote);
  assert.equal(r.conflicts.length, 0);
  assert.deepEqual(r.merged.items[0].doneMap, { '2026-01': true, '2026-02': true, '2026-03': true });
  assert.deepEqual(r.merged.items[0].doneAt, { '2026-03': 1 });
});

test('項目：同一個 doneMap key 兩邊改不同 → 衝突，候選保留其他欄位', () => {
  const base = st({ items: [item('a')] });
  const local = clone(base); local.items[0].doneMap = { '2026-01': true }; local.items[0].title = '本機標題';
  const remote = clone(base); remote.items[0].doneMap = { '2026-01': false }; remote.items[0].date = '2026-04-04';
  const { conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].fields, ['doneMap.2026-01']);
  assert.equal(conflicts[0].remote.doneMap['2026-01'], false);
  assert.equal(conflicts[0].remote.title, '本機標題');
  assert.equal(conflicts[0].local.date, '2026-04-04');
});

test('項目：頻率有人改過時，另一邊在舊頻率下勾的紀錄不會變成孤兒', () => {
  const weekly = { freq: 'weekly', day: 1, weekdays: [1] };
  const monthly = { freq: 'monthly', day: 5 };
  const base = st({ items: [item('a', { recurrence: weekly, doneMap: { 'W2026-03-02': true } })] });
  const local = clone(base); local.items[0].recurrence = monthly; local.items[0].doneMap = {};   // 改頻率並清空
  const remote = clone(base); remote.items[0].doneMap['W2026-03-09'] = true;                       // 舊頻率下又勾了一次
  const { merged, conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 0);
  assert.equal(merged.items[0].recurrence.freq, 'monthly');
  assert.deepEqual(merged.items[0].doneMap, {});
});

test('專案名稱 vs 夥伴（pet）→ 各改各的，零衝突', () => {
  const base = st({ ganttProjects: [proj('g')] });
  const local = clone(base); local.ganttProjects[0].name = '新名字';
  const remote = clone(base); remote.ganttProjects[0].pet = 'cat';
  const { merged, conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 0);
  assert.equal(merged.ganttProjects[0].name, '新名字');
  assert.equal(merged.ganttProjects[0].pet, 'cat');
});

test('大項目也逐欄位：不同欄位不衝突', () => {
  const base = st({ majorProjects: [{ id: 'm', name: '分類', color: 'a' }] });
  const local = clone(base); local.majorProjects[0].name = '改名';
  const remote = clone(base); remote.majorProjects[0].color = 'b';
  const { merged, conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 0);
  assert.deepEqual(merged.majorProjects[0], { id: 'm', name: '改名', color: 'b' });
});

test('舊形狀的基準（沒有 tasks／todos／pet／doneAt）照樣合得起來，不丟資料', () => {
  const oldGp = { id: 'g', name: '舊專案', notes: '' };                       // 沒有 tasks、pet
  const base = st({ ganttProjects: [oldGp], items: [{ id: 'a', title: 't', type: 'work', date: '2026-03-10', done: false }] });
  const local = clone(base);                                                  // 本機升級成新形狀並加了任務、待辦
  local.ganttProjects[0] = { ...oldGp, pet: null, tasks: [task('A', { todos: [todo('t1')] })] };
  local.items[0] = { ...base.items[0], doneMap: {}, overrides: {}, skipped: {}, doneAt: {} };
  const remote = clone(base);                                                 // 遠端（舊 build）改了專案名、勾了項目
  remote.ganttProjects[0].name = '遠端改名';
  remote.items[0].done = true;
  const { merged, conflicts } = M.threeWayMerge(base, local, remote);
  assert.equal(conflicts.length, 0);
  assert.equal(merged.ganttProjects[0].name, '遠端改名');
  assert.equal(merged.ganttProjects[0].tasks.length, 1);
  assert.equal(merged.ganttProjects[0].tasks[0].todos.length, 1);
  assert.equal(merged.items[0].done, true);
  assert.deepEqual(merged.items[0].doneAt, {});
});

test('resolveConflicts：選本機或遠端都不會丟掉另一邊不衝突的修改', () => {
  const base = st({ ganttProjects: [proj('g', { tasks: [task('A')] })] });
  const local = clone(base);
  local.ganttProjects[0].tasks[0].name = '本機名'; local.ganttProjects[0].notes = '本機筆記';
  const remote = clone(base);
  remote.ganttProjects[0].tasks[0].name = '遠端名'; remote.ganttProjects[0].name = '遠端專案名';
  for (const side of ['local', 'remote']) {
    const { merged, conflicts } = M.threeWayMerge(base, local, remote);
    assert.equal(conflicts.length, 1);
    M.resolveConflicts(merged, conflicts, side);
    const g = merged.ganttProjects[0];
    assert.equal(g.tasks[0].name, side === 'local' ? '本機名' : '遠端名');
    assert.equal(g.notes, '本機筆記', side + '：本機的筆記還在');
    assert.equal(g.name, '遠端專案名', side + '：遠端的專案名還在');
  }
});

test('合併不改動輸入', () => {
  const base = st({ ganttProjects: [proj('g', { tasks: [task('A', { todos: [todo('t1')] })] })], items: [item('a')] });
  const local = clone(base); local.ganttProjects[0].tasks[0].name = 'L'; local.items[0].doneMap = { x: true };
  const remote = clone(base); remote.ganttProjects[0].tasks[0].name = 'R'; remote.items[0].doneMap = { y: true };
  const snap = [clone(base), clone(local), clone(remote)];
  M.threeWayMerge(base, local, remote);
  assert.deepEqual([base, local, remote], snap);
});
