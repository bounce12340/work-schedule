/**
 * 衝突預覽（〈衝突預覽〉區段）。
 *
 * 規格是使用者 2026-09-30 兩輪決策台定的，重點是一句話：**只提示，什麼都不做**。
 * 所以這份測試守兩類東西：
 *
 *   1. 判定規則——半開區間、沒有結束時間時只比同開始時間（不套預設時長）、
 *      只比會議、時區不同不換算只提示、90 天範圍、略過／單次覆寫／假日調整
 *   2. 「什麼都沒發生」——傳進去的項目、分享項目與 absences 在呼叫前後逐字相同
 *
 * 與其他前端測試同一個作法：從 public/index.html 抽出真正的原始碼求值，不複製
 * 一份出來測。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function section(name) {
  const marker = `  // ================= ${name} =================`;
  const start = HTML.indexOf(marker);
  assert.notEqual(start, -1, `找不到區段「${name}」——區段註解是否被改名？`);
  const from = start + marker.length;
  const next = HTML.indexOf('  // ================= ', from);
  assert.notEqual(next, -1, `區段「${name}」之後找不到下一個區段標記`);
  return HTML.slice(from, next);
}

function makeEngine(holidays = []) {
  return new Function('initialHolidays', `
    let customHolidays = new Set(initialHolidays);
    let customWorkdays = new Set();
    let majorProjects = [];
    let items = [];
    ${section('date helpers')}
    ${section('occurrence engine')}
    ${section('衝突預覽')}
    return { findConflictPreview, meetingEndError, conflictMinutes,
             CONFLICT_DEFAULT_TZ, CONFLICT_WINDOW_DAYS };
  `)(holidays);
}

const C = makeEngine();

let seq = 0;
function meeting(extra = {}) {
  return {
    id: 'm' + (++seq), title: '會議', type: 'meeting', parentId: null,
    meetingTime: '09:00', date: '2026-10-05', recurrence: null,
    done: false, doneMap: {}, overrides: {}, skipped: {},
    ...extra
  };
}
const dates = list => list.map(x => x.date);

// ───────────────────────── 半開區間 ─────────────────────────

test('首尾相接不算重疊：09:00–10:00 與 10:00–11:00', () => {
  const a = meeting({ meetingTime: '09:00', endTime: '10:00' });
  const b = meeting({ meetingTime: '10:00', endTime: '11:00' });
  const r = C.findConflictPreview(a, { ownItems: [b] });
  assert.equal(r.overlaps.length, 0);
  assert.equal(r.sameStart.length, 0);
});

test('真的交疊才提示：09:00–10:00 與 09:30–10:30', () => {
  const a = meeting({ meetingTime: '09:00', endTime: '10:00' });
  const b = meeting({ meetingTime: '09:30', endTime: '10:30', title: '週會' });
  const r = C.findConflictPreview(a, { ownItems: [b] });
  assert.equal(r.overlaps.length, 1);
  assert.equal(r.overlaps[0].otherTitle, '週會');
  assert.equal(r.overlaps[0].source, 'own');
});

test('完全包含也算重疊', () => {
  const a = meeting({ meetingTime: '09:00', endTime: '12:00' });
  const b = meeting({ meetingTime: '10:00', endTime: '10:30' });
  assert.equal(C.findConflictPreview(a, { ownItems: [b] }).overlaps.length, 1);
});

// ───────────────────────── 沒有結束時間 ─────────────────────────

test('任一方沒有結束時間：同開始時間只列 sameStart，不列 overlaps', () => {
  const a = meeting({ meetingTime: '09:00' });
  const b = meeting({ meetingTime: '09:00', endTime: '10:00' });
  const r = C.findConflictPreview(a, { ownItems: [b] });
  assert.equal(r.overlaps.length, 0);
  assert.equal(r.sameStart.length, 1);
});

test('沒有結束時間時不套預設時長：09:00 與 09:30 不提示', () => {
  // 若偷偷套了「一小時」，這一條會紅
  const a = meeting({ meetingTime: '09:00' });
  const b = meeting({ meetingTime: '09:30', endTime: '10:30' });
  const r = C.findConflictPreview(a, { ownItems: [b] });
  assert.equal(r.overlaps.length + r.sameStart.length, 0);
});

test('結束時間早於或等於開始時間：視為沒填', () => {
  const a = meeting({ meetingTime: '09:00', endTime: '08:00' });
  const b = meeting({ meetingTime: '09:30', endTime: '10:30' });
  const r = C.findConflictPreview(a, { ownItems: [b] });
  assert.equal(r.overlaps.length, 0, '不當成跨午夜');
});

// ───────────────────────── 比對對象 ─────────────────────────

test('只比會議：有時間的工作項目不參與', () => {
  const a = meeting({ meetingTime: '09:00', endTime: '10:00' });
  const w = meeting({ type: 'work', meetingTime: '09:00', endTime: '10:00' });
  const r = C.findConflictPreview(a, { ownItems: [w] });
  assert.equal(r.overlaps.length + r.sameStart.length, 0);
});

test('編輯中的項目不跟自己比；純告知、沒時間的會議不比', () => {
  const a = meeting({ meetingTime: '09:00', endTime: '10:00' });
  const notice = meeting({ meetingTime: '09:00', endTime: '10:00', noticeOnly: true });
  const noTime = meeting({ meetingTime: null });
  const r = C.findConflictPreview(a, { ownItems: [a, notice, noTime] });
  assert.equal(r.overlaps.length + r.sameStart.length, 0);
});

test('編輯中的是非會議：什麼都不回', () => {
  const w = meeting({ type: 'work', meetingTime: '09:00', endTime: '10:00' });
  const b = meeting({ meetingTime: '09:00', endTime: '10:00' });
  const r = C.findConflictPreview(w, { ownItems: [b], absences: { '2026-10-05': [{ kind: 'leave' }] } });
  assert.deepEqual([r.overlaps, r.sameStart, r.tzMismatch, r.absenceHints], [[], [], [], []]);
});

test('不同日期不提示', () => {
  const a = meeting({ date: '2026-10-05', meetingTime: '09:00', endTime: '10:00' });
  const b = meeting({ date: '2026-10-06', meetingTime: '09:00', endTime: '10:00' });
  assert.equal(C.findConflictPreview(a, { ownItems: [b] }).overlaps.length, 0);
});

test('分享給我的項目標 source:shared', () => {
  const a = meeting({ meetingTime: '09:00', endTime: '10:00' });
  const s = meeting({ meetingTime: '09:30', endTime: '10:30' });
  const r = C.findConflictPreview(a, { ownItems: [], sharedItems: [s] });
  assert.equal(r.overlaps.length, 1);
  assert.equal(r.overlaps[0].source, 'shared');
});

// ───────────────────────── 時區（第一階段不換算） ─────────────────────────

test('沒填時區＝Asia/Taipei，與明寫 Asia/Taipei 的正常比對', () => {
  assert.equal(C.CONFLICT_DEFAULT_TZ, 'Asia/Taipei');
  const a = meeting({ meetingTime: '09:00', endTime: '10:00' });
  const b = meeting({ meetingTime: '09:30', endTime: '10:30', tz: 'Asia/Taipei' });
  assert.equal(C.findConflictPreview(a, { ownItems: [b] }).overlaps.length, 1);
});

test('時區不同：不換算，只列 tzMismatch', () => {
  // 台北 09:00 與東京 10:00 是同一個瞬間，但第一階段刻意不換算
  const a = meeting({ meetingTime: '09:00', endTime: '10:00' });
  const b = meeting({ meetingTime: '10:00', endTime: '11:00', tz: 'Asia/Tokyo' });
  const r = C.findConflictPreview(a, { ownItems: [b] });
  assert.equal(r.overlaps.length, 0);
  assert.equal(r.sameStart.length, 0);
  assert.equal(r.tzMismatch.length, 1);
  assert.equal(r.tzMismatch[0].tz, 'Asia/Taipei');
  assert.equal(r.tzMismatch[0].otherTz, 'Asia/Tokyo');
});

// ───────────────────────── 循環、例外、範圍 ─────────────────────────

test('每週循環：只列 90 天內，且回報檢查截止日', () => {
  const a = meeting({ date: '2026-10-05', meetingTime: '09:00', endTime: '10:00' });
  const weekly = meeting({ date: '2026-10-05', meetingTime: '09:30', endTime: '10:30',
    recurrence: { freq: 'weekly', day: 1, holidayRule: 'none', until: null, weekdays: [1] } });
  const aw = { ...a, recurrence: { freq: 'weekly', day: 1, holidayRule: 'none', until: null, weekdays: [1] } };
  const r = C.findConflictPreview(aw, { ownItems: [weekly] });
  assert.equal(r.windowStart, '2026-10-05');
  assert.equal(r.windowEnd, '2027-01-02', '含當天共 90 天');
  assert.equal(r.overlaps.length, 13, '10/5 起每週一，到 12/28 共 13 次');
  assert.ok(dates(r.overlaps).every(d => d <= r.windowEnd));
});

test('第 91 天的重疊不提示', () => {
  const a = meeting({ date: '2026-10-05', meetingTime: '09:00', endTime: '10:00',
    recurrence: { freq: 'monthly', day: 5, holidayRule: 'none', until: null } });
  const late = meeting({ date: '2027-01-03', meetingTime: '09:00', endTime: '10:00' });
  const r = C.findConflictPreview(a, { ownItems: [late] });
  assert.equal(r.windowEnd, '2027-01-02');
  assert.equal(r.overlaps.length, 0);
});

test('被略過的那一次不提示', () => {
  const rec = { freq: 'weekly', day: 1, holidayRule: 'none', until: null, weekdays: [1] };
  const a = meeting({ date: '2026-10-05', meetingTime: '09:00', endTime: '10:00', recurrence: rec });
  const b = meeting({ date: '2026-10-12', meetingTime: '09:00', endTime: '10:00' });
  assert.equal(C.findConflictPreview(a, { ownItems: [b] }).overlaps.length, 1);
  const skipped = { ...a, skipped: { 'W2026-10-12': true } };
  assert.equal(C.findConflictPreview(skipped, { ownItems: [b] }).overlaps.length, 0);
});

test('單次覆寫：只在新日期比較，原日期不留幽靈提示', () => {
  const rec = { freq: 'weekly', day: 1, holidayRule: 'none', until: null, weekdays: [1] };
  const a = meeting({ date: '2026-10-05', meetingTime: '09:00', endTime: '10:00', recurrence: rec,
    overrides: { 'W2026-10-12': '2026-10-14' } });
  const onOrig = meeting({ date: '2026-10-12', meetingTime: '09:00', endTime: '10:00' });
  const onNew = meeting({ date: '2026-10-14', meetingTime: '09:00', endTime: '10:00' });
  const r = C.findConflictPreview(a, { ownItems: [onOrig, onNew] });
  assert.deepEqual(dates(r.overlaps), ['2026-10-14']);
  assert.equal(r.overlaps[0].occKey, 'W2026-10-12', 'occKey 維持原本那一次的身分');
});

test('假日順延後的日期才是比較的日期', () => {
  const E = makeEngine(['2026-10-12']);
  const rec = { freq: 'weekly', day: 1, holidayRule: 'postpone', until: null, weekdays: [1] };
  const a = meeting({ date: '2026-10-05', meetingTime: '09:00', endTime: '10:00', recurrence: rec });
  const tue = meeting({ date: '2026-10-13', meetingTime: '09:00', endTime: '10:00' });
  const r = E.findConflictPreview(a, { ownItems: [tue] });
  assert.deepEqual(dates(r.overlaps), ['2026-10-13']);
});

// ───────────────────────── 不在／休假 ─────────────────────────

test('休假時段內的會議：輕量提示，不進 overlaps', () => {
  const a = meeting({ meetingTime: '14:00', endTime: '15:00' });
  const r = C.findConflictPreview(a, { absences: { '2026-10-05': [{ kind: 'leave', from: '13:00', to: '18:00' }] } });
  assert.equal(r.overlaps.length, 0);
  assert.equal(r.absenceHints.length, 1);
  assert.equal(r.absenceHints[0].kind, 'leave');
});

test('整天的不在／休假都會提示；時段不相交則不提示', () => {
  const a = meeting({ meetingTime: '09:00', endTime: '10:00' });
  assert.equal(C.findConflictPreview(a, { absences: { '2026-10-05': [{ kind: 'away' }] } }).absenceHints.length, 1);
  assert.equal(C.findConflictPreview(a, { absences: { '2026-10-05': [{ kind: 'leave', from: '13:00', to: '18:00' }] } }).absenceHints.length, 0);
  assert.equal(C.findConflictPreview(a, { absences: { '2026-10-05': [{ kind: 'leave', from: '10:00', to: '12:00' }] } }).absenceHints.length, 0, '首尾相接不算');
});

test('不認得的 kind 不提示', () => {
  const a = meeting({ meetingTime: '09:00', endTime: '10:00' });
  assert.equal(C.findConflictPreview(a, { absences: { '2026-10-05': [{ kind: 'sick' }] } }).absenceHints.length, 0);
});

// ───────────────────────── 什麼都沒發生 ─────────────────────────

test('純提示：輸入的項目、分享項目與 absences 前後逐字相同', () => {
  const rec = { freq: 'weekly', day: 1, holidayRule: 'none', until: null, weekdays: [1] };
  const a = meeting({ meetingTime: '09:00', endTime: '10:00', recurrence: rec, skipped: { 'W2026-10-19': true } });
  const own = [meeting({ meetingTime: '09:30', endTime: '10:30', recurrence: rec })];
  const shared = [meeting({ meetingTime: '09:00' })];
  const absences = { '2026-10-05': [{ kind: 'leave', from: '09:00', to: '12:00' }] };
  const before = JSON.stringify([a, own, shared, absences]);
  const r = C.findConflictPreview(a, { ownItems: own, sharedItems: shared, absences });
  assert.ok(r.overlaps.length > 0 && r.sameStart.length > 0 && r.absenceHints.length > 0, '確認確實有算到東西');
  assert.equal(JSON.stringify([a, own, shared, absences]), before);
});

// ───────────────────────── 表單驗證 ─────────────────────────

test('meetingEndError：沒填合法；早於或等於開始拒絕；格式錯拒絕', () => {
  assert.equal(C.meetingEndError('09:00', null), null);
  assert.equal(C.meetingEndError('09:00', ''), null);
  assert.equal(C.meetingEndError('09:00', '10:00'), null);
  assert.match(C.meetingEndError('09:00', '09:00'), /跨午夜/);
  assert.match(C.meetingEndError('22:00', '01:00'), /跨午夜/);
  assert.match(C.meetingEndError('09:00', '25:00'), /格式/);
  assert.match(C.meetingEndError(null, '10:00'), /開始時間/);
});
