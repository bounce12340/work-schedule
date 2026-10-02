/**
 * 專案的夥伴（〈專案的夥伴〉區段）：完成度、六階、白名單、名冊排序。
 * 設計文件 docs/superpowers/specs/2026-10-02-project-pet-and-mobile-scrollbar.md。
 *
 * 從 index.html 抽真正的原始碼求值（同 tests/game.test.mjs），不複製一份——
 * 複製一份出來測，測的是副本而不是實際跑的程式。
 *
 * 守的東西：
 *   - 完成度＝已完成任務數 ÷ 總任務數（使用者的裁決），沒有任務回 0 而不是 NaN
 *   - **adult 問的是「每一個任務都 done 了嗎」，不是比 >= 100**：四捨五入會讓
 *     199/200 印成 100%，而那一刻的差距正是這個功能的重點
 *   - 正規化的白名單：不認得的物種變 null（畫面上「空白」與「還沒選」長得一樣）
 *   - 舊存檔（沒有 pet 欄位）讀得回來，而且**不必升 STORAGE_VERSION**
 *   - petRoster 按完成度由高到低，沒選夥伴的不佔位置
 *   - 被分享者改不到 pet（直接打 Worker 端的 mergeSharedEdit）
 *
 * 突變驗證（加完測試做過，每一種各自確認會紅）：
 *   1. petStageOf 改成 `if(petCompletion(gp) >= 100) return 'adult'` → 1 紅（199/200 那條）
 *   2. petCompletion 沒有任務時回 NaN（拿掉 `if(!tasks.length) return 0`）→ 2 紅
 *   3. normalizeGanttProjects 的 pet 改成原樣留著（拿掉白名單）→ 2 紅
 *   4. petRoster 不排序 → 1 紅
 *   5. petRoster 不濾掉沒夥伴的 → 2 紅
 *   6. petAllDone 允許「零個任務也算全做完」→ 2 紅
 *   7. mergeSharedEdit 的甘特分支改成 `{ ...current, tasks, pet: incoming.pet }` → 1 紅
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

// 比對到區段名稱就好、不要求後面那串 `=`：〈持久化（單一儲存層）〉那一行的
// 收尾少一個空格，嚴格比對會找不到它（同 tests/absence.test.mjs 的作法）
function section(name) {
  const head = `  // ================= ${name}`;
  const start = HTML.indexOf(head);
  assert.notEqual(start, -1, `找不到區段「${name}」——區段註解是否被改名？`);
  const eol = HTML.indexOf('\n', start);
  const next = HTML.indexOf('  // ================= ', eol);
  assert.notEqual(next, -1, `區段「${name}」之後找不到下一個區段標記`);
  return HTML.slice(eol, next);
}

/**
 * 引擎本身零 DOM，但 normalizeGanttProjects 在〈持久化〉區段裡、而那一段要用
 * rtSanitize（富文字）與 todoProgress。三個區段一起裝進去，與 absence.test.mjs
 * 同一個作法。DOMParser 只有瀏覽器有，所以 rtSanitize 走不到的那條路由
 * tools/verify-richtext.mjs 在真瀏覽器裡顧，這裡只需要它不丟例外。
 */
function makeEngine() {
  const build = new Function(`
    // STORAGE_VERSION 與這幾個狀態變數都由〈持久化（單一儲存層）〉自己宣告，
    // 在這裡再宣告一次會是 "Identifier has already been declared"
    ${section('富文字')}
    ${section('持久化（單一儲存層）')}
    ${section('專案的夥伴')}
    return { PET_SPECIES, PET_IDS, PET_STAGES, petSpecies, petCompletion, petAllDone,
             petStageOf, petStageIndex, petRoster, normalizeGanttProjects };
  `);
  return build();
}

const E = makeEngine();

/** n 個任務，前 doneN 個做完 */
function proj(n, doneN, extra = {}) {
  return {
    id: 'gp1', name: '專案', notes: '',
    tasks: Array.from({ length: n }, (_, i) => ({
      id: 't' + i, name: '任務' + i, start: '2026-10-01', end: '2026-10-05',
      progress: i < doneN ? 100 : 0, done: i < doneN, todos: []
    })),
    ...extra
  };
}

// ---------------------------------------------------------------- 完成度

test('完成度＝已完成任務數 ÷ 總任務數', () => {
  assert.equal(E.petCompletion(proj(4, 0)), 0);
  assert.equal(E.petCompletion(proj(4, 1)), 25);
  assert.equal(E.petCompletion(proj(4, 2)), 50);
  assert.equal(E.petCompletion(proj(4, 4)), 100);
  assert.equal(E.petCompletion(proj(3, 1)), 33);
});

