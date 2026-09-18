# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案性質

前端是**零依賴的單一 HTML 檔** `public/index.html`（約 4800 行，CSS + HTML + JavaScript 全在裡面）；後端是 Cloudflare Worker + D1。**必須登入才能使用**（2026-09-16 起，見〈登入閘門〉）：雙擊開啟只會看到「請登入」。

```
public/index.html      主應用（單檔，零依賴；沒登入只會看到閘門）
public/login.html      登入／註冊／忘記密碼（含 Turnstile）
public/reset.html      從信裡的一次性連結設定新密碼
public/admin.html      帳號管理（僅管理者）
src/index.js           路由與存取控制
src/crypto.js          PBKDF2 密碼雜湊、token 產生
src/session.js         session 建立／查詢／銷毀
src/turnstile.js       Turnstile siteverify
src/plan.js            方案（free / pro）：planOf、上限、「只有變多才擋」
src/handlers/          auth / state / admin / share / password-reset / appauth 等 API
src/apppurchase.js     App Store 購買證明（AppTransaction JWS）的離線驗簽
src/mail.js            AgentMail 寄信（逾期提醒與密碼重設共用），並把每一封的結果寫進 mail_log
src/throttle.js        登入失敗節流（email 與 IP 兩個維度）
migrations/            既有資料庫的欄位變更（schema.sql 的 IF NOT EXISTS 補不了欄位）
schema.sql             D1 資料表
wrangler.jsonc         Worker 設定與綁定
tests/                 occurrence 引擎、三方合併、樂觀鎖、富文字、變數遮蔽（node:test，零相依）
tools/                 開發用腳本：冒煙測試、勾選等價驗證、富文字管線驗證、語法檢查、密碼救援、解析官方辦公日曆表
.github/workflows/ci.yml  驗證與自動部署（見〈CI 與自動部署〉）
docs/postmortems/      事故紀錄（線上才會壞的坑，出過事就寫一份）
docs/superpowers/specs/ 設計文件
public/sw.js           service worker（加到主畫面／離線可用）
public/manifest.webmanifest, public/icon*.png|svg
public/privacy.html    隱私權政策（不用登入；App Store 審查要求）
public/terms.html      使用條款（不用登入；訂閱 app 的審查要求）
tools/lib/signed-in.mjs 瀏覽器驗證腳本過閘門用：把「登入過」寫進 cloudMeta
mobile/                iOS app 外殼（Capacitor；自己的 package.json，見〈iOS app〉）
.github/workflows/ios.yml  在 GitHub 的 Mac 上打包、簽章、上傳到 App Store Connect（手動觸發）
```

**前端沒有 build step。** 唯一的前端外部資源是 Google Fonts CDN，離線時退回系統字型但功能不受影響。

測試涵蓋幾塊容易改壞、又測得起來的部分（`npm test`），其餘一律靠實測：

| 檔案 | 涵蓋 | 抽取方式 |
|---|---|---|
| `tests/occurrence.test.mjs` | occurrence 引擎 | 從 `index.html` 抽真正的原始碼求值 |
| `tests/merge.test.mjs` | 三方合併 | 同上 |
| `tests/state.test.mjs` | `handlePutState` / `handleUpdateShared` 的樂觀鎖 | 直接 import Worker 端模組 |
| `tests/richtext.test.mjs` | 富文字過濾器的安全決策、v1→v2 遷移 | 從 `index.html` 抽真正的原始碼求值 |
| `tests/shadow.test.mjs` | 頂層函式被區域變數／參數遮蔽 | 對 `index.html` 做靜態掃描（追大括號深度） |
| `tests/holidays.test.mjs` | 內建國定假日清單的完整性 | 從 `index.html` 取出 `BUILTIN_HOLIDAYS` 求值 |
| `tests/ops.test.mjs` | cron 執行記錄、功能使用狀況 | 直接 import Worker 端模組 |
| `tests/ai.test.mjs` | AI 端點的限流、記錄、金鑰不外洩 | 直接 import，並注入假的 `fetch` |
| `tests/deps.test.mjs` | 前置作業的配對與擋環、「不在」不影響任何計算、`normalizeItems` 的 `noticeOnly` | 從 `index.html` 抽真正的原始碼求值 |
| `tests/absence.test.mjs` | `absences` 的正規化、v1→v2→v3 逐階升級、三方合併（含基準／遠端仍是舊形狀） | 從 `index.html` 抽〈富文字〉〈持久化〉〈三方合併〉三個區段求值 |
| `tests/appauth.test.mjs` | Bearer 與 cookie 並存、購買證明驗簽（五種失敗一種成功）、email 驗證碼、app 註冊／登入 | 直接 import；`tests/fake-apple.mjs` 用純 JS 的 DER 編碼器自己當 Apple 簽憑證鏈 |
| `tests/account-delete.test.mjs` | 刪除自己的帳號：每張表清空、**別人的每一列原樣**、session 失效 | 直接 import Worker 端模組 |
| `tests/cors.test.mjs` | iOS app 來源的 CORS：預檢、正常與錯誤回應都帶標頭、別的來源與同源不加、永不開 credentials | 直接打 Worker 的 `fetch` 入口 |
| `tests/plan.test.mjs` | 方案：`planOf` 與寬限、「只有變多才擋」、`PUT /api/state` 的 402 且列不動、管理者設方案、AI 上限依方案、**前後端 `PLAN_LIMITS` 逐字相同** | 直接 import；上限那一份從 `index.html` 抽出來比 |
| `tests/game.test.mjs` | 遊戲化引擎：按時＝到期那天結束前、沒安排的日子跳過、今天 missed 不斷、上線日之前不算、等級門檻、挑戰梯子、徽章、`setOccurrenceDone` 寫時間戳、**純告知不算安排** | 從 `index.html` 抽〈遊戲化〉區段求值（連同 date helpers 與 occurrence engine） |
| `tests/plan-apple.test.mjs` | 訂閱交易與 Apple 通知：只往後、退款往前、永久不被蓋、搬移、去重、驗簽失敗 401 | 直接 import；`fake-apple.mjs` 自己當 Apple 簽 |
| `tests/push.test.mjs` | 推播：APNs JWT 與快取、410 刪 token、換人登入搬 token、沒事不推、三個開關獨立、失敗不寫 ymd | 直接 import，攔 `fetch` 當假的 APNs |
| `tests/state.test.mjs`（下半） | 連續斷掉的信：`dayReport`、三個「不該寄」（沒斷、連續 < 2、開關關著）、同一天只寄一次、寄失敗不記錄、兩個開關互不影響 | 直接 import Worker 端模組，攔 `fetch` 當假信箱 |

前三者的挑選理由：前兩者近乎純函式、零 DOM 依賴；第三者是**競態**——靠併發碰運氣測不到，但可以把空窗做成確定性的。

`tests/holidays.test.mjs` 與 `tests/ops.test.mjs` 是另一類：兩者守的都是**「看不見」本身就是 bug**。假日貼錯不會壞掉畫面，只會讓順延算出看似合理的錯誤日期；cron 沒在跑不會有任何徵兆，因為失敗只留在 console。這兩種錯誤的共同點是「沒有人會發現」，所以只能靠測試把它們變成看得見的。

`tests/shadow.test.mjs` 是另一種性質：它不驗行為，而是擋掉一個已經發生兩次的 bug class（見下方「多語系」章節）。這種錯誤 `node --check` 過、其餘測試也過，執行時卻整段 render 消失，只能靠靜態掃描或人眼。

`tests/d1.mjs` 用 **Node 內建的 `node:sqlite`**（不是相依套件）搭出 D1 相容外殼，讓 handler 跑真正的 SQL。不自己造假的 DB 物件是刻意的：要驗的正是「帶條件的 UPDATE 有沒有改到一列」，那是 SQL 的語意，假物件等於把答案寫成期望值，測起來永遠會過。

### 前提（2026-09-16 改過）

**`public/index.html` 仍然是零依賴的單檔**（沒有 build step、不引任何套件），但**不再是「雙擊就能用」**：使用者的裁決是「必須登入才能使用」（付費牆——單機檔沒有上限也不用帳號，等於免費版的上限只要不登入就繞過去）。詳見〈登入閘門〉與 `docs/superpowers/specs/2026-09-16-subscription-design.md`。

保留下來的：**登入過的裝置離線時照常用本機資料**（PWA 的價值），偵測不到後端時的降級邏輯原樣。改掉的只有「從來沒登入過、又沒有後端」這一種情況：以前是示範資料，現在是閘門。

### 登入閘門

規則只有一條，寫在 `runCloudSync` 的 `absent` 分支與〈啟動〉：**後端不存在（file:// 或 404）而且這台裝置從來沒登入過（`cloudMeta.owner` 為空）→ 全螢幕「請登入」，不 seed、不 persist。**

- file:// 在第一次繪製前就決定（`gatedAtBoot`），不必等 `cloudPull` 回來——那樣會先閃一下示範資料。
- 登入過但斷線（`failed`）照舊用本機資料；app 不走這條（`nativeBoot` 自己擋）；線上網頁由 Worker 的 302 擋，閘門在那裡永遠不會出現。
- **它擋的是「順手」不是「刻意」**：`index.html` 誰都下載得到，閘門在瀏覽器裡改一行就拆得掉。真正擋得住的是伺服器端（同步、分享、提醒、AI 都要帳號；上限在 `PUT /api/state`）。不要為了「更安全」把閘門做複雜。
- **`tools/` 的瀏覽器腳本全部靠 `tools/lib/signed-in.mjs` 過閘門**（把 owner 寫進 cloudMeta，測的是「登入過、後端不在」）。不要在 `index.html` 加任何測試模式的開關繞閘門。`smoke.mjs` 的「單檔開啟」兩輪改成真的用 file:// 開，驗閘門出現、按鈕在、`workSchedule.v1` 不存在（證明沒 seed）。突變驗證過：拿掉 `verify-toggle` 的那一行它會紅。

### 常用指令

```bash
npm run dev            # wrangler dev，本機起 Worker + 靜態資產
npm run db:init:local  # 對本機 miniflare D1 建表（--local 的資料庫與遠端各自獨立）
npm run db:init        # 對遠端 D1 建表
npm run admin:reset    # 破窗鎚：直接改密碼（見〈破窗鎚〉）
npm run deploy         # 部署
npm test               # 全部測試檔（node:test，不需安裝任何東西；目前 375 個測試）
```

跑單一測試檔或單一測試（`npm test` 沒有轉發參數的管道，直接用 node）：

```bash
node --test tests/occurrence.test.mjs
node --test --test-name-pattern '樂觀鎖' tests/state.test.mjs
```

`tools/` 底下的三支瀏覽器驗證腳本各自起一個臨時 http server，直接執行即可；Playwright 不是本專案的相依套件（零相依是前提），需要時才自行安裝：

```bash
npx playwright install chromium        # 或設 PLAYWRIGHT_CHROMIUM 指向現成的 binary
node tools/smoke.mjs                   # 也吃 PORT 環境變數（預設 8963/8964/8951）
node tools/verify-toggle.mjs
node tools/verify-richtext.mjs
```

本機開發需要 `.dev.vars`（已 gitignore），內含 Turnstile 官方測試金鑰與測試用 `ADMIN_EMAILS`。

### CI 與自動部署

`.github/workflows/ci.yml`。三個 job，切法對應〈驗證方式〉那份清單：

| job | 內容 | 何時跑 |
|---|---|---|
| `check` | `npm test`、`tools/check-syntax.mjs`、`tools/check-sw-version.mjs`、`wrangler deploy --dry-run` | 每個 PR 與 main |
| `smoke` | `smoke.mjs`、`verify-toggle.mjs`、`verify-richtext.mjs`、`check-calendar.mjs`、`check-notes.mjs`、`check-contrast.mjs`、`check-deps.mjs`、`check-ambience.mjs`（要 Chromium） | 每個 PR 與 main |
| `deploy` | `npx wrangler deploy`，完成後打一次線上 `/` 確認回 302 | 只有 push 到 `main` |

幾個刻意的決定：

- **`smoke` 與 `check` 分開**是為了回饋速度：`check` 幾秒就有結果，`smoke` 要裝 Playwright 與 Chromium（約 150MB）。合在一起的話，一個分號打錯也要等瀏覽器裝完才看得到。
- **Playwright 用 `npm install --no-save`**，不進 `package.json`——零相依是專案前提，CI 容器用完就丟。
- **`deploy` 要等 `smoke` 也綠**。記在〈驗證方式〉第 0 條的兩次事故，單元測試當時全部是綠的，只有在瀏覽器裡走過那條路徑才看得見；少了這道關卡，那兩次一樣會上線。
- **部署後打一次線上 `/`**。`wrangler deploy` 回成功只代表**上傳**成功，Worker 啟動時丟例外的話回來的是 1101 而不是 302（register 那次事故就是這個形狀）。`run_worker_first` 保證 `/` 每次都經過 Worker，所以 302 是「有在跑、而且存取控制沒破」最省事的證據。
- **`deploy` 的 concurrency 不取消進行中的部署**（其餘分支的 CI 會取消）。部署砍在半路會留下不確定的線上狀態，排隊等前一次做完才對。

需要兩個 GitHub repository secret：`CLOUDFLARE_API_TOKEN`（用「Edit Cloudflare Workers」範本建立即可，不需要全帳號權限）與 `CLOUDFLARE_ACCOUNT_ID`。Worker 自己的 secret（`TURNSTILE_SECRET`、`AGENTMAIL_*`、`ADMIN_EMAILS`）不歸 CI 管，`wrangler deploy` 不會動到已經設定好的值。

### PR 一律用 squash 合併

已決定，不要再改回 rebase。兩者的差別只有這兩點，squash 的取捨是刻意的：

| | GitHub 顯示 Verified | commit 的 author |
|---|---|---|
| rebase | ✗（GitHub 不簽 rebase merge） | Claude |
| **squash** | **✓**（GitHub 以 web-flow 金鑰簽章） | 你，Claude 掛 `Co-authored-by` |

合併後的 commit committer 一律是 `noreply@github.com`——**任何**在 GitHub 上按合併的方式都是如此。所以若有工具要求 committer 為某個特定 email，那個警告在這個 repo 永遠會叫，可以忽略，不要為了消掉它去 amend 已合併的 commit。

**改完 `.dev.vars` 一定要完整重啟 dev server。** `wrangler dev` 只在啟動時讀一次該檔，而且 TaskStop 之類的終止方式殺不掉 wrangler 的子進程樹——留下的 workerd 孤兒會繼續佔住 port，造成「原始碼熱重載了、環境變數卻停在舊值」這種極難診斷的狀況（開發時實際踩過，繞很久）。重啟前先確認 port 真的空了：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*wrangler*" -and $_.CommandLine -like "*work-schedule*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

殺 workerd 之前要先殺它的 node 父進程，否則會被重新拉起。懷疑環境變數沒進去時，最快的定位法是讓 Worker 暫時回傳 `Object.keys(env)`（只回 key 不回值）。

### 驗證方式

0. **凡是新增「前端呼叫的函式」，一定要在瀏覽器裡把那條路徑真的走一次。** `npm test` 與 `node --check` 都抓不到「函式根本沒被定義」——前者不碰前端整合，後者只驗語法。逾期提醒就是這樣上線的：前端區段整段沒進檔案，`pushReminderSoon` 從未定義，而後端 API、cron、單元測試全部是綠的。症狀是登入後顯示「初始化失敗，僅使用本機資料」。
1. **動到 occurrence 引擎（日期／循環／假日／單次覆寫）一律先跑 `npm test`。** 測試直接從 `public/index.html` 抽出真正的原始碼求值，不是複製一份——複製一份出來測，測的是副本而不是實際跑的程式，那比沒有測試更糟。
2. 前端語法檢查——`node tools/check-syntax.mjs`（抽出三個 HTML 與 sw.js 的 inline script 編譯一次，錯誤直接指出 HTML 的行號）
3. `npx wrangler deploy --dry-run` 驗證 wrangler 設定
4. 起 `npm run dev`，用瀏覽器實際操作四個頁籤，確認 console 無錯誤
5. **動到 `mobile/ios/` 的 Swift 就在 Mac 上編一次**（見〈開發者有 Mac 了〉）。`check-native-plugin.mjs` 只比對名字，編不過的語法與型別它一個都看不見

`tools/` 底下有三支瀏覽器驗證腳本，把上面幾條從「請記得做」變成「跑得起來」。它們依賴 Playwright，而 Playwright **不是**本專案的相依套件（零相依是前提），所以刻意不在 `npm test` 內：

| 腳本 | 驗什麼 | 什麼時候一定要跑 |
|---|---|---|
| `tools/smoke.mjs` | 七輪：「單檔開啟 × 中英文」（file://，驗登入閘門）、「已登入 × 中英文」（走四個頁籤；中文那輪是免費版、撞上限要開升級說明，英文那輪是 Pro、要開新增表單）、「iOS app 外殼（假 Capacitor）」、「隱私頁與使用條款頁」、「**iOS app 外殼的九個探針**」：零 pageerror、零 console.error、每頁關鍵錨點存在；app 那一輪還斷言**所有打到線上網址的請求都帶 Bearer**，九個探針各塞一個殘缺（或刻意變慢）的 `window.Capacitor`／後端，驗「安靜地變成單機模式」的各種成因（見〈app 的九個探針〉） | **任何前端改動**。第 0 條的自動化版本 |
| `tools/verify-toggle.mjs` | 勾選的就地更新與完整重繪結果完全相同 | 動到 `renderBoard()` 或 `moveOccRowToDone()` |
| `tools/verify-richtext.mjs` | 富文字過濾器的整條管線（含 DOM 走訪）擋得住 16 種攻擊向量 | 動到富文字 |
| `tools/check-calendar.mjs` | 日曆的色條軌道對齊、跨月與週界的收邊、每日記錄的 ✎ 記號 | 動到 `renderCalendar()` 或日曆的 CSS |
| `tools/check-notes.mjs` | 每日記錄／專案筆記的格式（醒目提示、顏色、字級）與內容在離開後仍在 | 動到富文字、`persistSoon()` 或任何 debounce 寫入 |
| `tools/check-contrast.mjs` | 正文級文字在**兩種主題**下都達到 WCAG 對比（4.5:1／大字 3:1） | 動到任何顏色變數或文字顏色 |
| `tools/check-deps.mjs` | 前置作業的「待前置」徽章、不阻擋勾選；「不在」的標記**與逾期並存**；逾期的顏色就是 `--red` 且字重比旁邊重；**純告知的八個「不算進去」** | 動到 `dependsOn`、`absences`、`noticeOnly`／`isActionable`、`toggleOccDone`、逾期判斷或任何視覺改版 |
| `tools/check-migrate.mjs` | **舊備份檔真的匯得回來**：造一份 v1 的 .json 丟進 `#importFile`，走完整條使用者路徑，再讀 localStorage 看實際存進去的東西；順便驗「比目前新的版本被擋下來，而且不動現有資料」 | 動到 `STORAGE_VERSION`、`migrateSnapshot`、`snapshot()`／`applySnapshot()`。在 CI 的 `smoke` job |
| `tools/check-ambience.mjs` | 時段（早／午／晚）的 `data-daypart` 與光暈、每日記錄的提示語照日期決定、打勾的彈跳只在被點的那一個上、週一的回顧（含 N=0 不出現）、**遊戲化**：完美一天的 toast 只在勾掉最後一件時、升級的光只在升級那一次（看計算後的 `animationName`）、櫻花樹的畫皮（群組 class 與 CSS 對得上、垂下還在）、**開機的櫻花**（1200ms 的上限**在 JavaScript 關掉時**照樣成立、演到使用者現在那一階、reduced-motion 完全不出現）、reduced-motion 關 | 動到 `tick()`、`<head>` 開機腳本、`DAILY_PROMPTS`、`renderLookback()`、`.checkbox` 的 CSS、〈遊戲化畫面〉或 `.boot-sakura` |
| `tools/check-native-plugin.mjs` | 原生插件的接線，六件事：SceneDelegate → MainViewController → `registerPluginInstance`、storyboard 的 `customClass`、**方法名兩側完全對齊（雙向）**、推播的 AppDelegate 接線與 **`aps-environment` 的值（Debug／Release 各自的環境，並比對 Swift 的 `#if DEBUG`）**、**訂閱 product id 在 Swift 與 Worker 逐字相同**（零相依，在 `check` job） | 動到 `mobile/ios/` 的任何 Swift／storyboard／entitlements，或 `index.html` 的〈原生外殼〉區段；CI 會自動跑 |
| `tools/check-sw-version.mjs` | 動到 `public/*.html` 時 `sw.js` 的 `CACHE` 有沒有跟著加（零相依，在 `check` job） | 任何前端改動；CI 會自動跑，本機 `node tools/check-sw-version.mjs origin/main HEAD` |
| `tools/measure-board.mjs` | 切換檢視／篩選／搜尋卡住主執行緒多久（自己造 64／150／300 項的資料） | 動到 `renderBoard()` 或看板的 CSS。**不在 CI**：數字隨環境浮動，設門檻只會製造沒有人相信的紅燈，用途是改動前後各跑一次自己比對 |
| `tools/check-mobile.mjs` | 手機（iPhone 13、CPU 降速 4 倍、64 個項目）：五頁都不橫向溢出（**中英文各量一次**——英文字串比中文長，只量中文的話驗不到最容易溢出的那一種）、切換與互動的停頓、**點擊目標大小** | 動到任何版面或 CSS。同樣不在 CI |

（`tools/check-syntax.mjs` 不在這張表裡：它零相依、跑不到一秒，已經放進 CI 的 `check` job 與上面〈驗證方式〉第 2 條。）

`smoke.mjs` 的頁籤走訪現在只在「已登入」那兩輪（「單檔開啟」變成閘門檢查）。逾期提醒那次事故只在登入後才踩得到（`runCloudSync` 才會呼叫到缺失的函式），所以那兩輪一定要用假後端真的走完 `runCloudSync`，不能只開靜態檔。

### 降級可以，沉默不行

`initCloudSync()` 的 catch 會把同步降級成單機模式——這是對的，同步壞掉不該連累本機使用。但它原本**什麼都不印**，畫面只顯示「初始化失敗」而 console 一片乾淨，使用者回報時完全沒有線索，只能逐行讀程式碼猜（實際踩過）。

任何「吞掉例外並降級」的地方都必須 `console.error` 把 stack 記出來。降級與沉默是兩件事。

**而且「沒有人吞」不等於「有人看見」。** `nativeBoot(...)` 原本是 fire-and-forget 的 async 呼叫，沒有 `.catch`：它摔倒時例外不會被吞掉，但會變成 **unhandledrejection**——連 `pageerror` 都不算，`tools/smoke.mjs` 的錯誤收集器看不到，手機上更沒有 console。結果與被吞掉一模一樣：畫面停在示範資料、狀態列一片乾淨（見 `docs/postmortems/2026-09-16-app-silent-standalone.md`）。**沒有 await 的 async 呼叫一律要接 `.catch`**，而且那個 catch 要把原因寫到畫面上，不是只寫進 console。

**而且不同的降級原因必須分得出來。** `cloudPull()` 原本對任何非 2xx 都回 `null`，於是「沒有這個端點（單檔／未部署）」與「端點在但這次失敗（5xx、網路中斷、回應不是 JSON）」變成同一個值——後端一次 502 就靜默變成單機模式、狀態列被清空，**畫面與雙擊檔案離線開啟完全一樣**，使用者以為還在同步，實際上變更只留在本機。現在它回 `{ kind: 'ok' | 'absent' | 'failed' | 'expired' }`，只有 `absent` 靜默，`failed` 會 `console.error` 並在狀態列顯示「連線失敗，暫時只用本機資料」。

UI 類的改動（版面、行動版、主題）**必須真的用瀏覽器看過**，靜態檢查看不出破版。行動版另有 `tools/check-mobile.mjs`——它把 CPU 降速 4 倍並自己造 64 個項目，因為**開發時踩不到手機**：桌機視窗寬、CPU 快、示範資料只有 6 項。三個真實的 bug 是它抓到的：AI 面板把送出鍵擠成 20px 寬（完全按不到）、勾選框只有 24×24（整個 app 最常按的東西），以及 AI 面板是全 app 唯一沒補 `env(safe-area-inset-*)` 的固定元素（真機上底部被 home indicator 蓋住）。這批改動就是靠實測才抓到三個問題：側欄變成看不見的全屏遮罩、任務列撐破卡片、甘特圖把行動版的版面視窗從 390px 撐成 425px。

**改動同步邏輯時，必須把六個情境都測過**（見下方「雲端同步」章節），因為它們彼此的差異只在啟動時的分支條件，很容易只修好一條路徑。

`工作排程確認系統_專案說明.md` 是給使用者看的功能總覽與交接文件；README.md（英文，主要版本）與 README.zh-TW.md（繁體中文）含部署步驟。改動功能時三者都要同步更新；README.ja.md／README.ko.md 只維持連結正確，內容允許落後。

## 檔案內部結構

### 「我的帳號」分頁

帳號相關的設定原本散在 header 與 **footer**——逾期提醒與行事曆訂閱這種「要停下來設定」的東西被放在整頁最底部。結果可以量化：系統上線至今 `ics_feed` 是 0 筆，兩位使用者的提醒也一直是關的。**沒有人找得到的功能等於不存在。**

分頁裡的每一個控制項都是**從原位置搬過來的同一個元素（id 不變）**，因此既有的 `.onclick` 綁定一行都沒改。這是刻意的：重寫等於為了版面而讓一批本來就正常的功能重新冒險。**不要改成「兩邊各放一份」**——同一個設定兩個顯示位置，狀態遲早不同步。

- **單機模式下分頁仍然存在**，只有雲端相關的區塊（帳號／提醒／訂閱／裝置）隱藏，並顯示一行說明。整個分頁消失會讓使用者以為功能不見了。
- **顯示偏好（主題／語言）只有這一頁能改**，右上角的圖示按鈕已移除。代價是切暗色多一次點擊，可接受的理由是沒手動選過時主題本來就跟隨系統。
- **「登出」也搬進來了**（2026-09-16）。它原本留在 header 當一顆 11px 的灰色小按鈕，而使用者實際回報「登入後沒有登出的選項」——帳號相關的東西大家都來這一頁找，留在 header 等於不存在。搬的是**同一個元素、id 不變**，`.onclick` 一行都沒改（含 app 裡清 Keychain 那條路）。header 只留 email，回答「現在是誰登著」。`tools/smoke.mjs` 的斷言**綁在 `#viewAccount #btnLogout`**，不是全文件的 `#btnLogout`——後者搬回 header 也會是綠的，而那正是要擋的狀態。突變驗證過：搬回去當場紅。
- 新增的前端函式一律加 `acct` 前綴：這一段一次加了好幾個頂層函式，而遮蔽事故發生過兩次（見〈多語系〉）。
- **`tools/smoke.mjs` 已擴充到走這一頁**。原本它的路徑裡沒有新分頁——為了抓這類 bug 而存在的檢查，卻剛好不涵蓋新加的東西，等於沒有。實際以「拿掉 `themeBtn` 的 markup」驗證過它會紅（`Cannot set properties of null (setting 'onclick')`）。

