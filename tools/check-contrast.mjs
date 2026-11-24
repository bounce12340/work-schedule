/**
 * 文字對比度。
 *
 * 為什麼需要這支
 * ---------------------------------------------------------------------------
 * 改配色時最容易壞、而且**眼睛最看不出來**的就是對比度：在自己那台校色良好的
 * 螢幕上「看起來還行」的淺灰字，在別人的筆電、在陽光下的手機上就是讀不到。
 * 它不會拋錯、不會破版，沒有任何一支現有檢查會紅。
 *
 * 這個專案還多一層風險：亮色與暗色是**兩組各自獨立的變數**，改了一組忘了另一組
 * 的症狀正是「白天正常，暗色模式下某一塊變成看不見的低對比」（CLAUDE.md 記過）。
 * 所以這支兩種主題都量。
 *
 * 判準用 WCAG 2.1 的對比公式：一般內文 4.5:1、大字（>=18.66px 或 >=14px 粗體）
 * 3:1。**刻意只擋「正文級」的元素**——徽章、時間戳這類輔助資訊本來就該退到後面，
 * 用同一條線去要求它們只會逼人把整個介面調得死板。
 *
 * 依賴 Playwright，而 Playwright **不是**本專案的相依套件（零相依是專案前提），
 * 所以放在 tools/ 而不是 tests/。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { markSignedIn, skipBootScene } from './lib/signed-in.mjs';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('需要 Playwright，但它不是本專案的相依套件（零相依是專案前提）。');
  console.error('要跑這個驗證請先安裝：npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const PORT = Number(process.env.PORT || 8992);

const srv = createServer((q, r) => {
  const n = new URL(q.url, 'http://x').pathname.slice(1) || 'index.html';
  if (n.startsWith('api/')) { r.writeHead(404); r.end('{}'); return; }
  let b; try { b = readFileSync(PUBLIC + n); } catch { r.writeHead(404); r.end('x'); return; }
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  r.end(b);
});
srv.listen(PORT);

// 量哪些元素。刻意只列「要讀的字」，不列徽章與輔助資訊——理由見檔頭。
const TARGETS = [
  ['.brand-title', '系統標題'],
  ['.occ-title', '項目標題'],
  ['.occ-date', '日期'],
  ['.metric-list-row', '指標卡的列'],
  ['.nav-item', '頁籤'],
  // 原本寫的是 `.chip-name`——那個 class 從來不存在（名字是 .chip 底下第一個沒有 class
  // 的 span），所以這一條每次都印「略過」，等於沒有
  ['#majorChips .chip > span:first-child', '大項目名稱'],
  ['#majorChips .chip .cnt', '大項目的項數'],
  ['.qbtn', '篩選鈕'],
  ['.brand-eyebrow', '招呼語'],
  ['.daylog-label', '每日記錄標題'],
  ['.notice-badge', '純告知的小標'],
  // 六種小標原本全是「等寬＋字距 2px＋--text-dim」，2.57:1，而這份清單一個都沒有——
  // 那正是它們一直沒被發現的原因。其中四張卡的小標包括「逾期未完成」那一張
  ['.metric-label', '四張卡的小標'],
  ['.major-section-label', '「大項目」那一區的小標'],
  ['.period-label', '「年份」小標'],
  // --text-dim 的代表（它用在 40 處字色上，逐一造出來不實際；token 本身另外由 TOKEN_CHECK 量）
  ['footer.storage-note', 'footer 的說明（--text-dim）'],
  // 按鈕上的字與看板上的小徽章。上面那句「不列徽章」讓這幾個一直沒被量到，2026-10-13 外部的
  // 檢查工具（impeccable）一次抓到七個：白字壓在 --amber 上 3.1:1、循環徽章 2.7:1、
  // 手機上的時鐘 2.8:1……全部都是 #25 修過的那個 bug class（--amber 當淺底上的字）。
  ['.mode-tab.active', '選中的檢視頁籤（白字壓在強調底上）'],
  ['#openItemModal', '「＋ 新增小項目」按鈕'],
  ['.pill.pending b', '「未完成」的數字'],
  ['.pill.done b', '「已完成」的數字'],
  ['.recur-badge', '循環徽章'],
  ['.meeting-time', '會議時間'],
  ['.tag-chip', '標籤'],
  ['.sub-badge', '步驟數'],
  ['#nowTime', '時鐘'],
];

/**
 * 要按幾下才看得到的元素。
 *
 * 「不在」的按鈕帶了一個**新的顏色 token**（`--away`），而這支腳本存在的理由
 * 正是「新顏色在其中一個主題下靜靜地變成看不見」。它預設不在畫面上，所以
 * 不能只靠上面那份清單——不量等於這個 token 完全沒有被守到。
 */
const AFTER_CLICKS = [
  ['#btnToggleAway', '「不在」按鈕'],
  ['.cal-weekday', '日曆的星期列（--text-dim）'],
];

/**
 * 帳號頁的取消訂閱區。**新的一塊 UI，而且刻意做得比旁邊醒目**——
 * 正因為「醒目」是它的重點，讀不讀得清楚就不能靠感覺。
 *
 * 它預設不在畫面上（要先切到「我的帳號」），所以不能只靠 TARGETS——
 * 不量等於這一塊完全沒有被守到（同〈永遠不會執行的斷言〉）。
 */
const IN_ACCOUNT = [
  ['.acct-unsub .acct-sub', '取消訂閱的說明'],
  ['#btnUnsubAll', '「全部都不要了」按鈕'],
];

/**
 * 專案頁的夥伴卡，以及挑夥伴面板裡的說明文字。
 *
 * **新的 UI 不量等於沒守到**，而這兩處都要先切頁籤、面板那一個還要再按一下才
 * 看得到——正是〈「畫面上沒有這個元素，略過」是一條永遠不會執行的斷言〉要防的
 * 形狀。夥伴卡的底色是不透明的 `--panel-2`（刻意不半透明，否則光暈會透上來，
 * 而 bgOf 量到的就是那個最差情況）。
 */
const IN_GANTT = [
  ['.pet-card-name', '夥伴卡的階段名稱'],
  ['.pet-card-sub', '夥伴卡的進度文字'],
  ['.pet-card-adult', '「成年」那個記號'],
  ['.gantt-toolbar-label', '「時間刻度」小標'],
  ['.task-field-label', '任務列的「開始／結束／進度」'],
];
const IN_PET_PANEL = [
  ['#petOverlay .scope-note', '挑夥伴面板的說明'],
  ['#petGrid .pet-pick-cap', '每一格的「幼體 → 成年」'],
];

/**
 * 休假格子的日期。它用的是**新的顏色 token**（`--leave`），而且壓在一層玻璃紙上
 * （`.cal-cell.leave::before`）——那層不是任何元素的祖先，`bgOf()` 看不到它，
 * 量到的會是「沒有玻璃紙」的漂亮數字。解法同光暈（見 measure 裡的 leaveWorst）。
 *
 * **只量非今天的格子**：今天那一格的日期本來就是琥珀色（那是「今天在哪裡」的
 * 標記，與這層玻璃紙無關）。
 *
 * 格子裡的**項目文字**現在也量得到了（見 `IN_LEAVE_TODAY`）。先前量不了的理由是
 * `bgOf()` 遇到半透明的祖先會直接跳過——示範資料在這個月只有今天那一格有項目，
 * 而 `.cal-cell.today` 的背景 alpha 只有 0.09，於是量到的是光暈而不是實際底色
 * （1.5:1 的假紅燈）。那個盲點已經補掉：半透明的祖先現在會由外往內疊起來。
 */
const IN_LEAVE_CELL = [
  ['.cal-cell.leave:not(.today) .cal-daynum', '休假格子的日期'],
];