test('沒有任務回 0 而不是 NaN', () => {
  // NaN 會讓後面每一個比較變成 false，動物永遠停在幼體，而且沒有人知道為什麼
  assert.equal(E.petCompletion(proj(0, 0)), 0);
  assert.equal(E.petCompletion({ tasks: null }), 0);
  assert.equal(E.petCompletion(undefined), 0);
  assert.equal(E.petStageOf(proj(0, 0)), 'baby');
});

// ---------------------------------------------------------------- 六階

test('六階的門檻', () => {
  assert.equal(E.petStageOf(proj(100, 0)), 'baby');     // 0%
  assert.equal(E.petStageOf(proj(100, 1)), 'small');    // 1%
  assert.equal(E.petStageOf(proj(100, 24)), 'small');   // 24%
  assert.equal(E.petStageOf(proj(100, 25)), 'half');    // 25%
  assert.equal(E.petStageOf(proj(100, 49)), 'half');
  assert.equal(E.petStageOf(proj(100, 50)), 'big');
  assert.equal(E.petStageOf(proj(100, 74)), 'big');
  assert.equal(E.petStageOf(proj(100, 75)), 'almost');
  assert.equal(E.petStageOf(proj(100, 99)), 'almost');
  assert.equal(E.petStageOf(proj(100, 100)), 'adult');
});

test('adult 問的是「每一個任務都 done 了嗎」，不是比 >= 100', () => {
  // 199/200 ＝ 99.5% → Math.round 印成 100%。比數字的話這一隻會提早成年，
  // 而「100% 才是成年」是這個功能的全部重點
  const almost = proj(200, 199);
  assert.equal(E.petCompletion(almost), 100, 'Math.round 確實會把它印成 100');
  assert.equal(E.petStageOf(almost), 'almost', '但它還沒成年');
  assert.equal(E.petAllDone(almost), false);

  const full = proj(200, 200);
  assert.equal(E.petStageOf(full), 'adult');
  assert.equal(E.petAllDone(full), true);
});

test('零個任務不算「全做完」', () => {
  // every() 對空陣列回 true——沒有 length > 0 的守衛，一個空專案會直接成年
  assert.equal(E.petAllDone(proj(0, 0)), false);
  assert.equal(E.petStageOf(proj(0, 0)), 'baby');
});

test('階段的序數：baby 是 0，adult 是最後一個', () => {
  assert.equal(E.petStageIndex('baby'), 0);
  assert.equal(E.petStageIndex('adult'), E.PET_STAGES.length);
  assert.equal(E.petStageIndex('不認得的階段'), 0, '不認得就當幼體，不要回 -1 讓畫皮算出負數');
});

// ---------------------------------------------------------------- 物種與白名單

test('八種夥伴，id 不重複，動物與植物都有', () => {
  assert.equal(E.PET_SPECIES.length, 8);
  assert.equal(new Set(E.PET_IDS).size, 8);
  assert.ok(E.PET_SPECIES.some(s => s.plant), '要有植物');
  assert.ok(E.PET_SPECIES.some(s => !s.plant), '要有動物');
  // 使用者點名的三隻與兩種樹都要在
  ['deer', 'bird', 'rabbit', 'fir', 'pine'].forEach(id =>
    assert.ok(E.PET_IDS.includes(id), id + ' 應該在清單裡'));
});

test('petSpecies 是白名單：不認得的一律 null', () => {
  assert.equal(E.petSpecies('deer').adult, '公鹿');
  assert.equal(E.petSpecies('dragon'), null);
  assert.equal(E.petSpecies(''), null);
  assert.equal(E.petSpecies(null), null);
  assert.equal(E.petSpecies(undefined), null);
});

test('normalizeGanttProjects 把不認得的物種剪成 null', () => {
  // 值會拿去查畫圖的函式表，不認得的字串在畫面上是「那一格空白」，
  // 而空白與「還沒選」長得一模一樣
  const out = E.normalizeGanttProjects([
    proj(1, 0, { id: 'a', pet: 'deer' }),
    proj(1, 0, { id: 'b', pet: 'dragon' }),
    proj(1, 0, { id: 'c', pet: 123 }),
    proj(1, 0, { id: 'd' }),                 // 舊存檔：根本沒有這個欄位
  ]);
  assert.equal(out[0].pet, 'deer');
  assert.equal(out[1].pet, null);
  assert.equal(out[2].pet, null);
  assert.equal(out[3].pet, null, '舊存檔沒有 pet 就是 null，不是 undefined');
});

