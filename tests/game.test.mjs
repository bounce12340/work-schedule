/**
 * 遊戲化引擎（〈遊戲化〉區段）：連續天數、XP、等級、挑戰梯子、徽章。
 * 設計文件 docs/superpowers/specs/2026-09-16-gamification-design.md。
 *
 * 從 index.html 抽真正的原始碼求值（同 tests/occurrence.test.mjs），不複製一份。
 * 引擎依賴 date helpers 與 occurrence engine，所以三個區段一起裝進去。
 *
 * 守的東西：
 *   - 「按時」是到期那天 23:59:59 之前——隔天補勾不算（連續天數才是「有沒有按時做」，不是「有沒有補勾」）
 *   - 沒安排的日子跳過：不斷也不加（使用者的裁決；週末、假日不會把火焰弄斷）
 *   - 今天還沒過完：今天 missed 不斷昨天的連續
 *   - 上線日之前不算（GAME_EPOCH）
 *   - 挑戰的梯子：拿到 7 才解鎖 14；斷了不掉階
 *
 * 突變驗證（加完測試做過）：把 gameOnTime 的 `<=` 拿掉（有時間戳就算按時）→ 4 紅；empty 也 run=0 → 1 紅；
 * 今天 missed 也 break → 1 紅；levelOf 門檻改成固定 100 → 2 紅。
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

function makeEngine() {
  const build = new Function(`
    let customHolidays = new Set();
    let customWorkdays = new Set();
    let majorProjects = [];
    let items = [];
    ${section('date helpers')}
    ${section('occurrence engine')}
    ${section('遊戲化')}
    return {
      GAME_EPOCH, GAME_LADDER, GAME_XP,
      dayVerdict, streakFromVerdicts, levelOf, stageOf, challengeOf, perfectWeeksOf, badgesOf, gameStats,
      gameOnTime, isActionable, ymd, parseYMD, setOccurrenceDone,
      setItems(list){ items = list; }
    };
  `);
  return build();
}

const E = makeEngine();
const EPOCH = E.GAME_EPOCH;                       // 2026-09-17（週四）
const ms = (ymd, hh = 12) => { const d = E.parseYMD(ymd); d.setHours(hh, 0, 0, 0); return d.getTime(); };
const addDays = (ymd, n) => { const d = E.parseYMD(ymd); d.setDate(d.getDate() + n); return E.ymd(d); };

let seq = 0;
function single(date, doneAtMs, extra = {}) {
  return { id: 'i' + (++seq), title: '項目', type: 'work', parentId: null, date, recurrence: null,
    done: doneAtMs != null, doneMap: {}, doneAt: doneAtMs != null ? { single: doneAtMs } : {}, overrides: {}, skipped: {}, ...extra };
}
/** 從上線日起連續 n 天、每天一件、全部按時做完 */
function perfectRun(n, from = EPOCH) {
  return Array.from({ length: n }, (_, i) => { const d = addDays(from, i); return single(d, ms(d, 9)); });
}

// ---------------------------------------------------------------- 判決

test('按時＝到期那天結束前做完；隔天補勾不算；沒有時間戳不算', () => {
  const day = EPOCH;
  const onTime = { item: single(day, ms(day, 23)), occKey: 'single', date: day };
  const late = { item: single(day, ms(addDays(day, 1), 0)), occKey: 'single', date: day };
  const legacy = { item: { ...single(day, null), done: true }, occKey: 'single', date: day };
  assert.equal(E.gameOnTime(onTime), true);
  assert.equal(E.gameOnTime(late), false, '隔天 00:00 已經是隔天');
  assert.equal(E.gameOnTime(legacy), false, '上線前的完成沒有時間戳');
  assert.equal(E.dayVerdict([]), 'empty');
  assert.equal(E.dayVerdict([onTime]), 'perfect');
  assert.equal(E.dayVerdict([onTime, late]), 'missed');
});

