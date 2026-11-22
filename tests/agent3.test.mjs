/**
 * agent 工作區（第二批 2B）：預測線、里程碑、認領、PR 看板的**前端那一半的規則**。
 * 設計文件：docs/superpowers/specs/2026-11-21-agent-workspace.md（第二批 6～9、乙 2）
 *
 * 守的東西，壞掉時**畫面看起來完全正常**：
 *   1. 里程碑的顏色規則前後端逐欄相同：伺服器說有風險（get_project_brief 的 atRisk）、
 *      畫面上的菱形卻是灰的——使用者與 agent 看到兩個不同的專案
 *   2. 「晚幾天」與「認領多久沒動靜」的界線前後端相同（24 小時整＝還算新的）
 *   3. 證據連結只收 http(s)（同 normalizeTaskLinks 的白名單；加進去之後被正規化洗掉＝使用者以為存了）
 *   4. PR 看板的順序：測試失敗最前面、「等你審」第二；已合併但任務沒完成才問「要標成完成嗎」
 *
 * 前端那一段是純函式（〈預測與里程碑（純函式）〉區段），這裡從 index.html 抽真正的原始碼求值，
 * 不是複製一份——複製出來測，測的是副本。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S from '../src/mcp/schedule.js';

const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
function section(name) {
  const head = `  // ================= ${name}`;
  const start = HTML.indexOf(head);
  assert.notEqual(start, -1, `找不到區段「${name}」`);
  const eol = HTML.indexOf('\n', start);
  const next = HTML.indexOf('  // ================= ', eol);
  return HTML.slice(eol, next);
}
const F = new Function(`
  let availableYears = [];
  ${section('富文字')}
  ${section('持久化（單一儲存層）')}
  ${section('預測與里程碑（純函式）')}
  return { agentEffectiveDone, agentLateDays, agentMilestoneStatus, agentClaimIdleDays, agentCleanLinkUrl,
           agentPrRank, agentOrderPrs, agentPrIsOpen, agentPrUrlOk, agentMergedHints, AGENT_CLAIM_STALE_MS };
`)();

// ------------------------------------------------------------ 前後端逐欄相同

const T = (id, end, over = {}) => ({ id, name: id, start: '2026-12-01', end, progress: 0, done: false, todos: [], forecastEnd: null, ...over });
const FIXTURE_TASKS = [
  T('a', '2026-12-10'),
  T('b', '2026-12-10', { forecastEnd: '2026-12-15' }),
  T('c', '2026-12-10', { forecastEnd: '2026-12-10' }),
  T('d', '2026-12-10', { forecastEnd: '2026-12-05' }),
  T('e', '2026-12-10', { done: true, forecastEnd: '2026-12-30' }),
  T('f', '2026-12-10', { todos: [{ id: 'x', text: '', done: true }, { id: 'y', text: '', done: false }], forecastEnd: '2026-12-31' }),
  T('g', '2026-12-10', { todos: [{ id: 'x', text: '', done: true }], done: false }),
  T('h', '2026-12-20', { forecastEnd: '2026-12-25' }),
  T('i', '2026-11-01'),
];

test('里程碑的顏色規則：前端與 src/mcp/schedule.js 在每一個組合上逐欄相同', () => {
  let n = 0;
  const dates = ['2026-11-30', '2026-12-09', '2026-12-10', '2026-12-11', '2026-12-14', '2026-12-15', '2026-12-20', '2026-12-31', '2027-01-15'];
  const todays = ['2026-11-01', '2026-12-10', '2026-12-11', '2026-12-31', '2027-02-01'];
  // 每一個任務單獨、每兩個一組、全部放一起——專案裡有什麼任務決定哪些算「把關的」
  const groups = [FIXTURE_TASKS, ...FIXTURE_TASKS.map(t => [t]),
    ...FIXTURE_TASKS.flatMap((a, i) => FIXTURE_TASKS.slice(i + 1).map(b => [a, b])), []];
  for (const tasks of groups) {
    const gp = { id: 'g', tasks };
    for (const date of dates) for (const today of todays) {
      const m = { id: 'm', name: 'M', date };
      assert.deepEqual(F.agentMilestoneStatus(gp, m, today), S.milestoneStatus(gp, m, today),
        `不一致：任務 ${tasks.map(t => t.id)}／里程碑 ${date}／今天 ${today}`);
      n++;
    }
  }
  assert.ok(n > 2000, '案例數太少，這條斷言會變成空的');
});

test('里程碑的規則本身（不只是兩邊一樣）：預測超過里程碑日＝有風險，剛好等於不算', () => {
  const gp = { id: 'g', tasks: [T('a', '2026-12-10', { forecastEnd: '2026-12-15' })] };
  assert.equal(F.agentMilestoneStatus(gp, { date: '2026-12-14' }, '2026-12-01').atRisk, true);
  assert.equal(F.agentMilestoneStatus(gp, { date: '2026-12-15' }, '2026-12-01').atRisk, false, '預測日剛好等於里程碑日：趕得上');
  // 已完成的任務就算預測還掛著也不算風險
  const done = { id: 'g', tasks: [T('a', '2026-12-10', { done: true, forecastEnd: '2026-12-30' })] };
  assert.equal(F.agentMilestoneStatus(done, { date: '2026-12-14' }, '2026-12-01').atRisk, false);
  // 計畫在里程碑之後的任務不是把關的
  const later = { id: 'g', tasks: [T('a', '2026-12-20', { forecastEnd: '2026-12-30' })] };
  assert.equal(F.agentMilestoneStatus(later, { date: '2026-12-14' }, '2026-12-01').gatingTasks, 0);
  // 已過里程碑日還有沒完成的＝有風險（已錯過）
  assert.equal(F.agentMilestoneStatus(gp, { date: '2026-12-10' }, '2026-12-11').atRisk, true);
});

test('晚幾天：前端與伺服器的 lateDays 相同（負的＝比計畫早；沒有預測＝null）', () => {
  for (const t of FIXTURE_TASKS) assert.equal(F.agentLateDays(t), S.lateDays(t), t.id);
  assert.equal(F.agentLateDays({ end: '2026-12-10', forecastEnd: '2026-12-15' }), 5);
  assert.equal(F.agentLateDays({ end: '2026-12-10', forecastEnd: '2026-12-05' }), -5);
  assert.equal(F.agentLateDays({ end: '2026-12-10', forecastEnd: null }), null);
  assert.equal(F.agentLateDays({ end: '2026-12-10', forecastEnd: 'soon' }), null);
});

test('有效的完成：有子待辦時由子待辦算（同伺服器）', () => {
  for (const t of FIXTURE_TASKS) assert.equal(F.agentEffectiveDone(t), S.effectiveDone(t), t.id);
});

test('認領的新舊：門檻與伺服器的 CLAIM_STALE_MS 同一個，剛好 24 小時還算新', () => {
  assert.equal(F.AGENT_CLAIM_STALE_MS, S.CLAIM_STALE_MS);
  const now = Date.UTC(2026, 11, 10, 12);
  const mk = ageMs => ({ assignee: 'Claude', claimedAt: now - ageMs });
  assert.equal(F.agentClaimIdleDays(mk(3600e3), now), null);
  assert.equal(F.agentClaimIdleDays(mk(S.CLAIM_STALE_MS), now), null, '剛好 24 小時：還算新（伺服器用的是 >）');
  assert.equal(F.agentClaimIdleDays(mk(S.CLAIM_STALE_MS + 1), now), 1);
  assert.equal(F.agentClaimIdleDays(mk(3 * 86400e3 + 5), now), 3);
  // 沒有 claimedAt（人手動指派的）視為新的，不標「沒動靜」；沒有人認領也不標
  assert.equal(F.agentClaimIdleDays({ assignee: 'user', claimedAt: null }, now), null);
  assert.equal(F.agentClaimIdleDays({ assignee: null, claimedAt: now - 9e9 }, now), null);
});

// ------------------------------------------------------------ 證據連結

test('證據連結：只收 http(s)，其餘（javascript:、data:、沒有協定、含空白）一律 null', () => {
  assert.equal(F.agentCleanLinkUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(F.agentCleanLinkUrl('  http://example.com  '), 'http://example.com');
  assert.equal(F.agentCleanLinkUrl('HTTPS://Example.com/X'), 'https://Example.com/X', '協定轉小寫（normalizeTaskLinks 的白名單是小寫比對）');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'example.com', 'ftp://x.y', 'https://a b', 'https://', '', null, undefined, 'https://x.y/\u0000'])
    assert.equal(F.agentCleanLinkUrl(bad), null, String(bad));
  assert.equal(F.agentCleanLinkUrl('https://x.y/' + 'a'.repeat(500)), null, '超過 500 字不收（截斷會讓網址壞掉）');
});

test('證據連結：畫面收下的網址，經過 normalizeGanttProjects 之後原樣還在（不會被洗掉）', () => {
  const G = new Function(`
    let availableYears = [];
    ${section('富文字')}
    ${section('持久化（單一儲存層）')}
    ${section('專案的夥伴')}
    ${HTML.slice(HTML.indexOf('  function todoProgress(todos){'), HTML.indexOf('  function syncTaskFromTodos(t){'))}
    return { normalizeGanttProjects };
  `)();
  for (const u of ['https://example.com/doc', 'http://a.b/c?d=e#f', 'https://docs.google.com/document/d/abc/edit']) {
    const clean = F.agentCleanLinkUrl(u);
    const gp = G.normalizeGanttProjects([{ id: 'g', name: 'x', tasks: [{ id: 't', name: 't', start: '2026-01-01', end: '2026-01-02', links: [{ url: clean, label: 'L' }] }] }]);
    assert.deepEqual(gp[0].tasks[0].links, [{ url: clean, label: 'L' }]);
  }
});

// ------------------------------------------------------------ PR 看板

const PR = (id, over = {}) => ({ id, number: 1, state: 'open', checks: 'none', review: 'none', title: id, url: 'https://github.com/o/r/pull/1', taskId: null, updatedAt: 1000, ...over });

test('PR 看板的順序：測試失敗最前面、「等你審」第二，其餘照最近更新', () => {
  const prs = [
    PR('plain-new', { updatedAt: 9000 }),
    PR('review', { review: 'pending', updatedAt: 3000 }),
    PR('fail-old', { checks: 'failing', updatedAt: 1000 }),
    PR('plain-old', { updatedAt: 2000 }),
    PR('fail-new', { checks: 'failing', updatedAt: 5000 }),
    PR('draft-review', { state: 'draft', review: 'pending', updatedAt: 8000 }),
  ];
  assert.deepEqual(F.agentOrderPrs(prs).map(p => p.id), ['fail-new', 'fail-old', 'review', 'plain-new', 'draft-review', 'plain-old']);
  // 不改動輸入
  assert.equal(prs[0].id, 'plain-new');
  // 測試失敗又等你審：仍然是第一類（失敗優先）
  assert.equal(F.agentPrRank(PR('x', { checks: 'failing', review: 'pending' })), 0);
  // 草稿不算「等你審」：還沒要人審
  assert.equal(F.agentPrRank(PR('x', { state: 'draft', review: 'pending' })), 2);
});

test('PR 看板：開著＝open 與 draft；連結只認 github.com', () => {
  assert.equal(F.agentPrIsOpen(PR('a')), true);
  assert.equal(F.agentPrIsOpen(PR('a', { state: 'draft' })), true);
  assert.equal(F.agentPrIsOpen(PR('a', { state: 'merged' })), false);
  assert.equal(F.agentPrIsOpen(PR('a', { state: 'closed' })), false);
  assert.equal(F.agentPrUrlOk('https://github.com/o/r/pull/1'), true);
  for (const bad of ['http://github.com/o/r', 'https://evil.example/github.com/', 'javascript:alert(1)', '', null, undefined])
    assert.equal(F.agentPrUrlOk(bad), false, String(bad));
});

test('「PR 已合併，要標成完成嗎？」：只在已合併、連到任務、而且那個任務還沒完成時問', () => {
  const gp = { id: 'g', tasks: [
    T('t_open', '2026-12-10'),
    T('t_done', '2026-12-10', { done: true }),
    T('t_todos', '2026-12-10', { todos: [{ id: 'x', text: '', done: false }] }),
    T('t_todos_done', '2026-12-10', { todos: [{ id: 'x', text: '', done: true }] }),
  ] };
  const prs = [
    PR('merged-open', { state: 'merged', taskId: 't_open' }),
    PR('merged-done', { state: 'merged', taskId: 't_done' }),
    PR('merged-todos', { state: 'merged', taskId: 't_todos' }),
    PR('merged-todos-done', { state: 'merged', taskId: 't_todos_done' }),
    PR('merged-no-task', { state: 'merged' }),
    PR('merged-missing-task', { state: 'merged', taskId: 'gone' }),
    PR('open-on-open-task', { state: 'open', taskId: 't_open' }),
    PR('closed-on-open-task', { state: 'closed', taskId: 't_open' }),
  ];
  assert.deepEqual(F.agentMergedHints(gp, prs).map(h => h.pr.id), ['merged-open', 'merged-todos']);
});
