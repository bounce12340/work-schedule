/**
 * 前端改了，service worker 的快取版本號有沒有跟著加。
 *
 * 為什麼需要這支
 * ---------------------------------------------------------------------------
 * 這是**已經發生過**的事故，而且它最惡劣的地方是**每一項檢查都是綠的**：
 *
 *   - `npm test` 綠、瀏覽器檢查綠、`wrangler deploy` 成功、線上 `GET /` 回 302、
 *     Cloudflare 的版本 ID 也換了新的。
 *   - 使用者打開網站，看到的還是舊版，回報「為何我沒看到任何改動」。
 *
 * 兩次上線（視覺改版、前置作業與「不在」）都忘了把 `sw.js` 的 `CACHE` 往上加。
 * CLAUDE.md 早就寫著要加——**寫在文件裡的規則會被忘記，寫成檢查的不會**。
 *
 * 判準刻意很窄：**動到會被 service worker 快取的前端檔案，版本號就必須變。**
 * 只改 Worker 端、測試、文件不受影響。零相依、跑不到一秒，所以放進 CI 的
 * `check` job 而不是需要 Chromium 的 `smoke`。
 *
 *     node tools/check-sw-version.mjs <base-ref> [head-ref]
 *     node tools/check-sw-version.mjs origin/main HEAD
 */
import { execFileSync } from 'node:child_process';

const [, , baseRef, headRef = 'HEAD'] = process.argv;
if (!baseRef) {
  console.error('用法：node tools/check-sw-version.mjs <base-ref> [head-ref]');
  process.exit(2);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

// 會被 service worker 端出來的前端檔案。sw.js 自己不列——改它本來就是這件事。
const WATCHED = /^public\/(index|login|reset|admin)\.html$/;
const SW = 'public/sw.js';

let changed;
try {
  changed = git('diff', '--name-only', `${baseRef}..${headRef}`).split('\n').filter(Boolean);
} catch (e) {
  // 淺 clone 拿不到 base 時要**大聲說**，不要靜默跳過——靜默跳過的檢查
  // 與沒有檢查一模一樣，而且還會給出「已經檢查過了」的錯覺。
  console.error('✗ 取不到 ' + baseRef + ' 與 ' + headRef + ' 之間的差異。');
  console.error('  CI 上通常是 actions/checkout 的 fetch-depth 太淺（需要 0 或足夠深）。');
  process.exit(1);
}

const touched = changed.filter(f => WATCHED.test(f));
if (!touched.length) {
  console.log('✓ 沒有動到會被 service worker 快取的前端檔案，不需要加版本號');
  process.exit(0);
}

const readCache = (ref) => {
  let src;
  try { src = execFileSync('git', ['show', `${ref}:${SW}`], { encoding: 'utf8' }); }
  catch { return null; }          // base 上還沒有 sw.js＝這次新增的，當作已經變了
  const m = src.match(/const\s+CACHE\s*=\s*['"]([^'"]+)['"]/);
  if (!m) {
    console.error('✗ 在 ' + ref + ' 的 ' + SW + ' 裡找不到 `const CACHE = "…"`。');
    console.error('  是不是改名了？改名的話這支檢查也要跟著改，不要讓它靜默失效。');
    process.exit(1);
  }
  return m[1];
};

const before = readCache(baseRef);
const after = readCache(headRef);

console.log('  動到的前端檔案：' + touched.join('、'));
console.log('  CACHE：' + (before === null ? '（base 上還沒有 sw.js）' : before) + ' → ' + after);

if (before !== null && before === after) {
  console.error('');
  console.error('✗ 前端檔案改了，但 ' + SW + ' 的 CACHE 版本號沒有跟著加。');
  console.error('');
  console.error('  後果不是「比較慢」而是**使用者看不到這次的改動**：導覽走 network-first，');
  console.error('  但 req.mode === "navigate" 不是每次開啟頁面都成立（PWA 啟動、返回上一頁、');
  console.error('  預抓），那些路徑會端出舊的 HTML，而舊快取沒有任何時機會被清掉。');
  console.error('');
  console.error('  已經發生過兩次，症狀是所有檢查全綠、部署成功、使用者說「沒看到改動」。');
  console.error('');
  console.error('  修法：把 ' + SW + ' 的 `const CACHE` 往上加一號。');
  process.exit(1);
}

console.log('✓ 版本號有跟著加');