| 行數範圍 | 內容 |
|---|---|
| 15–26 | `<head>` 內的**開機腳本**（見下方說明），唯一在主 IIFE 之外的 JS |
| 41–675 | `<style>`。`:root` 的 CSS 變數是所有顏色的唯一來源，`[data-theme="dark"]` 覆寫同一組變數 |
| 677–1064 | `<body>` 靜態骨架。**所有 modal 都預先寫死在 markup 裡**，靠 `.overlay` 的 class 切換顯示 |
| 1065–4774 | 單一 `<script>`，整段包在一個 IIFE 內 |

行號會隨改動漂移，別當精確座標用。要定位某個功能請找區段註解（`// ================= 名稱 =================`），`grep -n '^\s*// =\+ .* =\+$' public/index.html` 會列出全部 27 個。

因為全部包在 IIFE 裡，**沒有任何東西暴露在 global scope**——所以不能用 inline `onclick="..."` 屬性，事件一律在 JS 內用 `.onclick = fn` 綁定。新增 UI 時請沿用此模式。

### `<head>` 的開機腳本是刻意的例外

`<head>` 裡那段 IIFE 只做一件事：讀 `workSchedule.v1.theme` 並把結果寫成 `<html data-theme>`。**它必須在 `<style>` 與 `<body>` 之前執行**，否則暗色使用者每次載入都會先閃一下亮色底再切過去。放進主 script 就晚了——那時候畫面已經畫過一次。

它同樣不暴露任何全域變數，也不碰 IIFE 內的東西，所以與上面那條規則不衝突。字型 link 的 inline `onload`（只碰 `this`）是同一類例外，理由記在〈字型不阻擋首次繪製〉。

### 顯示偏好不進 `snapshot()`

主題與語言是**這台裝置的顯示偏好，不是排程資料**，各自存自己的 localStorage key。跟著雲端同步走的話，在桌機切成暗色會連手機一起變。

| key | 內容 |
|---|---|
| `workSchedule.v1` | 排程資料本體（`snapshot()` 的序列化結果） |
| `workSchedule.v1.unreadable` | 套用不了的存檔備份（見〈儲存層的三個設計約束〉第 4 點） |
| `workSchedule.v1.cloudMeta` | 雲端同步的版本號、`owner` 與 `baseSnapshot` |
| `workSchedule.v1.theme` / `.lang` | 主題／語言偏好 |
| `workSchedule.v1.rtToolbar` / `.activitySeen` | 富文字工具列展開狀態、操作記錄已讀位置 |

主題只在使用者**沒有手動選過**時跟隨系統（`prefers-color-scheme` 的 change 監聽器會先檢查 `readThemePref()`）；選過之後系統再怎麼切都以使用者的決定為準。新增顏色一律加進 `:root` 與 `[data-theme="dark"]` **兩組**變數，不要在個別選擇器裡硬寫色碼——漏掉暗色那一組的症狀是「白天看起來正常，暗色模式下某一塊變成看不見的低對比」。

### 刪除一律走 `deleteWithUndo()`

刪除不用 `confirm()` 攔截——攔截式對話框擋不住「按太快」，事後復原才擋得住。`deleteWithUndo(desc, mutate)` 先拍一份 `snapshot()` 再 `commit(mutate)`，並顯示 6 秒的復原 toast；復原就是把整份快照 `applySnapshot()` 回去。

**整份還原是刻意的取捨**：逐項還原的閉包版本更精緻，但整份還原用的是既有且測過的 `applySnapshot()` 機制。代價是復原也會撤銷這幾秒內的其他小變更，以刪除到復原的間隔而言可以接受。新增刪除操作時請沿用這個函式，不要自己 `commit(()=>{ ... })` 了事——那樣就沒有復原了。

## 核心架構：occurrence 引擎

這是整份程式碼最重要、也最容易改壞的抽象，動任何跟日期／循環有關的東西之前務必先讀懂。

**循環項目的每一次發生（occurrence）從不被儲存，而是每次 render 時即時算出來的。**

- `items[]` 只存「錨點日期 + 循環規則」
- `getOccurrencesInRange(item, start, end)` 展開成實際日期清單
- 產出的 occurrence 物件形狀：`{ item, date, occKey, done }`（程式中一律簡稱 `occ`）

### occKey 是整套設計的關鍵

`occKey` 用來識別「同一個 item 的第幾次發生」：

- 非循環項目：固定字串 `'single'`
- 每週／每兩週：`'W' + YYYY-MM-DD`（**未經假日調整**的原始日期；一週可複選多天，每天各是一次）
- 每月循環：`'YYYY-MM'`（固定日期與「第 N 個週 X」兩種模式共用同一格式，互換不會失去紀錄）
- 每季循環：`'YYYY-QN'`
- 每年循環：`'Y' + YYYY`

每週類用原始日期而非調整後的日期，是為了讓「這一次」的身分不隨假日設定改變。若用調整後的日期，使用者事後新增一個自訂假日就會讓該次換一個 key，先前的完成／覆寫紀錄整批對不上。

所有「單次」狀態都以 occKey 為 key 掛在**母項目**上，而不是複製出獨立項目：

- `item.done`（單次）／ `item.doneMap[occKey]`（循環）— 完成狀態
- `item.overrides[occKey]` — 覆寫該次日期
- `item.skipped[occKey]` — 略過該次

這就是為什麼調整或略過某一次不會影響其他週期。任何新增的 per-occurrence 功能都應遵循同一模式（掛一個新的 `occKey -> value` map 在 item 上），不要為了單次差異而 fork 出新 item。

**但這也是最容易踩的坑**：occKey 的格式跟頻率綁定，頻率一改（每月 ↔ 每季 ↔ 不循環）舊 key 全部對不上。因此 `btnConfirmItem` 在偵測到頻率變更時會清空 `done`／`doneMap`／`overrides`／`skipped`（modal 內有 `#recurChangeWarn` 事先警告）。若未來新增循環頻率，**必須同步更新這段清除邏輯**，否則會留下孤兒資料——症狀是改回原頻率時舊紀錄整批「復活」。

### 優先順序與邊界

- **覆寫日期優先於假日規則**：`getOccurrencesInRange` 內若存在 `overrides[occKey]`，就直接採用該日期，完全跳過 `adjustForHoliday()`
- `isHoliday()`：`customWorkdays`（補班日）優先——在集合內就是工作日；否則週六日或落在 `customHolidays` 內為假日。`adjustForHoliday()` 逐日 ±1 推移直到非假日
- `recurrence.count`（重複 N 次後停止）數的是**排程上的次數**，與是否被略過、是否落在檢視區間無關——否則略過一次會讓循環多出一次。也因此有 count 時每週類不能快轉，必須從錨點數起
- 循環設定一律經 `normalizeRecurrence()` 產生 canonical 形狀（modal 儲存與 applySnapshot 共用）。三方合併以 stableStringify 比對，欄位集不一致會把「沒改過」誤判成「兩邊都改過」
- 假日調整**只作用於循環項目**，非循環項目的日期原樣使用
- **跨多天事項**（`item.endDate`，僅非循環）：引擎以「與檢視區間重疊」判斷、仍只回**一筆**（occKey `'single'`，完成狀態整段共用）；日曆的逐日鋪排是 `renderCalendar` 自己的顯示邏輯，不是引擎的職責。循環＋區間刻意不支援——每一次都要有自己的區間會讓 occKey 與完成語意複雜化。逾期以結束日判斷，進行中不算
- 展開迴圈有兩道保險：`guard < 800`，以及 `cursorY > rangeEnd.getFullYear() + 2` 就中止。新增循環頻率（例如每週）時必須確認這兩個上限仍然合理，否則會在長區間靜默漏算

## 前置作業與「不在」：兩個刻意什麼都不做的功能

設計文件在 `docs/superpowers/specs/2026-09-08-tags-subtasks-deps-away.md`。兩者都曾經被設計成「會改變逾期的意義」，而**使用者的裁決把那一段砍掉了**：

> 不在就是不在，逾期就照樣逾期。

所以這兩個功能的規格有一大半是**「什麼都沒發生」**——而那是靜態檢查與單元測試最看不到的形狀：改成「更聰明一點」之後，畫面看起來還是對的。

| 功能 | 做什麼 | **不做什麼**（改了就是 bug） |
|---|---|---|
| 前置作業 `item.dependsOn` | 前置沒完成時，那一列標「⛓ 待前置」；勾下去時跳一句提示 | 不順延日期、不阻擋勾選、不影響逾期 |
| 「不在」`absences`（kind=away） | 日曆格子右上角 🌴；那天到期的列上多一個 🌴 附註 | 不進 `isHoliday()`、不順延、**不豁免逾期** |
| 「休假」`absences`（kind=leave） | 整格一層玻璃紙 ＋ 中間的浮水印圖示；列上多一個附註；**那一天的信與推播整批不送** | 同上，**一樣不豁免逾期**；不影響指標卡、連續天數與 ICS |
| 純告知 `item.noticeOnly` | 列上標「純告知」；過期改標「已過」並降一階字級 | **八個地方全部不算**（見下方專節）：不長勾選框、不逾期、不進四張卡與已完成區、不算遊戲化與範圍列的分母 |

`tools/check-deps.mjs` 把這些「沒發生」變成看得見的斷言，其中最重要的一條是**逾期標記與 🌴 必須同時出現在同一列**。突變驗證過五種改法都會紅。

### 純告知：一個開關，八個「不算進去」

`item.noticeOnly`（布林）。**不做成第四種 `type`**：`type` 已經承載了顏色與分類（work／meeting／assignment），而「這是工作還是會議」與「我要不要做它」是**兩個互相垂直的問題**——一場只是要知道、不必準備的會議，兩邊都要表達得出來。做成開關還有一個免費的好處：跨多天事項（`item.endDate`）自動就有了。

「算進去」在這份程式碼裡有**八個**地方，全部問同一個述詞 `isActionable(occ)`：

| 地方 | 純告知 |
|---|---|
| 今日待辦卡 / 本週待辦卡 | 不進去 |
| 逾期卡與列上的紅字 | **永遠不逾期** |
| 今日會議卡 | 不進去 |
| 勾選框（看板、日曆格子、跨多天色條、**共享頁**） | **不長勾選框** |
| 已完成區 | 永遠不進去 |
| 「只看未完成」 | **不受影響，一直都在** |
| 遊戲化（`dayVerdict` / 連續 / XP / 角色） | 不算。那天只有純告知＝`empty` |
| 範圍列的三顆數字 | 不算分母 |

**不要在八個地方各寫一次 `!o.item.noticeOnly`。** 那正是〈勾選不重建看板〉警告過的「在增量路徑複製一份遲早會走鐘」，而走鐘的症狀是**「畫面看起來是對的，只是數字不對」**——沒有人會發現今天的待辦卡多了一件不用做的事。

**「只看未完成」是唯一的例外方向**：純告知本來就不是待辦，把它藏起來等於把使用者放進去的資訊弄不見。

通知那一側：**行事曆訂閱有，提醒信與推播沒有**（`buildReminderDigest()` 濾掉）。理由與〈休假那幾天閉嘴〉是同一條——行事曆是「我自己去翻」，信與推播是「它跑來找我」。ICS 裡那幾筆**不帶 VALARM**；目前整個 `buildICS()` 一個 VALARM 都沒有，所以不必特別擋，但**日後要加提醒鬧鐘時，純告知那幾筆要跳過**。

**共享頁那一格不能漏。** 擁有者標成「不用做」的東西，被分享者若還勾得動，那一勾會寫回擁有者的雲端資料——那是別人替你決定一件事做完了。

**過期之後留在看板上**，加 `.notice-past`：字級降一階、小標從「純告知」換成「已過」，顏色走 `--notice`／`--text-muted`。**淡化不能只靠把顏色調淡**——〈「畫面上沒有這個元素，略過」是一條永遠不會執行的斷言〉那一節抓到過兩個已經上線很久的案例，修法都是「階層改用字級表達」。`tools/check-contrast.mjs` 因此**主動造一件過期的純告知**再量（示範資料那一件在未來，等它自然出現就是空的斷言）。

### 為什麼前置作業不自動順延

「A 延後了，B 自動跟著延後」聽起來才是這個功能的重點，但它做的事是**在使用者沒看的時候改掉一個日期**——與〈AI 小幫手〉那條「AI 把日期改錯一天你永遠不會發現」是同一種失敗模式，差別只在誰動的手。畫面看起來完全正常，只是那個日期默默地不對了。

### 為什麼「不在」不順延、也不豁免逾期

假日順延是**事前規則**：使用者在 modal 裡明確選過 `holidayRule`，而且國定假日是全年已知的。「不在」是**事後才知道的事實**（臨時請假）。拿它回頭移動日期會讓歷史紀錄變成假的——那件事本來就排在那天，只是人不在。

豁免逾期同理，而且更嚴重：這個系統的核心價值是〈視覺基調〉那一節的紅線，「該緊張的時候要讓人緊張」。把不在的日子調成不逾期，畫面會顯得更體貼，實際上是把這個工具存在的理由關掉。

### 配對規則：「這一次的日期或之前，最近的那一次」

**刻意不要求兩邊頻率相同**——那條管制藥品的鏈（申報 → 跟催 → 覆核 → 歸檔）本來就月／週混用。改成「occKey 相同才算」會讓整條鏈當場斷掉。找不到就視為沒有前置（B 的第一次早於 A 的第一次），**不是**「有一個沒做完」。

展開窗口有兩道限制，兩道都不能拿掉：

- **往前多留 45 天**（> `adjustForHoliday` 的 40 天上限）：`holidayRule='advance'` 會讓第一次落在錨點之前，從錨點當日開始展開的話那一次會被區間判斷濾掉，症狀是「明明有前置卻標不出來」。
- **循環項目往前最多 400 天**（> 最疏的頻率每年＝365 天）：不收斂的話成本會隨資料的**年齡**成長。量過：30 對「每週依賴每週」、前置從三年前開始、3120 列，切換頁籤 5 次是 558ms（無前置）／2991ms（不收斂）／1476ms（收斂）。**非循環的前置不能套這個下限**——它只有一次，五年前的那一次仍然是它，砍掉的話會與「前置已完成」長得一模一樣。

### 擋環是必要的，而且要擋在候選清單那一側

`A → B → A` 會讓顯示邏輯無限遞迴。modal 的候選清單**當場濾掉會繞成圈的項目**，而不是選完再跳錯誤——選不到的東西不會被選到，也不必解釋為什麼不行。

但 UI 擋得住手動繞環，**擋不住三方合併**：本機加了 `A → B`、另一台加了 `B → A`，「兩邊各自新增的都保留」就把兩條線一起留下來了。所以 `depWouldCycle` 內的 `seen` 集合不是最佳化而是正確性——少了它，存檔裡真的有環時整個分頁會當場卡死（有測試守著，突變驗證時實際跑出 timeout）。

### 勾掉一個「別人的前置」時必須落回完整重繪

`toggleOccDone` 的增量路徑（`moveOccRowToDone`）只搬走被勾的那一列，其餘上千列原地不動。但被勾的若是別人的前置，別人那幾列的「待前置」徽章就停在舊狀態——**畫面看起來完全正常，只是資訊是錯的**。因此 `isPrerequisiteOfAnything()` 為真時一律走完整的 `renderAll()`。這種情況少，代價可以接受。

### 休假那幾天閉嘴，但畫面上的紅字一個字都不動

這是〈休假不豁免逾期〉的**另一面**，兩條合起來才是完整的規則：

| | 畫面（紅字、指標卡、連續天數、ICS） | 主動送出去的（提醒信、櫻花樹的信、三種推播） |
|---|---|---|
| 「不在」away | 照常 | **照寄照推**——人仍在上班 |
| 「休假」leave | **照常，一個字都不改** | **整天不送** |

差別在**誰開口**。畫面是使用者自己去看的，他休完假回來要看到真實的狀況；信與推播是系統主動去打擾他，而請假那天的打擾沒有任何用處——逾期的事情他也做不了。

幾個不能拿掉的判斷：

- **判斷在前端**（`buildReminderLeaveDays()`），Worker 只問「今天在不在清單裡」。同 `ot`、`streak_current`、ICS 與逾期提醒本身：日期語意只存在 `index.html` 裡，在 Worker 重寫一份必然分歧。
- **只列 leave，不列 away。** 兩者在 `absences` 裡是同一份資料的兩種 kind，差別只在這一個 filter——所以 `tools/smoke.mjs` 的斷言分兩半：休假那天**在**裡面、出差那天**不在**裡面。只驗前者的話，把 away 一起列進去仍然是綠的。
- **整天跳過，不是把那幾項挑掉。** 挑掉會寄出一封說「你有 3 件事」但實際漏講 2 件的信——那比不寄更糟，因為收件人會以為那就是全部。
- **跳過的那一天不寫 `last_sent_ymd` / `streak_mail_ymd` / `push_*_ymd`。** 同「寄失敗刻意不寫」：沒送就不算送過，休假結束的第一天要能補上。
- **櫻花樹的信問的是「今天在不在休假」，不是「斷掉的那一天」。** 昨天請假、今天上班的人照樣收得到——他的連續確實斷了，櫻花樹講的是事實；那封信只是選在他人在的時候講。
- **`leave_days` 解析不了就當成「沒有休假」照寄。** 反過來（當成休假）的症狀是「提醒從某一天起靜靜地不見了」，而多收一封信看得見。
- **`buildReminderLeaveDays()` 的窗口與 `buildReminderDigest()` 刻意用同一個**（回看一年、前瞻三個月）。兩個窗口就是兩份要維護的規則，不一致的症狀是「某一天該閉嘴卻寄了」——沒有人會發現。

**這條路徑 `npm test` 證明不了。** `buildReminderLeaveDays()` 只在 cloudPush 成功後 3 秒才被呼叫到，少寫一個字母不會有任何徵兆（〈驗證方式〉第 0 條）。所以 `tools/smoke.mjs` 的假後端會**把 `PUT /api/reminder` 的 body 收下來**，已登入那兩輪走完之後檢查它。突變驗證過：away 一起列進去、永遠回空陣列、body 裡不帶 `leaveDays`，三種都當場紅。

### 「不在」只有一個設定入口

日曆的詳情區那顆按鈕，單日與拖曳選出的區間都適用。**刻意不做批次貼上框**（自訂假日那種）：同一份狀態兩個入口遲早不同步，而「不在」一次也就那幾天。

2026-09-17 起那顆按鈕**開的是面板而不是直接切換**——要選種類、時段與圖示，一顆切換按鈕表達不了。面板只做四件事：看現有的、加一筆、刪一筆、選圖示。**刻意不做「編輯既有的一筆」**：刪掉再加一次一樣快，而編輯要多一組「正在編哪一筆」的狀態，那是這個一年用不到幾次的功能不值得的複雜度。

圖示是**一組九個的固定清單**，不是自由輸入：自由輸入要處理貼進一整段文字、輸入法中途的組字，以及「這是不是一個 emoji」這個沒有好答案的問題。

### 休假的底色是一層偽元素，不是 `background-color`

`.cal-cell` 的 `background` 已經被「今天」與「已選取」用掉了（這是〈「不在」用斜線紋〉那條規則的原話）。休假若直接搶走它，**「今天剛好休假」那一格的琥珀色會不見**——而「今天在哪裡」是整個日曆最重要的一格。

所以休假走 `.cal-cell.leave::before`：一層低 alpha 的色片疊在上面，底下的琥珀色、選取的灰色、不在的斜線紋都還透得出來。`tools/check-deps.mjs` 有四條斷言守著（沒搶走 background、底色是偽元素那一層、今天＋休假底色一個位元都沒變、日期數字仍是琥珀）。突變驗證過：改成 `background` 當場紅三條。

**兩個角落記號（🌴 ✎）不能寫進「內容壓在玻璃紙之上」那條 z-index 規則。** 它們是 `position:absolute`，而那條規則同樣的優先度又排在後面，會把 absolute 蓋成 relative——兩個記號當場掉回文字流、日期數字被往下推。只補 `z-index`、不碰 `position`。這個 bug 是**新加的位置斷言抓到的**：原本只斷言「畫得出 🌴」，而掉回文字流之後它仍然畫得出來。

**`--leave` 是量出來的，不是挑出來的。** 第一版 `#3F6B4F` 在亮色下只有 4.45:1（差 0.05），`tools/check-contrast.mjs` 新增的那個 pass 當場抓到，改成 `#355942` 之後 5.74:1。那個 pass 必須**主動造一格休假出來**再量——等它自然出現就是〈永遠不會執行的斷言〉。

### 資料模型的收尾

新增 `item.dependsOn` 與頂層 `absences`（2026-09-17 之前叫 `awayDates`）時同步改過的地方，漏一個就是靜默的資料遺失：`snapshot()` / `applySnapshot()` / `normalizeItems()` / `threeWayMerge()`（`tmMergeSets`、`tmMergeAbsences`）/ `clearLocalData()` / `seed()`。`item.doneAt`（遊戲化的完成時間戳）也走過同一份清單，外加 `mergeSharedEdit`（被分享者勾選時伺服器要一起帶回，否則那一次永遠「沒有時間」）與改頻率時的清空。`normalizeDependsOn` **排序**的理由同 `normalizeTags`：三方合併以 stableStringify 比對整個項目，順序不同會被誤判成「兩邊都改過」。它也會剪掉指不到東西的 id——執行時雖然有「找不到就當作沒有前置」的守衛，正因為畫面不會壞，不剪就會靜靜地一直留在存檔裡。

## 狀態與資料模型

所有狀態都是 IIFE 內的 module-scoped `let`，透過 `localStorage`（key = `workSchedule.v1`）持久化。

檔案最底部的 `seed()` 會塞入示範資料（兩個大項目、六個小項目、一個含三項任務的甘特專案），**只在沒有存檔時執行**。改動資料模型時記得一併更新 seed 與 `STORAGE_VERSION`，否則舊存檔載入後會壞。

### 唯一的寫入入口：`commit()`

```js
commit(()=>{ /* 改資料 */ });   // → 重算年份 → 存檔 → renderAll()
```

**任何會改動資料的操作都必須走 `commit()`**，不要自己呼叫 `persist()` 或各別的 render。漏走一次就是「畫面對了但沒存檔」的靜默 bug。

例外只有兩類，都是刻意的：
- **純檢視切換**（mode tabs、年份／季別／月份選擇、日曆翻月、選日期）直接呼叫 `renderScheduleView()`／`renderCalendar()`——不改資料，不需存檔
- **高頻輸入**（每日記錄、專案筆記 textarea、甘特任務改名）用 `persistSoon()` 做 400ms debounce，避免每個字元寫一次 localStorage。**但離開前必須結帳**——見〈高頻輸入的 debounce 必須在離開前結帳〉

### 儲存層的三個設計約束

1. **所有 `localStorage` 存取都必須包 try/catch。** Claude Artifact 的沙盒 iframe 會封鎖 localStorage 並拋 `SecurityError`，沒包就整個 app 當場掛掉。失敗時降級為記憶體模式（footer 會自動改文案），功能全部照常。
2. **`persist()` 每次都實際嘗試寫入**，不拿 `storageAvailable` 當開關跳過。配額滿是可恢復的錯誤，使用者刪掉資料後應該自動恢復存檔；一次失敗就永久停用會讓存檔靜默死掉。`storageAvailable` 只用來決定 footer 文案。
3. **`snapshot()` / `applySnapshot()` 是本機與雲端共用的序列化格式。** 新增狀態欄位時只改這兩個函式，否則必定有一邊漏掉。
4. **套用不了的存檔要先備份再被覆蓋。** 啟動流程是 `loadState()` 失敗 → `seed()` → `persist()`，也就是說**那份存檔會被示範資料直接蓋掉**。失敗有兩種成因：JSON 解析不了（寫入被截斷），以及 `applySnapshot()` 回 `false`——存檔版本比目前這個 build 還新，`migrateSnapshot()` 拒絕。後者是真的會發生的（使用者開到快取住的舊版頁面，或留著沒關的舊分頁），而且被蓋掉的是**比較新**的資料。所以 `loadState()` 會先把原始內容搬到 `workSchedule.v1.unreadable` 再回 false，兩種情況都還有機會人工救回。

### 存檔版本的升級必須逐階往上走

`migrateSnapshot()` 原本是一串 `if`：`v === 1` 那條直接 `return` 一個 v2 物件。**在只有兩個版本時剛好正確**，所以它看起來沒有問題——直到 `STORAGE_VERSION` 變成 3。

那一刻一份 v1 存檔會停在 v2，接著 `applySnapshot()` 讀不到 v3 才有的欄位，於是那些資料**安靜地消失**：沒有例外、沒有紅字，存檔的 `version` 甚至會是 3（因為 `snapshot()` 照新格式寫回去），只是裡面空了一塊。

現在改成查表迴圈（`SNAPSHOT_MIGRATIONS`），每一階只負責自己那一步，加第四版時只要在表上多一列。表寫錯繞成環時有 `guard` 擋著，不會把分頁卡死。

**這件事不能只靠單元測試守。** 單元測試證明得了「`migrateSnapshot` 這個函式對」，證明不了「它真的被接上了」——而使用者手上那份半年前匯出的 `.json` 走的是完整的匯入路徑（含一個 `confirm()`）。`tools/check-migrate.mjs` 因此造一個 v1 的檔案丟進 `#importFile`、按下確定，再去讀 localStorage 看實際存進去的是什麼。突變驗證過：改回「只認上一版」時，第一條斷言（「升到目前版本」）**仍然是綠的**，紅的是第五、六條——這正好示範了為什麼「版本號對了」不等於「資料還在」。

### 「不在」與「休假」是同一份資料的兩種 kind