/**
 * 「休假格子裡的項目文字」量過了，**而且量出一個這支腳本修不掉的問題**，所以
 * 先不放進會讓 CI 變紅的清單——但數字要寫下來，不要變成一句「以後再說」。
 *
 * 量到的（亮色，今天＋休假那一格，底色合成後是 rgb(219,217,203)）：
 *
 *   · 還沒做的作業類項目  `--amber` #C9822E     **2.2:1**（需要 4.5:1）
 *   · 已完成的項目        `--text-dim` #A2A099  **1.84:1**
 *   · 換成 `--amber-ink` #8A5716 也只有         **4.29:1**——仍然不夠
 *   · 工作類的 `--teal` #1F8C68 在同一格是      **2.96:1**
 *
 * 這是〈顏色不只要好看，要量得出來〉那個 bug class 的第四次（頁籤、篩選鈕、
 * 空狀態之後），但這一次**換一個 token 解決不了**：`.cal-item-text` 的顏色
 * 就是型別的編碼（teal＝工作、amber＝作業、violet＝會議），把它們一起壓深到
 * 4.5:1 等於改掉整個日曆的顏色語言。那是產品決定，不是一支檢查腳本該順手做的
 * ——同 `--amber` 當初沒有被直接改掉、而是另開 `--amber-ink` 的理由。
 *
 * 要做的時候有三條路，都要先看過畫面：型別改用**形狀或圖示**而不是顏色、
 * 把每一種顏色各自做一個 `-ink` 版本、或是把格子裡的文字改成 `--text` 而讓
 * 顏色只留在左邊那顆點上。
 */

/**
 * 純告知（B）帶了一個**新的顏色 token**（`--notice`），而它的兩種狀態要分開量：
 *
 *   · `.notice-badge` 在示範資料裡本來就看得到（seed 有一件在兩天後）
 *   · `.notice-past` **要自己造**——示範那一件在未來，而「畫面上沒有這個元素，
 *     略過」是一條永遠不會執行的斷言（那一節抓到過兩個已經上線很久的問題）
 *
 * 過期的淡化**必須靠字級**，不是把顏色調到讀不了。所以這兩條量的就是「淡下去
 * 之後仍然讀得到」——量不過就表示淡化的方式選錯了。
 */
const NOTICE_PAST = [
  ['.occ-row.notice-past .occ-title', '過期純告知的標題'],
  ['.occ-row.notice-past .occ-date', '過期純告知的日期'],
];

/**
 * 空狀態原本掛在上面那份清單裡，但示範資料一定有項目，所以它每次都印
 * 「畫面上沒有這個元素，略過」——**一條永遠不會執行的斷言，與沒有這條一樣**，
 * 而且還會給出「已經量過了」的錯覺。空白時刻現在是這個介面刻意做柔的地方
 * （宋體、放鬆的行高），更不能靠運氣。所以改成主動把畫面逼成空的：
 * 搜尋一個不存在的字，篩選後的空狀態就會出現。
 */
const AFTER_SEARCH = [
  ['.empty-state', '空狀態'],
  ['.empty-state .empty-line2', '空狀態的第二行'],
  ['.empty-state span:not(.empty-line2)', '空狀態裡的強調字'],
];

/**
 * 在頁面裡量一份清單。兩份清單（一進頁面就在的、要按幾下才有的）共用同一套
 * 判準——分兩份寫遲早會分歧，而分歧的那一份會給出一個看起來很漂亮的假數字。
 */
const measure = sels => {
  // sRGB → 相對亮度（WCAG 2.1）
  const lum = ([r, g, b]) => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const parse = s => (s.match(/[\d.]+/g) || []).slice(0, 4).map(Number);
  const over = (top, base) => {           // top: [r,g,b,a] 疊在不透明的 base 上
    const a = top.length >= 4 ? top[3] : 1;
    return [0, 1, 2].map(i => Math.round(top[i] * a + base[i] * (1 - a)));
  };
  // 背景要往上找到第一個不透明的祖先——元素自己通常是 transparent，
  // 拿 transparent 去算對比會得到一個漂亮但完全假的數字。
  //
  // **半透明的祖先要疊起來，不能跳過。** 原本遇到 alpha ≤ 0.92 就直接略過、
  // 一路掉到 body，於是 `.cal-cell.today`（--today-bg 的 alpha 只有 0.09）裡面的字
  // 量到的是光暈而不是它實際壓在上面的顏色，數字低到 1.5:1——而畫面上讀得很清楚。
  // 那是工具的**假紅燈**，而假紅燈與假綠燈一樣糟：兩者都會讓人不再相信這一頁。
  //
  // 疊的順序是**由外往內**：最外面那一層先壓在不透明的底上，再一層層往內。
  // 反過來疊出來的顏色不對（alpha 不可交換）。
  const bgOf = (el, baseOverride) => {
    const layers = [];      // 由內往外收集，等一下反過來疊
    let base = null;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c.length < 3) continue;
      const a = c[3] === undefined ? 1 : c[3];
      if (a === 0) continue;                      // 完全透明：沒有貢獻
      if (a > 0.92) { base = c.slice(0, 3); break; }
      layers.push([c[0], c[1], c[2], a]);
    }
    if (base === null) {
      const c = parse(getComputedStyle(document.body).backgroundColor);
      base = baseOverride || (c.length >= 3 ? c.slice(0, 3) : [255, 255, 255]);
    }
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  };
  // 光暈畫在 body::before 上，不是任何元素的祖先，bgOf() 看不到它——所以直接
  // 坐在 body 上的字（招呼語、標題）量到的一直是 --bg，而不是它實際壓在上面的
  // 顏色。這裡改成算**最差情況**：把三團光暈各自以滿 alpha 疊在 --bg 上，取三者
  // 之中對比最低的那一個。任何位置的真實對比都不會比這個更差。
  const root = getComputedStyle(document.documentElement);
  const token = n => parse(root.getPropertyValue(n));
  const ratioOf = (fg, bg) => {
    const L1 = lum(fg), L2 = lum(bg);
    return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
  };
  // **光暈是最底下那一層，不是最上面那一層。** 它畫在 body::before 上，所以任何
  // 半透明的祖先（例如 `.nav-item.active` 的 --amber-dim）都疊在它**上面**。
  // 第一版把它當成疊在合成後的背景之上，算出來的顏色順序是反的——alpha 不可交換，
  // 那個數字看起來像個對比值，其實不對應畫面上任何一個位置。
  // 2026-10-03 起底圖不畫光暈了（回到 #25 之前的方格底）。所以先問 body::before
  // 真的有沒有畫漸層：沒有就不算——拿一團畫面上不存在的光暈去量，是假紅燈。
  // 哪天光暈回來，這一條自己就會重新生效。
  const haloDrawn = /radial-gradient/.test(getComputedStyle(document.body, '::before').backgroundImage || '');
  const haloWorst = (fg, el) => {
    if (!haloDrawn) return Infinity;
    const bodyBg = parse(getComputedStyle(document.body).backgroundColor).slice(0, 3);
    let worst = Infinity;
    for (const n of ['--halo-a', '--halo-b', '--halo-c']) {
      const h = token(n); if (h.length < 3) continue;
      worst = Math.min(worst, ratioOf(fg, bgOf(el, over(h, bodyBg))));
    }
    return worst;
  };
  // 休假的底色畫在 `.cal-cell.leave::before` 上——**同樣不是任何元素的祖先**，
  // 所以 bgOf() 對格子裡的字量到的是 --panel，不是它實際壓在上面的顏色。
  // 這與光暈是同一個盲點，用同一個解法：把 --leave-dim 疊上去再算一次，取較差的。
  const inLeaveCell = el => !!(el.closest && el.closest('.cal-cell.leave'));
  const leaveWorst = (fg, bg) => {
    const t = token('--leave-dim'); if (t.length < 3) return Infinity;
    const L1 = lum(fg), L2 = lum(over(t, bg));
    return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
  };
  const sitsOnBody = el => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c.length >= 3 && (c[3] === undefined || c[3] > 0.92)) return false;
    }
    return true;
  };
  const out = [];
  for (const [sel, label] of sels) {
    const el = document.querySelector(sel);
    if (!el) { out.push({ sel, label, missing: true }); continue; }
    const cs = getComputedStyle(el);
    const fg = parse(cs.color).slice(0, 3);
    const bg = bgOf(el);
    let ratio = ratioOf(fg, bg);
    if (sitsOnBody(el)) ratio = Math.min(ratio, haloWorst(fg, el));
    if (inLeaveCell(el)) ratio = Math.min(ratio, leaveWorst(fg, bg));
    const px = parseFloat(cs.fontSize);
    const w = parseInt(cs.fontWeight) || 400;
    const large = px >= 18.66 || (px >= 14 && w >= 700);
    out.push({ sel, label, ratio: +ratio.toFixed(2), px, large, need: large ? 3 : 4.5 });
  }
  return out;
};