test('舊存檔讀得回來，而且形狀與新建的一致', () => {
  // 不必升 STORAGE_VERSION 的根據：判準是「舊存檔在新程式碼底下讀起來會不會錯」。
  // 這裡讀起來不會錯——少一個可選欄位，正規化補上就對了。
  const old = E.normalizeGanttProjects([proj(2, 1, { id: 'x' })])[0];
  assert.ok('pet' in old, 'pet 這個 key 要存在，否則 stableStringify 比對時兩邊欄位集不同');
  assert.equal(old.pet, null);
  assert.equal(old.tasks.length, 2, '其餘欄位一個都沒少');
});

// ---------------------------------------------------------------- 名冊

test('petRoster 按完成度由高到低，沒選夥伴的不佔位置', () => {
  const list = [
    proj(4, 1, { id: 'a', name: '低', pet: 'deer' }),     // 25%
    proj(4, 3, { id: 'b', name: '高', pet: 'cat' }),      // 75%
    proj(4, 2, { id: 'c', name: '沒夥伴', pet: null }),   // 50% 但不該出現
    proj(4, 2, { id: 'd', name: '中', pet: 'fir' }),      // 50%
  ];
  const r = E.petRoster(list);
  assert.deepEqual(r.map(x => x.id), ['b', 'd', 'a']);
  assert.deepEqual(r.map(x => x.pct), [75, 50, 25]);
  assert.ok(!r.some(x => x.id === 'c'), '沒選夥伴的專案不進名冊');
});

test('petRoster 也濾掉物種不認得的（存檔被改壞）', () => {
  const r = E.petRoster([proj(1, 0, { id: 'a', pet: 'dragon' })]);
  assert.equal(r.length, 0);
});

test('petRoster 帶著現在那一階，不是長大後的樣子', () => {
  const r = E.petRoster([proj(2, 2, { id: 'a', pet: 'deer' }), proj(2, 0, { id: 'b', pet: 'cat' })]);
  assert.equal(r[0].stage, 'adult');
  assert.equal(r[1].stage, 'baby');
});

test('petRoster 收到不是陣列的東西不丟例外', () => {
  assert.deepEqual(E.petRoster(null), []);
  assert.deepEqual(E.petRoster(undefined), []);
});

// ---------------------------------------------------------------- 被分享者改不到 pet

test('被分享者改不到 pet（路徑本身走不到，但要有東西守著）', async () => {
  // mergeSharedEdit 的甘特分支回 `{ ...current, tasks }`——pet 來自擁有者那一側。
  // 這不是靠權限判斷擋住，是路徑走不到；但沒有這條測試，哪天有人「順手」把
  // pet 加進那個展開式就沒有東西會紅（同 listSessions 的 WHERE user_id = ?）。
  const mod = await import('../src/handlers/share.js');
  const merge = mod.__testMergeSharedEdit;
  assert.equal(typeof merge, 'function',
    'share.js 要把 mergeSharedEdit 匯出給測試用（__testMergeSharedEdit）');

  const owner = { id: 'gp1', name: '我的專案', pet: 'deer', notes: '祕密',
    tasks: [{ id: 't1', name: 'a', start: '2026-10-01', end: '2026-10-02', progress: 0, done: false, todos: [] }] };
  const fromSharee = { id: 'gp1', name: '被改掉的名字', pet: 'dragon', notes: '',
    tasks: [{ id: 't1', done: true, progress: 100, todos: [] }] };

  const out = merge('gantt', owner, fromSharee);
  assert.equal(out.pet, 'deer', '夥伴是擁有者的決定，被分享者改不到');
  assert.equal(out.name, '我的專案', '名稱也一樣改不到');
  assert.equal(out.notes, '祕密');
  assert.equal(out.tasks[0].done, true, '但勾選要生效——那是被授權的');
});

test('被分享者勾完任務，擁有者的動物就長大了（免費得到的性質）', async () => {
  const mod = await import('../src/handlers/share.js');
  const merge = mod.__testMergeSharedEdit;
  const owner = proj(2, 0, { id: 'gp1', pet: 'deer' });
  assert.equal(E.petStageOf(owner), 'baby');

  const after = merge('gantt', owner, {
    id: 'gp1',
    tasks: owner.tasks.map(t => ({ id: t.id, done: true, progress: 100, todos: [] }))
  });
  // 階段是算出來的，所以這條不必寫任何程式碼——但要有測試證明它真的成立
  assert.equal(E.petStageOf(after), 'adult');
  assert.equal(after.pet, 'deer');
});