`absences` 的形狀是 `{ ymd: [{ kind, from, to, icon? }] }`（2026-09-17 之前是只有日期的 `awayDates`）。不做成兩個各自獨立的清單，理由是使用者選了「同一天可以兩種並存」——兩個清單就得在彼此之間對照時段，而那份對照邏輯寫兩份遲早走鐘。

| 決定 | 理由 |
|---|---|
| **刻意不檢查時段重疊** | 真實世界就是這麼模糊（上午的會開到一半提早請假）。系統一旦判定「這不合法」就得決定砍掉哪一邊，那是在使用者沒看的時候改掉他填的東西——同〈為什麼前置作業不自動順延〉 |
| **不設每天的筆數上限** | 丟掉使用者填的東西比留著幾筆冗料糟糕得多。真正會長出重複的那條路（三方合併）是整天二選一，長不出來 |
| `normalizeAbsences` **排序與去重是正確性，不是美觀** | 三方合併以 stableStringify 比對整天的陣列，順序不同會讓「其實一樣」被判成衝突，然後跳一個根本不存在的對話框給使用者。同 `normalizeTags` / `normalizeDependsOn` |
| **空陣列不留** | `{'2026-01-01': []}` 與「那天沒有記錄」是同一件事，留著只會讓兩份內容一樣的存檔比對出差異 |
| 合併的粒度停在**一天** | 單筆層級要回答「這兩筆是同一筆被改過，還是各自新增的兩筆」，那需要每筆各自的 id。為了一年用不到幾次的欄位背一套身分系統不划算，而且「這一天你們兩邊填的不一樣，選一個」對使用者比較好解釋 |
| `absencesOfSnapshot()` **一定要能讀舊形狀** | 基準（`cloudMeta.baseSnapshot`）與遠端都可能還是 v2。直接讀 `.absences` 會讀到 undefined，於是「本來就有的那幾天」看起來像「對方把它刪掉了」——刪除會生效，資料靜靜消失。有測試守著 |
| **舊鍵 `awayDates` 不寫回去** | 兩邊都寫的話，「哪一個才是真的」會在某一次同步之後變成猜謎 |

`tools/check-deps.mjs` 的假資料**刻意維持 v2 的舊形狀**：這樣它順便在真的瀏覽器裡走一次 v2 → v3 的搬家。

## 多語系（`// ====== 語言 ======` 區段）

gettext 式：**中文原文本身就是字典的 key**，`I18N.en` 查不到就原樣回傳中文。因此新增中文字串不會壞掉，只是那一句暫時沒有翻譯——這是刻意的，比「查不到就顯示 key」或拋錯溫和得多。

三個全域：`tr(s)` 查表、`tf(s, ...args)` 查表後代入 `{0}`、`weekName(i)` 取星期名。靜態 markup 走 `data-i18n` / `data-i18n-ph` / `data-i18n-title`，`applyStaticI18n()` 會把原始中文快取在 `dataset.i18nSrc`，切回中文時才有東西可還原。

### `tr` / `tf` / `weekName` 絕對不可被區域變數遮蔽

這三個名字短、又都在同一個 IIFE 的頂層，**極容易被順手拿去當區域變數名**。踩過兩次，兩次都是同一個機制、同一種症狀：

| 遮蔽者 | 後果 |
|---|---|
| `gp.tasks.forEach(t => …)` 遮蔽當時叫 `t()` 的翻譯函式 | 全域函式因此改名為 `tr()` |
| `const tr = document.createElement('div')`（代辦項目的列）遮蔽 `tr()` | **甘特頁的任務表整個沒有渲染** |

第二次的症狀特別誤導：畫面上「專案進度底下的代辦項目不見了」，看起來像資料遺失或功能被移除，實際上是 `renderTodos()` 在 `inp.placeholder = tr('代辦項目內容')` 這一行丟 `tr is not a function`，往上炸掉整個任務區塊的建構。**資料一直都在，只是沒有被畫出來。**

危險在於這一類錯誤**現有的檢查全部抓不到**：`node --check` 只驗語法（遮蔽是合法的 JS）、`npm test` 不碰前端整合、Worker 與 D1 完全無關。只有在瀏覽器裡把那條路徑走一次才看得見。

`tr` 尤其危險，因為它同時是 `<tr>` 表格列與「todo row」的自然縮寫。列元素請命名為 `trow` / `rowEl`。

**碰撞是在全域那一側造成的**：`const tr = document.createElement('div')` 早就存在且無害，是後來把翻譯函式命名為 `tr()` 才撞上。因此大範圍的機械式改名（把 N 處字串包進某個函式）**不能只審 diff 的 `+` 行**——那次的碰撞就在被改的那一行上面兩行，是一行未變更的 context。要問的是：這個名字在每一個被改到的 scope 裡都還指向我以為的東西嗎？

`tests/shadow.test.mjs` 現在會擋下這件事（頂層函式被區域變數或參數遮蔽就紅，並指出行號）。它只管**函式**——資料變數被遮蔽的失敗模式是安靜的錯值而非 TypeError，而且有正當的例外（`threeWayMerge` 內的 `items` 是刻意的）。臨時想手動掃一次：

```bash
grep -nE '(const|let|var)[[:space:]]+(tr|tf|weekName)\b' public/index.html
```

完整經過記在 `docs/postmortems/2026-07-31-gantt-todos-missing.md`，包含全檔掃描找出的第三處潛伏案例（甘特圖月份刻度的 `tick` 遮蔽時鐘函式 `tick()`，已改名 `tickEl`）。

## 富文字（每日記錄與專案筆記）

這兩個欄位存的是 **HTML**，會被丟進 `innerHTML`。內容可能來自匯入的備份檔、雲端同步回來的資料，或（將來共享頁若顯示筆記）別人的帳號——所以「富文字」區段**是一道安全邊界，不是排版工具**。動它之前請先讀完本節。

### 過濾器的三條原則

1. **白名單，不是黑名單。** 標籤、URL 協定、CSS 屬性與值全部是「不在表上就不通過」。`javascript:` 有 `JaVaScRiPt:`、`java\tscript:`、開頭塞控制字元等無數變形，黑名單永遠列不完。
2. **屬性一律清空再放回。** 不逐一比對屬性名稱——`onXxx` 那類東西列不完，清空重建才沒有漏網之魚。
3. **危險的才丟內容，其餘只拆外殼。** 只有 `<script>`／`<iframe>` 這種本身會執行或載入東西的標籤連內容一起丟；不認得的標籤 unwrap（保留文字）。把使用者打的字弄不見也是壞事。

### 每一條入口都要濾，不能假設「存進來時濾過了」

- `applySnapshot()`：每日記錄與專案筆記逐一過濾
- `normalizeGanttProjects()`：`notes` 過濾
- 編輯器的 `paste`、`blur`、以及每次 `onInput` 存檔前

濾的目的正是防那些**不是從我們的編輯器進來的內容**，所以「編輯器已經濾過」永遠不能當作某條路徑免濾的理由。

### 為什麼用 execCommand

`document.execCommand` 標為 deprecated，但在零相依前提下它是唯一不必自己寫編輯引擎的作法——自行處理選取範圍、復原堆疊與跨瀏覽器游標行為，複雜度遠超過這個功能該有的份量。代價是各家輸出的標籤不一（`<b>` vs `<strong>`、殘留 `<font>`），因此存檔前一律過 `rtSanitize()` 正規化。**過濾器同時負責安全與一致性**，兩者不可分開處理。

工具列按鈕必須在 `mousedown` 就 `preventDefault`：execCommand 作用在目前的選取範圍上，按鈕一旦搶走焦點，範圍就沒了。

選色盤的「點別處關閉」監聽器要延到下一個 tick 才掛上 document，否則開啟用的那一次點擊會繼續冒泡，當場把自己關掉（實際踩過）。

### 顏色白名單必須認得 `rgb()`

我們傳給 `execCommand` 的是 `#FFF3A3`，但**瀏覽器把行內樣式序列化成 `background-color: rgb(255, 243, 163)`**。`rtNormColor` 原本只處理 `#RGB`／`#RRGGBB`，比對不到就整條丟掉——症狀是**醒目提示按下去看得到，失焦或重新載入之後就不見了**。

單元測試當時全綠，因為它餵的是我們自己寫的十六進位值，而不是瀏覽器實際吐出來的東西。**白名單的測試必須用「真的會流進來的形狀」當輸入**，否則守的是一個不存在的介面。

放寬的是**同一個顏色的另一種寫法**，不是白名單本身：認不得的格式原樣回傳，接著一樣因為不在清單裡而被丟掉。半透明（alpha ≠ 1）刻意不放行——那不會是我們自己塞進去的值。

### 高頻輸入的 debounce 必須在離開前結帳

每日記錄與專案筆記走 `persistSoon()`（400ms）→ `pushSoon()`（再 1500ms），所以**最後打的那幾個字有將近兩秒鐘只存在記憶體裡**。切頁籤沒事（記憶體還在），但關掉分頁、重新整理、或手機切到別的 app 之後回來，那段就沒了——而且畫面上完全看不出來。

`flushPendingWrites()` 補的是「離開前結一次帳」，掛在三個時機：編輯器 `blur`、`visibilitychange`（頁面還活著，網路請求送得出去）、`pagehide`（fetch 不保證送得完，但 localStorage 是同步的）。debounce 本身沒有錯，不要為了這個 bug 把它拿掉。

**監聽器不能掛在 `flushPendingWrites()` 旁邊**：〈持久化〉區段會被 `tests/richtext.test.mjs` 抽出來在 Node 裡求值（為了測 `migrateSnapshot`），頂層碰 `document` 會讓整支測試爆掉。掛在〈啟動〉區段——那支測試已經實際擋下來一次。

**驗這件事不能用「打完字然後 `page.reload()`」**：那是在跟 400ms 賽跑，誰快誰慢看當天的機器（第一版就是這樣寫的，拿掉修正之後測試照樣綠）。`tools/check-notes.mjs` 改成在同一次 `evaluate` 裡發出 `pagehide` 再讀 `localStorage`，中間沒有非同步空隙；並且**額外斷言「那一刻確實還沒寫進去」**，證明測到的是結帳而不是 debounce 剛好跑完。

### 測試的切分

`DOMParser` 只有瀏覽器有，Node 沒有內建。因此 `tests/richtext.test.mjs` 測的是所有**安全決策**（標籤政策、URL 白名單、style 值白名單、`<font>` 折算）——那些是純字串函式；**整條管線（含 DOM 走訪）必須在瀏覽器裡實測**，把惡意 HTML 當成「雲端來的資料」餵進去，然後檢查渲染後的 DOM 有沒有危險節點、`on*` 屬性、不安全的 `href`。

不要為了讓走訪也能在 Node 裡測而自己造一個假 DOM：假 DOM 的解析行為與真瀏覽器不同，測過了也不代表安全。

### applySnapshot 一定要正規化，不能只檢查 version

`applySnapshot()` 收到的資料可能來自舊版存檔、另一台還沒更新的裝置，或已損毀的雲端資料。缺 `date` 的 item 會讓 occurrence 展開時 `parseYMD` 直接拋錯——而雲端載入走 async，錯誤會變成 unhandled rejection：**畫面停在舊狀態、console 沒有明顯線索、使用者完全不知道發生什麼事**（開發時實際踩過）。

因此 `normalizeItems()` / `normalizeGanttProjects()` 會在套用前過濾掉缺少必要欄位的資料並補齊其餘欄位。新增欄位時記得一併更新這兩個函式。

## 雲端同步

只有部署後才啟用。`initCloudSync()` 偵測不到 `/api/state` 就靜默降級，這是前面說的「不可破壞的前提」。

`workSchedule.v1.cloudMeta` 記錄「上次成功同步到的雲端版本」與 **`baseSnapshot`（上次成功同步的完整內容）**。前者判斷有沒有衝突，後者是三方合併的基準——沒有基準就無法區分「哪一邊改過」，衝突只能退回整份二選一。

啟動時的四條分支（改動時每條都要測）：

| 本機 | 雲端 | 行為 |
|---|---|---|
| 空 | 空 | **清成空白**後推上雲端（見下方說明） |
| 有 | 空 | 推上雲端 |
| 空 | 有 | 採用雲端（不可重新 seed） |
| 有 | 有 | `cloudMeta.updatedAt === 遠端` → 本機較新，推上去；否則為**真衝突**，跳對話框讓使用者選 |

加上「本機編輯後 1.5s 自動推送」與「file:// 開啟」，共六個情境。最後一個的行為改過：從來沒登入過的裝置看到的是登入閘門（不 seed）；登入過的裝置（`cloudMeta.owner` 在）仍然靜默用本機資料。

**「空＋空」那一格刻意不是 seed。** 啟動時 `loadState()` 失敗會先跑 `seed()`（閘門關著時除外），但等到確認「已登入且雲端沒有資料」時，那份示範資料就必須清掉——否則每個新帳號第一次登入都會拿到一份不屬於自己的假資料，還得逐筆刪。判斷依據是 `localHadData`：它為 false 就代表畫面上這份是 seed 而不是使用者的東西。`seed()` 現在實際上只給 `tools/` 的瀏覽器腳本用（登入過、後端不在）——單檔雙擊開啟的展示價值已隨〈登入閘門〉一起拿掉。

**衝突以三方合併處理**（`threeWayMerge`，「三方合併」區段，純函式、有測試）：以 `baseSnapshot` 為基準逐項比對，只有一邊改過的自動採用、兩邊各自新增的都保留、單邊刪除生效；**只有「兩邊都改到同一個項目」才跳對話框**，且對話框只針對衝突項目二選一，其餘已合併。這是分享功能的必要條件——被分享者每次勾選都會改動擁有者的雲端版本號，若仍是整份二選一，擁有者下一次推送就會被迫在「自己的編輯」與「對方的勾選」之間擇一，選錯就有人的變更無聲消失。

自動合併**只在能證明「只有一邊改過」時發生**；同一項目兩邊都改仍然交給使用者，這與「衝突絕不能靜默挑邊」並不矛盾——挑邊指的是把「無法判定」的情況擅自決定。Worker 端以 `updated_at` 做樂觀鎖，`baseUpdatedAt` 對不上就回 409 並附上遠端資料。`cloudMeta` 缺 `baseSnapshot`（升級前的舊快取）時退回整份二選一的舊對話框。

### Worker 端

- 查無使用者資料時回 `state: null` 而非 404，代表「尚未同步過」，前端應沿用本地資料。
- 401 在前端代表 session 過期，必須導向 `/login`，**不能當成單機模式靜默降級**——那會讓使用者以為還在同步，實際上變更只留在本機。
- `GET /api/state` **順帶回傳 `user`**。前端啟動時本來就得先知道「是誰」才能決定要不要清掉別人留下的本地快取；這個端點本來就需要有效 session 才進得來，401 傳達的就是 `/api/auth/me` 要問的事。分兩次打等於兩次串行往返、兩次 session 查詢。`/api/auth/me` 仍然保留給 `admin.html` 等其他呼叫端。

#### 樂觀鎖必須是單句 SQL

`handlePutState` 與 `handleUpdateShared` 都以帶條件的 `UPDATE ... WHERE updated_at = ?` 寫入，用 `meta.changes` 判斷有沒有改到那一列。

**不可以退回「先 SELECT 版本 → 比對 → 再 UPDATE」的三步寫法。** 讀完到寫入之間有一段空窗，另一條路徑（擁有者的 `PUT /api/state` 與被分享者的 `PUT /api/shared/:id` 會改同一列）剛好落在裡面時，後寫的那一方會把對方無聲蓋掉——而被蓋掉的一方已經收到 200、也已經把它記成新的三方合併基準，不會再推一次去救。樂觀鎖擋得住看得見的衝突，擋不住自己製造出來的競態。

被分享者那一側改不到就**重讀重算並重試**（最多三次）而不是回錯誤：白名單合併只取被授權的欄位、且以擁有者當下的資料為基底，重算是冪等的。

`tests/state.test.mjs` 用 `withRaceBeforeFirstUpdate` 在 UPDATE 執行前注入一次別人的寫入，讓那個空窗百分之百重現。**這兩個測試對舊的三步寫法會失敗**——加測試時請確認新測試真的抓得到舊 bug，否則它只是在複述現況。

#### 授權查詢不該擋住 HTML

`run_worker_first` 讓 `/` 一定要經過 Worker，所以每次開啟都要先問一次 D1。但取靜態資產與查 session 沒有依賴關係，`servePage` 以 `Promise.all` 同時發，未授權時把拿到的資產丟掉改回 302——擋下來的東西完全一樣，只是不再排隊。代價是未授權訪客多一次資產子請求（邊緣快取，極便宜）。

### 換人登入的隱私防線

`cloudMeta` 除了版本號還記錄 `owner`。同一台電腦換人登入時，localStorage 仍是前一位使用者的資料；若不比對 owner，衝突對話框會讓新使用者有機會把別人的排程覆蓋進自己的雲端帳號。載入時 owner 不符即清空本地（清成空白，不重新 seed——理由同上），登出時也一併清除——兩道防線都要保留，不要因為「登出已經清過」就移除 owner 比對（session 過期、cookie 被替換等情況不會經過登出流程）。

## 每日 cron：提醒、推播、備份、清理

`wrangler.jsonc` 的 `triggers.crons` 只有一條（00:00 UTC＝台北早上 8 點），`scheduled()` 依序跑五件事（逾期提醒信、櫻花樹的信、**推播**、備份、清理）。**每一件各自獨立 try/catch，不能串在一起**——備份失敗不該連帶讓當天的提醒不寄，APNs 掛掉也不該讓信不寄，反過來都一樣。它們只是剛好在同一個時間點跑，彼此沒有依賴。

`step()` 在**成功時也會 `console.log`**。只在失敗時印的話，「備份從三週前就沒在跑了」看起來與「一切正常」一模一樣（log 裡什麼都沒有）——備份最可怕的失敗模式正是這種。

### 備份（`handlers/backup.js` → R2）

在這之前，所有人的排程只存在一個地方。其他每一種故障都還有救，只有資料沒了是真的沒了。

- **備份不含密碼雜湊，這是刻意的。** 帶著雜湊等於把所有人的憑證多複製一份到另一個地方，外洩面積直接放大。代價是還原後所有人要重設密碼——而**自助重設讓這個代價變成負擔得起的**：從「每個人都來拜託管理者」變成「每個人自己點一下」。這兩個功能是一組的。
- 備 `user_state`、`users`（不含雜湊）、`shares`。`ics_feed` 與 `reminder_feed` 不備——那是前端每次同步重新推上來的衍生資料，還原 `user_state` 之後會自己補回去。
- **空的備份當成失敗**（`users` 一筆都沒讀到就丟例外）。與其寫出一份空檔案佔掉輪替空間，不如當場失敗；備份最可怕的是「以為有、其實沒有」。
- 檔名 `backup/YYYY-MM-DD.json`。**選這個格式是為了讓字典序等於時間序**——R2 的 list 依 key 字典序回傳，所以「前面幾個」就是「最舊的幾個」，輪替不需要額外排序或讀 metadata。
- 留 14 份。輪替只碰 `backup/` 這個 prefix。
- 儲存桶必須先存在（`npx wrangler r2 bucket create work-schedule-backups`），否則 deploy 會失敗——而 **`--dry-run` 不會發現，它不連線**。

**看得見的備份才是備份。** cron 的 log 只有翻 Cloudflare 後台才看得到，而沒有人會每天去翻——所以 `/admin` 有一區列出目前有哪些備份（日期、大小、幾個帳號、幾份排程），最新一份超過 36 小時就標成警示色。一份三週前的備份在「有備份」這個問題上看起來也是綠燈，但它其實早就沒在跑了。

`GET /api/admin/backups` 只回 metadata，不回內容：用途是確認「有沒有、對不對」，沒有理由為了確認而把全系統所有人的排程送到瀏覽器。`POST` 立刻跑一次，讓「設定改動或第一次上線」能當場驗證，不必等到隔天早上；檔名以日期為 key，同一天重跑是覆蓋而不是長出第二份。

### 執行記錄（`cron_runs`，見 `handlers/ops.js`）

`step()` 除了 `console.log`，現在把每一次的結果寫進 `cron_runs`，並由 `/admin` 的「排程狀態」顯示。

理由是一次真實事故：**逾期提醒信整整兩週沒有寄出**，而所有條件都成立——`reminder_feed.enabled` 是 1、帳號是 `approved`、digest 裡確實有即將到期的項目。系統沒有任何徵兆，因為寄信失敗只留了一行 `console.warn`，而那行字在 Cloudflare 後台，沒有人會去翻。這正是備份那一節已經寫過的道理（**看得見的備份才是備份**），只是當時只套用到備份。

幾個不能拿掉的判斷：

- **失敗的那一筆才是重點**，所以 `ok = 0` 一樣要寫，而且 `detail` 存的是錯誤訊息而不只是狀態。只記成功等於重蹈 `console.log` 的覆轍。
- **管理頁看的是「最後一次成功」，不是「最後一次執行」。** 兩者在一份只有時間戳的清單裡看起來很像，意義卻相反——把失敗算進 `lastOkAt`，這個功能就會親手製造出它要防的那種假綠燈。有測試守著。
- **從未執行過 ≠ 執行成功。** 伺服器端刻意不寫死步驟清單（cron 多一件事，它會自動被監看）；前端則刻意寫死已知的三個（沒有記錄的東西不會自己出現在回應裡，那樣「從來沒跑過」會變成一片空白）。兩邊的方向相反，是互補的。
- **沒有丟例外 ≠ 這一步做到了。** `sendOverdueReminders` **刻意不往上丟**——一個人的信寄不出去，不該讓其他人的信也跟著不寄——所以它把個別失敗收進 `errors[]` 再正常回傳。`step()` 原本只看有沒有丟例外，於是「函式回來了」與「這一步真的做到了」分家：2026-09-09 早上 helen 的信被 AgentMail 以 403 擋下，這一步卻記成成功，`/admin` 顯示「✓ 正常」而一封都沒送出去。**假綠燈正是這張表要防的東西，由它自己製造出來是最糟的形狀。** 現在 `cronResultErrors()` 定下通用約定：回傳值裡的 `errors` 非空就不算乾淨的成功——不寫死「哪些步驟要檢查」，漏掉的那一個會靜靜地繼續發假綠燈。測試刻意測 `step()` 本身而不是只測那個純函式：純函式測過只證明判斷寫對了，證明不了 `step()` 真的有去問它。
- **寫記錄失敗只 `console.warn`。** 記錄寫不進去，不該讓一次成功的備份看起來像失敗。同 `share_activity` / `admin_activity`。
- `sendOverdueReminders` 的 `skipped` 已拆成 `nothingToSay` / `alreadySent` / `notApproved`，並回傳 `errors[]`。原本三種原因共用一個數字，於是「今天大家都沒事」與「這個帳號被停用了」在統計裡完全一樣——與〈降級可以，沉默不行〉要求區分 `absent` 與 `failed` 是同一件事。

### 寄信記錄（`mail_log`，見 `src/mail.js` 與 `handlers/ops.js`）

`cron_runs` 回答的是「**那一步**有沒有跑成功」，回答不了「**那一封信**有沒有寄出去」——中間差了整整一層。2026-09-09 helen 的信被 403 擋下之後補上的 `errors[]` 讓 cron 那一格終於會變紅，但密碼重設信與 app 的驗證碼**根本不經過 cron**：它們在使用者按下按鈕的那一刻同步寄出，失敗只有一行 `console.error`，而那行字在 Cloudflare 後台。

實際的形狀：helen 忘記密碼，按了「忘記密碼」，畫面照常說「信寄出去了」（那是刻意的，見〈忘記密碼〉的帳號列舉防線），重設連結真的產生了，信被寄信商的退訂名單擋掉。**系統裡沒有任何一個地方看得出這件事**——她只知道「信沒來」，而我們只知道「我們說寄了」。

所以每一封信不管成功失敗都寫一列 `mail_log`，`/admin` 的「寄信記錄（最近 30 天）」依種類分組顯示。

| 決定 | 理由 |
|---|---|
| **成功不存 `detail`** | 信的內容是重設連結、驗證碼、某個人的排程摘要。要回答的只是「有沒有寄成功」，沒有任何理由把那些留在資料庫裡。有測試守著（斷言傾印出來的整張表**不含**信的內文） |
| **失敗要把寄信商的 body 一起記下來** | 同 AgentMail 那條：只記狀態碼的話，「key 無效」與「收件人在退訂名單上」看起來一模一樣，而這兩者要做的事完全不同 |
| **四種失敗都要記**（secret 沒設、連線層丟例外、非 2xx、以及成功） | 前三種在「使用者沒收到信」這個症狀上長得一模一樣。分不出來就查不下去 |
| **`kind` 分四種**（`reset`／`verify`／`reminder`／`streak`） | 前兩者是**交易信**（使用者按了按鈕在等），後兩者是**訂閱信**（系統主動送）。退訂名單只該擋得住後者，而 helen 那次是前者被擋掉——不分種類的話這張表看起來只是「有幾封沒寄成功」，看不出那是最嚴重的一種。管理頁因此把這一欄標出來 |
| **寫記錄失敗只 `console.warn`** | 同 `cron_runs` / `share_activity` / `admin_activity`：記錄寫不進去，不該讓一封已經寄出去的信變成一個錯誤。**也因此 migration 還沒跑時整條寄信的路仍然是通的**，只是每寄一封多一行警告——與欄位型的 migration 不同，這一支漏跑不會 500 |
| **保留 30 天，寫入時順手清** | 同 `share_activity` 的 90 天。沒有保留上限的日誌表遲早會是資料庫裡最大的一張；而這種記錄的價值只存在於事發後的短期內 |
| **`sendMail` 的 `kind` 有預設值 `'unknown'`** | 漏傳不會壞掉，只是那一封歸不了類。讓它變成必填的話，日後多一種信就得改簽章，而漏改的症狀是 500 |

**這張表證明不了「信有沒有被讀到」**，它只證明到「寄信商收下了」為止。helen 那一次寄信商是明白回 403 的，所以看得見；如果寄信商回 200 之後才在自己那邊丟掉，這張表仍然會顯示綠色。要再往下就必須接 webhook，那是另一件事。

### 交易信與訂閱信分家（`pickSender`）

**退訂名單是帳號層級的。** 2026-09-09 helen 的密碼重設信被 AgentMail 以
`message_rejected: recipient is suppressed` 擋掉，而那個帳號底下**三個 inbox 的
per-inbox 名單全都是空的**（用唯讀 API 查過兩次，2026-09-18 再確認一次仍然成立）。
兩個直接的後果：

