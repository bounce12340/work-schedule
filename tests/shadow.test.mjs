/**
 * 頂層輔助函式不可被內層的區域變數或參數遮蔽。
 *
 * 為什麼需要這個測試
 * ---------------------------------------------------------------------------
 * 三個 HTML 的 JS 都包在 `(function(){ … })()` 內，所有輔助函式都是那個 scope
 * 的頂層綁定。在更內層用同名的區域變數（`const tr = document.createElement('div')`）
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
 * 涵蓋的遮蔽寫法
 * ---------------------------------------------------------------------------
 * `const`／`let`／`var`（含物件與陣列解構）、巢狀 `function` 宣告、一般函式的
 * 參數、箭頭函式的參數（含巢狀括號與解構）、`catch` 的參數。
 *
 * **已知不涵蓋**：物件的 method shorthand（`{ foo(tr){} }`）。這份程式碼沒有用
 * 這種寫法，硬加會為了幾乎不存在的情境引入誤報的風險——而會誤報的測試很快就
 * 沒有人理它。
 *
 * 只管**函式**被遮蔽
 * ---------------------------------------------------------------------------
 * 頂層的資料變數（`items`、`shares` 等）被內層同名變數遮蔽是另一回事：失敗模式
 * 是安靜的錯值而不是 TypeError，而且有些是刻意的——`threeWayMerge()` 內的
 * `items` 與同段的 `gantt`／`majors`／`logs` 對稱，那個純函式本來就不該碰到全域
 * 的 `items`。把兩者混在一起會讓這個測試充滿必須逐一豁免的條目。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILES = ['index.html', 'login.html', 'admin.html'];

/**
 * 每個字元位置對應的大括號深度；字串／樣板／註解／正規表示式字面值維持 -1。
 * 需要深度才能分辨「頂層宣告」與「內層宣告」，光靠縮排並不可靠；而標出
 * 非程式碼區域才不會把字串裡的 `function(` 當成真的宣告。
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
        if (s[i] === '$' && s[i + 1] === '{') {          // ${…} 裡面是程式碼，照常計深度
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

/** 把參數列或解構樣式的文字拆成「被綁定的識別名」 */
function bindingNames(text) {
  const out = [];
  const parts = [];
  let buf = '', depth = 0;
  for (const ch of text) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  parts.push(buf);

  for (let part of parts) {
    part = part.trim().replace(/^\.\.\./, '').trim();
    if (!part) continue;
    // 預設值：`a = 1` 綁的是 a；等號右邊是運算式，不是綁定
    let depth2 = 0, cut = -1;
    for (let i = 0; i < part.length; i++) {
      const ch = part[i];
      if ('([{'.includes(ch)) depth2++;
      else if (')]}'.includes(ch)) depth2--;
      else if (ch === '=' && depth2 === 0 && part[i + 1] !== '>' && part[i - 1] !== '=' && part[i - 1] !== '!'
               && part[i - 1] !== '<' && part[i - 1] !== '>') { cut = i; break; }
    }
    if (cut >= 0) part = part.slice(0, cut).trim();
    if (!part) continue;

    if (part.startsWith('{') || part.startsWith('[')) {
      // 物件樣式的 `key: binding` 綁的是右邊；簡寫 `key` 綁的是 key 本身
      const inner = part.slice(1, -1);
      for (const sub of bindingNames(inner)) out.push(sub);
      continue;
    }
    if (part.includes(':')) { out.push(...bindingNames(part.slice(part.indexOf(':') + 1))); continue; }
    if (/^[A-Za-z_$][\w$]*$/.test(part)) out.push(part);
  }
  return out;
}