const br = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM });
const problems = [];

// 天空會跟著時段變色，而 header 的字（招呼語、標題）直接坐在光暈上——
// 所以除了亮暗兩種主題，傍晚那組光暈也要量一次。時間用 page.clock 釘死，
// 不靠執行當下幾點；不然這個檢查會在白天過、晚上紅，沒有人會相信它。
// ---------- 工具的自我檢查 ----------
//
// `bgOf()` 會不會疊半透明的祖先，**畫面上的元素證明不了**：顏色是產品決定，
// 今天剛好誰過誰不過，跟這條規則對不對無關。所以用一個答案已知的假元素直接問它。
//
// 黑字，外面一層 alpha 0.5 的黑，再外面是不透明的白：
//   疊起來 → 底色 rgb(128,128,128)，黑字對它大約 5.3:1
//   跳過   → 底色 rgb(255,255,255)，黑字對它 21:1
// 兩個差了四倍，不會因為誰調了一個色碼就分不出來。
const SELF_CHECK = async page => {
  const got = await page.evaluate(m => {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:0;top:0;background:#fff;z-index:-9999';
    box.innerHTML = '<div style="background:rgba(0,0,0,0.5)"><span id="__cc" style="color:#000">x</span></div>';
    document.body.appendChild(box);
    const r = (new Function('sels', 'return (' + m + ')(sels)'))([['#__cc', 'self']]);
    box.remove();
    return r[0] && r[0].ratio;
  }, measure.toString());
  if (!(got > 4.8 && got < 6)) {
    throw new Error(`bgOf() 沒有疊半透明的祖先：假元素量到 ${got}:1，疊起來應該是 5.3:1 左右（跳過的話會是 21:1）`);
  }
  console.log(`  ✓ 自我檢查：半透明的祖先有被疊起來（假元素 ${got}:1）`);
};

/**
 * 每一個輸入框都要是同一套樣式。全域規則是一份**型別清單**，原本漏了
 * search／email／password／url，於是搜尋框、變更密碼、分享對象與 app 的登入畫面全部
 * 掉回瀏覽器預設（2px 凹陷灰框、方角、沒有內距），暗色下還是一塊灰底——對比工具
 * 看不出來，因為字讀得到，只是長得不像這個 app。
 * 掃的是**文件裡的每一個 input**（關著的對話框裡的也算，計算後的樣式照樣有），不是
 * 只掃那四種：日後多一種型別（tel、month…）沒列進清單，這裡就紅。
 */
/**
 * --text-dim 這個 token 本身。它用在 40 處字色上（已完成的項目、提示、時間戳、星期列、
 * footer…），原本 2.57:1／2.26:1——全部不及格，而清單上一個都沒量到。逐一把 40 處造出來
 * 不實際，所以直接量 token 在它會壓上去的兩種底色（--panel、--panel-2）上的對比；並且守住
 * 另一個方向：它必須**仍比 --text-muted 淡**，否則「已完成比待辦淡」的層次就沒了。
 */
const TOKEN_CHECK = async (page, label) => {
  const r = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim();
    const lum = h => { const n = parseInt(h.slice(1), 16);
      return [16, 8, 0].map(s => { const c = ((n >> s) & 255) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); })
        .reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0); };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const dim = v('--text-dim'), muted = v('--text-muted');
    return { dim, onPanel: ratio(dim, v('--panel')), onPanel2: ratio(dim, v('--panel-2')),
             mutedOnPanel2: ratio(muted, v('--panel-2')) };
  });
  const f = x => x.toFixed(2);
  if (r.onPanel < 4.5) problems.push(`${label}｜--text-dim（${r.dim}）在 --panel 上 ${f(r.onPanel)}:1，低於 4.5:1`);
  if (r.onPanel2 < 4.5) problems.push(`${label}｜--text-dim（${r.dim}）在 --panel-2 上 ${f(r.onPanel2)}:1，低於 4.5:1`);
  if (r.onPanel2 >= r.mutedOnPanel2) problems.push(`${label}｜--text-dim 不再比 --text-muted 淡（${f(r.onPanel2)} ≥ ${f(r.mutedOnPanel2)}）——「已完成比待辦淡」的層次沒了`);
  if (r.onPanel >= 4.5 && r.onPanel2 >= 4.5 && r.onPanel2 < r.mutedOnPanel2)
    console.log(`  ✓ ${label}：--text-dim ${r.dim} 在 panel ${f(r.onPanel)}:1、panel-2 ${f(r.onPanel2)}:1，仍比 --text-muted 淡`);
};

const INPUT_CHECK = async (page, label) => {
  const bad = await page.evaluate(() => {
    const ref = getComputedStyle(document.getElementById('inputItemTitle'));
    const skip = new Set(['checkbox', 'radio', 'file', 'hidden', 'range', 'color', 'button', 'submit']);
    return [...document.querySelectorAll('input')].filter(el => !skip.has(el.type)).map(el => {
      const c = getComputedStyle(el);
      const ok = c.borderTopStyle === ref.borderTopStyle && c.borderTopLeftRadius === ref.borderTopLeftRadius
        && c.backgroundColor === ref.backgroundColor;
      return ok ? null : `#${el.id || '(無 id)'}[type=${el.type}]：${c.borderTopWidth} ${c.borderTopStyle}、圓角 ${c.borderTopLeftRadius}`;
    }).filter(Boolean);
  });
  if (bad.length) bad.forEach(b => problems.push(`${label}｜輸入框沒套到共用樣式 ${b}`));
  else console.log(`  ✓ ${label}：每一個輸入框都套到共用樣式（框線、圓角、底色與 #inputItemTitle 相同）`);
};