- **「寄之前先查名單」做不出來。** per-inbox API 看不到那份名單，寫出來的檢查
  會永遠回答「沒事」——那比沒有檢查更糟，因為它會讓人以為查過了。
- **換一個同帳號底下的 inbox 沒有用。** 要另一個**帳號**（或另一家寄信商）。

所以 `sendMail` 依 `kind` 挑憑證：

| | 走哪一組 | 退訂名單該不該擋得住 |
|---|---|---|
| `reset` / `verify`（**交易信**） | `AGENTMAIL_TX_*`，沒設就退回共用那一組 | **不該**——使用者自己剛剛按了按鈕在等 |
| `reminder` / `streak`（訂閱信） | `AGENTMAIL_*` | 該。那本來就是系統主動送的 |

差別不是內容，是**誰開口**——與〈休假那幾天閉嘴〉是同一條線。

| 決定 | 理由 |
|---|---|
| **沒設定就退回共用那一組，不是失敗** | 讓新的 secret 變成必填等於今天所有的信都寄不出去。代價是「有沒有真的分家」在畫面上看不出來，所以下一列是必要的 |
| **管理頁主動講「現在是共用的」** | 退回去如果是安靜的，就與 helen 那次同一個形狀：沒有任何徵兆。同〈看得見的備份才是備份〉——說得出「還沒修好」，才不會以為修好了 |
| **只設一半要退回去、而且要 `console.warn`** | 丟例外的症狀是交易信全部停掉（更糟）；靜靜退回去的症狀是「我明明設定了，卻什麼都沒發生」。所以退回去但出聲，管理頁也標成「設定不完整」 |
| **`TX_KINDS` 只寫一份**，在 `mail.js` 裡 | 在各呼叫端各判斷一次的話，日後多一種信會被默默歸錯類，而症狀是「某一種信從某一天起靜靜地不見了」。同〈純告知：不要在八個地方各寫一次〉 |
| **沒帶 `kind` 的走訂閱那一組** | 多一個帳號的成本由「系統主動送的」承擔才合理；而且漏傳 `kind` 本來就會在管理頁顯示成 `unknown`，看得見 |
| **`mail_log.sender` 記的是信箱位址，不是 `'tx'` / `'bulk'` 標籤** | 要回答的問題正是「**到底有沒有真的分家**」。標籤在設定前後都讀成 `'tx'`，看起來一模一樣；位址才分得出來。而且設定改掉的那一刻 `senders` 就變了，證明不了歷史——歷史只能從每一列自己讀 |
| **`mailSenders()` 只回信箱位址，永遠不回 key** | 位址是每一封信的 From，本來就公開；key 不是。同 `listBackups` 只回 metadata、`usage` 不回排程內容 |

`tests/ops.test.mjs` 六條守著，突變驗證過六種改法各自會紅（`TX_KINDS` 清空、
只設一半也採用、`split` 永遠回 true、`sender` 不寫進去、`mailSenders` 連 key 一起回、
`listMailLog` 不收集 senders）。三種設定狀態各在瀏覽器裡渲染確認過。

**這張只把路鋪好，沒有真的分家。** 分家要一個**新的 AgentMail 帳號**（或另一家
寄信商），那是帳號層級的事，程式這一側做不到。開好之後：

```bash
npx wrangler secret put AGENTMAIL_TX_API_KEY    # 新帳號的 API key
npx wrangler secret put AGENTMAIL_TX_INBOX_ID   # 新帳號的寄件信箱
```

設完打開 `/admin` 的「寄信記錄」，最上面那一列會從「⚠️ 共用一個」變成「✓ 已分家」。

### 使用狀況（`/api/admin/usage`）

「做好了但沒有人用」是產品訊號，而它原本只有**直接查 D1** 才知道。系統上線至今 `ics_feed` 與 `shares` 都是 0——那件事應該要在管理頁上看得到，而不是靠有人想起來去查。

- **只回數量與狀態，不回任何排程內容**（有測試守著）。要回答的是「有沒有人在用、正不正常」，沒有理由為此把全系統所有人的排程送到瀏覽器——與 `listBackups` 只回 metadata 是同一個判斷。
- 項目數用 SQL 的 `json_array_length` 就地算，不把 `state` 讀進 Worker 再解析：那條路不該隨人數線性放大。`json_valid` 的守衛讓一份壞掉的 `state` 只影響那一列的數字，而不是讓整張表查不出來。
- **從未同步過的帳號也要列出來。**「註冊了但沒在用」本身就是訊號，讓它消失等於把那個訊號丟掉。

### 清理（`purgeExpired`）

session 原本只有「剛好被碰到」時才刪，`password_resets` 更徹底：原本完全沒有人清。

**用過的重設連結保留 7 天才刪**，不是立刻刪：使用者按上一頁或郵件用戶端預抓時，「這個連結已經用過了」比「查無此連結」好懂太多，那個訊息要撐得過幾天。

## 登入失敗節流（`src/throttle.js`）

Turnstile 擋得住「一秒鐘一萬次」的機器人，擋不住「一分鐘三次、試一整天」的人。兩者是不同的攻擊形狀。

| 決定 | 理由 |
|---|---|
| **不是「鎖定帳號」而是滑動窗口** | 真的鎖定的話，任何人對著別人的 email 一直打錯就能把對方鎖在門外——防禦本身變成阻斷服務 |
| **email 與 IP 兩個維度都記** | 只擋 email：換一個就能繼續打；只擋 IP：同一間辦公室互相牽連。IP 的門檻較寬（20 vs 5），因為它天生會被共用 |
| **帳號不存在時也要計數** | 否則「這次有沒有被擋」就成了「這個 email 有沒有註冊」的旁通道，登入訊息刻意模糊的用心會整個白費 |
| **節流檢查放在 PBKDF2 之前** | 被擋下的請求不該還去燒 CPU，否則「擋下來」本身成了另一種消耗資源的方式 |
| **計數用單句 UPSERT** | 「先讀再寫」在兩次併發失敗之間有空窗，後寫的會蓋掉前一次——攻擊者開兩條連線就能讓計數永遠停在 1。與〈樂觀鎖必須是單句 SQL〉是同一件事 |
| **登入成功清掉計數** | 先前的失手不該累積到下一次把本人擋在外面 |

## 登入中的裝置（`sessions.user_agent` / `last_seen_at`）

給「我的帳號」頁的裝置清單用。兩個欄位都可為 NULL——加欄位之前就存在的 session 沒有這些資料，顯示為「未知裝置」即可，不需要為了一個顯示用的欄位把所有人踢出去重新登入。

- **不記 IP。** 它是個人資料，而這個功能真正要回答的是「我是不是在別人的電腦上忘記登出了」——裝置類型加上最後使用時間就足以回答。
- **user agent 只能在 `handleLogin` 取得**（`session.js` 拿不到 request），存原文並截斷至 300 字元；折算成「Chrome on Windows」是**前端**的顯示邏輯，規則會隨瀏覽器改版而變。
- **`listSessions` 的 `WHERE user_id = ?` 綁的是這次請求解出來的 user，沒有任何參數可以指定別人。** 這不是靠權限判斷擋住，是路徑本身走不到——但有測試守著，否則哪天有人「順手」加一個參數就沒有東西會紅。
- **回應不含 token 原文，也不含雜湊**：前端只需要知道「是不是這一台」（`current` 旗標），不需要能指認任何一列。
- **「登出其他裝置」保留當下這一台。** 使用情境是「我在別人的電腦上忘記登出」，把自己也踢掉只會讓按下去的人當場被登出，然後懷疑是不是按錯了。

### `last_seen_at` 的寫入節流，以及一個修正過的推論

每個請求都寫一次等於每個人的每個操作都多一次 D1 寫入，而畫面顯示的是「2 小時前」這種精度。因此**超過一小時才更新一次**。

作法是「`getSessionUser` 的 SELECT 順便讀出 `last_seen_at` → 過期才發 UPDATE」。設計階段原本寫成「合併為單句帶條件的 UPDATE，理由同〈樂觀鎖必須是單句 SQL〉」，**那個類比是錯的**：樂觀鎖防的是「有意義的變更被無聲蓋掉」，而兩個並發請求寫進去的 `last_seen_at` 幾乎相同，誰贏都一樣。合併成單句反而比較貴——新鮮時本來可以一句 SQL 都不發。

那句 UPDATE 仍帶著條件，但用途只剩「同時判定為過期時只有一個真的寫進去」。

## 管理者操作記錄（`admin_activity`）

原本只有 `share_activity`（別人動我的分享資源），管理者停用帳號、改角色、重設密碼卻一筆都沒留。系統有兩位以上管理者時，「是誰把我停用的」必須答得出來。

- **描述由伺服器依實際前後值產生**（`狀態 pending → approved`），不採用前端送來的字串。理由同 `share_activity`。
- **刪除帳號要先記錄再刪**：刪完之後 target 的 email 就沒有地方可以讀了，而「當時刪掉的是誰」正是這種記錄最需要回答的問題。
- 記 email 的**當下快照**，帳號被刪掉之後記錄仍要讀得懂。
- 任何管理者都看得到全部——這種記錄的用途就是互相監督，只讓自己看自己做過什麼等於沒有記錄。
- 寫入失敗只 `console.warn`，不讓已經成功的操作變成 500（帳號狀態已經改了，回錯誤會讓管理者重試而重複操作）。

## iOS app（`mobile/`）

設計文件在 `docs/superpowers/specs/2026-09-14-ios-app-design.md`，決策過程都在裡面。這裡只記實作後不能拿掉的判斷。

**形狀（2026-09-16 改過）：免費下載＋app 內訂閱（子專案 E，設計文件 `2026-09-16-subscription-design.md`）、`index.html` 內建、與網頁版共用同一套帳號與資料。** 原本是付費下載（錢在 App Store 那一刻收完、不需要 IAP），改成訂閱之後 IAP 變成必要；購買證明（AppTransaction）免費 app 也有，**保留**它當「一個 Apple ID 一個帳號」的防濫用機制——免費版有上限，開十個帳號就是繞過上限最直接的方法。E1（方案與上限）、**E2（StoreKit 訂閱）與 E3（Apple 伺服器通知）皆已實作**（見〈訂閱的寫入〉）。

| 決定 | 理由 |
|---|---|
| **內建 `index.html`，不是殼載入線上網站** | Ionic 團隊說 `server.url` 本來只給開發用；到 2026 年「把網站包起來」幾乎一定被 4.2 退件。代價是前端每次改版要重新送審 |
| `mobile/` 有**自己的 `package.json`** | Capacitor 只裝在那裡，根目錄零相依不變；`npm test` 與現有 CI 不碰它 |
| `mobile/www/` 是**建置產物，不進 git** | 它只是 `public/index.html` 的副本，副本一定走鐘。`prepare-www.mjs` 每次打包重新複製，並檢查〈原生外殼〉區段真的在裡面 |
| 前端**包一層 `fetch`**，不改三十幾處呼叫 | 相對路徑 `/api/...` 在 `capacitor://localhost` 底下會打到 app 自己身上。大範圍機械式改名正是〈多語系〉那節遮蔽事故的形狀。只在 `window.Capacitor.isNativePlatform()` 為真時換掉，網頁版連這一層都沒有。這是全檔唯一改寫全域行為的地方 |
| app 走 **Bearer token**，網頁走 cookie，**同一張 `sessions` 表** | WKWebView 對第三方 cookie 很嚴，靠它會時好時壞。`readSessionToken()` 先 cookie 後 Bearer；app 的 session 180 天 |
| Worker 對 `capacitor://localhost` 這一個來源回 **CORS** 標頭（`src/index.js` 的 `withCors` / `corsPreflight`），**不開 Allow-Credentials** | app 打線上 `/api/*` 是跨網域：WKWebView 先送 OPTIONS 預檢，沒有 `Access-Control-Allow-Origin` 整個請求被瀏覽器丟掉，前端只拿到 TypeError，畫面上是「連線失敗，請確認網路後再試」，而 Worker 一筆請求都沒收到（TestFlight 第一次打開就是這樣，登入與註冊都進不去）。**錯誤回應也要帶**，否則 401 看起來也像斷線。不開 credentials：app 走 Bearer，不該讓跨來源請求帶得動網頁版的 cookie。`tools/smoke.mjs` **抓不到**這類錯誤——它用 `page.route` 在瀏覽器送出前就攔下請求，預檢不會發生——`tests/cors.test.mjs` 直接打 Worker 的 fetch 入口守著 |
| 前端叫原生插件走 `Capacitor.nativePromise('WorkScheduleNative', 方法, 參數)`，**不是** `Capacitor.Plugins.WorkScheduleNative` | 真機上的 `window.Capacitor` 是 WKWebView 注入的 `native-bridge.js`，它不會把原生註冊的插件放進 `Plugins`——只有 `@capacitor/core` 的 `registerPlugin()` 會，而單檔 HTML 沒有引入 core。第一版讀 `Plugins.*` 在真機上永遠是 null：Keychain 從沒存過、購買證明永遠「拿不到」（TestFlight 第一次註冊就是這樣紅的）。`tools/smoke.mjs` 的假 Capacitor 原本直接塞了那個物件，比真的大方，現在改成只給 `nativePromise`——**假的東西不能比真的多給**。「拿不到購買證明」的訊息現在會附上原因，手機上沒有 console 可看 |
| `NATIVE`（我在不在 app 裡）由**五個互相獨立的訊號**決定，任一成立即為真 | 只問 `isNativePlatform` 一個名字是上一列那個 bug class 的第二次（見 `docs/postmortems/2026-09-16-app-silent-standalone.md`）。而 `NATIVE` 判錯的代價比插件判錯大得多——整個 app 退回網頁版那條路：`API_BASE` 變空字串、`/api/state` 打到 app 自己肚子裡、不帶 Bearer、不讀 Keychain、也不顯示 app 的登入畫面，畫面上只會安靜地變成「單機模式」。五個訊號：`isNativePlatform` / `getPlatform` / `nativePromise` / `webkit.messageHandlers.bridge` / `capacitor:`｜`ionic:` protocol。反方向同樣要守住——網頁版與單檔必須一個都不成立（手機 Safari 沒有 `messageHandlers.bridge`） |
| `nativeBoot(...)` 的呼叫**一定要 `.catch`** | 它是 fire-and-forget 的 async：摔倒只會變成 unhandledrejection，**連 `pageerror` 都不算**，smoke 的錯誤收集器看不到、手機上也沒有 console。`initCloudSync` 早就有 catch，這裡是同一條規則漏掉的一格 |
| app 裡的 `/api/state` 404 判成 `failed` 而不是 `absent` | `absent` 是為了單檔與未部署而存在的「沒有後端」，在 app 裡永遠是謊話（`API_BASE` 是線上網址）。同一段程式在兩個環境下的正確答案不一樣時，要問的是環境而不是狀態碼 |
| 所有原生相關的失敗都附上 `nativeDiag()`（protocol／有沒有 Capacitor／哪些訊號成立／插件在不在），而且**它自己包 try/catch** | **手機上沒有 console 可看**，同「拿不到購買證明」附上原因。第一版的 `nativeDiag()` 直接呼叫 `nativePlugin()`，外殼壞到「讀 bridge 就丟例外」時它會在 catch 裡再爆一次，把要傳達的訊息一起吞掉——**會爆炸的診斷函式比沒有診斷更糟**（探針 4 實際抓到的） |
| `SceneDelegate` 的 `rootViewController` **必須是 `MainViewController`**，不是 `CAPBridgeViewController` | 插件是在 `MainViewController.capacitorDidLoad()` 裡 `registerPluginInstance` 的。SceneDelegate 自己建 window 時，`Main.storyboard` 的 `customClass` 形同虛設——**兩條路各自都「看起來對」，合起來卻不通**，於是插件從來沒有註冊過。這就是 TestFlight build 7～10 那個追了四輪的根因，症狀是 `nativePromise` 的 promise **永遠不會 settle**。`tools/check-native-plugin.mjs` 守著 |
| **跨語言的接線要有一個地方比對兩側**：Swift 的 `jsName`／`pluginMethods` 與 `index.html` 的 `nativePromise('…')`／`call('…')` 逐字相同 | 名字對不上時原生那側不會報錯，它只是不回話。同〈方案與上限〉的前後端 `PLAN_LIMITS` 逐字相同——只要「兩邊必須一致」，就要有東西去比。**CI 仍然沒有 Mac**（`ios.yml` 是打包不是測試），所以自動化的那一層只能靜態比對原始碼，但跑不到一秒。本機編一次更強，只是**會被忘記**，所以兩者都要（見〈開發者有 Mac 了〉） |
| token 存 **Keychain**，不放 localStorage | WKWebView 的網頁儲存會跟著「清除網站資料」消失，也沒有 Keychain 的保護。自寫的 Swift 插件（約 60 行）做這件事，不裝第三方插件 |
| 註冊附 **AppTransaction 的 JWS，離線驗簽**（`src/apppurchase.js`） | x5c 鏈逐段驗到內建的 Apple Root CA - G3、ES256 驗本體、比對 bundleId 與環境。不打 Apple 的 API：沒有網路依賴、沒有限流、沒有另一把金鑰。**根憑證可注入只為了測試**（`tests/fake-apple.mjs` 自己當 Apple） |
| `app_transaction_id` **UNIQUE**：一次購買一個帳號 | 擋「買一份、開十個帳號」。同一個 Apple ID 重灌拿到同一個 id，換手機登入即可；刪掉帳號後 id 空出來可以再註冊。競態靠 UNIQUE 擋，不靠先 SELECT 再 INSERT |
| **email 驗證碼取代 Turnstile** | Turnstile 在非 http 網域跑不起來。收得到寄到這個信箱的碼，同時證明信箱是本人的、也擋機器人。只存雜湊（以 email 為鹽）、10 分鐘、5 次、用過即刪 |
| 註冊的順序：密碼長度 → 驗購買證明 → email／購買是否用過 → **最後才消費驗證碼** | 驗證碼用過即刪；若先消費再發現購買證明不對，使用者得回信箱重新索取 |
| 驗證碼端點**無論 email 有沒有註冊都回 200** | 否則變成帳號列舉工具（同忘記密碼）。已註冊的人在註冊那一步才拿到 409——到那時他已經證明自己收得到那個信箱的信 |
| `APP_PURCHASE_ALLOW_SANDBOX=1` 才放行 Sandbox／Xcode 環境 | TestFlight 測試期間開，上架後關。預設拒絕，忘記關比忘記開安全 |
| 401 在 app 裡**清 Keychain、回登入畫面**，不導向 `/login` | app 裡沒有那一頁。`sessionExpired()` 分兩條路 |
| 登入／註冊成功後 `location.reload()` | 與「帶著 token 開 app」走同一條啟動路徑（`nativeBoot`），不另外拼一份初始化 |
| **刪除自己的帳號**（`DELETE /api/auth/account`）：先記錄再刪，`shares` 兩個方向都刪，`share_activity` 保留 | Apple 5.1.1(v) 硬規定。`ADMIN_EMAILS` 名單內的帳號也能刪自己：名單防的是另一位管理者的橫向操作，本人拿密碼刪自己是直向的。測試守著「別人的每一列原樣」 |
| `public/privacy.html` 不用登入 | App Store 審查員與還沒註冊的人都會來看。`run_worker_first` 沒列它，靜態資產直接供應 |
| AI 每日上限依方案：免費 5、Pro 20 | 每次呼叫都要付 DeepSeek 錢；免費版不能不限，給 5 次是讓人試得到 |
| 打包在 GitHub 的 `macos-26` 映像（**不是 `xcode-27`**） | 當初的理由是「開發者沒有 Mac」，**那個前提 2026-09-17 過期了**（見〈開發者有 Mac 了〉）；仍然維持雲端打包，新的理由是**它不受本機環境影響**——Xcode 版本、憑證、描述檔在每個人的機器上都會漂移，而 CI 每次都從乾淨的映像開始。`xcode-27` 標籤是「預覽」映像，裡面只有 beta——beta 打的 build 可以上傳到 App Store Connect 但**會被拒收**（第五次打包：「Unsupported SDK or Xcode version … you need to use the latest Release Candidates」）。`macos-26` 預設是 Xcode 26.x 正式版。自動簽章帶 App Store Connect API 金鑰，四個 secrets：`ASC_KEY_ID`、`ASC_ISSUER_ID`、`ASC_API_KEY_P8`、`APPLE_TEAM_ID`。金鑰寫進 `~/private_keys`，跑完一律刪 |
| **archive 走 ad-hoc 簽章**（`CODE_SIGN_STYLE=Manual` + `CODE_SIGN_IDENTITY="-"` + `AD_HOC_CODE_SIGNING_ALLOWED=YES`），正式簽章留給 `exportArchive` | 自動簽章的 archive 一律用**開發用**身分，那種描述檔必須綁至少一台實體裝置，帳號沒裝置就失敗（第一次打包：「Your team has no devices」）；在 archive 硬指定 `Apple Distribution` 又會被 Xcode 拒絕為「conflicting provisioning settings」（第二次）。export（`app-store-connect` + `signingStyle automatic` + `-allowProvisioningUpdates`）自己用**發佈用**身分重簽，不綁裝置，憑證由 Xcode 雲端簽章代管，runner 不需要 .p12。**不要把 `project.pbxproj` 的 `CODE_SIGN_IDENTITY` 改成 Distribution**，那會讓本機用 Xcode 打包也撞同一個錯。**但「完全不簽」是錯的**（原本寫 `CODE_SIGNING_ALLOWED=NO`）：沒有簽章那一步，entitlements 就不會被寫進 archive，而 `exportArchive` 重簽時是從 archive 身上讀「原本要求了什麼」——讀到空的就簽出一個沒有推播權限的 app。ad-hoc 簽章把 entitlements 真的寫進去，同時一樣不需要描述檔、不綁裝置、不需要 .p12（build 13／14 兩次都栽在這裡，見 `docs/postmortems/2026-09-17-aps-entitlement-stripped.md`）。`ios.yml` 現在在 archive 之後**斷言** `aps-environment = production` 真的在裡面，缺了就擋下這次打包 |
| `ASC_KEY_ID` 那把金鑰的角色**必須是 Admin** | 雲端簽章要用雲端代管的發佈憑證，App Manager／Developer 金鑰被拒（第三次打包：「You haven't been given access to cloud-managed distribution certificates」）。使用者帳號有「Access to Cloud Managed Distribution Certificate」的勾選框，**API 金鑰沒有**，只能靠角色。代價是這把金鑰權限很大，只放在 GitHub secrets、跑完就刪 |

| 打包**自動跑**：main 的 CI 全綠、而且這次動到 `public/index.html` 或 `mobile/` | 原本寫的是「只在手動觸發或 tag 時跑，Mac runner 貴而且慢」。**「貴」這個前提過期了**——這是公開 repo，GitHub 的標準 runner 對公開 repo 不計費（同〈忘記密碼〉那節：「系統沒有寄信基礎設施」在接上 AgentMail 之後就不成立了，設計決定的前提會過期）。真正的代價是「打出沒有人要的 build」，所以兩道閘門都不能拿掉 |
| 掛在 **`workflow_run`（CI 完成）** 而不是 `on.push` | `on.push` 與 CI 並行，測試還沒跑完就開始打包了。`workflow_run` 拿得到那一次的結論，才擋得住「紅的 commit 變成手機上的 app」 |
| `workflow_run` 的兩個 checkout **都要指名 `head_sha`** | 那種觸發預設 checkout 的是預設分支的最新狀態，不是觸發那一次的 commit。漏掉的話判斷與打包的都是別的東西，而且不會報錯 |
| 路徑判斷只認 `public/index.html`，**不是整個 `public/`** | 只有它會被塞進 app（`mobile/scripts/prepare-www.mjs` 只複製它）。`login.html`、`admin.html`、`privacy`／`terms`、`sw.js` 都不在 app 裡 |
| 判斷放在一個 ubuntu 的小 job（`decide`），不是在 Mac job 裡逐步 `if` | Mac runner 連開都不用開；而且「要不要打包」的理由集中在一個地方看得完 |
| 看不到上一個 commit 時**寧可打包** | 漏打一次要等下一輪，多打一次只是浪費三分鐘。判斷靠 `HEAD~1..HEAD`，前提是 PR 一律 squash 合併 |

**改版時要做的事**：`mobile/package.json` 的 `version` 往上加（build 號是 GitHub 的 `run_number`，不用管）→ **合併進 main 就會自動打包上傳**（CI 綠、且動到 `public/index.html` 或 `mobile/`）→ App Store Connect 送審。手動觸發與 `ios-v*` tag 仍然留著，兩者都不看路徑條件。

**部署順序**：`migrations/005-app-purchase.sql`、`006-plan.sql`、`007-streak-mail.sql`、`008-push.sql`、`009-leave-days.sql`、`010-mail-log.sql` 與 `011-mail-sender.sql` 都要在部署新 Worker **之前**跑（`010` 是新增資料表，漏跑只會讓寄信多一行警告，不會 500；**`011` 是加欄位，漏跑會讓 `/api/admin/mail-log` 的 SELECT 直接失敗**）（`getSessionUser` 的 SELECT 讀 `plan_source`，欄位不在**每一個**登入請求都會 500；`007`／`008`／`009` 的欄位則是 `/api/reminder` 與 cron 會讀），理由見〈資料庫結構變更〉。006 跑完、Worker 部署完之後，還要到 `/admin` 把既有的兩個帳號設成「Pro（永久）」——漏掉的症狀是他們的第四個專案被擋，當場就會知道。

### 開發者有 Mac 了（2026-09-17）

原本整個 iOS 這一段建立在「開發者沒有 Mac」之上。**那個前提已經不成立**——這是這份文件裡第三次遇到前提過期（前兩次：「系統沒有寄信基礎設施」在接上 AgentMail 之後、「Mac runner 貴」在確認公開 repo 不計費之後）。

**改變了什麼**

| 原本 | 現在 |
|---|---|
| Swift 改動**編不了**，只能靠 `check-native-plugin.mjs` 比對名字 | **可以真的編一次**（`xcodebuild`）——語法與型別錯誤當場就知道 |
| 原生行為只能等 TestFlight，一輪半小時起跳 | **模擬器跑得動**。build 7～10 那個「插件從來沒有註冊過」在模擬器裡五分鐘就看得到 |

