/**
 * 內建國定假日清單的完整性。
 *
 * 為什麼需要這個測試
 * ---------------------------------------------------------------------------
 * `BUILTIN_HOLIDAYS` 是**手工貼進去的資料**：每年由 tools/parse-gov-calendar.py
 * 從人事行政總處的官方 xlsx 解析，再把輸出貼進 index.html。這條路徑上沒有任何
 * 東西會在貼錯時發出聲音——而錯誤的假日不會壞掉畫面，它只會讓「遇假日順延」
 * 算出**看似合理但錯誤的日期**。使用者不會發現，這正是最糟的失敗模式。
 *
 * 那支腳本本身已經對「檔案格式變了」很敏感（內建數個 assert）。這裡守的是它
 * 之後的那一段：解析出來到貼進原始碼之間。
 *
 * 為什麼「不能有週六日」是有效的檢查
 * ---------------------------------------------------------------------------
 * 腳本輸出的是**平日放假**——週六日本來就被 `isHoliday()` 當成假日，列進來完全
 * 多餘。所以清單裡出現週末只有兩種可能：貼到了不該貼的區塊，或解析出的月份
 * 整批位移。後者是已經發生過的真實 bug（十一月被讀成一月、十二月讀成二月），
 * 它產出的日期**全都合法**，只是完全錯誤——月份一移，約 2/7 的日期會落到週末。
 *
 * 這不是萬無一失的檢查（位移剛好全部避開週末是可能的），但它是這份資料唯一
 * 不必外連網路就驗得到的內在性質。真正的驗證仍然是「重跑腳本、比對輸出」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

/**
 * 從原始碼取出 BUILTIN_HOLIDAYS。
 *
 * 用求值而不是正規表示式逐條抓：要驗的是「實際跑的那份資料」，而不是我對它的
 * 格式的假設。抓不到就讓測試直接失敗——這份清單不見了本身就是必須被看見的事。
 */
function builtinHolidays() {
  const start = SRC.indexOf('const BUILTIN_HOLIDAYS = {');
  assert.notEqual(start, -1, 'index.html 裡找不到 BUILTIN_HOLIDAYS');
  const open = SRC.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.notEqual(end, -1, 'BUILTIN_HOLIDAYS 的大括號沒有閉合');
  return new Function('return ' + SRC.slice(open, end))();
}

const H = builtinHolidays();
const years = Object.keys(H);

test('至少涵蓋一個年度，且都是非空陣列', () => {
  assert.ok(years.length > 0, '清單是空的');
  for (const y of years) {
    assert.ok(Array.isArray(H[y]), `${y} 不是陣列`);
    assert.ok(H[y].length > 0, `${y} 是空的——沒有假日的年度不該列進來`);
  }
});

test('每個日期都是真實存在的日期', () => {
  for (const y of years) {
    for (const d of H[y]) {
      assert.match(d, /^\d{4}-\d{2}-\d{2}$/, `${y}：${d} 不是 YYYY-MM-DD`);
      // 用 UTC 還原再比對字串：Date 會把 2027-02-30 悄悄變成 3/2，
      // 只檢查格式抓不到這種「合法字串、不存在的日期」
      const back = new Date(d + 'T00:00:00Z').toISOString().slice(0, 10);
      assert.equal(back, d, `${y}：${d} 不是真實存在的日期`);
    }
  }
});

test('日期的年份要與它所屬的鍵一致', () => {
  for (const y of years) {
    for (const d of H[y]) {
      assert.equal(d.slice(0, 4), String(y), `${d} 被放進了 ${y} 年`);
    }
  }
});

test('沒有週六日——清單裡放的是「平日放假」', () => {
  for (const y of years) {
    for (const d of H[y]) {
      const dow = new Date(d + 'T00:00:00Z').getUTCDay();
      assert.ok(dow !== 0 && dow !== 6,
        `${d}（${'日一二三四五六'[dow]}）是週末。週末本來就是假日，列進來代表貼錯或解析位移`);
    }
  }
});

test('同一年內不重複，且已排序', () => {
  for (const y of years) {
    const list = H[y];
    assert.equal(new Set(list).size, list.length, `${y} 有重複的日期`);
    assert.deepEqual(list, [...list].sort(),
      `${y} 沒有排序——排序過才看得出來漏了哪一段`);
  }
});

test('年度數量合理，不會多到像是貼了整份月曆', () => {
  for (const y of years) {
    // 台灣的平日國定假日近年在 12～20 天之間（含補假）。這個範圍刻意寬鬆：
    // 它要抓的是「整批貼錯」那種數量級的錯誤，不是政策微調。
    assert.ok(H[y].length >= 8 && H[y].length <= 30,
      `${y} 有 ${H[y].length} 天平日假期，超出合理範圍——請確認貼上的是「平日放假」而不是整份月曆`);
  }
});