test('跨多天事項以結束日為到期日', () => {
  const start = EPOCH, end = addDays(EPOCH, 3);
  const occ = { item: single(start, ms(end, 20), { endDate: end }), occKey: 'single', date: start };
  assert.equal(E.gameOnTime(occ), true, '結束日當天做完算按時');
  const occLate = { item: single(start, ms(addDays(end, 1), 1), { endDate: end }), occKey: 'single', date: start };
  assert.equal(E.gameOnTime(occLate), false);
});

// ---------------------------------------------------------------- 連續

const V = (pairs) => pairs.map(([date, verdict]) => ({ date, verdict }));
const D = (i) => addDays(EPOCH, i);

test('連續：empty 跳過不斷也不加；missed 斷', () => {
  const v = V([[D(0), 'perfect'], [D(1), 'empty'], [D(2), 'empty'], [D(3), 'perfect'], [D(4), 'perfect']]);
  assert.deepEqual(E.streakFromVerdicts(v, D(4)), { current: 3, best: 3, todayPerfect: true });
  const broken = V([[D(0), 'perfect'], [D(1), 'perfect'], [D(2), 'missed'], [D(3), 'perfect'], [D(4), 'perfect']]);
  assert.deepEqual(E.streakFromVerdicts(broken, D(4)), { current: 2, best: 2, todayPerfect: true });
});

test('連續：今天還沒過完——今天 missed 不斷昨天的連續，今天 empty 也不加', () => {
  const v = V([[D(0), 'perfect'], [D(1), 'perfect'], [D(2), 'missed']]);
  assert.deepEqual(E.streakFromVerdicts(v, D(2)), { current: 2, best: 2, todayPerfect: false });
  const e = V([[D(0), 'perfect'], [D(1), 'perfect'], [D(2), 'empty']]);
  assert.deepEqual(E.streakFromVerdicts(e, D(2)), { current: 2, best: 2, todayPerfect: false });
  // 同一份資料，隔天再看：昨天的 missed 就真的斷了
  assert.deepEqual(E.streakFromVerdicts([...v, { date: D(3), verdict: 'empty' }], D(3)), { current: 0, best: 2, todayPerfect: false });
});

test('連續：best 記歷史最長，斷掉後 current 從 0 重數', () => {
  const v = V([[D(0), 'perfect'], [D(1), 'perfect'], [D(2), 'perfect'], [D(3), 'missed'], [D(4), 'perfect']]);
  assert.deepEqual(E.streakFromVerdicts(v, D(4)), { current: 1, best: 3, todayPerfect: true });
});

// ---------------------------------------------------------------- 等級、階段、梯子、徽章

test('等級門檻遞增：0→1 級、100→2 級、300→3 級、600→4 級', () => {
  assert.deepEqual(E.levelOf(0), { level: 1, into: 0, need: 100 });
  assert.deepEqual(E.levelOf(99), { level: 1, into: 99, need: 100 });
  assert.deepEqual(E.levelOf(100), { level: 2, into: 0, need: 200 });
  assert.deepEqual(E.levelOf(299), { level: 2, into: 199, need: 200 });
  assert.deepEqual(E.levelOf(300), { level: 3, into: 0, need: 300 });
  assert.deepEqual(E.levelOf(600), { level: 4, into: 0, need: 400 });
  assert.equal(E.stageOf(1), 'seed'); assert.equal(E.stageOf(3), 'sprout'); assert.equal(E.stageOf(5), 'seedling');
  assert.equal(E.stageOf(8), 'tree'); assert.equal(E.stageOf(12), 'flower'); assert.equal(E.stageOf(17), 'fruit');
  assert.equal(E.stageOf(40), 'fruit', '外觀只到第六階，之後只長數字');
});

test('挑戰梯子：拿到 7 才解鎖 14；斷了從 0 重爬同一階，不掉階；30 拿到就沒有目標', () => {
  assert.deepEqual(E.challengeOf({ current: 3, best: 3 }), { target: 7, done: 3, unlocked: [] });
  assert.deepEqual(E.challengeOf({ current: 0, best: 9 }), { target: 14, done: 0, unlocked: [7] });
  assert.deepEqual(E.challengeOf({ current: 20, best: 20 }), { target: 30, done: 20, unlocked: [7, 14] });
  assert.deepEqual(E.challengeOf({ current: 2, best: 31 }), { target: null, done: 30, unlocked: [7, 14, 30] });
});