**沒有改變的**

- **CI 仍然沒有 Mac。** `check` 與 `smoke` 都在 ubuntu 上，`ios.yml` 只是打包。所以 `check-native-plugin.mjs` **不能拿掉**：本機編一次更強，但它靠人記得；靜態檢查每個 PR 都跑。**兩者是地板與天花板，不是二選一。**
- **雲端打包仍然是預設。** 理由換了（見上面那一列）：它不受本機的 Xcode 版本、憑證、描述檔漂移影響。
- **真機仍然無可取代的部分**：`AppTransaction`（模擬器拿不到）、真的 APNs token、真的付款。模擬器能做的是 StoreKit Testing 與推播檔拖放，形狀對但不是真的。

**動到 `mobile/ios/` 的任何 Swift 時，本機至少編一次**：

```bash
cd mobile/ios/App && xcodebuild -scheme App -sdk iphonesimulator -configuration Debug build
```

編不過的東西沒有理由推上去讓雲端的 Mac 花三分鐘再發現一次。

## 方案與上限（`src/plan.js`）

設計文件 `docs/superpowers/specs/2026-09-16-subscription-design.md`。免費版：大項目與甘特專案**各**最多 3 個、AI 每天 5 次；Pro 不限（AI 20 次）。實作後不能拿掉的判斷：

| 決定 | 理由 |
|---|---|
| 「是不是 Pro」只看 `users.plan_source` / `plan_expires_at`，**不在請求當下問 Apple** | 同購買證明的離線驗簽：沒有網路依賴、沒有限流、沒有另一把金鑰 |
| 到期後 **3 天寬限**（`GRACE_MS`） | Apple 續訂失敗有 billing retry，那幾天 Apple 仍算訂閱中；沒有寬限的話信用卡過期當天就被降級，而 Apple 還在幫他重試 |
| 上限規則是 **「新的數量 ≤ max(上限, 舊的數量)」**，不是「≤ 上限」 | 降級的人可能有 10 個專案：一個都不刪、一個都不鎖，只是不能再新增。改回「≤ 上限」的症狀是**連既有的都存不回去**、每次同步 402，看起來只像「同步失敗」。有測試守著 |
| 伺服器擋（`PUT /api/state` 回 **402**），前端只是禮貌 | `index.html` 誰都下載得到，改一下 localStorage 再同步就繞過前端。402 附上 `over: { kind, count, limit }`，前端的 `handleCapped` 顯示「超過免費版上限，這次沒有同步」並開升級說明 |
| 超過上限時才多讀一次舊 state | Pro 與沒超過的人一句 SQL 都不多。讀完再寫不破壞樂觀鎖：別人在中間改了那一列，UPDATE 的 `WHERE updated_at = ?` 本來就會落空 |
| **「＋ 新增」按鈕仍在、仍可點**，到上限點下去開升級說明而不是表單 | 按鈕消失會讓人以為功能不見了。同「我的帳號」在單機模式仍存在的理由 |
| 前端 `PLAN_LIMITS` 與後端**逐字相同**，測試比對 | 兩邊數字不一樣的症狀是「按鈕讓我新增、同步卻 402」或反過來 |
| 前端沒有帳號時（登入過、現在離線）當 **pro** | 沒有伺服器可以擋，前端也不該自己擋 |
| 既有的兩個帳號：管理者在 `/admin` 設「Pro（永久）」，**不寫進 migration** | migration 在公開的 repo 裡，email 不該進去。`plan_source='admin'` 且 `plan_expires_at` 為 NULL |
| 方案是「給東西」：管理者**可以**設自己與 `ADMIN_EMAILS` 名單內的帳號 | 那兩道保險只管角色與狀態（停用、降級）。永久帳號正是名單內的那兩個，其中一個就是操作者本人。同一個請求夾帶 `status` 就回到原本的規則，連方案也一起擋 |
| Apple 的通知**不會蓋掉** `plan_source='admin'`（E3 實作時） | 否則永久帳號的主人在 app 裡試訂一次再取消，到期那天就被降回免費 |
| `users.apple_original_txn` UNIQUE；換帳號「恢復購買」是**搬過去**不是拒絕（E2） | 訂閱屬於 Apple ID 不屬於我們的帳號。UNIQUE 擋的是同一筆交易被兩個帳號同時算成 Pro |
| `public/terms.html` 不用登入 | Apple 對訂閱 app 的硬規定：訂閱畫面與 App Store metadata 都要連得到使用條款（自動續訂、取消方式、退款由 Apple 處理都寫在裡面） |

## 訂閱的寫入（E2／E3，`src/handlers/planapple.js`）

購買證明、訂閱交易、伺服器通知**是同一條 Apple 憑證鏈、同一種簽章**，只差在 payload 裡有哪些欄位。所以 `src/apppurchase.js` 分兩層：`verifyAppleJws()` 驗鏈與驗簽，`verifyAppTransaction()` 與 `verifySubscriptionTransaction()` 各自讀自己的欄位。

**bundleId 與環境的檢查刻意留在上層**（設計文件原本寫在底層）：伺服器通知把這兩個欄位放在 `data.bundleId` / `data.environment`，交易放在 payload 頂層。硬塞進底層就得傳一個「去哪裡拿」的存取器，比讓三個呼叫端各自讀、再共用 `checkBundleEnvironment()` 複雜。

| 決定 | 理由 |
|---|---|
| **只往後不往前** | `currentEntitlements` 是整批送上來的，順序不保證。照單全收會讓最舊的那一筆把最新的到期日蓋掉，使用者付了錢卻在幾天後被降級 |
| **退款（`revocationDate`）是唯一例外，往前寫** | 它本來就是「提早結束」。漏掉的話退了款的人繼續是 Pro |
| **`plan_source='admin'` 不被 Apple 蓋掉**（兩條路都是） | 永久帳號的主人在 app 裡試訂一次再取消，到期那天就被降回免費——他從來沒有要求過那件事。代價：他真的付了錢的話那筆訂閱不記在 `apple_original_txn` 上，日後取消永久身分要「恢復購買」一次。兩害相權，「永久帳號被無聲降級」比較嚴重，因為當事人不會知道為什麼 |
| **同一份訂閱綁到第二個帳號是「搬過去」不是拒絕** | 訂閱屬於 Apple ID 不屬於我們的帳號。單句帶條件的 UPDATE，理由同〈樂觀鎖必須是單句 SQL〉 |
| **`PRODUCT_IDS` 白名單**，不是「有 `expiresDate` 就算」 | 日後多一個別的訂閱，不該讓它也解鎖 Pro |
| 通知**一律回 200 除了驗簽失敗** | 回 5xx Apple 會重送，而「這筆我不認得」重送十次也不會變成認得 |
| `notificationUUID` **去重是省事，不是正確性的前提** | 每一種寫入規則本身都冪等（「只往後」寫同一個到期日是同一個結果、搬移到已經是自己的帳號是 no-op）。所以 `plan_events` 寫失敗只 `console.warn` 不會壞事——**這一點要寫下來，否則下一個人會以為它是前提** |
| `DID_CHANGE_RENEWAL_STATUS`（取消自動續訂）**一個欄位都不改** | 已經付掉的那一期到到期日之前仍然是 Pro。當成立即到期是在沒收已付的錢 |

### app 那一側：為什麼沒有 `notifyListeners`

`Transaction.updates` 要監聽（家庭共享、在別台裝置續訂、Ask to Buy 核准都從那裡進來），但**結果不透過事件送到 JS**：

- 前端是單檔 HTML，沒有引入 `@capacitor/core`，所以沒有 `addListener`。真機上注入的 bridge 與 core 給的東西不一樣——那正是 build 7～10 追了四輪的 bug class。
- `currentEntitlements()` 本來就回「現在有效的全部」。JS 在**啟動**與**回到前景**各問一次，涵蓋的情況完全相同，而且**測得到**（假的 Capacitor 也答得出來）。

原生那側的監聽器只負責 StoreKit 要求的 `finish()`，不 finish 的交易會被一直重送。

**訂閱畫面上的四件事是 Apple 的硬規定，缺一個就退件**：價格與週期（**一律從 StoreKit 拿，不寫死**——各國幣別與匯率換算都在那裡）、「自動續訂、可隨時取消」的說明、「恢復購買」按鈕、隱私權政策與使用條款的連結。`tools/smoke.mjs` 把這四件事寫成斷言。

## 推播（子專案 B，`src/apns.js` + `src/handlers/push.js`）

設計文件 `docs/superpowers/specs/2026-09-17-push-design.md`。三種推播：逾期／即將到期、櫻花樹的撒嬌信（F3）、今天有事要做。內容一律用前端推上來的 `reminder_feed.digest` 算，**與 ICS／提醒信／F2 同一個模式**。

**推播不取代 email，兩者各自有開關。** 手機換了、app 刪了、通知權限被關掉——三種情況下 token 都會安靜地失效，而**使用者不會知道自己從此收不到任何東西**。信箱是唯一不會這樣消失的管道。

| 決定 | 理由 |
|---|---|
| **沒設 APNs secret 就安靜跳過並記成「未設定」**，不是失敗 | 記成紅色的話管理頁天天發假警報，而假紅燈與假綠燈一樣糟——兩者都會讓人不再相信那一頁 |
| **410／`BadDeviceToken` 當場刪掉那個 token**；5xx 留著 | 不刪的話這張表會慢慢長滿再也送不到的 token，而每天都會為它們各打一次 API。一次 5xx 不代表這支手機不見了 |
| `device_tokens.token` 是**主鍵**，換人登入 `ON CONFLICT DO UPDATE` 整列搬過去 | 允許一個 token 對兩個 user 的話，前一位使用者的排程會推到現在這個人的鎖定畫面上——那是資料外洩，不是重複資料 |
| **沒事就完全不推**（三種都是） | 一封沒事的信只是多一列未讀；一則沒事的推播會震動手機，然後人會把通知整個關掉，真的有事時什麼都收不到 |
| 三個開關**各自獨立**，且與 email 的兩個也獨立 | 畫面上就是五顆按鈕。關掉逾期信不代表不想要逾期推播 |
| **送失敗刻意不寫 `push_*_ymd`** | 沒送成功就不算推過，下一次排程要能補。同 `last_sent_ymd` |
| APNs JWT **快取 50 分鐘** | Apple 要求同一把金鑰至少 20 分鐘才換一次、上限 60 分鐘，換太勤會被擋（`TooManyProviderTokenUpdates`） |
| 失敗時**一定要把 APNs 的 `reason` 讀出來** | 只記狀態碼的話「金鑰不對」與「token 不對」看起來一模一樣。同 AgentMail 那條 |
| 權限對話框**只在使用者按下開關時才跳** | iOS 只讓你問一次，開機就問的轉換率遠低於「他自己按了那顆按鈕」之後才問 |
| 權限被拒絕要**說出來**，不是讓開關彈回去 | 那是最典型的沉默：使用者會以為 app 壞了，而不是他自己關掉了通知權限 |
| `aps-environment` **Debug 與 Release 各一個檔案**（`AppDebug.entitlements`＝development、`App.entitlements`＝production），不共用 | 它決定 device token 是**哪一台 APNs 的**。共用一份寫死 `development` 的檔案等於指望 `exportArchive` 會自己換成 production——那是指望不是保證，猜錯時不報錯，症狀是推播送得出去卻永遠收不到（`BadDeviceToken`，看起來像「token 壞了」）。Swift 的 `apsEnvironment()` 早就 `#if DEBUG` 分兩條路，`check-native-plugin.mjs` 現在把兩側釘在一起 |
| **Apple 後台的 App ID 要先勾 Push Notifications，而且要在打包之前** | 沒勾的話 `exportArchive` 重簽時會**安靜地把這一欄從 app 裡拔掉**——打包綠、上傳成功、裝得起來，只有手機真的註冊推播那一刻才會說「找不到有效的 aps-environment 授權字串」（build 13 實際踩過，見 `docs/postmortems/2026-09-17-aps-entitlement-stripped.md`）。**原始碼這一側驗不到這件事**：靜態檢查只看得到「我們有沒有寫」，看不到「簽好的 app 身上有沒有」 |
| 「今天有事要做」**預設關**，另外兩種預設開 | 前兩者有事才響；第三種每天固定時間會響，那種東西預設開是打擾 |

**最大的技術風險：APNs 只收 HTTP/2**，而「Workers 打不打得到」在開發環境證明不了（要真的 `.p8` 與真的 device token）。所以不靠祈禱：

- `POST /api/admin/push-test` 讓管理者**設定完當天**就能證明它通不通，APNs 的回應原樣回給管理頁。
- cron 的推播那一步走 `step()`，成功與失敗都進 `cron_runs`，`/admin` 看得到。同〈看得見的備份才是備份〉。
- 連線層的例外（協定被拒就是這個形狀）要進 `errors[]`，不是只留在 console。

## 遊戲化（〈遊戲化〉與〈遊戲化畫面〉區段）

設計文件 `docs/superpowers/specs/2026-09-16-gamification-design.md`。參考「Life Reset: 66 Day Habit」，只搬 XP／等級／連續／挑戰梯子，不搬懲罰、排行榜、勵志卡、附加工具。免費版與 Pro **沒差**。

| 決定 | 理由 |
|---|---|
| **所有數字都是算出來的，不是存起來的**（同 occurrence 引擎） | 存帳本就要合併帳本（兩台裝置各自賺 XP，`threeWayMerge` 要長第二套語意）；帳本會跟資料脫節（刪項目、還原備份）；存檔格式不必升版 |
| 唯一的新儲存是 `item.doneAt[occKey]`（毫秒），只在 `setOccurrenceDone` 寫 | 「那一天結束前做完」沒有時間戳算不出來。取消勾選就刪掉那個 key |
| 「一天」＝那天安排的事**在那天 23:59:59 前**全部做完；隔天補勾不算 | 使用者的裁決。否則連續天數變成「有沒有補勾」而不是「有沒有按時做」 |
| 沒安排的日子 `empty`：**不斷也不加** | 使用者的裁決；週末、假日、「不在」的日子才不會把火焰弄斷。有測試守著 |
| 今天 `missed` 不斷昨天的連續 | 今天還沒過完。隔天再看才真的斷。有測試守著 |
| `GAME_EPOCH`（上線日）之前一律不算 | 舊的完成沒有時間戳，追溯會把上線第一天畫成「你以前什麼都沒按時做」。角色從種子開始 |
| 挑戰梯子 7 → 14 → 30，拿到才解鎖下一階；斷了從 0 重爬同一階、**不掉階** | 使用者選的形狀（不是 66 天） |
| 角色是一棵櫻花樹，六階，inline SVG，顏色走 CSS 變數 | 「紙與光」同一套顏色；單檔不引外部圖檔。連續斷掉那天只**微微垂下**，不枯不死——那是信的工作（F2），不是畫面的。畫皮與引擎的分界見〈換畫皮：櫻花樹接手，而引擎一個字都沒動〉 |
| **紅線不動**：逾期的紅字、字重、顏色一個都不改 | 遊戲化只加東西不減東西。`tools/check-deps.mjs` 那兩條斷言照樣守著 |
| 完美一天的 toast 與升級的光在 `renderAll` 裡比對前後（`gameCelebrate`） | 那一刻才是遊戲化真正發生的地方；數字每次 renderAll 重算（展開上線日到今天，與年度檢視同量級），**不做快取**——快取失效才是 bug 的來源 |
| 升級的光掛在 `.levelup`、`animationend` 拿掉；`prefers-reduced-motion` 一律關 | 同打勾的 `.pop`：掛在狀態 class 上會每次重繪都冒 |
| v1 **不防**「改日期救火焰」 | 要防就得存第二份時間戳（覆寫的時間）。同一個人在同一份工具裡騙自己，先寫下來看有沒有人這樣做 |

### 換畫皮：櫻花樹接手，而引擎一個字都沒動

原本的角色是一株植物（種子 → 發芽 → 小苗 → 小樹 → 開花 → 結果），2026-09-18 換成一棵**跟著四季循環**的櫻花樹：新芽 → 抽枝 → 花苞 → 綻放 → 花落 → 新芽（第二輪）。

| 決定 | 理由 |
|---|---|
| **`GAME_STAGES` 的六個 key（`seed`…`fruit`）刻意沒有跟著改** | 它們是「第幾階」的識別字，不是畫皮的名字。`tests/game.test.mjs` 斷言 `stageOf(12) === 'flower'`，而那支測試正是「畫皮有沒有動到語意」的絆線——**換畫皮時它如果紅了，代表動到的不只是畫皮**。跟著改名就得改那支測試，絆線也就一起拆掉了 |
| 所以 `sakuraArt()` 第一行就把序數**翻成櫻花的四季**，底下只講櫻花的話 | 不翻的話下一個人讀到 `stage === 'fruit'` 會照字面畫一顆果實出來。給人看的名字（新芽／抽枝／…）只活在 `acctRenderGame` 的那一份對照表裡 |
| **第 5 階回到第 0 階的樣子，芽與葉逐字相同，只有樹幹更粗** | 「不停的四季循環」要看得出來是第幾輪，否則 Lv.17 與 Lv.1 長得一模一樣，升級就沒有意義了。多畫一片葉子來湊差別是錯的——那會變成另一個形狀，看的人會以為長出了別的東西 |
| `<g class="sakura">` 與 CSS 的 `.game-avatar .sakura` **必須逐字相同** | 對不上時 CSS 整條不作用，而**畫面看起來完全正常**：只有「連續斷掉那天微微垂下」從此再也不會發生，沒有任何東西會紅。`tools/check-ambience.mjs` 因此量計算後的 `transform-origin`（對得上才量得到 `60px 100px`），並真的加一次 `.wilt` 看 `transform` 有沒有變成旋轉矩陣 |
| 連續斷掉仍然只是**微微垂下**，不枯不死 | 沒有改。枯掉是信的工作（F2），不是畫面的 |
| **信必須跟著改口**（見下一節） | 不改的症狀是「畫面上是櫻花樹，信卻是別的植物寫的」。不會壞、不會報錯，只會讓人覺得哪裡怪怪的 |

畫皮換完之後要一起看的還有：`--sakura-*` 六個變數（`:root` 與 `[data-theme="dark"]` **兩組**）、帳號頁的階段名稱、I18N 的中英兩版、帳號頁與推播開關上的 🌸、以及 `tests/state.test.mjs` 裡比對署名的那一條。

### 開機的櫻花：它是遮罩，不是關卡

開機時一層 `position:fixed` 的櫻花蓋在畫面上，從新芽長到**你現在那一階**，約一秒後自己淡掉。「遮罩不是關卡」這句話有兩個具體的實作，兩個都不能拿掉：

| 決定 | 理由 |
|---|---|
| **`pointer-events:none`** | 畫面照常繪製、照常按得到，它只是蓋在上面演一段。〈字型不阻擋首次繪製〉量過：CDN 慢 1.5 秒時擋住繪製會讓 FCP 從 536ms 變成 2060ms——一個純粹為了好看的動畫沒有資格讓 app 開起來慢四倍。順帶解掉 `page.click()` 會打到它的問題（設計文件原本擔心的那一條） |
| **由 CSS 決定它何時消失，不是 JS** | 交給 JS 的計時器，JS 一摔倒就留下一張**永遠蓋住整個 app 的紙**——與 `.ai-panel[hidden]` 那個看不見的全屏遮罩是同一個 bug class，而那一次是瀏覽器測試才抓到的。現在 JS 只負責畫：畫不出來最多是一片乾淨的底色，1200ms 後照樣自己走。**上限因此是唯一的機制，不是 JS 的備援**，所以「它會不會消失」與「JS 有沒有跑」完全無關 |
| `prefers-reduced-motion` 是 **`display:none`**，不是淡出 | 純氛圍、沒有任何資訊在裡面，是最該被關掉的那一種動畫（同光暈、同升級的光） |
| 階段順序從 `GAME_STAGES` 取，**不另外抄一份** | 抄出來的那一份遲早走鐘。`bootSakuraPlay` 只做「畫到第 N 階」，等級與階段仍然是引擎算的 |
| **只在開機呼叫一次**（〈啟動〉區段，`applyLang()` 之後） | 切頁籤播一次是儀式，第三次就變成「這個 app 好慢」。那時 `renderAll()` 已經跑過，`lastGame.stage` 現成 |

**設計文件的「資料就緒（`renderAll()` 跑完一次）就淡出」在實作時併進了上限那一條，而那是實作階段才看得出來的事**：`renderAll()` 是同步的、在第一次繪製之前就已經跑完，所以「資料就緒」在 t=0 永遠成立——照字面做的話這段動畫一幀都不會播。它要等的東西其實不存在，所以它不等任何東西，只有上限。

`tools/check-ambience.mjs` 九條守著，其中兩條是這一節的重點：

- **上限本身**要被測到，而不是只測「正常情況下會消失」——那一輪把 **JavaScript 整個關掉**再看 1500ms 時它在不在。改成 JS 的計時器當場紅。
- 成長動畫真的**演到使用者現在那一階**：種子造到 Lv.3（抽枝），斷言開場那一幀沒有枝、820ms 後有枝。永遠停在第一幀的話只有這一條會紅。

那一輪的種子**要釘死時鐘**（`page.clock`）：等級是從「上線日到今天」算出來的，靠執行當天是幾號的話，過幾天這支檢查就會自己變色。

### F2：連續斷掉時，由櫻花樹寄一封撒嬌的信

走既有的每日 cron 與 `reminder_feed`（`sendStreakBroken`）。不能拿掉的判斷：

| 決定 | 理由 |
|---|---|
| digest 每一筆多帶 **`ot`（按時完成）布林**，**不是**推 `doneAt` 讓 Worker 自己比 | 那個判斷的細節（到期日、跨多天以結束日算、當天 23:59:59 的界線）在〈遊戲化〉區段且有測試守著。在 Worker 重寫一份必然分歧，而分歧的症狀是「畫面說連續 12 天、信說斷了」——比沒有這封信更糟。同 ICS 與逾期提醒。**設計文件原本寫 `a: doneAt`，實作時改成 `ot`，理由就是這一條** |
| 連續天數也由前端算好推上來（`streak_current`） | 信裡印的就是它，與閘門用的是同一個數字，不會出現「擋住了卻印另一個數」 |
| `dayReport` 只看**一天**，不往回走 | 「那天有安排、而且不是每一件都按時完成」就是斷了。往回數幾天是前端的事 |
| **連續不到 2 天不寄** | 每天一封「你昨天又沒做完」只會訓練收件者忽略這個寄件人——「沒事就閉嘴」在這裡比逾期提醒更重要，因為會觸發的條件更寬 |
| 同一天只寄一次（`streak_mail_ymd`）；**寄失敗刻意不寫那個欄位** | 沒寄成功就不算寄過，下一次排程要能補。同逾期提醒的 `last_sent_ymd` |
| 與逾期提醒是**兩個各自獨立的開關**（`streak_mail`），查詢也用它而不是 `enabled` | 畫面上就是兩顆按鈕。關掉逾期提醒不代表不想聽櫻花樹說話，反過來也一樣。有測試守著 |
| 今天一早自己打開 app 同步過的人收不到 | 他推上來的連續已經歸零——人已經回來了，櫻花樹不必再叫他。這是刻意的，不是漏洞 |
| 信是**那棵樹的第一人稱**，署名也是；講事實（幾天、哪幾件）不評價 | 使用者的裁決是「撒嬌」。罵人的信會被封鎖寄件人，然後逾期提醒也一起收不到 |

F3（推播版）**已實作**，見〈推播〉：它與 email 版共用 `dayReport` 與同一個 `MIN_STREAK` 門檻，兩邊不一樣的話會出現「信說斷了、推播沒推」。

### app 的九個探針（`tools/smoke.mjs` 第七輪）

TestFlight build 7 回報的症狀是「app 安靜地變成單機模式」——沒有紅字、沒有 app 的登入畫面、畫面上是示範資料。那個狀態有**八個各自獨立的成因，而八個在畫面上長得一模一樣**，既有的檢查一個都抓不到。完整經過在 `docs/postmortems/2026-09-16-app-silent-standalone.md`。

| 探針 | 外殼長什麼樣 | 斷言 |
|---|---|---|
| 1 | 只有 `nativePromise`（沒有 `isNativePlatform`） | 仍要認出自己是 app——證據是 app 的登入畫面蓋上來（網頁版那條路不會有它） |
| 2 | 只有 `isNativePlatform`，插件不在 | 狀態列要出現「app 啟動異常」並附診斷 |
| 3 | 外殼正常、Keychain 有 token，`/api/state` 回 404 | 要是**紅字**的連線失敗，不是單機模式 |
| 4 | 讀 bridge 就丟例外 | 摔倒要被 `.catch` 接住並寫在畫面上 |
| 5 | 外殼與網路都正常，`/api/state` 回 **200 但沒有 `user`** | 帳號頁那一格要印出診斷 |
| 6 | 電話打得出去、**對面永遠不回話**（promise 不會 settle） | 要超時、回到登入畫面，並在那裡說出 `probe=timeout` |
| 7 | 外殼與 Keychain 都正常，`/api/state` **永遠不回應** | 看門狗要在 12 秒後開口說「啟動卡住了」 |
| 8 | 外殼正常、Keychain **讀得到但寫不進去**，使用者真的登入一次 | **不准退回登入畫面**，而且狀態列要說出「存不住登入狀態」並附診斷 |
| 9 | 外殼、Keychain、網路**全部正常**，只是 `/api/state` 慢一拍，而使用者在那之前就切到「我的帳號」 | 同步完成時那一頁要**跟著變**——帳號頁寫「單機模式」而 footer 寫「雲端同步啟用中」是自相矛盾 |

**刻意不把第五輪的假 Capacitor 改殘缺**：那一輪要驗的是「正常的 app 走得完」，兩件事混在一起，哪一個壞了都分不出來。突變驗證過八種改法各自只紅一支。

**探針 6／7 守的是第三輪：卡住的形狀沒有任何事件。** build 9 印出來的是 `signals=`（五個全中）、`plugin=yes`——app 認得自己、插件也在，卻仍然什麼都沒發生。因為 `nativePromise` 的 promise **不是 reject，是完全不會 settle**：沒有例外、沒有 rejection、沒有紅字，程式根本還沒走到會說話的那一行。任何一個不會 settle 的 `await` 都長這樣，列不完。三個對策：

