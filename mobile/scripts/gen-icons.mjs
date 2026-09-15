/**
 * 從 public/icon.svg 產 App Store 要的 1024×1024 圖示，以及啟動畫面的 2732×2732 圖。
 *
 * 用 Chromium 把 SVG 畫出來再截圖：專案裡沒有任何影像處理相依，而 Playwright 本來就
 * 是 tools/ 底下瀏覽器檢查在用的東西（不進 package.json，需要時才裝）。從 repo 根目錄跑：
 *
 *   node mobile/scripts/gen-icons.mjs        # 也吃 PLAYWRIGHT_CHROMIUM
 *
 * 產物直接 commit 進 ios/App/App/Assets.xcassets——打包機器不必再裝任何東西。
 * 圖示改了才需要重跑。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const assets = root + 'mobile/ios/App/App/Assets.xcassets/';
const svg = readFileSync(root + 'public/icon.svg', 'utf8');

const { chromium } = await import(root + 'node_modules/playwright/index.mjs');
const launch = process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {};
const browser = await chromium.launch(launch);

async function shot(html, size, out) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: size, height: size }, omitBackground: false });
  await page.close();
  console.log(`✓ ${out.replace(root, '')} (${size}×${size})`);
}

// App Store 圖示：SVG 鋪滿整格。App Store 自己會切圓角，所以把 SVG 的圓角矩形拉成滿版。
const iconSvg = svg.replace(/rx="96"/, 'rx="0"');
await shot(
  `<html><body style="margin:0;background:#C9822E">${iconSvg.replace('<svg ', '<svg width="1024" height="1024" ')}</body></html>`,
  1024, assets + 'AppIcon.appiconset/AppIcon-512@2x.png'
);

// 啟動畫面：紙色底、圖示置中。三個檔名是 Capacitor 範本的（light / dark / universal）。
const splash = `<html><body style="margin:0;background:#F6F4EE;display:flex;align-items:center;justify-content:center;width:2732px;height:2732px">
  ${svg.replace('<svg ', '<svg width="420" height="420" ')}</body></html>`;
for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  await shot(splash, 2732, assets + 'Splash.imageset/' + f);
}
await browser.close();