test('完美的一週：週一到週五都在範圍內、至少一天 perfect、沒有 missed', () => {
  // 2026-09-21 是週一
  const week = (mon, verdicts) => verdicts.map((v, i) => [addDays(mon, i), v]);
  assert.equal(E.perfectWeeksOf(V(week('2026-09-21', ['perfect', 'perfect', 'empty', 'perfect', 'perfect']))), 1);
  assert.equal(E.perfectWeeksOf(V(week('2026-09-21', ['perfect', 'missed', 'perfect', 'perfect', 'perfect']))), 0);
  assert.equal(E.perfectWeeksOf(V(week('2026-09-21', ['empty', 'empty', 'empty', 'empty', 'empty']))), 0, '整週沒安排不算');
  assert.equal(E.perfectWeeksOf(V(week('2026-09-21', ['perfect', 'perfect', 'perfect', 'perfect']))), 0, '只有四天在範圍內不算完整的一週');
});

test('徽章：次數、梯子、完美週', () => {
  assert.deepEqual(E.badgesOf(0, { best: 0 }, 0), []);
  assert.deepEqual(E.badgesOf(1, { best: 0 }, 0), ['first']);
  assert.deepEqual(E.badgesOf(50, { best: 14 }, 1), ['first', 'ten', 'fifty', 'streak7', 'streak14', 'perfectWeek']);
});

// ---------------------------------------------------------------- 整條路：從 items 到 stats

test('gameStats：七天每天一件按時做完 → 連續 7、解鎖 7 天徽章、XP 算得出來', () => {
  E.setItems(perfectRun(7));
  const today = D(6);
  const s = E.gameStats(today);
  assert.equal(s.onTime, 7);
  assert.equal(s.perfectDays, 7);
  assert.deepEqual(s.streak, { current: 7, best: 7, todayPerfect: true });
  assert.deepEqual(s.challenge, { target: 14, done: 7, unlocked: [7] });
  assert.deepEqual(s.badges, ['first', 'streak7']);
  // 7×10 + 7×30 + 2×100 = 480 → 第 3 級（門檻 300），距第 4 級（600）還要 120
  assert.equal(s.xp, 480);
  assert.equal(s.level, 3); assert.equal(s.into, 180); assert.equal(s.need, 300);
  assert.equal(s.stage, 'sprout');
  assert.equal(s.todayVerdict, 'perfect');
});

test('gameStats：上線日之前的完成一律不算；空資料是種子', () => {
  E.setItems([single('2026-09-10', ms('2026-09-10', 9))]);   // 上線前
  const s = E.gameStats(D(2));
  assert.equal(s.onTime, 0); assert.equal(s.xp, 0); assert.equal(s.level, 1); assert.equal(s.stage, 'seed');
  assert.deepEqual(s.badges, []);
  E.setItems([]);
  assert.equal(E.gameStats('2026-09-01').stage, 'seed', '今天早於上線日也不會炸');
});

test('gameStats：週末沒安排不斷火焰；一件沒按時就斷', () => {
  // 週四、週五完美，週六日沒安排，週一完美 → 連續 3
  const thu = EPOCH, fri = D(1), mon = D(4);
  E.setItems([single(thu, ms(thu, 9)), single(fri, ms(fri, 9)), single(mon, ms(mon, 9))]);
  assert.equal(E.gameStats(mon).streak.current, 3);
  // 週五那件隔天才勾 → 週五 missed → 到週一只有 1
  E.setItems([single(thu, ms(thu, 9)), single(fri, ms(D(2), 10)), single(mon, ms(mon, 9))]);
  assert.equal(E.gameStats(mon).streak.current, 1);
  assert.equal(E.gameStats(mon).streak.best, 1);
});

