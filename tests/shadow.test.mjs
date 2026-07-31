/**
 * 頂層輔助函式不可被內層的區域變數或參數遮蔽。
 *
 * 為什麼需要這個測試
 * ---------------------------------------------------------------------------
 * `public/index.html` 的 JS 全部包在一個 IIFE 內，所有輔助函式都是那個 scope 的
 * 頂層綁定。在更內層用同名的區域變數（`const tr = document.createElement('div')`）
 * 是**合法的 JS**，所以：
 *
 *   - `node --check` 過（它只驗語法）
 *   - 其餘測試過（都不碰前端整合）
 *   - 後端與 D1 完全無關
 *
 * 而執行時那一整段 render 會丟 `X is not a function` 並整塊消失。這個 bug class
 * 已經發生兩次，兩次都是靠使用者回報「某個區塊不見了」才發現：
 *
 *   1. `gp.tasks.forEach(t => …)` 遮蔽當時叫 `t()` 的翻譯函式（全域因此改名 `tr()`）
 *   2. `const tr = document.createElement('div')`（代辦項目的列）遮蔽 `tr()`
 *      → 甘特頁的任務表整段沒有渲染
 *
 * 詳見 docs/postmortems/2026-07-31-gantt-todos-missing.md。
 *
 * 這個測試只管**函式**被遮蔽。頂層的資料變數（`items`、`shares` 等）被純函式
 * 內的同名區域變數遮蔽是另一回事：失敗模式是安靜的錯值而不是 TypeError，
 * 而且有些是刻意的（`threeWayMerge` 內的 `items` 與 `gantt`／`majors`／`logs`
 * 對稱，那個函式本來就不該碰到全域的 `items`）。把兩者混在一起會讓這個測試
 * 充滿必須逐一豁免的例外，很快就沒有人理它。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const SRC = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(m => m[1])
  .reduce((a, b) => (b.length > a.length ? b : a));

/**
 * 每個字元位置對應的大括號深度；字串／樣板／註解／正規表示式字面值標成 -1。
 * 需要深度才能分辨「頂層宣告」與「內層宣告」，光靠縮排並不可靠。
 */
function depthMap(s) {
  const d = new Int32Array(s.length).fill(-1);
  let depth = 0, i = 0;
  const prevSig = k => { for (let j = k - 1; j >= 0; j--) if (!/\s/.test(s[j])) return s[j]; return ''; };
  while (i < s.length) {
    const c = s[i], c2 = s[i + 1];
    if (c === '/' && c2 === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'") {
      const q = c; i++;
      while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (c === '`') {
      i++;
      while (i < s.length && s[i] !== '`') {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === '$' && s[i + 1] === '{') {        // ${…} 裡面是程式碼，照常計深度
          i += 2;
          let n = 1;
          while (i < s.length && n > 0) { if (s[i] === '{') n++; else if (s[i] === '}') n--; i++; }
          continue;
        }
        i++;
      }
      i++; continue;
    }
    // 前一個有意義的字元決定 `/` 是除法還是 regex 開頭
    if (c === '/' && !'})]'.includes(prevSig(i)) && !/[\w$]/.test(prevSig(i))) {
      i++;
      let inClass = false;
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === '[') inClass = true;
        else if (s[i] === ']') inClass = false;
        else if (s[i] === '/' && !inClass) break;
        else if (s[i] === '\n') break;
        i++;
      }
      i++; continue;
    }
    if (c === '{') { d[i] = depth++; i++; continue; }
    if (c === '}') { d[i] = --depth; i++; continue; }
    d[i] = depth; i++;
  }
  return d;
}

const DM = depthMap(SRC);
const LINES = SRC.split('\n');
const lineOf = idx => SRC.slice(0, idx).split('\n').length;
const TOP = 1;                              // IIFE 內容位於深度 1

/** IIFE 頂層的函式綁定：`function f(){}` 與 `const f = … =>` / `= function` */
function topLevelFunctions() {
  const found = new Map();
  const re = /\b(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n;]*))/g;
  for (let m; (m = re.exec(SRC));) {
    if (DM[m.index] !== TOP) continue;
    const name = m[1] || m[2];
    if (m[1]) { if (!found.has(name)) found.set(name, lineOf(m.index)); continue; }
    const rhs = (m[3] || '').trim();
    const looksLikeFn =
      /^async\b/.test(rhs) || /^function\b/.test(rhs) ||
      /^\([^()]*\)\s*=>/.test(rhs) || /^[A-Za-z_$][\w$]*\s*=>/.test(rhs);
    if (looksLikeFn && !found.has(name)) found.set(name, lineOf(m.index));
  }
  return found;
}

const FNS = topLevelFunctions();

test('IIFE 頂層確實有一批輔助函式可以被遮蔽（測試本身沒有失效）', () => {
  // 抓不到任何頂層函式時，下面兩個測試會空轉而永遠是綠的——那比沒有測試更糟
  assert.ok(FNS.size > 50, `只抓到 ${FNS.size} 個頂層函式，解析大概壞了`);
  for (const name of ['tr', 'tf', 'weekName', 'commit', 'renderAll']) {
    assert.ok(FNS.has(name), `頂層函式清單裡找不到 ${name}()，解析大概壞了`);
  }
});

test('沒有區域變數遮蔽頂層的輔助函式', () => {
  const hits = [];
  const re = /\b(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))/g;
  for (let m; (m = re.exec(SRC));) {
    if (DM[m.index] <= TOP) continue;
    const name = m[1] || m[2];
    if (!FNS.has(name)) continue;
    const line = lineOf(m.index);
    hits.push(`  L${line}  ${name}  ← 頂層函式定義在 L${FNS.get(name)}\n      ${LINES[line - 1].trim().slice(0, 96)}`);
  }
  assert.deepEqual(hits, [],
    '有區域變數遮蔽了頂層函式，那一段 render 執行時會丟 "X is not a function"：\n' +
    hits.join('\n') + '\n  （列元素請命名為 trow／rowEl／tickEl 之類，不要用函式的名字）');
});

test('沒有函式參數遮蔽頂層的輔助函式', () => {
  const hits = [];
  // 只認單一識別名與不含巢狀括號的參數列，寧可漏也不要誤報
  const re = /(?:\(([^()]{0,160})\)|([A-Za-z_$][\w$]*))\s*=>/g;
  for (let m; (m = re.exec(SRC));) {
    if (DM[m.index] === -1) continue;
    const raw = m[1] !== undefined ? m[1] : m[2];
    for (const part of raw.split(',')) {
      const name = part.trim().replace(/^\.\.\./, '').replace(/[=:].*$/, '').trim();
      if (!FNS.has(name)) continue;
      const line = lineOf(m.index);
      hits.push(`  L${line}  ${name}  ← 頂層函式定義在 L${FNS.get(name)}\n      ${LINES[line - 1].trim().slice(0, 96)}`);
    }
  }
  assert.deepEqual(hits, [],
    '有箭頭函式的參數遮蔽了頂層函式（第一次的 t() 就是這樣壞的）：\n' + hits.join('\n'));
});