const PASSES = [
  ['light', '亮色', null],
  ['dark', '暗色', null],
  ['light', '亮色・傍晚', '2026-09-09T20:30:00'],
  ['dark', '暗色・傍晚', '2026-09-09T20:30:00'],
];
for (const [theme, label, fixedTime] of PASSES) {
  const page = await br.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-TW' });
  if (fixedTime) await page.clock.setFixedTime(new Date(fixedTime));
  await page.addInitScript(t => { try { localStorage.setItem('workSchedule.v1.theme', t); } catch (e) {} }, theme);
  await markSignedIn(page);   // 登入閘門：見 tools/lib/signed-in.mjs
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('#board');
  await page.waitForTimeout(800);
  if (label === '亮色') await SELF_CHECK(page);
  if (!fixedTime) await INPUT_CHECK(page, label);
  if (!fixedTime) await TOKEN_CHECK(page, label);
  await page.locator('#reminderClose').click().catch(() => {});
  await page.waitForTimeout(200);

  const rows = await page.evaluate(measure, TARGETS);

  // 切到日曆、選一天，才量得到那顆按鈕
  await page.locator('.nav-item', { hasText: '日曆' }).click();
  await page.waitForSelector('#calGrid .cal-cell[data-date]');
  await page.locator('.cal-cell[data-date]').first().click();
  await page.waitForTimeout(300);
  rows.push(...await page.evaluate(measure, AFTER_CLICKS));

  // 切到「我的帳號」量取消訂閱那一區
  await page.locator('.nav-item', { hasText: '我的帳號' }).click();
  await page.waitForSelector('#viewAccount.active');
  await page.waitForTimeout(300);
  rows.push(...await page.evaluate(measure, IN_ACCOUNT));

  // 切到「專案」量夥伴卡。**「成年」那個記號要主動逼出來**：示範資料的待辦沒有
  // 全部完成，等它自然出現的話那一條永遠印「略過」——與沒有這一條一模一樣，而且
  // 還會給出「已經量過了」的錯覺。所以走應用程式自己的路徑把每一件待辦勾完
  // （不是硬塞 class：硬塞的話哪天 petBuildCard 不再加那個記號了，這裡還是綠的）。
  await page.locator('#navGantt').click();
  await page.waitForSelector('#viewGantt.active .pet-card');
  // 一律點「目前還沒勾的第一個」。`.all()` 取回來的 locator 是**懶惰**的：它記的是
  // 「`:not(.done)` 的第 N 個」，勾掉第一個之後清單就縮短了，nth(1) 當場找不到人
  // （第一版就是這樣超時的）。
  const pending = page.locator('#viewGantt .task-done-cb:not(.done)');
  for (let guard = 0; guard < 40 && await pending.count(); guard++) {
    await pending.first().click();
    await page.waitForTimeout(120);
  }
  await page.waitForSelector('.pet-card-adult');     // 勾完了才量，否則量到的是半大的那一階
  await page.waitForTimeout(250);
  rows.push(...await page.evaluate(measure, IN_GANTT));

  // 開挑夥伴的面板。它是 overlay，量完一定要關掉，否則後面的 nav 點不到
  await page.locator('.pet-card-pick').first().click();
  await page.waitForSelector('#petOverlay.show .pet-pick');
  await page.waitForTimeout(250);
  rows.push(...await page.evaluate(measure, IN_PET_PANEL));
  await page.locator('#btnPetCancel').click();
  await page.waitForTimeout(200);

  // 量完切回日曆，後面那幾段還要用到日曆的畫面
  await page.locator('.nav-item', { hasText: '日曆' }).click();
  await page.waitForSelector('#calGrid .cal-cell[data-date]');
  await page.waitForTimeout(200);

  // 造一格休假出來再量。**不能等它自然出現**：示範資料的休假日落在下個月，
  // 而「畫面上沒有這個元素，略過」是一條永遠不會執行的斷言。
  // 走的是應用程式自己的寫入路徑（開面板 → 選休假 → 加上去），不是硬塞 class
  // ——硬塞的話，哪天 renderCalendar 不再畫那個 class 了，這裡還是綠的。
  await page.locator('.cal-cell[data-date]:not(.today)').first().click();
  await page.waitForTimeout(250);
  await page.locator('#btnToggleAway').click();
  await page.waitForTimeout(200);
  await page.locator('#absKindLeave').click();
  await page.locator('#btnAbsAdd').click();
  await page.waitForTimeout(350);
  rows.push(...await page.evaluate(measure, IN_LEAVE_CELL));


  // 造一件**已經過期**的純告知再量。同樣走應用程式自己的寫入路徑（開新增視窗 →
  // 勾「純告知」→ 填一個過去的日期），不是硬塞 class：硬塞的話，哪天 buildOccRow
  // 不再加那個 class 了，這裡還是綠的。
  await page.locator('.nav-item', { hasText: '項目安排' }).click();
  await page.waitForSelector('#board');
  await page.locator('#openItemModal').click();
  await page.waitForTimeout(250);
  // 對話框的欄位名（`.field label`）：所有對話框共用同一條規則，量這一個就涵蓋全部
  rows.push(...await page.evaluate(measure, [
    ['#itemOverlay .field label', '對話框的欄位名'],
    ['#itemOverlay .field-hint', '對話框的提示文字（--text-dim，壓在 --panel-2 上）'],
  ]));
  await page.fill('#inputItemTitle', '去年的公告');
  await page.locator('#inputNoticeOnly').check();
  await page.fill('#inputItemDate', '2026-01-05');
  await page.locator('#btnConfirmItem').click();
  await page.waitForTimeout(400);
  rows.push(...await page.evaluate(measure, NOTICE_PAST));

  // 逼出空狀態：回到項目安排頁，搜尋一個不會命中的字
  await page.locator('.nav-item', { hasText: '項目安排' }).click();
  await page.waitForSelector('#board');
  await page.fill('#inputSearch', 'zzz不存在的東西zzz');
  await page.waitForTimeout(400);            // 搜尋有 180ms debounce
  rows.push(...await page.evaluate(measure, AFTER_SEARCH));

  console.log(`\n===== ${label} =====`);
  for (const r of rows) {
    if (r.missing) { console.log(`  ?  ${r.label}（畫面上沒有這個元素，略過）`); continue; }
    const ok = r.ratio >= r.need;
    console.log(`  ${ok ? '✓' : '✗'}  ${String(r.ratio).padStart(5)}:1  (需要 ${r.need}:1)  ${r.label}  ${r.px}px`);
    if (!ok) problems.push(`${label}｜${r.label}：${r.ratio}:1，低於 ${r.need}:1`);
  }
  await page.close();
}

// ---------- agent 工作區（1B）：狀態徽章、專案說明書、最新進展、等你回覆、連線設定 ----------
//
// 這一整塊要有後端才畫得出來（收件匣、日誌都來自伺服器），而上面那條流程的假伺服器對 /api/* 一律 404。
// 所以另外起一個**有假後端的伺服器**，並且**主動把每一種狀態造出來**——卡住／等待／待驗收的任務、
// 一個還開著的提問、一份提案（含一份套不上去的）、一筆被遮蔽的日誌、「agent 剛更新了」那一條、
// 被自動暫停的連線。等它們自然出現就是「畫面上沒有這個元素，略過」那條永遠不會執行的斷言
// （CLAUDE.md〈顏色不只要好看，要量得出來〉抓到過兩個已經上線很久的案例）。
// 這一輪**找不到元素就是錯誤**，不是「略過」。
//
// 新增的顏色 token（--st-*）亮暗兩組都在 :root 與 [data-theme="dark"]；blocked 刻意用「深色實心」而不是紅色
// （紅是逾期專用），所以它的對比要量，不能靠感覺。
const AGENT_PORT = PORT + 1;
const plusD = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const AGENT_STATE = {
  version: 3, majorProjects: [], items: [],
  ganttProjects: [{ id: 'g1', name: '新廠專案', notes: '', pet: null, brief: '預算上限 200 萬，不要刪任何東西', tasks: [
    // 2B：逾期又有預測（虛線接在紅色長條後面、「上線」里程碑算出會趕不上）、認領三天沒動靜、連結、預估；
    // 等待的預測晚 5 天、進行中的預測早 4 天；一個已完成的任務讓「已達成」的里程碑有東西可量
    { id: 'tO', name: '逾期又進行中', start: '2026-01-01', end: '2026-02-01', progress: 10, done: false, todos: [], status: 'doing', blockedNote: '',
      forecastEnd: plusD(10), assignee: 'Claude Code', claimedAt: Date.now() - 3 * 86400000 - 5000, estimateHours: 8, actualHours: 3 },
    { id: 'tB', name: '卡住的任務', start: '2026-01-01', end: plusD(90), progress: 10, done: false, todos: [], status: 'blocked', blockedNote: '',
      assignee: 'Claude Code', claimedAt: Date.now() - 3600000,
      links: [{ url: 'https://example.com/design', label: '設計稿' }, { url: 'https://example.com/spec', label: '' }] },
    { id: 'tW', name: '等待的任務', start: '2026-01-01', end: plusD(90), progress: 10, done: false, todos: [], status: 'waiting', blockedNote: '等廠商回覆', forecastEnd: plusD(95) },
    { id: 'tR', name: '待驗收的任務', start: '2026-01-01', end: plusD(90), progress: 10, done: false, todos: [], status: 'review', blockedNote: '' },
    { id: 'tD', name: '進行中的任務', start: '2026-01-01', end: plusD(90), progress: 10, done: false, todos: [], status: 'doing', blockedNote: '', forecastEnd: plusD(86) },
    { id: 'tX', name: '已完成的任務', start: '2026-01-01', end: '2026-01-15', progress: 100, done: true, todos: [], status: 'todo', blockedNote: '' },
  ], milestones: [{ id: 'm1', name: '上線', date: plusD(5) }, { id: 'm2', name: '驗收', date: plusD(60) }, { id: 'm3', name: '設計定稿', date: '2026-01-20' }] }],
  dailyLogs: {}, absences: {}, customHolidays: [], customWorkdays: [], selectedGanttProjectId: 'g1', availableYears: [2026, 2027],
};
const agentEv = (id, kind, body, over = {}) => ({ id, projectId: 'g1', taskId: null, kind, actor: kind === 'decision' ? 'user' : 'Claude Code',
  body, refId: null, status: null, options: null, defaultAfter: null, redactedAt: null, createdAt: Date.now() - (over.ago || 60000), ...over });