test('gameStats：循環項目的每一次各自看 doneAt[occKey]；略過的那一次不算安排', () => {
  const it = { id: 'w', title: '週報', type: 'work', parentId: null, date: EPOCH,
    recurrence: { freq: 'weekly', days: [4], interval: 1 }, done: false, doneMap: {}, doneAt: {}, overrides: {}, skipped: {} };
  const k1 = 'W' + EPOCH, k2 = 'W' + D(7);
  it.doneMap[k1] = true; it.doneAt[k1] = ms(EPOCH, 10);
  it.doneMap[k2] = true; it.doneAt[k2] = ms(D(8), 10);   // 隔天才勾
  E.setItems([it]);
  const s = E.gameStats(D(8));
  assert.equal(s.onTime, 1);
  assert.deepEqual(s.streak, { current: 0, best: 1, todayPerfect: false });
  it.skipped[k2] = true;                                    // 略過那一次：那天變 empty
  assert.equal(E.gameStats(D(8)).streak.current, 1);
});

test('setOccurrenceDone 寫時間戳、取消就拿掉', () => {
  const it = single(EPOCH, null);
  const occ = { item: it, occKey: 'single', date: EPOCH };
  E.setOccurrenceDone(occ, true);
  assert.ok(Number.isFinite(it.doneAt.single) && it.doneAt.single > 0);
  E.setOccurrenceDone(occ, false);
  assert.equal('single' in it.doneAt, false);
});

// ---------------------------------------------------------------- 純告知（B）
//
// 純告知的項目對遊戲化**完全隱形**：那天只有純告知就等於沒安排（empty），
// 而 empty「不斷也不加」。這一組守的是兩個方向——
//
//   · 少算：純告知被算進去，沒勾它的那天就變成 missed，連續會被一件不用做的事弄斷
//   · 多算：純告知的那一天被當成 perfect，連續憑空多一天
//
// 兩者在畫面上都看不出來：火焰的數字沒有人記得昨天是幾。

test('純告知不算安排：那天只有它＝empty，連續不斷也不加', () => {
  const notice = single(D(1), null, { noticeOnly: true });
  // 第 0 天按時做完一件，第 1 天只有一件純告知，第 2 天又按時做完一件
  E.setItems([single(EPOCH, ms(EPOCH, 9)), notice, single(D(2), ms(D(2), 9))]);
  const s = E.gameStats(D(2));
  // empty 是「不斷**也不加**」：兩個 perfect 中間夾一天 empty ⇒ current = 2
  assert.equal(s.streak.current, 2, '中間那天是 empty，跳過而不是斷掉');
  assert.equal(s.onTime, 2, '純告知不會被算成一次「按時完成」');
  assert.equal(s.perfectDays, 2, 'empty 不是 perfect——連續不會憑空多一天');

  // 反向：把同一件事改成不是純告知，那天就變成沒做完的 missed，連續當場斷掉。
  // 這一條是上面那一條的意義所在——沒有它，「current 就是 2」也可能只是巧合。
  delete notice.noticeOnly;   // single() 回的是 item 本身，旗標就掛在它上面
  assert.equal(E.gameStats(D(2)).streak.current, 1, '算進去的話中間那天會 missed');
});

test('純告知與真的待辦在同一天：只看真的那一件', () => {
  const day = D(1);
  E.setItems([single(day, null, { noticeOnly: true }), single(day, ms(day, 9))]);
  assert.equal(E.gameStats(day).todayVerdict, 'perfect', '真的那件做完了就是 perfect');

  E.setItems([single(day, null, { noticeOnly: true }), single(day, null)]);
  assert.equal(E.gameStats(day).todayVerdict, 'missed', '真的那件沒做完就是 missed');
});

test('isActionable 只看 noticeOnly 這一個旗標', () => {
  assert.equal(E.isActionable({ item: { noticeOnly: true } }), false);
  assert.equal(E.isActionable({ item: { noticeOnly: false } }), true);
  assert.equal(E.isActionable({ item: {} }), true, '沒有這個欄位的舊資料一律算數');
});