- **每一通原生電話都有時限**（`NATIVE_CALL_TIMEOUT_MS`）：把「沒有事件」變成一個會說話的 reject。
- **開機看門狗**（`BOOT_WATCHDOG_MS`）：不問卡在哪，只問「到現在有沒有走到任何一種結局」（同步啟用／登入畫面蓋上來／狀態列已經解釋過了）。一種都沒有就開口。這是這一輪真正的保險，涵蓋還沒想到的下一條。
- **診斷要誠實**：`plugin=yes` 改成 `bridge=`（有沒有電話線）＋ `probe=`（對面有沒有接）。**過度樂觀的診斷會把人帶去查錯的地方**——`plugin=yes` 看起來像「插件正常」，實際上那通電話沒人回。

**探針 8 守的是「登入之後」，前七支守的都是開機。** 使用者回報的第二個症狀是「登入後又突然退出 app，要重新登錄」，而它與前四輪是**同一個根因**：插件沒註冊 → `keychainSet` 沒人接 → 六秒後超時 → `nativeTokenSave` 把失敗吞掉 → **照樣 `location.reload()`** → Keychain 還是空的 → 又是登入畫面。一次又一次，全程沒有任何一句話。

三個判斷不能拿掉：

- **`nativeTokenSave` 回傳布林，不是 void。** 吞掉這個失敗的代價不是少一行 log，是整個 app 用不了。沒有這個回傳值，呼叫端連「有沒有存進去」都問不到——〈降級可以，沉默不行〉在這裡的具體形狀就是它。
- **存不住就絕對不能 `reload()`。** reload 回來 Keychain 還是空的，於是又是同一頁。改成：這一次照樣讓她進得去（token 還在記憶體裡），但把原因寫在狀態列上，並明說關掉 app 要重登。
- **那句話要寫在 `initCloudSync` 之後。** 同步成功會把狀態列改成「已同步」，先寫就被蓋掉了——而被蓋掉的正是這一次唯一要講的那句話（實測踩到，探針 8 第一版就是紅在這裡）。

**探針 9 守的是「同步好好的、只有那一頁沒跟上」。** 前八支守的都是同步真的壞掉；這一支的環境全部正常，只是 `/api/state` 慢一拍，而使用者在那之前就切到「我的帳號」。症狀是**同一個畫面上兩句話互相矛盾**——帳號頁寫「目前為單機模式」，下方的 footer 寫「雲端同步啟用中」。不會壞、不會報錯，使用者只會以為自己沒登入（實際回報過）。根因是 `cloudEnabled` **有五個地方會改**，五處都記得更新 footer、**沒有一處記得帳號頁**，所以現在一律走 `setCloudEnabled()`——把「跟著旗標走的畫面」收斂到一個地方，下一個人加第三塊時不必再記得第四個呼叫點。

**這一支的第一版是綠的，而且綠的理由是錯的**：假後端讓它走到「這台裝置初次開啟 → 採用雲端」那條分支，而那條分支結尾有一個 `renderAll()`，順手把帳號頁重畫了。真正咬人的是另一條（本機有資料、版本對得上 → `cloudPush()` 就 return，中間沒有任何重繪）。**突變驗證是唯一發現這件事的方法**——測試過了不代表它測到了要測的東西。現在探針 9 先載入一次寫下 `cloudMeta`，再 reload 走那條沒有重繪的路。

**探針 5 守的不是某一條路，是那一格本身。** build 8 上線後症狀仍在——而且連新加的紅字都沒出現，因為它走的是第五條（`/api/state` 回 200 卻沒有 `user` → `setCloudNote('')`）。逐條堵洞永遠會漏掉下一條，所以帳號頁多一格 `#acctSignedOutDiag`：**只要走到單機模式、而環境看起來像 app，就把當下的訊號印出來**，不問是哪一條路帶來的。判斷用 `looksNativeShell()` 而**不是 `NATIVE`**——`NATIVE` 判錯正是要診斷的故障之一，讓它決定診斷要不要出現，最需要說話的那一種情況剛好會最安靜。

**驗證**：`tests/appauth.test.mjs`、`tests/account-delete.test.mjs`（突變驗證七種改法都會紅）；`tools/smoke.mjs` 的「iOS app 外殼」那一輪用假的 `window.Capacitor` 走登入畫面、寄驗證碼、登入、**所有線上請求都帶 Bearer**、登出清 Keychain（拿掉 Bearer 那一行當場紅）。原生那一側：模擬器跑得到插件註冊與大部分行為，`AppTransaction` 與真的推播只能靠 TestFlight。

**真機驗收要分「讀」與「寫」兩半，而且要指名看哪一格**（build 11 就是這樣結案的）：讀＝帳號頁「雲端同步啟用中」綠色**且沒有 `#acctSignedOutDiag` 那一格**（它不在才是證據）；寫＝**把 app 完全關掉再打開，不用重新登入**。第一半全綠時第二半照樣可能是壞的（build 6～10 就是），所以只驗第一半等於把那個無限輪迴留在原地。八支探針擋得住回歸，證明不了這一次真的通了。**這一段的成本 2026-09-17 之後降了很多**：插件註冊在**模擬器**上就走得到，那四輪追的東西現在五分鐘看得到；真機仍然無可取代的只剩 `AppTransaction`、真的 APNs token 與真的付款。

## 跨帳號分享

只分享**指標**，不複製內容。`shares` 一列＝「擁有者把某一個資源分享給某一位使用者」，資源本身永遠只有一份，存在擁有者的 `user_state` JSON 裡。

複製一份到對方帳號會立刻讓兩邊各自漂移，而分享的語意就是雙方看的是同一個東西——這是整個設計的出發點，不要為了「讀取比較快」而改成複製。

| 端點 | 用途 |
|---|---|
| `GET /api/shares` | 我分享出去的（只回 id，名稱由前端在本地解析）＋ 別人分享給我的（附資源內容） |
| `POST /api/shares` | 建立／更新權限。`UNIQUE` 讓重複分享變成改權限而不是長出第二列 |
| `DELETE /api/shares/:id` | 擁有者收回，或被分享者自行移除 |
| `PUT /api/shared/:shareId` | 被分享者寫回**單一資源**。伺服器端以**欄位白名單合併**（`mergeSharedEdit`），只接受完成狀態／進度／子代辦勾選 |
| `GET /api/activity` | 與我有關的共享操作記錄 |
| `GET /ics/:token`（公開） | 行事曆訂閱 feed，token 即憑證 |

### 幾個不能拿掉的判斷

- **路徑帶的是分享單 id，不是資源 id。** 可寫的目標與權限都由那筆分享決定；若以資源 id 直接定位，任何人猜到 id 就能寫別人的資料。
- **寫回時驗證 `resource.id === share.resource_id`**，否則等於拿一張合法的分享單去改擁有者的其他東西。
- **只換掉 state 陣列裡的那一個元素**，其餘原樣寫回。這是「別人能改我的資料」可以被接受的前提：影響範圍限於被授權的那一個資源。
- **建立分享時確認資源存在於擁有者的雲端 state**，否則會留下永遠解析不到的孤兒列（`resource_id` 在 JSON blob 裡，沒有外鍵可擋）。前端因此在 POST 前先強制 `cloudPush()`，免得剛建立、還沒推上去的項目被判定為不存在。
- **擁有者刪除資源後分享列仍在**，`GET /api/shares` 會回 `resource: null`，前端顯示「已被移除」——比讓它從畫面上憑空消失容易理解。

### 分享過來的資料不進 `snapshot()`

它們的權威來源是對方的帳號，因此**不寫 localStorage、不進雲端同步、離線就顯示為不可用**。若在本地留快取，離線編輯後會與對方的版本無聲分歧。

也因此它們**不併入 `items[]` / `ganttProjects[]`**，只出現在「共享」頁。混進去的話，每一條 render 與寫入路徑都要多判斷一次「這是不是別人的」，而 `commit()` 會把別人的資料一起推進我自己的雲端 state——那是資料汙染，不是功能。

代價是分享的項目不會出現在日曆與指標卡。要改成整合式顯示的話，得先把「寫入路徑依資源歸屬分流」這件事做對，不是加個旗標就好。

### 分享的三種對象

`kind` 為 `item`（小項目）、`gantt`（專案）、`major`（大項目＝底下所有小項目）。大項目分享的寫回對象是**底下的某一個子項目**，授權依據是「該項目此刻真的隸屬於被分享的大項目」（伺服器逐次驗證 `parentId`）——擁有者把項目移出大項目，這條授權立即失效。

### 行事曆訂閱（ICS）

內容由**前端產生**（`buildICS()`），每次成功同步後推上伺服器保存，`/ics/:token` 只負責供應。不在 Worker 重新實作展開邏輯：occurrence 引擎只存在前端單檔內，兩套必然分歧；假日順延也本來就無法用 RRULE 表達，展開成靜態事件才是對的。代價是使用者一段時間沒開 app，feed 停在最後一次同步——對訂閱可接受。token 只存雜湊、URL 只在產生當下回傳一次，重新產生即撤銷舊連結。

### 逾期提醒信（cron）

**與 ICS 同一個模式，理由也完全相同**：內容由前端 `buildReminderDigest()` 展開、每次成功同步後推上伺服器，Cron 只做「比對日期 → 寄信」。Worker 不重新實作 occurrence 引擎——兩套必然分歧，而**提醒寄錯日期比沒有提醒更糟**，因為使用者會信任它。

- 推上來的是**已展開的排程**（`[{t,d,k,done}]`）而不是「已經算好的逾期清單」。逾期與否隨日期改變，今天不逾期的項目後天就逾期了；存日期讓 cron 每天自己比對，使用者一段時間沒開 app 也不影響正確性。
- **今天到期的不算逾期。** 那是「今天要做」，混進去會把真正遲交的東西淹沒——它屬於「即將到期」那一段。
- **沒有逾期、也沒有即將到期就完全不寄。** 每天一封「你今天沒事」只會訓練收件者忽略這個寄件人，真的有事時反而看不到。加了事前提醒之後這條**更重要**，不是更不重要：會觸發寄信的條件變寬了，那道「沒事就閉嘴」的閘門就更要守住。
- **提醒預設為開啟**（`reminder_feed.enabled` 預設 1）。提醒的價值在於「不必記得去看」，而預設關閉等於要求使用者先知道有這個功能、再自己去打開——真正需要提醒的人往往就是不會去翻設定的人。信只寄到本人的註冊信箱、沒事就完全不寄，打擾成本很低。
- **但「預設開啟」不能只改 schema。** 實際建立那一列的是 `handleReminderPut` 的 INSERT，它原本寫死 `enabled = 0`，schema 的預設值永遠用不到。改完之後最危險的方向反過來了：**推送絕不能把使用者親手關掉的提醒又打開**（`DO UPDATE` 只改 digest），那是他明確表達過的選擇，有測試守著。
- **事前提醒（`lead_days`）**：提前幾天開始通知，預設 3、上限 30。`0` 代表只在逾期時通知，也就是原本的行為——那條路要留得回去。`pickOverdue` 取 `d < today`、`pickUpcoming` 取 `today <= d <= today+lead`，兩者**剛好互補，不重疊也不漏接**。
- 信件分兩段且**逾期永遠在前**：兩者要的行動不同（「已經遲了，現在處理」vs「先看一眼，安排時間」），混成一張表會讓真正遲交的被淹沒。主旨有逾期時讓逾期當主角——收件匣通常只看得到主旨。
- `lead_days` 是**既有資料庫要跑 migration 的欄位**（見〈資料庫結構變更〉）。
- `last_sent_ymd` 讓同一天不重寄（cron 會重試）；**寄失敗時刻意不寫這個欄位**，沒寄成功就不算寄過，下一次排程要能補。
- `handleReminderPut` 只更新 digest、不動 `enabled`：推送是同步的副作用，不該把使用者關掉的提醒打開。
- 需要兩個 secret，另有選填的 `APP_URL` 用於信中的連結：

| 變數 | 值長什麼樣 | 說明 |
|---|---|---|
| `AGENTMAIL_API_KEY` | `am_us_inbox_b1e2…` | 帳號層級的憑證。**前綴雖然寫著 `inbox`，它是 API key 不是 inbox id** |
| `AGENTMAIL_INBOX_ID` | `uic_ai@agentmail.to` | 寄件信箱的識別碼，形式是 **email 位址** |
| `AGENTMAIL_TX_API_KEY` | 同上形狀 | **選填。** 交易信（密碼重設／驗證碼）專用，要是**另一個帳號**的 key。沒設就與訂閱信共用，見〈交易信與訂閱信分家〉 |
| `AGENTMAIL_TX_INBOX_ID` | 同上形狀 | **選填。** 上面那個帳號的寄件信箱。兩個都設才生效，只設一個會退回共用並在 `/admin` 標成「設定不完整」 |

推播另外要三個（見〈推播〉與設計文件的〈使用者要做的事〉）：

| 變數 | 說明 |
|---|---|
| `APNS_KEY_ID` | APNs 金鑰的 Key ID（10 碼）。**與打包用的 `ASC_KEY_ID` 是不同的兩把金鑰** |
| `APNS_TEAM_ID` | Team ID（10 碼） |
| `APNS_P8` | `.p8` 檔案的**完整內容**，含 BEGIN／END 那兩行。只能下載一次 |

三個都沒設時推播那一步安靜跳過並記成「未設定」——**不是失敗**，理由見〈推播〉。

這兩個極容易搞反——`am_us_inbox_…` 看起來就像 inbox id，但它其實是 key（開發時實際搞錯過兩次）。分辨方法是直接問 API：

```bash
curl -H "Authorization: Bearer <你以為的 key>" https://api.agentmail.to/v0/inboxes
```

回 200 就代表那個值是 API key，而回應的 `inboxes[].inbox_id` 才是要填進 `AGENTMAIL_INBOX_ID` 的東西。

#### AgentMail 的端點路徑一定要帶 `/v0`

```
POST https://api.agentmail.to/v0/inboxes/{inbox_id}/messages/send
Authorization: Bearer <API_KEY>
```

**版本前綴不可省略。** 官方文件正文與部分範例寫成 `https://api.agentmail.to/inboxes/…`（沒有前綴），照抄會 404——而 404 在 log 裡看起來像「inbox 不存在」，會往完全錯誤的方向查。以 <https://docs.agentmail.to/openapi.json> 為準：`servers` 是 `https://api.agentmail.to`，路徑本身帶 `/v0`。

`tests/state.test.mjs` 的 cron 測試**比對完整 URL 字串**而不是只看結尾，就是為了讓這個前綴掉了會失敗（加測試後實際拿掉 `/v0` 驗證過它會紅）。

`to` 依規格接受單一字串或字串陣列；`subject`／`text`／`html` 都是選填，錯誤回應（400/403/404/409）的訊息在 body 裡，因此失敗時要把 body 一起記下來——只記狀態碼的話，「key 無效」與「inbox 不存在」看起來一模一樣。

### 權限只有兩級

- `view` — 唯讀
- `edit` — 可勾選完成、可勾選子代辦、可改任務進度

**重新命名、改日期、刪除一律只有擁有者能做**，被分享者的 UI 不提供這些操作。權限的粒度若要再細分，應該加在 `permission` 欄位（例如 `'comment'`），不要用前端隱藏按鈕充當權限。

## 備份、PWA 與操作記錄

### 匯出／匯入

匯出的就是 `snapshot()`，與雲端同步共用同一個序列化格式——不要為了備份另外做一套轉換，那會多一個必然走鐘的地方。匯入走 `applySnapshot()`，因此版本檢查與正規化都是現成的。

**下載檔名必須是 ASCII。** Chromium 遇到非 ASCII 的 `download` 屬性會整個忽略，檔案存成沒有副檔名的 `download`，而匯入的檔案選擇器只收 `.json`——備份存得下去卻選不回來（實測過）。同理，`<a download>` 要先掛進 DOM 再點，游離的 anchor 在部分瀏覽器上會忽略該屬性。

### Service worker（`public/sw.js`）

三條規則，第一條是安全性不是效能：

1. **`/api/*` 一律不快取。** 那裡面是使用者資料與登入狀態，快取住的話換人登入會端出前一位使用者的排程。
2. **導覽請求走 network-first。** 快取優先會讓部署後的新版本要等清快取才生效。
3. **只快取 200 且非重新導向的同源 GET。** `/` 未登入時會 302 到 `/login`，存起來就變成「永遠被導向登入頁」。

改版時把 `CACHE` 的版本號往上加，`activate` 會自動清掉舊的。註冊端只在 `http(s)` 下進行，`file://` 開啟時瀏覽器不允許 service worker，硬註冊會丟例外而破壞單檔開啟的前提。

### 操作記錄

只記「被分享者對別人的資源做了什麼」。擁有者改自己的東西不記——那是他自己的資料，記了只會把真正需要注意的事情淹沒。

- **描述由伺服器算**（比對前後的完成數量），不採用前端送來的字串。讓被分享者自己決定記錄要寫什麼，記錄就沒有意義了。
- **`resource_name` 是當下的名稱快照**，刻意不正規化：資源改名或刪除後，記錄仍要讀得懂當時動的是哪一個。
- **保留 90 天**，寫入時順手清理。沒有保留上限的日誌表遲早會是資料庫裡最大的一張。
- 記錄失敗只留 `console.warn`，不讓已經成功的寫入變成 500——資料已經進去了，回錯誤會讓使用者重試而重複操作。

### 國定假日

`BUILTIN_HOLIDAYS` 只放**已經正式公布**的年度，由 `tools/parse-gov-calendar.py` 從人事行政總處的官方 xlsx 解析而來。

**不在執行時去抓官網**：跨網域會被 CORS 擋、離線就失效，而且會讓「單檔可獨立開啟、零外部相依」的前提破功。寧可每年手動跑一次腳本。

**不自行推算日期。** 假日每年由行政院公布，且會因調整放假與補假而變動（例如 2026 年的 2/27、4/3、10/9 都是因為節日落在週末而調整的）。沿用去年或自己推算，會讓「遇假日順延」算出看似合理但錯誤的日期——那比沒有這個功能更糟，因為使用者不會發現。

那份官方檔案是給人看的月曆版面，**放假與否只用粉紅底色（`FFFF99FF`）標示，沒有任何文字標籤**，所以只能靠樣式判讀。腳本內建數個 assert，格式一變會直接報錯而不是安靜產出錯誤日期。已經踩過的坑：十一月與十二月的標題被拆成兩個儲存格（`'十'+'一'`、`'十'+'二'`），只取「月」之前最後一個中文數字的話，十一月會被讀成一月、十二月讀成二月——產出的日期全都合法卻完全錯誤。

#### 新增年度的作法（照這個順序做）

檔案在 <https://www.dgpa.gov.tw/informationlist?uid=30>，標題是民國年（**116 年＝2027**），附件那三個連結指向同一個 xlsx，差別只在 `nfix` 決定轉成什麼格式——要的是 `nfix=` 空值那一個。

1. 下載該年度的 xlsx
2. `python3 tools/parse-gov-calendar.py <檔案> --json`
3. **先拿一個已經在 `BUILTIN_HOLIDAYS` 裡的年度重跑一次**，確認輸出與現有清單逐字相同。這是唯一能證明「解析器對這個檔案格式仍然有效」的方法——新年度沒有答案可以對，舊年度有。2027 那次就是這樣驗的：2026 的 16 天一字不差，才採用 2027 的輸出。
4. 貼進 `BUILTIN_HOLIDAYS`，跑 `node --test tests/holidays.test.mjs`

`tests/holidays.test.mjs` 守的是第 4 步之後：日期真的存在、年份與鍵一致、同年不重複且已排序、天數在合理範圍，以及**不能出現週六日**。最後一條是這份資料唯一不必連網就驗得到的內在性質——腳本輸出的是「平日放假」，週末本來就被 `isHoliday()` 當成假日，列進來只可能是貼錯或月份整批位移（就是上面那個十一月／十二月的坑，位移後約 2/7 的日期會落到週末）。它不是萬無一失，所以**它不能取代第 3 步**。

**補班日沒有內建結構。** 2026、2027 都是 0 天，所以 `BUILTIN_WORKDAYS` 還不存在。哪一年真的有補班日，要先加那個結構——不要把補班日塞進 `BUILTIN_HOLIDAYS`，那會讓「要上班的週六」變成假日，方向剛好相反。

## AI 小幫手（`src/handlers/ai.js`）

接 DeepSeek 官方 API（`https://api.deepseek.com/chat/completions`，OpenAI 相容）。兩個端點：`/api/ai/ask`（問答，唯讀）與 `/api/ai/plan`（**提案**）。

**AI 永遠不直接寫入。** `/api/ai/plan` 只回一份提案，寫入發生在使用者在畫面上勾選並按下「加入」的那一刻，走既有的 `commit()`。這個形狀比「AI 直接寫、寫錯了按復原」安全一個層級：復原是**事後補救**，勾選是**事前確認**——最壞情況因此從「資料被改錯、等人發現」變成「畫面上多了一份沒被採納的清單」。

設計文件在 `docs/superpowers/specs/2026-09-08-ai-sidebar-design.md`，以下是實作後不能拿掉的判斷：

| 決定 | 理由 |
|---|---|
| 金鑰只在 Worker（`DEEPSEEK_API_KEY` secret） | `index.html` 是任何人都下載得到的檔案。同 `AGENTMAIL_API_KEY` |
| **排程由前端展開後送上來** | occurrence 引擎只存在前端單檔內。在 Worker 重寫一份必然分歧，而「AI 根據錯誤的日期回答」比沒有 AI 更糟。同 ICS 與逾期提醒 |
| **上游的錯誤原文絕不轉發給前端** | 那是最容易漏金鑰的一條路（上游可能把 key 回吐在錯誤訊息裡）。完整內容留在 `ai_activity` 與 console。**有測試守著** |
| `ai_activity` 的那一列**在呼叫之前**就先寫 | 這張表同時是花費記錄與限流依據。順序反過來的話，寫入失敗＝沒有限流，而「記錄失敗只 console.warn」那條慣例在這裡會變成可以無限花錢的洞。所以佔不到位子就不呼叫 |
| 限流分鐘與天兩層，且回得出還要等多久 | 「請稍後再試」等於沒說。同〈降級可以，沉默不行〉 |
| token 數顯示在 `/admin` | 看不見的花費會失控。同〈看得見的備份才是備份〉 |
| 偵測不到 `/api/ai/status` 就**完全不顯示入口** | `cloudPull()` 的 `absent` 分支，不是 `failed` |
| AI 的回覆一律 `textContent`，絕不 `innerHTML` | 那是外部內容 |

**`.ai-panel[hidden]{ display:none; }` 這一行不能拿掉。** `display:flex` 的優先度高於瀏覽器內建的 `[hidden]{display:none}`，少了它，「關著」的面板仍然佔滿右半邊並吃掉所有點擊——一個看不見的全屏遮罩。這是瀏覽器測試抓到的真實 bug，靜態檢查與單元測試都不會紅。

### `align-items` 在 column 底下管的是寬度，不是對齊

英文版在 390px 會橫向溢出 21px，中文不會。追下去的根因不在任何一個「太寬」的元素上：

```css
.layout{ display:flex; gap:20px; align-items:flex-start; }          /* 桌機：橫排 */
@media (max-width:820px){ .layout{ flex-direction:column; } }        /* 行動版：直排 */
```

橫排時 `align-items:flex-start` 管的是**垂直對齊**（讓側欄不要被拉到跟看板一樣高，那是刻意的）。`flex-direction` 一變成 column，同一個宣告管的就變成**寬度**——`.main-panel` 因此不再是容器的寬度，而是縮到「內容的寬度」，也就是它裡面最寬的那一列說了算。

**最誤導的地方是 `.main-panel` 早就寫了 `flex:1; min-width:0`。** 那兩個管的是**主軸**，在 column 底下完全使不上力，所以看起來「該做的都做了」。修法是在那個 media query 裡把 `align-items` 一起改成 `stretch`。

第二個成因是 `.filter-types`（標籤篩選那一排）沒有 `flex-wrap`，內容比面板寬時把面板的內容寬度一起撐大。改成換行而不是橫向捲動：標籤數量是使用者自己長出來的，橫捲會讓後面幾個藏起來，而「找不到的東西等於不存在」。

**但這一節真正的重點是工具的洞。** `tools/check-mobile.mjs` 一直有「五頁都不橫向溢出」這條斷言，而它**只跑中文**——英文字串一律比中文長，所以這條斷言天生驗不到最容易溢出的那一種情況。同〈「畫面上沒有這個元素，略過」是一條永遠不會執行的斷言〉：檢查涵蓋不到的地方等於沒有檢查，而且還會給出「已經量過了」的錯覺。

現在它**中英文各量一次版面**（速度只量一次——字串長度不影響它，而再跑一輪要多花一分鐘）。英文那一輪**重新載入再量**，不是就地切語言：上一輪走過子清單、AI 面板、勾選，頁面已經不是乾淨的狀態，就地量到的數字沒辦法跟中文那一輪對照。

突變驗證：兩個修法各自拿掉，**英文那一輪都會紅、中文那一輪都是綠的**——後者正是這條新斷言存在的理由。

### iOS 會因為小字級的輸入框把整頁放大

**任何可聚焦控制項在手機上都不能小於 16px。** iOS Safari 聚焦字級小於 16px 的輸入框時會把**整頁**放大 `16 ÷ 字級` 倍，畫面因此比視窗寬，右邊的東西被推出螢幕。

使用者實際回報的形狀：AI 的輸入框是 13px，點下去整頁放大 1.23 倍，「拆解」按鈕整個跑出右邊。**它看起來像版面壞掉，完全不像字級問題**——是最難從症狀推回原因的一種，而且**桌機瀏覽器與模擬器都不會放大**，量版面永遠量不到。

防放大的規則原本就寫了，但寫成 `select, input[type=…], textarea{ font-size:16px }`，優先度只有 `(0,0,1)`——**任何帶 class 的規則都比它強**。當時被蓋掉的有 `.ai-foot textarea`(13)、`#inputSearch`(13.5)、`#reminderLead`(11)、`#importFile`(13.3)、`#inputHolidayBulk`(12)。

現在寫成 `select, input, textarea, [contenteditable="true"]{ font-size:16px !important; }`。**這裡的 `!important` 是刻意的**：不用它就得維護一份「所有帶 class 的控制項」清單，而漏掉一個的後果正是這個 bug。**也不要改用 `maximum-scale=1` 擋放大**——那會連使用者自己要放大也一起擋掉。

