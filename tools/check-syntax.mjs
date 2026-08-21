/**
 * 前端的 inline `<script>` 語法檢查。
 *
 * 為什麼需要這支
 * ---------------------------------------------------------------------------
 * CLAUDE.md 的〈驗證方式〉第 2 條寫著「抽出 <script> 內容後 node --check」，
 * 但那一直是一句**請你記得做**的話，沒有對應的工具——而 `npm test` 抽的是
 * 特定區段（occurrence 引擎、富文字）求值，語法壞在別的地方它一樣是綠的。
 *
 * 這支把那條規則變成跑得起來的指令：三個 HTML 的每一段 inline script 都編譯
 * 一次，語法錯誤就紅，並指出**HTML 檔的實際行號**（不是 script 內的相對行號，
 * 那個對不上編輯器裡看到的位置，找起來很痛苦）。
 *
 * 只驗語法，不執行
 * ---------------------------------------------------------------------------
 * 用 `vm.Script` 編譯而不 `runInNewContext`：編譯會丟 SyntaxError，執行則需要
 * DOM 與 localStorage，那是 tools/smoke.mjs 的工作。兩者的分工是刻意的——這支
 * 零相依、跑不到一秒，適合擋在每一次 commit 前面。
 *
 * 抓不到的東西要知道
 * ---------------------------------------------------------------------------
 * 遮蔽（tests/shadow.test.mjs）、函式沒定義、render 路徑丟例外（tools/smoke.mjs）
 * 全部是合法語法，這支一律放行。它只負責「檔案還是不是合法的 JS」這一件事。
 *
 *     node tools/check-syntax.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const FILES = ['index.html', 'login.html', 'admin.html', 'sw.js'];
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));

/**
 * 取出所有 inline `<script>` 區塊，連同它在檔案裡的起始行號。
 * 帶 `src` 的略過（那是外部檔案，內容不在這裡）；`type` 若不是 JavaScript
 * 也略過，避免把 JSON-LD 之類的東西當成程式碼編譯。
 */
function inlineScripts(html) {
  const out = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i);
    if (type && !/^(text\/javascript|application\/javascript|module)$/i.test(type[1])) continue;

    // 行號從 1 起算：<script> 標籤之前有幾個換行，內容就從第幾行的下一行開始
    const before = html.slice(0, m.index + m[0].indexOf('>') + 1);
    out.push({
      code: m[2],
      line: before.split('\n').length,
      isModule: !!(type && /^module$/i.test(type[1])),
    });
  }
  return out;
}

let checked = 0;
let failed = 0;

for (const name of FILES) {
  const path = PUBLIC + name;
  const raw = readFileSync(path, 'utf8');

  // sw.js 本身就是 JS，不是 HTML——直接整份當一段
  const blocks = name.endsWith('.js')
    ? [{ code: raw, line: 0, isModule: false }]
    : inlineScripts(raw);

  if (!blocks.length) {
    console.error(`✗ ${name}：找不到任何 inline script——選擇器壞了還是檔案改了？`);
    failed++;
    continue;
  }

  for (const b of blocks) {
    checked++;
    try {
      // lineOffset 讓錯誤訊息報的是 HTML 的行號，直接貼進編輯器就能跳過去
      new Script(b.code, { filename: `public/${name}`, lineOffset: b.line });
    } catch (e) {
      failed++;
      console.error(`✗ public/${name}（第 ${b.line} 行起的 script）：${e.message}`);
      const where = String(e.stack || '').split('\n').slice(0, 3).join('\n');
      console.error(where);
    }
  }
}

if (failed) {
  console.error(`\n✗ ${checked} 段 script 中有 ${failed} 段語法有問題`);
  process.exit(1);
}
console.log(`✓ ${FILES.length} 個檔案、${checked} 段 inline script 語法皆正確`);
