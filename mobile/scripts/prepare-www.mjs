/**
 * 把 app 要內建的前端複製到 mobile/www/。
 *
 * www/ 是**建置產物**，不進 git（見 mobile/.gitignore）：它只是 public/index.html 的
 * 副本，而副本一定會走鐘——理由與「測試直接從 index.html 抽原始碼、不複製一份」
 * 相同。每次打包（cap sync 之前）重新產生，就沒有「哪一份才是真的」的問題。
 *
 * 複製主畫面與法律頁：app 用不到 login.html（依賴 Turnstile）、sw.js（capacitor://
 * 下不註冊）、manifest 與 PWA 圖示（app 有自己的 AppIcon）。法律頁必須和主畫面
 * 一起打進 bundle，否則訂閱畫面裡的使用條款／隱私權連結在離線 app 內會變成 404。
 */
import { mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const www = fileURLToPath(new URL('../www/', import.meta.url));

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
const appFiles = ['index.html', 'privacy.html', 'terms.html'];
for (const file of appFiles) {
  copyFileSync(root + 'public/' + file, www + file);
}

// 版本記在一起，打包出來的 app 才說得出「裡面是哪一版的前端」
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
writeFileSync(www + 'build.json', JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString() }, null, 2));

const html = readFileSync(www + 'index.html', 'utf8');
if (!html.includes('原生外殼')) {
  console.error('✗ index.html 裡找不到〈原生外殼〉區段——app 會打不到後端');
  process.exit(1);
}
for (const file of ['privacy.html', 'terms.html']) {
  if (!readFileSync(www + file, 'utf8').includes('<html')) {
    console.error(`✗ ${file} 不是有效的 HTML——App Store 審查與訂閱頁需要能開啟法律頁`);
    process.exit(1);
  }
}
console.log(`✓ mobile/www/ 已產生（index.html ${(html.length / 1024).toFixed(0)} KB，版本 ${pkg.version}）`);