const AGENT_DATA = {
  version: { updatedAt: 1, latestEventAt: 5000 },
  events: [
    agentEv('q1', 'question', '要用哪個方案？', { status: 'open', options: ['甲案', '乙案'], taskId: 'tB' }),
    agentEv('e2', 'progress', '整理完訪談紀錄', { ago: 3600000 }),
    agentEv('e3', 'handoff', '交接：下一步做視覺', { ago: 7200000, taskId: 'tW' }),
    agentEv('e4', 'decision', '問題：x\n決定：y', { ago: 8000000 }),
    agentEv('e5', 'progress', '', { redactedAt: Date.now() - 86400000, ago: 90000000 }),
    // 3B：一個還開著的風險（專案頁的「風險」那一塊要有東西可量）
    agentEv('r1', 'risk', '廠商可能來不及交件，上線會晚', { status: 'open', taskId: 'tB', ago: 100000000 }),
  ],
  // 3B：版本歷史、成績單、分享連結（按「產生連結」之後才有 active——「撤銷」與「重新產生」要有東西可量）
  versions: [
    { id: 'v1', createdAt: Date.now() - 3600e3, actor: 'Claude Code', summary: 'agent 修改之前：改了任務日期', bytes: 1234 },
    { id: 'v2', createdAt: Date.now() - 7200e3, actor: 'system', summary: '每日留存', bytes: 1200 },
  ],
  scorecard: [{ connId: 'c1', name: 'Claude Code', active: true, changes: 12, undone: 2, tasksCompleted: 3, estimateHours: 10, actualHours: 12, comparedTasks: 2 }],
  share: null,
  questions: [{ ...agentEv('q1', 'question', '要用哪個方案？', { status: 'open', options: ['甲案', '乙案'], taskId: 'tB', defaultAfter: plusD(-1) }),
    projectName: '新廠專案', taskName: '卡住的任務', pastDeadline: true }],
  proposals: [
    { id: 'p1', title: '把施工往後排一週', actor: 'Claude Code', connId: 'c1', createdAt: Date.now() - 30000, ops: 1,
      preview: { ok: true, rows: [{ entity: '專案「新廠專案」的任務「施工」', field: '結束日', before: '2027-02-10', after: '2027-02-17' }] } },
    // 套不上去的那一份：卡片上會有紅色的說明（.agent-msg.err）
    { id: 'p2', title: '刪掉一個已經不在的任務', actor: 'Claude Code', connId: 'c1', createdAt: Date.now() - 20000, ops: 1,
      preview: { ok: false, error: '找不到這個任務', rows: [] } },
  ],
  review: [{ projectId: 'g1', projectName: '新廠專案', taskId: 'tR', taskName: '待驗收的任務', todosInReview: [{ id: 'a', text: '備料' }] }],
  // 2B：PR 看板。失敗的（--red）、等你審的、一般的、已合併連到還沒完成的任務（「要標成完成嗎？」）、已關閉
  prs: [
    { id: 'a', number: 78, repo: 'o/r', url: 'https://github.com/o/r/pull/78', projectId: 'g1', taskId: 'tB', title: '測試失敗的 PR', state: 'open', checks: 'failing', review: 'none', source: 'webhook', updatedAt: Date.now() - 7200000 },
    { id: 'b', number: 77, repo: 'o/r', url: 'https://github.com/o/r/pull/77', projectId: 'g1', taskId: null, title: '等審的 PR', state: 'open', checks: 'pending', review: 'pending', source: 'agent', updatedAt: Date.now() - 3600000 },
    { id: 'c', number: 79, repo: 'o/r', url: 'https://github.com/o/r/pull/79', projectId: 'g1', taskId: null, title: '一般的草稿 PR', state: 'draft', checks: 'passing', review: 'approved', source: 'agent', updatedAt: Date.now() - 60000 },
    { id: 'd', number: 76, repo: 'o/r', url: 'https://github.com/o/r/pull/76', projectId: 'g1', taskId: 'tW', title: '已合併的 PR', state: 'merged', checks: 'passing', review: 'approved', source: 'agent', updatedAt: Date.now() - 86400000 },
    { id: 'e', number: 70, repo: 'o/r', url: 'https://github.com/o/r/pull/70', projectId: 'g1', taskId: null, title: '關掉的 PR', state: 'closed', checks: 'none', review: 'none', source: 'agent', updatedAt: Date.now() - 172800000 },
  ],
  connections: [
    { id: 'c1', kind: 'oauth', name: 'Claude Code', access: 'write', projectId: null, createdAt: 1, lastUsedAt: null, mode: 'review', paused: false, needsAcceptance: true, pausedReason: null },
    { id: 'c2', kind: 'key', name: '自動暫停的金鑰', access: 'read', projectId: 'g1', createdAt: 2, lastUsedAt: null, mode: 'direct', paused: true, needsAcceptance: false, pausedReason: 'auto' },
  ],
};
// 公開分享頁（p.html）讀到的內容：每一種畫面元素都要有（逾期紅條、預測虛線、有風險的菱形、勾選才多帶的各區）
const PUBLIC_DATA = {
  project: { name: '公開的專案' }, today: plusD(0),
  milestones: [{ name: '上線', date: plusD(10), atRisk: true, reason: '把關的任務預測會晚' }, { name: '驗收', date: plusD(200), atRisk: false }],
  tasks: [
    { name: '逾期又預測更晚', start: plusD(-60), end: plusD(-5), status: 'doing', progress: 40, done: false, forecastEnd: plusD(14) },
    { name: '已完成的任務', start: plusD(-80), end: plusD(-70), status: 'todo', progress: 100, done: true, forecastEnd: null },
    { name: '卡住的任務', start: plusD(-3), end: plusD(40), status: 'blocked', progress: 10, done: false, forecastEnd: plusD(36) },
    { name: '一般進行中', start: plusD(0), end: plusD(60), status: 'todo', progress: 0, done: false, forecastEnd: null },
  ],
  includes: ['events', 'risks', 'prs'],
  events: [{ kind: 'progress', by: 'Claude Code', at: new Date().toISOString(), text: '整理完訪談紀錄' }],
  risks: [{ by: 'Claude Code', at: new Date().toISOString(), text: '廠商可能來不及交件' }],
  prs: [{ repo: 'o/r', number: 5, title: '公開的 PR', url: 'https://github.com/o/r/pull/5', state: 'open', checks: 'failing', review: 'none' },
        { repo: 'o/r', number: 4, title: '已通過的 PR', url: 'https://github.com/o/r/pull/4', state: 'merged', checks: 'passing', review: 'approved' }],
};
const agentSrv = createServer((q, r) => {
  const u = new URL(q.url, 'http://x');
  const send = (code, body, type = 'application/json') => { r.writeHead(code, { 'content-type': `${type}; charset=utf-8` }); r.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (u.pathname.startsWith('/api/')) {
    if (u.pathname === '/api/state') return send(200, q.method === 'PUT' ? { ok: true, updatedAt: 1 }
      : { user: { email: 'c@x.test', role: 'user', status: 'approved', plan: 'pro', planSource: 'admin', planExpiresAt: null }, state: null, updatedAt: null });
    if (u.pathname === '/api/agent/inbox') return send(200, { questions: AGENT_DATA.questions, proposals: AGENT_DATA.proposals, review: AGENT_DATA.review, agentAvailable: false });
    if (u.pathname === '/api/state/version') return send(200, AGENT_DATA.version);
    if (/^\/api\/projects\/[^/]+\/events$/.test(u.pathname)) return send(200, { events: AGENT_DATA.events });
    if (/^\/api\/projects\/[^/]+\/prs$/.test(u.pathname)) return send(200, { prs: AGENT_DATA.prs, counts: { open: 3, merged: 1, closed: 1 } });
    if (u.pathname === '/api/github/hooks') return q.method === 'POST'
      ? send(200, { url: 'https://x.test/api/github/hook/TOKENTOKENTOKENTOKEN', secret: 'SECRETSECRET', note: '' }) : send(200, { configured: false, createdAt: null });   // 沒設定過：按「建立」不會跳 confirm（Playwright 會自動取消它）
    if (u.pathname === '/api/mcp/connections') return send(200, { pro: true, connections: AGENT_DATA.connections });
    if (u.pathname === '/api/mcp/activity') return send(200, { changes: [] });
    if (u.pathname === '/api/history/versions') return send(200, { configured: true, versions: AGENT_DATA.versions });
    if (/^\/api\/history\/versions\/[^/]+\/diff$/.test(u.pathname)) return send(200, { rows: [
      { entity: 'ganttTask', id: 'g1/tO', name: '新廠專案／逾期又進行中', field: 'end', before: '2026-02-01', after: '2026-03-01' },
      { entity: 'item', id: 'i1', name: '某個項目', field: '（新增）', before: null, after: '某個項目' }], total: 2, truncated: false });
    if (u.pathname === '/api/agent/scorecard') return send(200, { windowDays: 90, connections: AGENT_DATA.scorecard });
    if (/^\/api\/projects\/[^/]+\/share$/.test(u.pathname)) {
      if (q.method === 'POST') { AGENT_DATA.share = { id: 's1', createdAt: Date.now(), include: ['risks'] }; return send(200, { id: 's1', token: 'T', url: 'https://x.test/p/TOKENTOKENTOKENTOKENTOKEN', include: ['risks'] }); }
      return send(200, { active: AGENT_DATA.share });
    }
    if (/^\/api\/p\//.test(u.pathname)) return send(200, PUBLIC_DATA);
    if (u.pathname === '/api/shares') return send(200, { outgoing: [], incoming: [] });
    if (u.pathname === '/api/activity') return send(200, { activity: [] });
    return send(200, { ok: true });
  }
  const n = /^\/p\/[^/]+$/.test(u.pathname) ? 'p.html' : (u.pathname.slice(1) || 'index.html');
  let b; try { b = readFileSync(PUBLIC + n); } catch { return send(404, 'x', 'text/plain'); }
  send(200, b.toString('utf8'), 'text/html');
});
agentSrv.listen(AGENT_PORT);

const AGENT_PROJECT = [
  ['.st-badge.doing', '徽章：進行中'], ['.st-badge.blocked', '徽章：卡住（深色實心）'],
  ['.st-badge.waiting', '徽章：等待中'], ['.st-badge.review', '徽章：待驗收'],
  ['.gantt-row-label .st-glyph', '甘特圖左邊標籤的狀態小字'],
  ['.task-status-note .agent-msg', '卡住沒寫原因的提示'], ['.task-review-bar > .agent-msg', '待驗收那一條的說明'],
  ['.agent-brief > summary', '專案說明書的標題'], ['.agent-brief-hint', '專案說明書的提示'], ['.agent-brief-foot', '說明書的字數與說明'],
  ['.agent-timeline .agent-h', '最新進展標題'], ['.agent-ev-actor', '進展：誰'], ['.agent-ev-kind:not(.question):not(.handoff):not(.decision)', '進展：種類（一般）'],
  ['.agent-ev-kind.question', '進展：提問'], ['.agent-ev-kind.handoff', '進展：交接筆記'], ['.agent-ev-kind.decision', '進展：決定'],
  ['.agent-ev-when', '進展：時間'], ['.agent-ev-body', '進展：內文'], ['.agent-ev-body.redacted', '進展：被遮蔽的那一筆'],
  ['.agent-link', '進展：「遮蔽」'], ['.agent-opt', '回答的選項按鈕'], ['.agent-send', '「回覆」按鈕'],
];
const AGENT_INBOX = [
  ['.agent-inbox .agent-h', '等你回覆標題'], ['.agent-inbox .agent-pill', '等你回覆的數字'], ['.agent-inbox > .agent-line', '「agent 連不進來」的說明'],
  ['.agent-card-ctx', '卡片的來源列'], ['.agent-card-title', '卡片標題（問題／提案）'], ['.agent-deadline', '期限'],
  ['.agent-opt', '選項按鈕'], ['.agent-send', '主要按鈕（回覆／同意）'], ['.agent-card .qbtn', '次要按鈕（退回）'],
  ['.agent-diff-ent', '提案對照：東西'], ['.agent-diff-field', '提案對照：欄位'], ['.agent-diff-val .old', '提案對照：改前'], ['.agent-diff-val .new', '提案對照：改後'],
  ['.agent-card[data-kind=proposal] .agent-msg.err', '提案套不上去的紅字說明'], ['.agent-card .agent-line', '卡片裡的說明'],
];
// 2B：預測線、里程碑、任務列底下那一條、PR 看板、GitHub 通知設定。**全部要主動造出來**（找不到元素就是錯誤）
const AGENT_2B = [
  ['.gantt-forecast-label', '預測線：「晚 N 天」'], ['.gantt-ms-row-label', '里程碑那一列的標籤'], ['.gantt-ms-name:not(.risk)', '里程碑的名稱'], ['.gantt-ms-name.risk', '里程碑的名稱（有風險）'],
  ['.agent-ms-chip:not(.risk):not(.ok)', '里程碑編輯器：趕得上'], ['.agent-ms-chip.risk', '里程碑編輯器：有風險'], ['.agent-ms-chip.ok', '里程碑編輯器：已達成'],
  ['.agent-ms-why', '里程碑編輯器：有風險的原因'], ['.agent-ms .agent-brief-hint', '里程碑的摘要（有風險時變紅字）'],
  ['.task-meta .task-field-label', '任務列：預估／實際／小時'], ['.agent-fc', '任務列：預測那一行'], ['.agent-fc .qbtn', '任務列：「採用預測」'],
  ['.agent-claim:not(.stale)', '任務列：認領'], ['.agent-claim.stale', '任務列：認領（N 天沒動靜）'],
  ['.agent-linkchip a', '任務列：證據連結'], ['.agent-linkchip button', '任務列：移除連結的 ✕'], ['.agent-links > .qbtn', '任務列：「＋ 連結」'],
  ['.agent-prs .agent-h', 'PR 看板標題'], ['.agent-pr-counts', 'PR 看板：計數'], ['.agent-pr-num', 'PR：編號'], ['.agent-pr-title', 'PR：標題'],
  ['.agent-pr-state:not(.merged)', 'PR：狀態'], ['.agent-pr-state.merged', 'PR：已合併'],
  ['.agent-pr-meta', 'PR：測試與來源'], ['.agent-pr-meta .bad', 'PR：測試失敗（--red）'], ['.agent-pr-meta .wait', 'PR：等你審'], ['.agent-pr-meta .good', 'PR：測試通過'],
  ['.agent-pr-hint', '「PR 已合併，要標成完成嗎？」'], ['.agent-pr-hint .agent-send', '「標成完成」按鈕'], ['.agent-pr-more', '看已合併／已關閉'],
];
const AGENT_2B_ACCOUNT = [
  ['#acctGhStatus', 'GitHub 通知：狀態'], ['#btnGhCreate', 'GitHub 通知：重新產生'], ['#btnGhDelete', 'GitHub 通知：移除'],
  ['.acct-gh-secret .acct-sub', 'GitHub 通知：只顯示一次的說明'], ['.acct-gh-secret li', 'GitHub 通知：設定步驟'], ['#btnGhHide', 'GitHub 通知：我已複製'],
];
// 3B：專案頁的風險與分享連結、帳號頁的版本歷史／範圍／成績單／每週摘要
const AGENT_3B_PROJECT = [
  ['.agent-risks .agent-h', '風險：標題'], ['.agent-risk-meta', '風險：誰與多久前'], ['.agent-risk-body', '風險：內文'], ['.agent-risk .qbtn', '風險：「關閉這個風險」'],
  ['.agent-share .agent-h', '分享連結：標題'], ['.agent-share [data-role=share-state]', '分享連結：公開了什麼'], ['.agent-share > .agent-line', '分享連結：勾選的說明'],
  ['.agent-share .acct-chk', '分享連結：勾選項目'], ['.agent-share .agent-send', '分享連結：「產生／重新產生」'], ['.agent-share .qbtn', '分享連結：「撤銷連結」'],
  ['.agent-share-url .agent-line', '分享連結：只顯示一次的說明（琥珀底）'], ['.agent-share-url .ghost-btn', '分享連結：複製／收起來'],
];
const AGENT_3B_ACCOUNT = [
  ['#acctHistorySub', '版本歷史：說明'], ['.hist-when', '版本歷史：時間'], ['.hist-actor', '版本歷史：誰'], ['.hist-sum', '版本歷史：摘要'], ['.hist-btns .ghost-btn', '版本歷史：看差異／退回'],
  ['.hist-diff-note', '版本歷史：差異的說明'], ['.hist-row .agent-diff-val .old', '版本歷史：差異（那一版的值）'], ['.hist-row .agent-diff-val .new', '版本歷史：差異（現在的值）'],
  ['.agent-scope:not(.narrow)', '連線的範圍'], ['.agent-scope.narrow', '連線的範圍（有收窄）'], ['.agent-score', '成績單：一條連線'], ['.agent-score b', '成績單：連線名稱'],
  ['#btnWeeklyMail', '第七顆通知開關（每週摘要）'], ['#viewAccount .acct-chk', '建立金鑰：只能讀'],
];
const AGENT_LIVE = [['#agentLive', '「agent 剛更新了」那一條'], ['#btnAgentLive', '「更新畫面」按鈕']];
const AGENT_ACCOUNT = [
  ['.agent-caps', '一次性的能力說明'], ['.agent-conn-set .ghost-btn:not(.on)', '連線設定的開關（平常）'], ['.agent-conn-set .ghost-btn.on', '連線設定的開關（開著）'],
  ['.agent-conn-paused', '暫停原因'], ['#btnAgentNotify', '第六顆通知開關'], ['#btnAgentPauseAll', '「暫停所有 agent」'],
];
for (const theme of ['light', 'dark']) {
  const label = theme === 'light' ? '亮色' : '暗色';
  AGENT_DATA.share = null;         // 兩種主題各自從「還沒有連結」開始：已經有連結的話，按「產生」會先跳 confirm
  const page = await br.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-TW' });
  await page.clock.install();
  await page.addInitScript(([t, st]) => { try { localStorage.setItem('workSchedule.v1.theme', t); localStorage.setItem('workSchedule.v1', JSON.stringify(st)); } catch (e) {} },
    [theme, AGENT_STATE]);
  await skipBootScene(page);
  await page.goto(`http://localhost:${AGENT_PORT}/`);
  await page.waitForSelector('#agentInbox:not(.off) .agent-card', { timeout: 8000 });
  await page.waitForTimeout(300);
  const rows = [];
  rows.push(...await page.evaluate(measure, AGENT_INBOX));

  await page.locator('#navGantt').click();
  await page.waitForSelector('#agentTimeline .agent-ev', { timeout: 8000 });
  await page.waitForTimeout(300);
  rows.push(...await page.evaluate(measure, AGENT_PROJECT));

  // 2B：先把要量的東西造出來——里程碑編輯器展開、已合併／已關閉展開
  await page.waitForSelector('#agentPrs .agent-pr', { timeout: 8000 });
  await page.locator('.agent-ms > summary').click();
  await page.locator('#agentPrs .agent-pr-more').click();
  await page.waitForTimeout(250);
  rows.push(...await page.evaluate(measure, AGENT_2B));
  // 3B：風險（資料裡有一筆開著的）、分享連結（先按「產生連結」，撤銷鈕與「只顯示一次」那一塊才造得出來）
  await page.waitForSelector('#agentRisks .agent-risk', { timeout: 8000 });
  await page.waitForSelector('#agentShare .agent-send', { timeout: 8000 });
  await page.locator('#agentShare .agent-send').click();
  await page.waitForSelector('#agentShareUrl', { timeout: 5000 });
  await page.waitForTimeout(200);
  rows.push(...await page.evaluate(measure, AGENT_3B_PROJECT));
  // 圖形（不是字）：菱形與虛線要與底色有 3:1（WCAG 非文字對比）。三種菱形都要有
  const gfx = await page.evaluate(() => {
    const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const rgb = s => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return +((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2); };
    const panel = rgb(getComputedStyle(document.querySelector('.gantt-wrap')).backgroundColor);
    const strip = rgb(getComputedStyle(document.querySelector('.gantt-row-track:not(.gantt-ms-track)'), '::before').backgroundColor);
    const out = [];
    for (const [sel, label] of [['.gantt-ms.risk', '菱形：有風險'], ['.gantt-ms.ok', '菱形：已達成'], ['.gantt-ms:not(.risk):not(.ok)', '菱形：趕得上']]) {
      const e = document.querySelector(sel);
      out.push(e ? { label, ratio: ratio(rgb(getComputedStyle(e).backgroundColor), panel) } : { label, missing: true, sel });
    }
    const f = document.querySelector('.gantt-forecast');
    out.push(f ? { label: '預測的虛線', ratio: ratio(rgb(getComputedStyle(f).borderTopColor), strip) } : { label: '預測的虛線', missing: true, sel: '.gantt-forecast' });
    return out;
  });
  for (const g of gfx) {
    if (g.missing) { console.log(`  ✗  ${g.label}（找不到 ${g.sel}）`); problems.push(`agent 工作區・${label}｜${g.label}：找不到 ${g.sel}（斷言是空的）`); continue; }
    const ok = g.ratio >= 3;
    console.log(`  ${ok ? '✓' : '✗'}  ${String(g.ratio).padStart(5)}:1  (需要 3:1)  ${g.label}（圖形）`);
    if (!ok) problems.push(`agent 工作區・${label}｜${g.label}：${g.ratio}:1，低於 3:1`);
  }

  // 「agent 剛更新了」：版本號變了 → 輪詢一次（假時鐘快轉）→ 那一條出現
  AGENT_DATA.version = { updatedAt: 1, latestEventAt: 99999 };
  await page.clock.fastForward(31000);
  await page.waitForFunction(() => document.getElementById('agentLive').getClientRects().length > 0, null, { timeout: 5000 });
  rows.push(...await page.evaluate(measure, AGENT_LIVE));
  AGENT_DATA.version = { updatedAt: 1, latestEventAt: 5000 };

  await page.locator('.nav-item', { hasText: '我的帳號' }).click();
  await page.waitForSelector('#acctMcpConnList .agent-conn', { timeout: 8000 });
  await page.waitForTimeout(300);
  rows.push(...await page.evaluate(measure, AGENT_ACCOUNT));
  // 3B：版本歷史先把一版的差異打開，成績單與範圍等它們自己畫出來
  await page.waitForSelector('#histList .hist-row', { timeout: 8000 });
  await page.locator('#histList .hist-row .hist-btns .ghost-btn').first().click();
  await page.waitForSelector('#histList .agent-diff-row', { timeout: 5000 });
  await page.waitForSelector('#acctMcpScore .agent-score', { timeout: 8000 });
  rows.push(...await page.evaluate(measure, AGENT_3B_ACCOUNT));
  await page.locator('#btnGhCreate').click();       // 2B：把「只顯示一次」那一塊造出來
  await page.waitForSelector('#acctGhSecret', { state: 'visible', timeout: 5000 });
  rows.push(...await page.evaluate(measure, AGENT_2B_ACCOUNT));

  console.log(`\n===== agent 工作區・${label} =====`);
  for (const r of rows) {
    if (r.missing) { console.log(`  ✗  ${r.label}（找不到 ${r.sel}——假資料沒有把它造出來，這條斷言是空的）`); problems.push(`agent 工作區・${label}｜${r.label}：找不到 ${r.sel}（斷言是空的）`); continue; }
    const ok = r.ratio >= r.need;
    console.log(`  ${ok ? '✓' : '✗'}  ${String(r.ratio).padStart(5)}:1  (需要 ${r.need}:1)  ${r.label}  ${r.px}px`);
    if (!ok) problems.push(`agent 工作區・${label}｜${r.label}：${r.ratio}:1，低於 ${r.need}:1`);
  }
  await page.close();
}

// ---------- 公開分享頁（p.html）：自己一份 CSS、亮暗兩組變數 ----------
const PUBLIC_TARGETS = [
  ['h1', '專案名稱'], ['.wrap > .sub', '副標'], ['.expose', '這個連結公開了什麼'], ['.expose b', '「這個連結公開了：」'], ['h2', '區塊標題'],
  ['.ms-row span:nth-child(2)', '里程碑名稱'], ['.ms-date', '里程碑日期'], ['.ms-risk', '里程碑：有風險'], ['.g-axis', '甘特：起訖日'],
  ['.g-name .n', '任務名稱'], ['.g-st', '任務狀態'], ['.g-meta', '任務日期與進度'], ['.g-late', '預測晚 N 天'],
  ['.ev-meta', '日誌：誰與日期'], ['.ev-body', '日誌：內文'], ['.risk-item .ev-body', '風險：內文'], ['.pr a', 'PR：連結'], ['.pr .s', 'PR：狀態'], ['.pr .s.bad', 'PR：測試失敗'], ['.foot', '頁尾'],
];
for (const theme of ['light', 'dark']) {
  const label = theme === 'light' ? '亮色' : '暗色';
  const page = await br.newPage({ viewport: { width: 390, height: 900 }, locale: 'zh-TW' });
  await page.addInitScript(t => { try { localStorage.setItem('workSchedule.v1.theme', t); } catch (e) {} }, theme);
  await page.goto(`http://localhost:${AGENT_PORT}/p/TOKENTOKENTOKENTOKENTOKEN`);
  await page.waitForSelector('h1', { timeout: 8000 });
  const rows = await page.evaluate(measure, PUBLIC_TARGETS);
  // 圖形：長條（一般／完成／逾期）與預測虛線要與軌道有 3:1；菱形（有風險與否）與卡片底
  const gfx = await page.evaluate(() => {
    const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const rgb = s => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return +((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2); };
    const track = rgb(getComputedStyle(document.querySelector('.g-track')).backgroundColor);
    const card = rgb(getComputedStyle(document.querySelector('.card')).backgroundColor);
    const out = [];
    for (const [sel, bg, lab, prop] of [['.g-bar:not(.done):not(.overdue)', track, '長條：一般'], ['.g-bar.done', track, '長條：已完成'], ['.g-bar.overdue', track, '長條：逾期（--red）'],
      ['.g-fc', track, '預測的虛線', 'borderTopColor'], ['.g-fc-early', track, '預測較早的細記號'], ['.dia:not(.risk)', card, '菱形：一般'], ['.dia.risk', card, '菱形：有風險']]) {
      const e = document.querySelector(sel);
      out.push(e ? { label: lab, ratio: ratio(rgb(getComputedStyle(e)[prop || 'backgroundColor']), bg) } : { label: lab, missing: true, sel });
    }
    return out;
  });
  console.log(`\n===== 公開分享頁・${label} =====`);
  for (const r of rows) {
    if (r.missing) { console.log(`  ✗  ${r.label}（找不到 ${r.sel}——假資料沒有把它造出來，這條斷言是空的）`); problems.push(`公開分享頁・${label}｜${r.label}：找不到 ${r.sel}（斷言是空的）`); continue; }
    const ok = r.ratio >= r.need;
    console.log(`  ${ok ? '✓' : '✗'}  ${String(r.ratio).padStart(5)}:1  (需要 ${r.need}:1)  ${r.label}  ${r.px}px`);
    if (!ok) problems.push(`公開分享頁・${label}｜${r.label}：${r.ratio}:1，低於 ${r.need}:1`);
  }
  for (const g of gfx) {
    if (g.missing) { console.log(`  ✗  ${g.label}（找不到 ${g.sel}）`); problems.push(`公開分享頁・${label}｜${g.label}：找不到 ${g.sel}（斷言是空的）`); continue; }
    const ok = g.ratio >= 3;
    console.log(`  ${ok ? '✓' : '✗'}  ${String(g.ratio).padStart(5)}:1  (需要 3:1)  ${g.label}（圖形）`);
    if (!ok) problems.push(`公開分享頁・${label}｜${g.label}：${g.ratio}:1，低於 3:1`);
  }
  await page.close();
}
// 失效連結的那一頁（沒有專案內容，只有一句話）
for (const theme of ['light', 'dark']) {
  const label = theme === 'light' ? '亮色' : '暗色';
  const page = await br.newPage({ viewport: { width: 390, height: 700 }, locale: 'zh-TW' });
  await page.addInitScript(t => { try { localStorage.setItem('workSchedule.v1.theme', t); } catch (e) {} }, theme);
  await page.route('**/api/p/**', r => r.fulfill({ status: 404, body: '{"error":"x"}', contentType: 'application/json' }));
  await page.goto(`http://localhost:${AGENT_PORT}/p/GONE`);
  await page.waitForSelector('.msg .big', { timeout: 8000 });
  const rows = await page.evaluate(measure, [['.msg .big', '失效連結：標題'], ['.msg .sub', '失效連結：說明']]);
  console.log(`\n===== 公開分享頁（失效）・${label} =====`);
  for (const r of rows) {
    if (r.missing) { console.log(`  ✗  ${r.label}（找不到）`); problems.push(`公開分享頁（失效）・${label}｜${r.label}：找不到（斷言是空的）`); continue; }
    const ok = r.ratio >= r.need;
    console.log(`  ${ok ? '✓' : '✗'}  ${String(r.ratio).padStart(5)}:1  (需要 ${r.need}:1)  ${r.label}`);
    if (!ok) problems.push(`公開分享頁（失效）・${label}｜${r.label}：${r.ratio}:1，低於 ${r.need}:1`);
  }
  await page.close();
}
agentSrv.close();

console.log('');
if (problems.length) { problems.forEach(p => console.log('  ✗ ' + p)); }
else console.log('✓ 兩種主題的正文級文字都達到 WCAG 標準');
await br.close(); srv.close();
process.exit(problems.length ? 1 : 0);