`tools/check-mobile.mjs` 會列出所有小於 16px 的可聚焦控制項並附上放大倍率。它**不量版面而量計算後的字級**，因為那是這個 bug 唯一測得到的形狀。

### 手機上的 AI 面板

**整頁，不是底稿。** 原本是 `85dvh` 的底部彈出，理由是「不要整頁蓋掉」。那個規則守錯了東西——會咬人的是「**關著卻佔著**」（上面那個看不見的遮罩），不是「開著時佔滿」。440px 寬的螢幕分一半給背景，兩邊都不好用；整頁之後內容區從 529px 變成 583px。

三件事缺一不可：

| | 少了會怎樣 |
|---|---|
| `padding-top/bottom: env(safe-area-inset-*)` | `viewport-fit=cover` 讓頁面延伸到動態島與 home indicator 底下。`.app`／`.sidebar`／`.modal`／`.undo-toast` 都補了，**只有這裡漏掉**——最下面的用量與兩顆按鈕的下緣被蓋住，看起來就像「面板超出畫面」（使用者實際回報的形狀） |
| `body.ai-open{ overflow:hidden }` | 手指想捲面板卻捲到後面的看板，畫面莫名其妙地動 |
| `.ai-panel[hidden]{ display:none }` | 上面那條，看不見的全屏遮罩 |

開關**一定要走 `aiSetOpen()`**，不要在別處直接改 `hidden`：`body.ai-open` 與 `hidden` 一旦分家，就會留下「面板關了但整頁還捲不動」這種只有在手機上才踩得到的狀態。

**驗背景鎖定不能用 `window.scrollBy()`。** `overflow:hidden` 擋的是使用者輸入，程式捲動照樣有效——第一版的探針就是這樣寫的，修好了也顯示「沒鎖住」。要用真的滾輪／觸控事件（`page.mouse.wheel`）。

**驗安全區域不能用計算後的值。** Chromium 沒有瀏海，`env()` 一律回 0，量到的永遠是 `0px`。`tools/check-mobile.mjs` 改成走 CSSOM 找 `.ai-panel` 的規則、確認原始碼裡真的寫了 `safe-area-inset-bottom`。

### 提案（`/api/ai/plan`）不能拿掉的判斷

| 決定 | 理由 |
|---|---|
| **`complete` 只接受真的出現在送出去那份清單裡的 `(id, occ)`** | 模型編一個 id 出來，伺服器就要濾掉。這是伺服器端擋得住、也應該擋的錯誤。**有測試守著** |
| 日期不合法的項目**標記起來、不丟掉** | 丟掉的話使用者不會知道 AI 本來想排在哪天；標記則讓她看得到、也改得動。前端把它預設成不勾 |
| 用 `response_format: json_object`，但**仍然自己驗一次** | 不要叫模型「回 JSON」再自己 parse 一段可能壞掉的文字；也不要因為用了結構化輸出就相信內容 |
| 「加入哪一種專案」讓使用者選 | `majorProjects` 與 `ganttProjects` 是兩套互不相干的東西（見〈兩套互不相干的「專案」概念〉）。猜錯再改比多一個下拉貴 |

### `withUndo()` 的快照必須是深拷貝

`snapshot()` 回傳的 `items` / `ganttProjects` 是**活的陣列參照**，不是副本。

刪除之所以一直復原得了，是因為它用 `items = items.filter(...)` **換掉整個陣列**，快照裡的舊參照因此還指著原本那一份。但只要有人改成**就地修改**（`items.push(...)`、`item.done = true`），快照就會跟著一起被改——等於根本沒有快照，而且**畫面看起來完全正常**，只有按下復原時才發現沒反應。

AI 的批次寫入正是就地修改，第一版因此復原不了，是瀏覽器測試抓到的。現在 `withUndo()` 一律 `JSON.parse(JSON.stringify(snapshot()))`；成本可以忽略（實測 300 個項目的 `JSON.stringify` 是 1.1ms）。

模型固定 `deepseek-v4-flash`。pro 貴三倍而「這週有什麼」看不出差別——先量再調。

## 認證與權限

流程：Turnstile 真人驗證 → email + 密碼 → 管理者核准 → 使用。

| 規則 | 理由 |
|---|---|
| `TURNSTILE_SECRET` 未設定時**一律擋下**註冊與登入 | 未設定就放行，等於真人驗證形同虛設 |
| 密碼用 PBKDF2-SHA256 100,000 迭代，比對走 constant-time | 用 `===` 比字串會提早回傳，洩漏正確前綴長度；100,000 是 Workers 的硬上限，見下方章節 |
| session 在 DB 只存 token 的 SHA-256 | DB 外洩時裡面的值無法直接拿來登入 |
| 用 DB session 而非無狀態 JWT | 管理者停用帳號要能**立即**生效 |
| 登入失敗一律回「email 或密碼錯誤」，帳號不存在時仍跑一次雜湊 | 避免被用來列舉哪些 email 有註冊；兩條路徑耗時要接近 |
| 帳號狀態只在密碼正確後才揭露 | 此時對方已證明是帳號持有人 |
| 註冊時 email 重複則明說 | 比照登入回模糊訊息會讓使用者卡在「註冊沒反應」 |
| 未核准帳號登入時**不發 session** | 因此不需要 `/pending` 頁面，對方根本進不了站 |
| 管理者不能變更自己的角色或狀態 | 避免手滑把自己降級，導致無人能管理系統 |
| `ADMIN_EMAILS` 名單內的帳號無法從介面停用／降級／刪除／重設密碼 | 系統的最後保險，即使操作者是另一位管理者 |
| 但**自助重設不受這條限制**（見〈忘記密碼〉） | 名單防的是另一位管理者的橫向接管；收得到那封信等於證明自己是本人 |
| 狀態一旦不是 `approved` 就銷毀該使用者所有 session | 否則對方在下次登入前仍能繼續使用，停用形同虛設 |

### 密碼欄位的眼睛

四個地方（`login.html`、`reset.html`、app 的登入畫面、變更密碼與刪除帳號）的密碼欄位都有顯示／隱藏切換。動機很具體：**登不進去的人如果看不到自己打了什麼，連「是不是打錯」都無從判斷**——那一次的求助信裡沒有任何可用的線索。

| 決定 | 理由 |
|---|---|
| **切換狀態不進 localStorage** | 記住的話，下一次在別人旁邊打開這個表單，密碼直接是明碼。所以開表單時一律 `pwEyeReset()`——不是「載入時重設」，是**每次開**都重設 |
| **只切被點的那一個** | 整組一起切等於一次把三個欄位都變明碼。`btn.onclick` 只碰 `btn.parentElement` 裡的那個 input |
| 按鈕 **`tabindex="-1"`** | Tab 要從「目前密碼」跳到「新密碼」，不是跳到眼睛上。它是滑鼠／觸控的東西 |
| 圖示是**兩個疊著的 inline SVG，靠 `.shown` 決定顯示哪一個** | JS 只切 class 與 `input.type`，不在 JS 裡拼 SVG 字串。零外部圖檔（同〈氛圍層的三個實作決定〉） |
| aria-label 走**新的 `data-i18n-aria` 管道** | 它與其他三條不同：原文會在執行時被改掉（顯示密碼 ↔ 隱藏密碼），所以 `pwEyeLabel` 直接寫 `dataset.i18nAriaSrc`，`applyStaticI18n` 讀的就是當下那一句。少了這條，切成英文時 aria-label 還是中文 |
| `login.html` / `reset.html` **各自一份**（沒有 I18N） | 那兩頁是獨立的 HTML，本來就各有自己的 `<style>` 與 `<script>`。所以 `tools/smoke.mjs` 的斷言**分三處**走：index 的變更密碼、app 的登入畫面、那兩頁各一次——只驗其中一處的話，另外兩處沒有眼睛也是綠的 |

斷言驗的是**真的切得動**（`input.type` 換了），不是「按鈕畫得出來」——後者在 `onclick` 沒接上時照樣是綠的。突變驗證過四種：切不動、狀態被記住、旁邊的欄位一起變明碼、`login.html` 的眼睛不見了。

### 忘記密碼：名單內的帳號原本會被鎖死

`ADMIN_EMAILS` 名單內的帳號連管理者都不能重設密碼。那道保險本身是對的（重設密碼等於接管帳號），但它把「**本人**忘記密碼」也一起擋死了——四條路全部封閉：

| 想走的路 | 結果 |
|---|---|
| 管理者按「重設密碼」 | 403「這是設定檔指定的管理者」 |
| 自己用「變更密碼」 | 要先輸入舊密碼 |
| 登入頁的「忘記密碼」 | 在這條路徑存在之前，沒有這個功能 |
| 裝置還登著 | 一樣要舊密碼 |

實際踩過：唯一的救法是去 Cloudflare 把那個 email 從 `ADMIN_EMAILS` 拿掉、重設、**再加回去**——而最後那一步一旦忘記，該帳號就永遠失去保護，畫面上完全看不出來。

**自助重設刻意不檢查 `ADMIN_EMAILS`，而那不是在保險上打洞。** 名單防的是「另一位管理者」的**橫向**接管；收得到寄到該帳號信箱的信，等於**證明自己就是本人**，是直向的。兩者擋的東西不同。

**代價要說清楚**：帳號安全從此綁在信箱安全上，信箱被盜等於帳號被盜。原本的設計沒有這個弱點，代價是忘記密碼就永遠打不開。這是取捨，不是純好處。

`handlers/admin.js` 原本寫著「不做 email 寄信重設是刻意的：系統沒有寄信基礎設施」——那句話在接上 AgentMail 寄逾期提醒之後就過期了。**設計決定的前提會過期，改動前先確認它現在還成不成立。**

兩支端點的濫用防線刻意不同：

| 端點 | Turnstile | 為什麼 |
|---|---|---|
| `POST /api/auth/forgot` | **要** | 它會**寄信到別人的信箱**，是最典型的濫用目標 |
| `POST /api/auth/reset` | **不要** | 憑證是連結裡的 256 位元 token，猜不到；這條路是使用者已經進不去時才走的，多一個 Turnstile 只是多一個會壞的東西 |

其餘幾個不能拿掉的判斷：

- **無論結果如何都回同一個 200。** 回「查無此 email」等於把這裡變成帳號列舉工具——登入失敗訊息刻意模糊也是同一個理由，不能自己在旁邊開一個後門。**寄信失敗也是回 200**（但一定要 `console.error`，理由見〈降級可以，沉默不行〉）。
- **只有 `approved` 的帳號能重設。** 停用中的帳號能重設密碼的話，停用就形同虛設。
- **索取新連結時刪掉舊的。** 留著的話，使用者以為「我重新要了一次」，先前那封信裡的連結卻還有效。
- **`used_at` 標記已使用而不是刪除列**：連結被重複點（郵件用戶端預抓、按上一頁）時，「已經用過」與「查無此連結」要能分辨。
- **密碼太短要退回，且不能消耗連結**——否則使用者打太短就得回信箱重新索取。
- **重設成功後銷毀該使用者所有 session，且不順手發新的**：前提通常是「我進不去」或「我懷疑被盜」，留任何一個舊 session 等於重設完了對方還在裡面；讓他用新密碼真的登入一次，也才確認得了新密碼真的能用。

`tests/reset.test.mjs` 涵蓋以上每一條。加測試時用突變驗證過它們真的抓得到 bug（拿掉 `used_at` 檢查、拿掉 `approved` 檢查、把 token 存成原文，三種都會紅）。

### 資料庫結構變更（`migrations/`）

`schema.sql` 是**完整的 canonical schema**，全部用 `CREATE TABLE IF NOT EXISTS`——所以它對「新資料庫」永遠正確，對「已經存在的資料庫」卻**補不了新欄位**（`IF NOT EXISTS` 只看表在不在，不看欄位）。

新增欄位因此要在 `migrations/` 下留一支單獨的 SQL，並在**部署之前**跑過：

```bash
npx wrangler d1 execute work-schedule-db --remote --file=./migrations/011-mail-sender.sql   # 最新的一支；舊的照編號
```

**順序不能反。** 新程式碼 `SELECT r.lead_days`，欄位還沒加就會讓提醒的 cron 與 `/api/reminder` 直接失敗。新增**資料表**沒有這個問題（`db:init` 重跑 `schema.sql` 就會建），只有**欄位**需要 migration。

**`010-mail-log.sql` 是新增資料表，所以它是唯一漏跑也不會壞的一支**：`recordMail` 的寫入包在 try/catch 裡，表不在只會讓每寄一封信多一行 `console.warn`，信照樣寄得出去（那條規則本身的理由見〈寄信記錄〉）。仍然要跑——漏跑的代價是那張表一直是空的，而「空的」與「都沒失敗」在管理頁上長得一模一樣。

**緊接著的 `011-mail-sender.sql` 就不是那樣了**：它是 `ALTER TABLE ... ADD COLUMN`，漏跑會讓 `listMailLog` 的 `SELECT ... sender` 直接失敗，管理頁那一區整個讀不出來。兩支一起跑就不會搞混。

SQLite 沒有 `ADD COLUMN IF NOT EXISTS`，重跑會報 `duplicate column name`——那個錯誤是安全的，代表已經加過了。

### 破窗鎚：`npm run admin:reset`

**操作手冊在 `docs/runbook-account-recovery.md`**——照哪個順序試、每一步怎麼確認真的成功了，以及哪幾件事要在需要它的那一天**之前**就先確認好（最重要的一條：不只一個人進得去 Cloudflare，否則這條「所有路都斷掉時的路」自己也只有一條）。下面只記設計上的判斷。

`tools/reset-password.mjs`，直接對 D1 改密碼並清 session，**不經過 Worker**：

```bash
node tools/reset-password.mjs someone@example.com --yes          # 遠端
node tools/reset-password.mjs someone@example.com --yes --local  # 本機
```

它是「連寄信這條路都斷了」時才用的——AgentMail 掛掉、使用者的信箱本身進不去、或系統裡一個管理者都沒有。`--yes` 是刻意的：它會立刻改掉別人的密碼並把所有裝置登出，不該因為打錯一個指令就發生。

`wrangler d1 execute` 只收 `--command`、沒有參數化介面，所以 SQL 是自己拼的——因此 `sqlQuote` / `buildSql` 抽成純函式並有測試（`tests/rescue.test.mjs`），不在指令中間硬拼。**改到 0 列會當成錯誤**：沒有這個檢查的話，email 打錯會安靜地什麼都沒發生，然後有人拿著一組永遠登不進去的密碼去問人。

**它不會寫進 `admin_activity`**，因為它不經過 Worker——那是它的本質不是缺陷（Worker 壞掉時它仍然要能用），但也因此手冊要求用完自己留一筆記錄在團隊看得到的地方。

#### 名單釘住的帳號要在畫面上看得出來

`handleListUsers` 多回一個 `configAdmin`，`/admin` 在那幾列顯示「設定檔指定」徽章，並用一行說明取代掉那四顆按鈕（停用、降級、重設密碼、刪除）。

**這不是新的權限，是把既有的權限說出來。** 那四個本來就會被伺服器回 403，但擋在按下去之後——於是管理者按了、看到紅字、以為系統壞了，然後想到的解法是「去 Cloudflare 把 email 從 `ADMIN_EMAILS` 拿掉」，而那正是這支工具存在的理由：**拿掉之後忘記加回去，保護就永遠沒了，而畫面上完全看不出來。** 把這件事寫在畫面上，那一次就不會發生。

列出來不算洩漏：這張清單只有管理者看得到，而名單內的帳號本來就已經顯示為 admin。有測試守著（三種突變都會紅），其中一條特別守「一般帳號不能被標成釘住的」——標錯的症狀是管理者放棄一條本來走得通的路。

### PBKDF2 迭代次數有平台硬上限（本機測不出來）

`crypto.subtle.deriveBits` 在 Workers **正式環境**最多接受 **100,000** 次迭代，超過直接丟：

```
NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported (requested 210000).
```

**本機 workerd 不強制這條規則**，所以這是一個本機百分之百測得過、線上百分之百失敗的坑，實際踩過：迭代次數照 OWASP 建議設成 210,000，本機從註冊到登入全綠，線上註冊卻每次回 Error 1101。難以診斷的原因是它**完全不像雜湊的問題**——例外在雜湊開始算之前就丟出來，該次請求 CPU 只有 3～5ms（正常跑完 PBKDF2 要 ~74ms），DB 一筆都沒寫進去，看起來就像整個 Worker 壞掉。

診斷這類「只在線上壞」的問題時，GraphQL analytics 的 `workersInvocationsAdaptive` 很有用：`dimensions.status` 能區分 `scriptThrewException`（程式丟例外）與 `exceededCpu`（CPU 超限），兩者的處理方向完全不同。

`src/crypto.js` 的 `MAX_ITERATIONS` 同時用於產生與驗證：儲存格式帶著迭代次數，所以平台哪天放寬上限，只要調高常數，舊密碼仍然驗得過。反之，超過上限的既有雜湊（只可能來自本機）在線上會被當成驗證失敗並留下 `console.warn`，而不是讓請求 500。

`wrangler.jsonc` 的 `limits.cpu_ms = 500` 是成本防護，不是效能上限；帳號的 `default_usage_model` 為 `standard`，CPU 時間本身不是這裡的瓶頸。

完整的排查過程記在 `docs/postmortems/2026-07-30-register-error-1101.md`。

### 外部 script 不加 SRI 是刻意的

Turnstile 的 `api.js` 是 Cloudflare 持續更新的驗證元件，官方要求從固定 URL 取得且不提供 hash，加 SRI 會在其更新當下讓真人驗證整個失效；Google Fonts CSS 也會依 User-Agent 變動。兩者皆來自與本站同源的 Cloudflare 信任域。

### 兩套互不相干的「專案」概念（極易混淆）

| 變數 | 出現位置 | 說明 |
|---|---|---|
| `majorProjects` | 項目安排頁的 chip 列 | 純分類標籤，無日期。`item.parentId` 指向它；刪除後底下項目變成獨立項目 |
| `ganttProjects` | 專案頁 | 完全獨立的另一套資料，各自帶 `tasks[]` 與 `notes` |

兩者之間沒有任何關聯，不要試圖合併或互相引用。

### 檢視範圍狀態

`mode`（`'year'|'quarter'|'month'|'date'`）搭配 `selYear`／`selQuarter`／`selMonth`／`selDate` 決定 `currentRange()` 回傳的區間；日曆頁另有獨立的 `calYear`／`calMonth`／`calSelectedDate`，兩套不共用。

## Render 模式

全量重繪，沒有任何 diff 機制。責任分層固定如下，不要混用：

- `renderAll()` — 唯一的總入口。重繪頂部 metrics ＋ 提醒，再依 `currentView` 分派到當前頁面
- `renderScheduleView()` — 只管「項目安排」頁自己的區塊（chips／tabs／period／scope／board）
- `renderSharedView()` — 只管「共享」頁。它的資料來源是 `shares`（記憶體內，來自 `/api/shares`），不是 `items`／`ganttProjects`
- `renderNav()` — 切換 `.active` class 後呼叫 `renderAll()`

DOM 建構有兩種寫法，請依情境沿用：

- **互動元素**（列、chip、按鈕）用 `document.createElement` + closure 綁 `.onclick`，例如 `buildOccRow()`
- **大塊靜態內容**用 `innerHTML` 字串拼接，但**使用者輸入必須先過 `escapeHtml()`**（`renderReminderList()`、`renderMetricList()` 是範例）

### 日曆的點選與拖曳選取

`calSelectedDate` + `calSelectedEnd` 表示選取；`calSelectedEnd` 為 null 代表只選了一天。

- **預設不選任何日期。**「＋ 為此日期新增」是「你選了某一天」的結果，不該平時就掛在畫面上。
- 選取一律經 `calRange()` 正規化成「起 ≤ 訖」。往回拖在使用者眼中是同一段區間，若照原始順序存下去，後面每一處比較都要先判斷方向。
- **拖曳過程中只切 class，不重繪整個日曆**（`paintSelection()`）。每次 mousemove 都跑一次 `renderCalendar()` 會把 42 個格子連同內容全部重建，完全跟不上；真正的重繪留到放開手時做一次。
- `mouseup` 監聽在 **document** 而不是格線上：使用者常常拖出日曆外面才放開。
- 觸控的 `touchmove` 事件其 `target` 一直是起始元素，必須用 `elementFromPoint` 反查目前指到哪一格；而且只有真的跨格才 `preventDefault`，否則單指上下捲動會被卡住。
- 格子內的核取方塊要在 `mousedown`／`touchstart` 就排除（`closest('.cal-item-check')`），否則勾選會被拖曳選取搶走。
- 區間模式不顯示逐日清單與每日記錄——那兩者都是「某一天」的概念。

### 跨多天事項畫成貫穿的色條

`renderCalendar` 把 `item.endDate` 的項目從逐項文字裡抽掉，改畫一條橫帶。**兩件事撐起「連續」的錯覺，少一件就散掉：**

1. **軌道（lane）**：同一個項目在每一格都必須落在同一個高度。`calSpanLanes()` 依開始日排序做貪婪配置，而**沒有色條的軌道也要留一個等高的空位**（`.cal-span.gap`）——否則下方的色條會往上跳，與隔壁格錯開。症狀特別難查：畫面上看不出原因，只覺得「怪怪的」。
2. **負外距**：`margin: 0 -12px` 把色條拉出格子的 padding（8px＋1px 邊框）並各多蓋掉 grid 間隙（6px）的一半，相鄰兩格因此剛好接起來。週的頭尾格子要用 `.wk-start` / `.wk-end` 收回去，否則整排會凸出網格外面。

`.start` / `.end` 只在**真正的起訖日**才加（比對 `dateStr`，不是 `sp.from`／`sp.to`——`sp` 是同一個物件被塞進區間內的每一格，拿它比會讓四格全部被判成起點，色條斷成四塊而且長出四個勾選框；實際踩過，`tools/check-calendar.mjs` 抓到的）。週界一律維持平的，那樣才讀得出「還沒結束」。

**勾選框只放在本月的第一段上**：整段共用一個完成狀態，四天各放一個會讓人以為勾的是「那一天」。它與 `.cal-item-check` 一樣要排除在拖曳選取之外。

### 每日記錄在格子上只留一個記號

有內容就在右上角放 `✎`（絕對定位，不塞進 `.cal-daynum`——那個元素在手機版是置中的，改成 flex 排版會把日期推歪）。判斷用既有的 `rtIsEmpty()`，不自己寫一份：編輯器留下的空殼形狀（`<div><br></div>`）就是它認得的那些。

**打字時只做就地更新（`syncDayLogMark`），絕對不能呼叫 `renderCalendar()`**——那會連下方的詳情區一起重建，正在打字的編輯器當場被銷毀，游標與注音組字都會斷掉。同〈勾選不重建看板〉。

### 勾選走樂觀回饋，是全量重繪唯一的緩衝

全量重繪的成本隨畫面上的列數成長，而**預設的年度檢視在幾十個循環項目下就有上千列**（實測數字見「響應速度」）。若打勾符號要等整段跑完才出現，資料一多就變成「按了沒反應」。

因此核取方塊一律走 `toggleOccDone(occ, checkEl, labelEl)`：先就地把那一列切成新狀態（它已經在 DOM 裡，改 class 是 O(1)），再把寫入與重繪排到下一個 frame。項目安排列與日曆格子共用這一個函式。

兩個容易改錯的地方：

- **必須用兩層 `requestAnimationFrame`。** rAF 的 callback 跑在「下次繪製之前」，只包一層會和剛才的視覺變更擠在同一個 frame，等於完全沒有延後。
- **`occ.done` 要一起就地更新。** 否則延後的那幾十毫秒內再點一次會讀到舊值，兩次算出同一個 `next`。真正的資料仍由 `setOccurrenceDone` 寫入。

這是全量重繪策略的緩衝，不是例外：資料流沒有變，只是把視覺回饋提前。**不要因此把其他操作也改成延後**——其餘操作的視覺結果無法只靠切一個 class 表達，延後只會讓畫面短暫地與資料不一致。

### 勾選不重建看板

延後之後畫面仍然會卡（延後的是時間點，不是成本）。所以勾選在最常見的那一種互動裡**不重建看板**：`moveOccRowToDone(row)` 只把那一列從 `#board` 移除、把已完成計數加一，其餘上千列原地不動。

**只處理一種情況**：看板上的一列被勾成完成、`hideDone` 關著、已完成區收合。其餘一律 `return false` 讓呼叫端走完整的 `renderAll()`——取消勾選要插回正確位置、「只看未完成」要讓整列消失、已完成區展開時要維持日期排序、勾完之後一項不剩要換成完成畫面，這些規則都寫在 `renderBoard()` 裡，**在增量路徑複製一份遲早會走鐘**。

走鐘的症狀特別難發現：畫面看起來是對的，只是少一列或計數對不上。所以 `tools/verify-toggle.mjs` 不驗「畫面對不對」，而是驗**兩條路徑結果相同**——動作做完後切走再切回來（強制完整重繪），比對前後的 DOM 簽章。改動 `renderBoard()` 或 `moveOccRowToDone()` 之後一定要跑它。

### 時鐘與資料重算已解耦

`tick()` 每秒只更新時鐘文字。metrics 與提醒改由 `commit()` 驅動，另外記 `lastTickYmd` 偵測跨日才觸發一次 `renderAll()`。**不要把資料重算加回 `tick()`**——那等於每秒把所有循環項目展開一次，成本隨項目數線性放大。

### 甘特頁的例外：表格不重建

這是全量重繪策略唯一開的洞，而且是必要的。表格內的名稱／日期／進度欄位若在編輯時重建整張表，正在輸入的 input 會被銷毀，Tab 換欄位和連續輸入都會斷掉。

因此表格內編輯一律呼叫 `refreshGanttChart(gp)`——只替換 `#ganttChartWrap`，表格原地不動；名稱改動則透過 `.gantt-row-label[data-task-id]` 就地更新圖表文字。只有**新增／刪除任務**（行數改變）才走完整的 `commit()` → `renderGanttView()`。

### 甘特圖時間軸：固定像素寬 + 水平捲動

時間軸不是 `flex:1` 撐滿容器，而是「每日像素寬 × 天數」的固定寬度，放在 `.gantt-scroll` 裡水平捲動。撐滿容器的舊做法等於「不管專案多長都塞進同一個寬度」——跨年度專案會被壓縮到每個月只有幾像素，長條全部黏在一起。

