/**
 * 原生插件的接線檢查（零相依，放在 CI 的 `check` job）。
 *
 * 為什麼需要這個
 * ---------------------------------------------------------------------------
 * TestFlight build 7～10 追了四輪的那個 bug，根因是**一行沒有人驗過的接線**：
 *
 *     // SceneDelegate.swift
 *     window?.rootViewController = CAPBridgeViewController()   // ← 不是 MainViewController
 *
 * 插件是在 `MainViewController.capacitorDidLoad()` 裡註冊的，而那個類別從頭到尾沒有被
 * 用到——storyboard 雖然指著它，但 SceneDelegate 自己建窗戶，storyboard 那一份被丟掉。
 * 於是插件**從來沒有註冊過**。
 *
 * 這個失敗在 JS 那一側是最難查的形狀：`nativePromise` 回傳的 promise 不 reject、也不
 * resolve，**完全不會 settle**，啟動流程就停在 `await` 上。沒有例外、沒有 rejection、
 * 沒有任何事件。完整經過在 docs/postmortems/2026-09-16-app-silent-standalone.md。
 *
 * 為什麼是靜態檢查
 * ---------------------------------------------------------------------------
 * **CI 沒有 Mac**（`ios.yml` 才有，而且那是打包不是測試），所以能在**每個 PR 上自動跑**的
 * 只有「把原始碼讀出來比對」。
 *
 * 2026-09-17 起開發者有 Mac 了，模擬器與 `xcodebuild` 都跑得動——**那比這支腳本強得多**
 * （它只比對名字，看不見語法與型別）。但它靠人記得，而這支每個 PR 都跑。**兩者是地板與
 * 天花板，不是二選一**，所以不要因為「現在編得了」就把它拿掉。
 *
 * 它驗六件事，每一件都是「兩邊必須一致、卻沒有人檢查」的一處：
 *
 *   1. SceneDelegate 的 rootViewController 是 MainViewController（不是 CAPBridgeViewController）
 *   2. MainViewController 真的有註冊那個插件
 *   3. storyboard 的 customClass 也指著它（兩條路要一致，免得下一個人改了其中一條）
 *   4. **Swift 的 jsName／方法名與 index.html 呼叫的字串逐字相同**——同〈方案與上限〉
 *      那條「前後端 PLAN_LIMITS 逐字相同」：名字對不上的症狀不是報錯，是永遠不回話
 *   5. **推播的 AppDelegate 接線與 entitlements**——device token 只會從
 *      UIApplicationDelegate 回來，接不起來的症狀是「那通電話永遠不 settle」
 *   6. **訂閱的 product id 在 Swift 與 Worker 兩側逐字相同**——打錯的症狀是
 *      「買得下去，但買完還是免費版」，使用者付了錢而畫面沒有變
 *
 * 零相依、跑不到一秒，所以放在 `check` job 而不是要 Chromium 的 `smoke`。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(ROOT + p, 'utf8');

const IOS = 'mobile/ios/App/App/';
const problems = [];
const checked = [];
const fail = (msg) => problems.push(msg);

// ---- 1. SceneDelegate 用的是哪一個 view controller ----
const scene = read(IOS + 'SceneDelegate.swift');
const rootVC = scene.match(/rootViewController\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
if (!rootVC) {
  fail('SceneDelegate.swift 裡找不到 `rootViewController = XxxViewController()`——接線方式改過了，這支檢查要跟著更新');
} else if (rootVC[1] !== 'MainViewController') {
  fail(`SceneDelegate.swift 的 rootViewController 是 \`${rootVC[1]}\`，不是 MainViewController。`
     + '自寫的插件在 MainViewController.capacitorDidLoad() 裡註冊，換掉它等於插件永遠不存在，'
     + '而 JS 那一側的症狀是 promise 永遠不會 settle（build 7～10 的那個 bug）');
} else {
  checked.push('SceneDelegate → MainViewController');
}

// ---- 2. MainViewController 真的有註冊插件 ----
const mainVC = read(IOS + 'MainViewController.swift');
if (!/registerPluginInstance\s*\(\s*WorkScheduleNativePlugin\s*\(\s*\)\s*\)/.test(mainVC)) {
  fail('MainViewController.swift 沒有 `bridge?.registerPluginInstance(WorkScheduleNativePlugin())`——插件不會被註冊');
} else {
  checked.push('MainViewController 有註冊插件');
}
if (!/class\s+MainViewController\s*:\s*CAPBridgeViewController/.test(mainVC)) {
  fail('MainViewController 必須繼承 CAPBridgeViewController，否則 capacitorDidLoad() 不會被呼叫');
} else {
  checked.push('MainViewController 繼承 CAPBridgeViewController');
}

// ---- 3. storyboard 也要指著同一個類別 ----
const storyboard = read(IOS + 'Base.lproj/Main.storyboard');
if (!/customClass="MainViewController"/.test(storyboard)) {
  fail('Main.storyboard 的 viewController customClass 不是 MainViewController——兩條路不一致，'
     + '下一個人改回走 storyboard 時插件又會消失');
} else {
  checked.push('storyboard → MainViewController');
}

// ---- 4. 兩側的名字要逐字相同 ----
const swift = read(IOS + 'WorkScheduleNativePlugin.swift');
const html = read('public/index.html');

const jsName = (swift.match(/jsName\s*=\s*"([^"]+)"/) || [])[1];
const calledName = (html.match(/nativePromise\(\s*'([^']+)'/) || [])[1];
if (!jsName) fail('WorkScheduleNativePlugin.swift 裡讀不到 `jsName`');
else if (!calledName) fail("public/index.html 裡讀不到 `nativePromise('…'` 的插件名");
else if (jsName !== calledName) {
  fail(`插件名對不上：Swift 的 jsName 是「${jsName}」，index.html 呼叫的是「${calledName}」。`
     + '名字對不上時原生那側不會報錯，它只是不回話——promise 永遠不 settle');
} else {
  checked.push(`插件名一致（${jsName}）`);
}

// Swift 宣告的方法
const declared = new Set(
  [...swift.matchAll(/CAPPluginMethod\(\s*name:\s*"([^"]+)"/g)].map(m => m[1])
);
// index.html 實際會呼叫的方法（nativePlugin() 內的 call('xxx')）
const called = new Set([...html.matchAll(/\bcall\('([A-Za-z][A-Za-z0-9_]*)'\)/g)].map(m => m[1]));

if (!declared.size) fail('WorkScheduleNativePlugin.swift 裡沒有任何 CAPPluginMethod');
if (!called.size) fail("public/index.html 的 nativePlugin() 裡讀不到 call('…')");

for (const m of called) {
  if (!declared.has(m)) {
    fail(`index.html 會呼叫 \`${m}\`，但 Swift 的 pluginMethods 沒有宣告它——那一通電話永遠不會有人接`);
  }
  // Swift 那側也要真的有這個 @objc 函式，只列在 pluginMethods 不算
  if (!new RegExp(`@objc\\s+func\\s+${m}\\s*\\(`).test(swift)) {
    fail(`Swift 宣告了 \`${m}\` 卻沒有對應的 \`@objc func ${m}\``);
  }
}
// 反方向也要驗：**Swift 宣告了、前端卻沒有接進插件表**的方法。
//
// 這個洞是實際踩到的：Swift 有 requestPush，前端卻只寫了 `p.requestPush(...)` 而忘了
// 在 nativePluginCache 裡加上 `requestPush: call('requestPush')`——於是 `p.requestPush`
// 是 undefined，畫面上顯示「這個版本的 app 還不支援推播」。**兩邊各自看起來都對**，
// 而 JS 那側連錯都不算（讀一個不存在的屬性不會丟例外）。
for (const m of declared) {
  if (!called.has(m)) {
    fail(`Swift 宣告了 \`${m}\`，但 index.html 的 nativePluginCache 沒有接它——`
       + '前端讀到的會是 undefined，而讀一個不存在的屬性不會報錯，只會安靜地走進「不支援」那條路');
  }
}
if (called.size && declared.size && ![...called].some(m => !declared.has(m)) && ![...declared].some(m => !called.has(m))) {
  checked.push(`方法兩側完全對齊（${[...called].sort().join('、')}）`);
}

// ---- 5. 推播的接線（子專案 B）----
// device token 只會從 UIApplicationDelegate 的兩個 callback 回來，**不會**出現在插件裡。
// 所以 AppDelegate 收到之後要交給插件——**又一條跨檔案的接線**，與 build 7～10 那個
// 「storyboard 指著 A、實際跑的是 B」同一個形狀：兩邊各自看起來都對，合起來卻不通，
// 而且不報錯，只是永遠不回話（那通電話不會 settle）。
const appDelegate = read(IOS + 'AppDelegate.swift');
for (const [cb, why] of [
  ['didRegisterForRemoteNotificationsWithDeviceToken', 'token 回來了卻沒有人接，requestPush 的 promise 永遠不會 settle'],
  ['didFailToRegisterForRemoteNotificationsWithError', '註冊失敗時同樣沒有人接——失敗比成功更需要說話'],
]) {
  if (!appDelegate.includes(cb)) fail(`AppDelegate.swift 少了 \`${cb}\`——${why}`);
}
if (!/deliverPushToken/.test(appDelegate) || !/static func deliverPushToken/.test(swift)) {
  fail('AppDelegate 與插件之間的 deliverPushToken 接不起來——device token 送不回 JS');
} else if (appDelegate.includes('didRegisterForRemoteNotificationsWithDeviceToken')) {
  checked.push('推播的 AppDelegate 接線');
}

// entitlements：沒有 aps-environment 的話註冊推播在真機上直接失敗，而錯誤訊息
// （「no valid aps-environment entitlement」）看起來像簽章問題而不是設定漏掉。
//
// **值也要驗，不能只驗「有沒有這個字」。** `aps-environment` 決定 device token 是哪一台
// APNs 的：Release（TestFlight／App Store）一定要 production，Debug 一定要 development。
// 兩個 configuration 原本共用同一個寫死 development 的檔案，而這支檢查當時只問「有沒有
// 這一欄」——**整個 bug 從頭到尾它都是綠的**。填錯的症狀是推播送出去卻永遠收不到
// （400 BadDeviceToken），而那個字看起來像「token 壞了」，會往完全錯誤的方向查。
//
// 這裡驗不到的一件事要寫清楚：**Apple 後台的 App ID 有沒有勾 Push Notifications。**
// 沒勾的話 Xcode 會在簽章時安靜地把這一欄整個拔掉，打包照樣綠燈、照樣上傳得了
// （build 13 實際踩過）。原始碼這一側只能保證「我們有要求」，要不到是另一回事。
const pbxproj = read('mobile/ios/App/App.xcodeproj/project.pbxproj');
const APS = [
  { file: 'App.entitlements',      want: 'production',  config: 'Release' },
  { file: 'AppDebug.entitlements', want: 'development', config: 'Debug' },
];
let apsOk = true;
for (const { file, want, config } of APS) {
  const got = (read(IOS + file).match(/<key>aps-environment<\/key>\s*<string>([^<]*)<\/string>/) || [])[1];
  if (got === undefined) {
    fail(`${file} 沒有 aps-environment——真機上註冊推播會直接失敗`); apsOk = false;
  } else if (got !== want) {
    fail(`${file} 的 aps-environment 是 "${got}"，${config} 要的是 "${want}"`
       + '——症狀不是報錯，是推播送出去卻收不到（BadDeviceToken）'); apsOk = false;
  }
  if (!pbxproj.includes(`CODE_SIGN_ENTITLEMENTS = App/${file};`)) {
    fail(`project.pbxproj 的 ${config} 沒有指向 ${file}——檔案在，但建置時不會被用到`); apsOk = false;
  }
}
// 兩個 configuration 各指各的：只驗「兩個字串都出現過」的話，兩邊都指到同一個檔案
// （正是原本的狀態）也會過。
if (apsOk && pbxproj.split('CODE_SIGN_ENTITLEMENTS').length - 1 !== APS.length) {
  fail(`project.pbxproj 裡的 CODE_SIGN_ENTITLEMENTS 不是剛好 ${APS.length} 個——Debug 與 Release 要各指各的`);
  apsOk = false;
}
// Swift 那側在 #if DEBUG 回 sandbox、否則 production，與上面兩個檔案是同一組對應。
// 分家的症狀同樣是「送得出去、收不到」。
if (apsOk && !/#if DEBUG\s+return "sandbox"\s+#else\s+return "production"/.test(swift)) {
  fail('apsEnvironment() 的 #if DEBUG 分支與 entitlements 對不上（Debug→sandbox、Release→production）');
  apsOk = false;
}
if (apsOk) checked.push('推播的 entitlements（Debug／Release 各自的環境）');

// ---- 6. 訂閱的 product id 三側要逐字相同 ----
// Swift 拿它去跟 StoreKit 要商品、Worker 拿它當白名單、App Store Connect 是真正的來源。
// 打錯的症狀不是報錯，是**「買得下去，但買完還是免費版」**——使用者付了錢而畫面沒變，
// 而三個地方各有一份字串，沒有任何東西會發現它們不一樣。同 PLAN_LIMITS 那條。
// （App Store Connect 那一份沒有辦法從原始碼驗，只能在這裡把另外兩份釘在一起。）
const planApple = read('src/handlers/planapple.js');
const workerIds = [...planApple.matchAll(/'(com\.bounceto\.workschedule\.pro\.[a-z]+)'/g)].map(m => m[1]).sort();
const swiftIds = [...swift.matchAll(/"(com\.bounceto\.workschedule\.pro\.[a-z]+)"/g)].map(m => m[1]).sort();

if (!workerIds.length) {
  fail('src/handlers/planapple.js 裡讀不到任何 pro product id——PRODUCT_IDS 改過形狀了，這支檢查要跟著更新');
} else if (!swiftIds.length) {
  fail('WorkScheduleNativePlugin.swift 裡讀不到任何 pro product id');
} else if (workerIds.join(',') !== swiftIds.join(',')) {
  fail(`訂閱 product id 對不上：\n      Worker：${workerIds.join('、')}\n      Swift ：${swiftIds.join('、')}\n`
     + '      症狀不是報錯，是「買得下去，但買完還是免費版」');
} else {
  checked.push(`product id 一致（${workerIds.length} 個）`);
}

// ---- 結果 ----
if (problems.length) {
  console.error(`✗ 原生插件的接線有 ${problems.length} 個問題：`);
  problems.forEach(p => console.error('  - ' + p));
  process.exit(1);
}
console.log(`✓ 原生插件接線正確：${checked.join('、')}`);