function analyze(fileName) {
  const html = readFileSync(new URL(`../public/${fileName}`, import.meta.url), 'utf8');
  const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => m[1]).reduce((a, b) => (b.length > a.length ? b : a));
  const DM = depthMap(src);
  const LINES = src.split('\n');
  const lineOf = idx => src.slice(0, idx).split('\n').length;
  const code = i => DM[i] !== -1;
  const TOP = 1;                             // IIFE 內容位於深度 1

  /** 從 open 位置的括號找到配對的收尾（跳過字串內的括號） */
  const matchFwd = (open, oc, cc) => {
    let n = 0;
    for (let i = open; i < src.length; i++) {
      if (!code(i)) continue;
      if (src[i] === oc) n++;
      else if (src[i] === cc && --n === 0) return i;
    }
    return -1;
  };
  const matchBack = (close, oc, cc) => {
    let n = 0;
    for (let i = close; i >= 0; i--) {
      if (!code(i)) continue;
      if (src[i] === cc) n++;
      else if (src[i] === oc && --n === 0) return i;
    }
    return -1;
  };

  // ---- 頂層的函式綁定：`function f(){}` 與 `const f = … =>` / `= function` ----
  const fns = new Map();
  const topRe = /\b(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n;]*))/g;
  for (let m; (m = topRe.exec(src));) {
    if (DM[m.index] !== TOP) continue;
    const name = m[1] || m[2];
    if (m[1]) { if (!fns.has(name)) fns.set(name, lineOf(m.index)); continue; }
    const rhs = (m[3] || '').trim();
    if ((/^async\b/.test(rhs) || /^function\b/.test(rhs) ||
         /^\([^()]*\)\s*=>/.test(rhs) || /^[A-Za-z_$][\w$]*\s*=>/.test(rhs)) && !fns.has(name)) {
      fns.set(name, lineOf(m.index));
    }
  }

  // ---- 所有更內層、與頂層函式同名的綁定 ----
  const hits = [];
  const add = (idx, name, how) => {
    if (!fns.has(name)) return;
    const line = lineOf(idx);
    hits.push(`  ${fileName}:${line}  ${name}  （${how}）  ← 頂層函式定義在第 ${fns.get(name)} 行\n` +
              `      ${LINES[line - 1].trim().slice(0, 96)}`);
  };

  // 變數宣告，含解構
  const varRe = /\b(?:const|let|var)\s*(?=[A-Za-z_$[{])/g;
  for (let m; (m = varRe.exec(src));) {
    if (!code(m.index) || DM[m.index] <= TOP) continue;
    const rest = src.slice(m.index + m[0].length);
    const first = rest[0];
    if (first === '{' || first === '[') {
      const open = m.index + m[0].length;
      const close = matchFwd(open, first, first === '{' ? '}' : ']');
      if (close < 0) continue;
      for (const n of bindingNames(src.slice(open + 1, close))) add(m.index, n, '解構宣告');
    } else {
      const id = (rest.match(/^[A-Za-z_$][\w$]*/) || [])[0];
      if (id) add(m.index, id, '區域變數');
    }
  }

  // 巢狀的 function 宣告
  const fnDeclRe = /\bfunction\s+([A-Za-z_$][\w$]*)/g;
  for (let m; (m = fnDeclRe.exec(src));) {
    if (!code(m.index) || DM[m.index] <= TOP) continue;
    add(m.index, m[1], '巢狀函式宣告');
  }

  // 一般函式的參數（含匿名 function(){}）
  const fnParamRe = /\bfunction\b\s*(?:[A-Za-z_$][\w$]*)?\s*\(/g;
  for (let m; (m = fnParamRe.exec(src));) {
    if (!code(m.index)) continue;
    const open = src.indexOf('(', m.index + 8);
    const close = matchFwd(open, '(', ')');
    if (close < 0) continue;
    for (const n of bindingNames(src.slice(open + 1, close))) add(m.index, n, '函式參數');
  }

  // catch 的參數
  const catchRe = /\bcatch\s*\(/g;
  for (let m; (m = catchRe.exec(src));) {
    if (!code(m.index)) continue;
    const open = src.indexOf('(', m.index);
    const close = matchFwd(open, '(', ')');
    if (close < 0) continue;
    for (const n of bindingNames(src.slice(open + 1, close))) add(m.index, n, 'catch 參數');
  }

  // 箭頭函式的參數（往回配對括號，所以巢狀括號與解構都算得到）
  for (let i = 0; i < src.length - 1; i++) {
    if (!code(i) || src[i] !== '=' || src[i + 1] !== '>') continue;
    let j = i - 1;
    while (j >= 0 && (!code(j) || /\s/.test(src[j]))) j--;
    if (j < 0) continue;
    if (src[j] === ')') {
      const open = matchBack(j, '(', ')');
      if (open < 0) continue;
      for (const n of bindingNames(src.slice(open + 1, j))) add(i, n, '箭頭參數');
    } else {
      let k = j;
      while (k >= 0 && /[\w$]/.test(src[k])) k--;
      const id = src.slice(k + 1, j + 1);
      if (/^[A-Za-z_$][\w$]*$/.test(id)) add(i, id, '箭頭參數');
    }
  }

  return { fns, hits };
}

const RESULT = new Map(FILES.map(f => [f, analyze(f)]));

test('解析本身有效（頂層函式真的抓得到）', () => {
  // 抓不到任何頂層函式時，下面的檢查會空轉而永遠是綠的——那比沒有測試更糟
  for (const f of FILES) {
    assert.ok(RESULT.get(f).fns.size > 0, `${f} 一個頂層函式都沒抓到，解析大概壞了`);
  }
  const idx = RESULT.get('index.html').fns;
  assert.ok(idx.size > 50, `index.html 只抓到 ${idx.size} 個頂層函式，解析大概壞了`);
  for (const name of ['tr', 'tf', 'weekName', 'commit', 'renderAll']) {
    assert.ok(idx.has(name), `index.html 的頂層函式清單裡找不到 ${name}()，解析大概壞了`);
  }
});

for (const f of FILES) {
  test(`${f}：沒有東西遮蔽頂層的輔助函式`, () => {
    const { hits } = RESULT.get(f);
    assert.deepEqual(hits, [],
      `有東西遮蔽了頂層函式，那一段執行時會丟 "X is not a function"：\n${hits.join('\n')}\n` +
      '  （列元素請命名為 trow／rowEl／tickEl 之類，不要用函式的名字）');
  });
}