- `GANTT_ZOOMS` 的四個刻度（週／月／季／年）決定 `pxPerDay`，值是照「約 800px 的視窗裡看得到多久」挑的。
- **標籤欄放在捲動區外面，不用 `position:sticky`。** sticky 在有 overflow 的祖先裡各家瀏覽器行為不一；兩欄各自獨立、靠 `--gantt-row-h` 對齊，結果可預期。改動時兩邊的列高必須一起改。
- `ganttScrollLeft` 記住捲動位置跨重畫保留（改一次進度不該讓畫面跳回最左邊），但**切換刻度時要歸零**——像素位置整個換算過，沿用舊值會落在毫無意義的地方。
- 範圍一律從月初到月底，且今天若落在專案區間外仍會被納入，否則「跳到今天」沒有東西可跳。
- `contain: inline-size` 保留在 `.gantt-wrap` 上（現在是所有尺寸都有，不再只有行動版）：內容現在一定比容器寬，沒有它行動版的 shrink-to-fit 會用最小內容寬度決定版面視窗，把整頁撐寬。

### 指標卡的列高必須是整數倍

`.metric-list` 的 `max-height` 要正好等於「行高 + gap」的整數倍（目前 5 × 20 + 4 × 4 = 116px），且 `.metric-list-row` 要固定 `height/line-height`。不是整數倍的話最後一列會被切成一半，看起來像渲染壞掉而不是「還有更多」（實際踩過）。`renderMetricList` 的 `MAX` 也要跟著這個格數走。

## 響應速度：量過的數字與排除掉的方向

改效能之前先量。以下是實測結果，**不要憑直覺重做已經排除的項目**。

### 已排除（量過，不值得動）

| 曾經懷疑 | 實測 | 結論 |
|---|---|---|
| `commit()` 每次序列化整份 state | 300 項時 `JSON.stringify` 1.10ms ＋ `setItem` 0.40ms | 佔不到勾選成本的 3% |
| 傳輸量太大 | `index.html`（當時 197KB）經 brotli 約 50KB，`content-encoding: br` 已生效 | 已是最佳 |
| `getSessionUser` 查兩次 | 本來就是單一 JOIN | 沒有浪費 |
| D1 讀取複本 | 資料庫在 APAC、使用者也在台灣 | 開複本只幫得到遠端使用者，目前沒有 |

### 字型不阻擋首次繪製

一般的 `<link rel="stylesheet">` 是 render-blocking：CDN 慢的時候整頁一個字都不畫（實測延遲 1.5s 會讓 FCP 從 536ms 變成 2060ms）。而網址裡本來就有 `display=swap`——擋住首次繪製換不到任何東西。

三個 HTML 都改用 `media="print"` + `onload` 切回 `all`，並補上 `fonts.gstatic.com` 的 `preconnect crossorigin`（CSS 在 googleapis，實際的 woff2 在 gstatic，只指前者仍要重新握手）。改完後 FCP 與「完全沒有字型 link」的下限相同。

**這裡的 inline `onload` 是允許的例外**：它只碰 `this`，不需要存取 IIFE 內的東西，與「不能用 inline onclick」那條規則的理由不衝突。

### 勾選的成本：貴的是重建 DOM，不是重算資料

這一段先前寫錯過，而且錯得會把人帶往完全無效的方向，所以把量測方法一併記下來。

用 `PerformanceObserver` 的 **longtask** 量主執行緒實際被卡住的時間（不是量 `commit()` 回來得多快——那兩個差了一個數量級）。預設的**年度**檢視最貴，因為循環項目會展開成整年的列：

| 資料 | board 列數 | 改善前 | 改善後 |
|---|---:|---:|---:|
| 50 項 | 808 | 744ms | **0ms** |
| 150 項 | 2349 | 2368ms | **0ms** |
| 300 項 | 4682 | 5525ms | **77ms** |

把 `getAllOccurrences` / `buildOccRow` / `commit` / `persist` 逐一包起來計時之後，300 項那一格的組成是：

| 項目 | 耗時 |
|---|---:|
| `commit()` 全部 JS（含展開、建列、序列化、存檔） | 130ms |
| ├ `getAllOccurrences` × 6 | 17ms |
| ├ `buildOccRow` × 3247 | 59ms |
| └ `persist()`（`JSON.stringify` ＋ `setItem`） | 5ms |
| **其餘（瀏覽器對數千列重跑樣式計算與版面配置）** | **~2490ms** |

**JS 只佔 5%。** 因此：

- ~~收斂五次重複的 occurrence 展開~~ **已量過，不值得做**：六次展開合計 17ms，全部省下來也只有總成本的 0.6%。先前這裡寫著「可望把勾選成本再砍一半」，那個推測是錯的。
- ~~board 逐列 append 改 `DocumentFragment`~~ **早就已經是 fragment 了**（`renderBoard()` 內），這條先前沒有跟著更新。

真正有效的是**不要重建那幾千列**：勾選時只把那一列搬走，其餘原地不動（見「Render 模式」的〈勾選不重建看板〉）。

### 切換與搜尋：讓瀏覽器少做白工

先前這裡寫著「要再往下壓只能減少 DOM 列數，那是產品決定」。**那個結論下得太早**——列數確實不能減，但可以讓瀏覽器不要對看不到的列做版面配置。

用 `tools/measure-board.mjs` 量（longtask 總和，預設的年度檢視）：

| 項目數 | board 列數 | 切換頁籤 | 搜尋打 5 個字 | 「只看未完成」 |
|---:|---:|---:|---:|---:|
| 64（實際使用者的量） | 1461 | 1292ms → **68ms** | 2562ms → **0ms** | 607ms → **59ms** |
| 150 | 3369 | 2968ms → **309ms** | 6514ms → **363ms** | 1371ms → **154ms** |
| 300 | 6621 | 4739ms → **775ms** | 13288ms → **1911ms** | 2858ms → **601ms** |

兩個改動，**都沒有動到使用者看得到的行為**：

1. **`.occ-row` 加 `content-visibility:auto` + `contain-intrinsic-size:auto 52px`。** 瀏覽器跳過畫面外元素的版面與繪製，捲到才算。DOM 完全沒變——所有列仍然存在、`querySelector` 取得到、`body.innerText` 含得到（**Ctrl+F 仍然找得到，已實測**），所以〈勾選不重建看板〉的增量路徑與 `verify-toggle` 的等價驗證都不受影響。這正是它比虛擬捲動好的地方：虛擬捲動要動到「畫面上有哪些列」，那才是產品決定。不支援的瀏覽器照舊渲染，只是沒有這個好處。
2. **搜尋輸入 debounce 180ms。** 原本每個字元都 `renderBoard()`；打五個字就重建五次。與〈高頻輸入用 `persistSoon` 做 400ms debounce〉是同一個判斷，只是那邊延後寫入、這邊延後重繪。**清空是例外，要立刻回應**——那是「我不找了」，等 180ms 會像卡住。

`contain-intrinsic-size` 的 `auto` 讓瀏覽器記住該列真正量到的高度；沒有它的話捲軸長度會在捲動時一直跳。

**開發時踩不到這個問題**：示範資料只有 6 個項目。真實使用者的 64 個項目展開成 1461 列，那個差距是 `tools/measure-board.mjs` 存在的理由——它自己造資料，不必等使用者回報。

還沒做的：

- ~~**切換檢視／篩選時仍然會重建整個看板**，要再往下壓只能減少 DOM 列數（虛擬捲動或分頁），那必須是明確的產品決定~~ **已解決，而且不必動到那個決定**（見下方〈切換與搜尋：讓瀏覽器少做白工〉）。
- **service worker 導覽改 stale-while-revalidate**：快取裡有完好的 app shell 卻每次都等網路。收益最大，但**代價是部署後要多開一次才看得到新版**——目前刻意維持 network-first，要改必須是明確的決定，不能順手。

## 視覺基調：紙與光，但「逾期」不准變柔和

參考的是一款療癒系日記 App 的氣質（大留白、紙感、柔色、軟語氣），但**刻意只搬一半**：

| 搬了 | 沒搬，而且不該搬 |
|---|---|
| 底層的光暈與紙紋 | 滿版插畫（看板一頁上千列，圖會壓掉對比） |
| 卡片去邊框、改柔陰影 | 低資訊密度（密度正是這個看板的價值） |
| 空白時刻的軟語氣 | **把警示也調軟** |

**最後那一條是紅線。** 療癒系設計的核心原則是「不給使用者壓力」，而這個工具的核心價值是「該緊張的時候要讓人緊張」——標案逾期、查廠遲交是有後果的。逾期的紅色標記不是裝飾，是這個系統存在的理由。氣質可以柔，警示不行。

### 這個介面有兩種聲音

最能把「工程控制台」變成「日記」的不是顏色，是**字**。原本整個 app 只用等寬 ＋ 黑體，那本身就是機器的聲音。現在分成兩套：

| 聲音 | 字體 | 用在哪 |
|---|---|---|
| **人在說話** | `--serif`（Noto Serif TC） | 招呼語、系統標題、空白時刻、每日記錄、做完之後的那一句、提醒面板標題 |
| **機器在報數** | `--mono` / `--sans` | 日期、數量、徽章、項目標題，以及**逾期** |

**這不是為了好看而混用兩套字，它是紅線的實作方式。** 把柔的部分交給宋體之後，紅色的逾期標記留在等寬字裡反而**更突出**——它現在是一句人話中間插進來的機器警報。柔化與警示因此不是互相妥協，是互相襯托。實測（`tools/check-deps.mjs` 會印出來）：逾期 `rgb(199,75,67)` / 700 / JetBrains Mono，旁邊沒逾期的日期 `rgb(95,94,88)` / 400。

離線退回系統宋體，功能不受影響（同 `--sans` 的處理）。字型仍然非阻擋載入，理由見〈字型不阻擋首次繪製〉。

**header 的 eyebrow 原本是大寫的 `SCHEDULE CONTROL BOARD`**——「工程控制台」那個聲音的字面版本。換成一句招呼（早安／午安／晚安）：右邊的時鐘負責精確報時，左邊這句負責「現在是一天裡的什麼時候」，兩種聲音在 header 就先碰面。它寫在 `tick()` 裡但**先比對現有文字才寫入**，所以切換語言時會自己更新，不必另外掛一條路徑；那也不違反〈時鐘與資料重算已解耦〉——那條擋的是「每秒展開所有循環項目」，成本隨項目數放大，而這裡是一次字串比較。

### 天空跟著時間變色

招呼語知道現在是一天裡的什麼時候，底圖也知道：早上苔綠與暖沙、下午偏金、傍晚之後偏玫瑰與靛。`<html data-daypart>` 由 **`<head>` 開機腳本先寫、`tick()` 再維持**——理由同主題：晚上打開若先畫成早上的顏色再切過去就是一次閃爍。兩處判斷時段的那一行完全相同，改一邊一定要改另一邊。

選擇器寫成 `:root[data-theme="…"][data-daypart="…"]`（0,3,0）才壓得過 `:root[data-theme="dark"]`（0,2,0），六個組合各自一組變數。

#### 對比工具原本看不到光暈

`check-contrast.mjs` 的 `bgOf()` 往上找第一個不透明的祖先，而光暈畫在 `body::before`——**不是任何元素的祖先**。直接坐在 body 上的字（招呼語、標題、日曆詳情區的按鈕）量到的一直是 `--bg`，不是它實際壓在上面的顏色。加了「傍晚也量一次」之後數字一模一樣才發現這件事：那個 pass 原本是空的。

現在改成算**最差情況**：三團光暈各自以滿 alpha 疊在 `--bg` 上，取對比最低的那一個。任何位置的真實對比都不會比它更差。改完當場抓到兩個：招呼語 3.29:1（它坐在左上角，正是苔綠光暈的中心）、「不在」按鈕 3.28:1（半透明底透出光暈）。前者改 `--text`（階層靠字級），後者底色改不透明的 `--panel`。

### 每日記錄的提示語照日期決定

`DAILY_PROMPTS` 十句，`dailyPrompt(dateStr)` 以日期字串 hash 選一句。**照日期不是隨機**：同一天重新整理不跳、昨天與今天問的是不同的問題。句子刻意都很輕——沒有「你今天完成了什麼」這種考卷式的問句，逾期的紅字已經在問那個了。這是「人在說話」最後一個還沒用到的位置。

### 打勾的彈跳只掛在被點的那一個上

`.pop` 由 `toggleOccDone()` 加、`animationend` 拿掉。**不能掛在 `.done` 上**：那樣每次完整重繪幾千個已完成的框會一起彈，畫面看起來只是「有點閃」，沒有任何檢查會紅。`check-ambience.mjs` 因此看的是計算後的 `animationName`，不是 class——要防的錯法正是「class 都對、動畫掛錯地方」。突變驗證過：掛回 `.done` 會紅。

### 週一的一句回顧

「上週你做完了 N 件事。」只在**週一**、而且 **N > 0** 才出現——N = 0 那句是一根刺，不是回顧，與逾期提醒信「沒事就完全不寄」是同一個判斷。只講做完的：沒做完的那些逾期的紅字已經在講了，這一行是往回看，不是往前逼。從 `renderAll()` 呼叫而不是 `tick()`，它要展開上週七天，那是資料重算。

### 光暈會動，但動得幾乎看不出來

兩分鐘走完一趟、位移只有 1.5%。目的不是讓人看見它在動，是讓底圖不像一張貼死的圖片。

- **只動 `transform`，不動 `background-position`。** 後者每一格都要重畫整層漸層；transform 是合成層的事。實測 1461 列的看板閒置 6 秒：**主執行緒 0ms、穩定 60fps**，開關動畫沒有差別。
- `inset` 往外多 10%，位移才不會在邊緣露出底色。
- **`prefers-reduced-motion` 一律停掉。** 純氛圍、沒有任何資訊在裡面，是最該被關掉的那一種動畫。

**量這件事不能只看 `tools/measure-board.mjs`。** 它量的是「操作時主執行緒被卡住多久」，而一個永遠在跑的動畫真正的代價是**閒置時的持續開銷**——longtask 量不到。實際踩過：measure-board 前後跑一次看起來像「切換頁籤 130ms → 266ms」，再跑一次卻反過來（動畫關掉時 555ms、開著時 0ms）。那支工具的文件自己寫著數字隨環境浮動，**單跑一次拿來下結論會把人帶去砍掉一個沒有問題的改動**。

### 氛圍層的三個實作決定

- **用 `body::before/::after` 的固定偽元素，不用 `background-attachment: fixed`。** 後者在 iOS Safari 上支援極差（行為接近 scroll，而且會逼出重繪）；固定偽元素只合成一次，捲動時完全不重畫。
- **不用任何外部圖檔。** 光暈是 radial-gradient，紙紋是 inline SVG 的 `feTurbulence` data URI——「單檔雙擊開啟」是不可破壞的前提，`<img src>` 會讓離線開啟破圖。空狀態的插畫（`emptyArt()`）同理。
- **內容面板維持不透明。** 療癒感來自四周的留白與光暈，不是「讓字浮在圖上」——那會讓對比掉下去。`tools/check-contrast.mjs` 守著這條線。

### 顏色不只要好看，要量得出來

`tools/check-contrast.mjs` 第一次跑就抓到**兩個已經上線很久**的問題：作用中的頁籤 2.84:1、篩選鈕 4.28:1（退回改版前跑過，數字一模一樣，確認不是改版造成的）。

這類錯誤不拋錯、不破版，在開發者自己那台校色良好的螢幕上「看起來還行」——**只有量得出來，看不出來**。而這個專案還多一層風險：亮色與暗色是兩組各自獨立的變數，改一組忘另一組的症狀正是「白天正常，暗色下某一塊變成看不見的低對比」。所以那支腳本兩種主題都量。

`--amber` 當底色很好看，當**淺底上的字**只有 2.84:1。因此另外有一個 `--amber-ink`（深琥珀）專門用在淺底上，而不是去動 `--amber` 本身——那是整個介面的主色，改了每一處都要重驗。

#### 「畫面上沒有這個元素，略過」是一條永遠不會執行的斷言

`check-contrast.mjs` 的清單裡一直有 `.empty-state`，但示範資料一定有項目，所以每次都印「略過」——**與沒有這一條一模一樣，而且還會給出「已經量過了」的錯覺**。後來主動把畫面逼成空的（搜尋一個不存在的字）之後，當場抓到兩個**已經上線很久**的問題：

| | 亮色 | 暗色 | 需要 |
|---|---:|---:|---|
| 空狀態的第二行（`--text-dim`） | 2.57:1 | 3.51:1 | 4.5:1 |
| 空狀態裡的強調字（`--amber`） | 2.84:1 | — | 4.5:1 |

第二個與頁籤、篩選鈕是同一個 bug class（`--amber` 當淺底上的字），#25 修過一輪卻漏掉這裡，原因正是它當時不在畫面上。

修法是**階層改用字級表達**（15px vs 13px），不要靠把顏色淡到讀不了。`AFTER_CLICKS` / `AFTER_SEARCH` 兩份清單就是為了這件事存在的：**要按幾下才看得到的東西，也要量。**

#### 半透明的祖先要疊起來，而且光暈在最底下

`bgOf()` 原本遇到 alpha ≤ 0.92 的祖先就**直接跳過**、一路掉到 body。症狀是 `.cal-cell.today` 裡的字（`--today-bg` 的 alpha 只有 0.09）量到的是光暈而不是實際底色，數字低到 1.5:1——**而畫面上讀得很清楚**。那是工具的**假紅燈**，與假綠燈一樣糟：兩者都會讓人不再相信這一頁。

現在改成由內往外收集半透明層，最後**由外往內**疊在第一個不透明的底上（alpha 不可交換，反過來疊出來的顏色不對）。

**同時修掉的是光暈的層序，而那一條比前面那一條更值得記。** 光暈畫在 `body::before` 上，所以任何半透明的祖先（例如 `.nav-item.active` 的 `--amber-dim`）都疊在它**上面**。第一版把光暈當成疊在合成後的背景**之上**，於是頁籤量出 2.83:1、看起來像一個「既有的對比問題」——**它不是**。層序改對之後同一個元素是 4.93:1。差別不在誰的顏色，在那個數字根本不對應畫面上任何一個位置。

**這種行為改變沒有辦法用畫面上的元素來守。** 顏色是產品決定，今天剛好誰過誰不過，跟「這條規則對不對」無關。所以改成用一個**答案已知的假元素**直接問它：黑字、外面一層 alpha 0.5 的黑、再外面是不透明的白——疊起來是 5.3:1，跳過是 21:1，差四倍，不會因為誰調了一個色碼就分不出來。突變驗證：退回跳過 → 自我檢查當場紅；光暈疊回最上面 → 頁籤又變成 2.83:1。

**還沒解決的一件事**（數字寫在 `check-contrast.mjs` 的註解裡）：日曆格子裡的項目文字在休假那一格只有 **2.2:1**（`--amber`）／**2.96:1**（`--teal`），換成 `--amber-ink` 也只有 4.29:1。這是〈顏色不只要好看，要量得出來〉那個 bug class 的第四次，但**換一個 token 解決不了**——那些顏色就是型別的編碼，一起壓深等於改掉整個日曆的顏色語言。那是產品決定，所以先量出來寫下來，沒有順手改。

#### 紅線要量得出來，不能只靠人保證

每一次視覺改版都是一次順手把逾期一起調柔的機會——調柔之後畫面會更好看，沒有任何檢查會紅，只有真的遲交的人會付代價。所以 `tools/check-deps.mjs` 現在斷言兩件事：逾期的顏色**就是 `--red`**（不是被換成別的顏色），而且**字重比旁邊的日期重**。突變驗證過：調成灰色紅 4 條、字重調回 400 紅 2 條。

### 「今天先不寫」

每日記錄旁邊那顆按鈕。它**什麼都不寫入**，只是把編輯器收起來換一句話，而且**刻意不存狀態**——存了就變成另一種要求（「你今天已經表態過了」），而它的用意剛好相反：給使用者一個不做事的正當出口。重新整理回到原樣，那是對的。

兩個踩過的坑：

- **按鈕要掛在 `slot` 裡，不是它的父層。** `renderCalDetail` 每次只清 `slot`，掛在父層的話它會跨重繪活下來——寫過字的日子還會被問「要不要寫」。
- **驗它的測試順序很重要。** 第一版寫成「按下按鈕 → 換一天 → 檢查不見了」，三條斷言全過，但**過的理由是錯的**：按鈕在點擊當下就被 `remove()` 了，掛在哪一層都測不到。突變驗證（把按鈕掛回父層）照樣綠才發現。現在改成「**不要按**它，直接換一天」。

## 樣式慣例

型別與顏色的對應寫死在 CSS 變數，改色只改 `:root`：

- `work` → `--teal` #1F8C68（工作項目）
- `meeting` → `--violet` #6C5CE0（會議安排）
- `assignment` → `--amber` #C9822E（作業；同時是介面主色、今日標示、循環徽章色）

class 命名沿用 `type-<type>`（列）與 `type-badge <type>`（徽章）；顯示文字統一走 `typeLabels` / `modeLabels` 兩個 lookup 物件，不要在各處硬寫中文字串。

## 已知限制（刻意為之，回報前先確認是否為此）

1. **必須登入才能使用**（2026-09-16 起）：從來沒登入過的裝置開單檔只會看到閘門；登入過的裝置離線時照常用本機資料
2. 假日自動判斷週六日；國定假日提供**已公布年度的內建清單**（一鍵載入）與批次貼上，見下方「國定假日」章節。未公布的年度不內建
3. ~~無法表達「週末補班日」~~ 已支援：`customWorkdays`（modal 內「補班日」區）優先於週末判斷。2026 與 2027 年都沒有補班日，所以目前沒有 `BUILTIN_WORKDAYS`——哪一年真的有了，要**先加那個結構**再貼資料，不要把補班日誤塞進 `BUILTIN_HOLIDAYS`（那會讓它變成假日，方向剛好相反）
4. 甘特圖長條為靜態百分比定位，不支援拖曳；日期只能透過表格輸入修改
5. 變更循環頻率會重置該項目的各次完成／覆寫／略過紀錄（見上方 occurrence 引擎章節）
6. 檢視狀態（目前頁籤、選取的年／季／月、搜尋與篩選條件）不存檔，重整回到預設；只有資料本身持久化。篩選條件尤其不該存——使用者下次打開會看到一份被篩選過的清單卻不知道為什麼有些項目不見了
7. 分享的資源不會併入自己的項目安排／日曆／指標，只出現在「共享」頁（理由見下方分享章節）
8. 「可操作」不含重新命名、改日期與刪除——那些只有擁有者能做
9. 分享過來的內容沒有本機快取，離線時看不到也改不了
10. **前置作業只顯示，不順延也不阻擋**；一個項目最多五個前置。「A 延後 B 自動跟著延後」是刻意不做的（見上方章節）
11. **「不在」不影響逾期、不影響提醒信、不影響 ICS**，只是日曆與列上的一個標記。使用者的裁決：「不在就是不在，逾期就照樣逾期」。**「休假」的逾期規則完全相同**（紅字一個字都不改），差別只有一個：**那一天的提醒信、櫻花樹的信與三種推播整批不送**（見〈休假那幾天閉嘴〉）
12. **純告知（`item.noticeOnly`）什麼都不算**：不長勾選框、永遠不逾期，也不進今日／本週／逾期／會議四張卡、已完成區、範圍列的數字與遊戲化。行事曆訂閱看得到，提醒信與推播不通知。「只看未完成」**不影響它**
13. 前置作業的狀態不進提醒信與 ICS——那兩者的內容由前端展開後推上去，加進去等於再開一條會分歧的路
14. **免費版有上限**：大項目與甘特專案各最多 3 個、AI 每天 5 次；Pro（app 內自動續訂訂閱）不限。降級不刪資料，只是不能再新增。在 app 裡註冊仍要附 Apple 的購買證明——一個 Apple ID 一個帳號，那是防濫用不是收費
15. **前端每次改版，app 要重新打包送審**：`index.html` 內建在 app 裡（自動更新是之後的子專案）。**打包本身已經自動化**——合併進 main、CI 全綠、而且動到 `public/index.html` 或 `mobile/` 就會自己打包並上傳到 TestFlight；要送審仍然要自己去 App Store Connect 按
16. **網頁上不開放陌生人自己註冊**：註冊只在 app 裡發生；網頁註冊仍走管理者核准，留給例外
17. **遊戲化的數字從 2026-09-17 起算**：之前的完成沒有時間戳，不算按時；連續天數不防「把日期往後改」。**開機的櫻花只在開機演一次**，切頁籤不播；它是 `pointer-events:none` 的遮罩，底下照樣按得到，1200ms 的上限由 CSS 保證（JS 不跑也會走），`prefers-reduced-motion` 開著時完全不出現
18. **推播只有 iOS app 有**：網頁版沒有（Web Push 要另一套金鑰與另一條 service worker 路徑，刻意不做）。推播**不取代 email**，兩者各自有開關——token 會因為換手機／刪 app／關權限而安靜失效，信箱是唯一不會這樣消失的管道
19. **交易信與訂閱信目前共用同一個寄件帳號**：程式已經支援分家（設 `AGENTMAIL_TX_*` 兩個 secret 即可，`/admin` 看得到目前是哪一種），但真的要分家需要**另一個 AgentMail 帳號**——退訂名單是帳號層級的，換同帳號底下的另一個信箱沒有用。在那之前，某個收件人被退訂名單擋掉時，他的密碼重設信與驗證碼也會一起收不到
20. **通知不做「稍後提醒」與互動按鈕**：那要 Notification Service Extension，而且要處理「在通知上勾完成」之後的同步衝突。先看有沒有人用

## 尚未做的重構

約 3700 行 JS 目前仍在單一 IIFE 內，靠區段註解分隔。收攏成 `DateUtil`／`OccurrenceEngine`／`Store`／各 View 的 namespace 物件是合理的下一步。occurrence 引擎現在有測試護著，重構它相對安全；其餘部分仍然沒有網，**不該和功能修改混在同一批做**——會讓 diff 大到無法人工審查。要做就單獨一個 commit，且不夾帶任何行為變更。

注意 `tests/occurrence.test.mjs` 是靠區段註解（`// ================= 名稱 =================`）定位原始碼的。重構時若改動區段名稱，測試會直接失敗並指出找不到哪一個區段——這是刻意的，不要改成靜默跳過。

特別值得保護的是：occurrence 引擎目前近乎純函式、零 DOM 依賴，這是全檔最好的設計。模組化時務必維持這個性質。
