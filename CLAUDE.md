# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案性質

前端是**零依賴的單一 HTML 檔** `public/index.html`（約 1700 行，CSS + HTML + JavaScript 全在裡面），可以獨立雙擊開啟運作；後端是 Cloudflare Worker + D1，只在部署後才啟用。

```
public/index.html      主應用（單檔，可直接雙擊開啟）
public/login.html      登入／註冊（含 Turnstile）
public/admin.html      帳號管理（僅管理者）
src/index.js           路由與存取控制
src/crypto.js          PBKDF2 密碼雜湊、token 產生
src/session.js         session 建立／查詢／銷毀
src/turnstile.js       Turnstile siteverify
src/handlers/          auth / state / admin / share 四組 API
schema.sql             D1 資料表
wrangler.jsonc         Worker 設定與綁定
tests/                 occurrence 引擎、三方合併、雲端寫入樂觀鎖的測試（node:test，零相依）
tools/                 開發用腳本（解析官方辦公日曆表）
public/sw.js           service worker（加到主畫面／離線可用）
public/manifest.webmanifest, public/icon*.png|svg
```

**前端沒有 build step。** 唯一的前端外部資源是 Google Fonts CDN，離線時退回系統字型但功能不受影響。

測試涵蓋三塊（`npm test`），其餘一律靠實測：

| 檔案 | 涵蓋 | 抽取方式 |
|---|---|---|
| `tests/occurrence.test.mjs` | occurrence 引擎 | 從 `index.html` 抽真正的原始碼求值 |
| `tests/merge.test.mjs` | 三方合併 | 同上 |
| `tests/state.test.mjs` | `handlePutState` / `handleUpdateShared` 的樂觀鎖 | 直接 import Worker 端模組 |
| `tests/richtext.test.mjs` | 富文字過濾器的安全決策、v1→v2 遷移 | 從 `index.html` 抽真正的原始碼求值 |

挑這三塊是因為它們同時是最容易改壞、也最容易測的部分。前兩者近乎純函式、零 DOM 依賴；第三者是**競態**——靠併發碰運氣測不到，但可以把空窗做成確定性的。

`tests/d1.mjs` 用 **Node 內建的 `node:sqlite`**（不是相依套件）搭出 D1 相容外殼，讓 handler 跑真正的 SQL。不自己造假的 DB 物件是刻意的：要驗的正是「帶條件的 UPDATE 有沒有改到一列」，那是 SQL 的語意，假物件等於把答案寫成期望值，測起來永遠會過。

### 不可破壞的前提

**`public/index.html` 必須永遠能單獨雙擊開啟使用。** 雲端同步是漸進增強：偵測不到 `/api/state` 就靜默降級為純 localStorage。任何讓前端「非得有後端才能跑」的改動都違反這個前提。

### 常用指令

```bash
npm run dev            # wrangler dev，本機起 Worker + 靜態資產
npm run db:init:local  # 對本機 miniflare D1 建表（--local 的資料庫與遠端各自獨立）
npm run db:init        # 對遠端 D1 建表
npm run deploy         # 部署
npm test               # occurrence 引擎測試（node:test，不需安裝任何東西）
```

本機開發需要 `.dev.vars`（已 gitignore），內含 Turnstile 官方測試金鑰與測試用 `ADMIN_EMAILS`。

**改完 `.dev.vars` 一定要完整重啟 dev server。** `wrangler dev` 只在啟動時讀一次該檔，而且 TaskStop 之類的終止方式殺不掉 wrangler 的子進程樹——留下的 workerd 孤兒會繼續佔住 port，造成「原始碼熱重載了、環境變數卻停在舊值」這種極難診斷的狀況（開發時實際踩過，繞很久）。重啟前先確認 port 真的空了：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*wrangler*" -and $_.CommandLine -like "*work-schedule*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

殺 workerd 之前要先殺它的 node 父進程，否則會被重新拉起。懷疑環境變數沒進去時，最快的定位法是讓 Worker 暫時回傳 `Object.keys(env)`（只回 key 不回值）。

### 驗證方式

0. **凡是新增「前端呼叫的函式」，一定要在瀏覽器裡把那條路徑真的走一次。** `npm test` 與 `node --check` 都抓不到「函式根本沒被定義」——前者不碰前端整合，後者只驗語法。逾期提醒就是這樣上線的：前端區段整段沒進檔案，`pushReminderSoon` 從未定義，而後端 API、cron、單元測試全部是綠的。症狀是登入後顯示「初始化失敗，僅使用本機資料」。
1. **動到 occurrence 引擎（日期／循環／假日／單次覆寫）一律先跑 `npm test`。** 測試直接從 `public/index.html` 抽出真正的原始碼求值，不是複製一份——複製一份出來測，測的是副本而不是實際跑的程式，那比沒有測試更糟。
2. 前端語法檢查——抽出 `<script>` 內容後 `node --check`
3. `npx wrangler deploy --dry-run` 驗證 wrangler 設定
4. 起 `npm run dev`，用瀏覽器實際操作四個頁籤，確認 console 無錯誤

### 降級可以，沉默不行

`initCloudSync()` 的 catch 會把同步降級成單機模式——這是對的，同步壞掉不該連累本機使用。但它原本**什麼都不印**，畫面只顯示「初始化失敗」而 console 一片乾淨，使用者回報時完全沒有線索，只能逐行讀程式碼猜（實際踩過）。

任何「吞掉例外並降級」的地方都必須 `console.error` 把 stack 記出來。降級與沉默是兩件事。

UI 類的改動（版面、行動版、主題）**必須真的用瀏覽器看過**，靜態檢查看不出破版。這批改動就是靠實測才抓到三個問題：側欄變成看不見的全屏遮罩、任務列撐破卡片、甘特圖把行動版的版面視窗從 390px 撐成 425px。

**改動同步邏輯時，必須把六個情境都測過**（見下方「雲端同步」章節），因為它們彼此的差異只在啟動時的分支條件，很容易只修好一條路徑。

`工作排程確認系統_專案說明.md` 是給使用者看的功能總覽與交接文件；README.md 含部署步驟。改動功能時兩者都要同步更新。

## 檔案內部結構

| 行數範圍 | 內容 |
|---|---|
| 9–289 | `<style>`。`:root` 的 CSS 變數是所有顏色的唯一來源 |
| 291–511 | `<body>` 靜態骨架。**所有 modal 都預先寫死在 markup 裡**，靠 `.overlay` 的 class 切換顯示 |
| 512–1694 | 單一 `<script>`，整段包在一個 IIFE 內 |

因為全部包在 IIFE 裡，**沒有任何東西暴露在 global scope**——所以不能用 inline `onclick="..."` 屬性，事件一律在 JS 內用 `.onclick = fn` 綁定。新增 UI 時請沿用此模式。

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
- **高頻輸入**（每日記錄、專案筆記 textarea、甘特任務改名）用 `persistSoon()` 做 400ms debounce，避免每個字元寫一次 localStorage

### 儲存層的三個設計約束

1. **所有 `localStorage` 存取都必須包 try/catch。** Claude Artifact 的沙盒 iframe 會封鎖 localStorage 並拋 `SecurityError`，沒包就整個 app 當場掛掉。失敗時降級為記憶體模式（footer 會自動改文案），功能全部照常。
2. **`persist()` 每次都實際嘗試寫入**，不拿 `storageAvailable` 當開關跳過。配額滿是可恢復的錯誤，使用者刪掉資料後應該自動恢復存檔；一次失敗就永久停用會讓存檔靜默死掉。`storageAvailable` 只用來決定 footer 文案。
3. **`snapshot()` / `applySnapshot()` 是本機與雲端共用的序列化格式。** 新增狀態欄位時只改這兩個函式，否則必定有一邊漏掉。

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

加上「本機編輯後 1.5s 自動推送」與「file:// 開啟時完全靜默」，共六個情境。

**「空＋空」那一格刻意不是 seed。** 啟動時 `loadState()` 失敗會先跑 `seed()` 讓單機開啟有東西可看，但等到確認「已登入且雲端沒有資料」時，那份示範資料就必須清掉——否則每個新帳號第一次登入都會拿到一份不屬於自己的假資料，還得逐筆刪。判斷依據是 `localHadData`：它為 false 就代表畫面上這份是 seed 而不是使用者的東西。單機模式（沒有帳號）仍然保留 seed，那是單檔雙擊開啟時的展示價值。

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
- **今天到期的不算逾期。** 那是「今天要做」，混進去會把真正遲交的東西淹沒。
- **沒有逾期就完全不寄。** 每天一封「你沒有逾期項目」只會訓練收件者忽略這個寄件人，真的有事時反而看不到。
- `last_sent_ymd` 讓同一天不重寄（cron 會重試）；**寄失敗時刻意不寫這個欄位**，沒寄成功就不算寄過，下一次排程要能補。
- `handleReminderPut` 只更新 digest、不動 `enabled`：推送是同步的副作用，不該把使用者關掉的提醒打開。
- 需要兩個 secret，另有選填的 `APP_URL` 用於信中的連結：

| 變數 | 值長什麼樣 | 說明 |
|---|---|---|
| `AGENTMAIL_API_KEY` | `am_us_inbox_b1e2…` | 帳號層級的憑證。**前綴雖然寫著 `inbox`，它是 API key 不是 inbox id** |
| `AGENTMAIL_INBOX_ID` | `uic_ai@agentmail.to` | 寄件信箱的識別碼，形式是 **email 位址** |

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
| `ADMIN_EMAILS` 名單內的帳號無法從介面停用／降級／刪除 | 系統的最後保險，即使操作者是另一位管理者 |
| 狀態一旦不是 `approved` 就銷毀該使用者所有 session | 否則對方在下次登入前仍能繼續使用，停用形同虛設 |

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

### 勾選走樂觀回饋，是全量重繪唯一的緩衝

`commit()` 是同步的完整重繪，成本隨項目數成長（300 項時一次勾選約 52ms）。若打勾符號要等它整段跑完才出現，資料一多就變成「按了沒反應」。

因此核取方塊一律走 `toggleOccDone(occ, checkEl, labelEl)`：先就地把那一列切成新狀態（它已經在 DOM 裡，改 class 是 O(1)），再把 `commit()` 排到下一個 frame。項目安排列與日曆格子共用這一個函式。

兩個容易改錯的地方：

- **必須用兩層 `requestAnimationFrame`。** rAF 的 callback 跑在「下次繪製之前」，只包一層會和剛才的視覺變更擠在同一個 frame，等於完全沒有延後。
- **`occ.done` 要一起就地更新。** 否則延後的那幾十毫秒內再點一次會讀到舊值，兩次算出同一個 `next`。真正的資料仍由 `commit()` 內的 `setOccurrenceDone` 寫入。

這是全量重繪策略的緩衝，不是例外：資料流沒有變，只是把視覺回饋提前。**不要因此把其他操作也改成延後**——其餘操作的視覺結果無法只靠切一個 class 表達，延後只會讓畫面短暫地與資料不一致。

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
| 傳輸量太大 | 197KB 的 `index.html` 經 brotli 約 50KB，`content-encoding: br` 已生效 | 已是最佳 |
| `getSessionUser` 查兩次 | 本來就是單一 JOIN | 沒有浪費 |
| D1 讀取複本 | 資料庫在 APAC、使用者也在台灣 | 開複本只幫得到遠端使用者，目前沒有 |

### 字型不阻擋首次繪製

一般的 `<link rel="stylesheet">` 是 render-blocking：CDN 慢的時候整頁一個字都不畫（實測延遲 1.5s 會讓 FCP 從 536ms 變成 2060ms）。而網址裡本來就有 `display=swap`——擋住首次繪製換不到任何東西。

三個 HTML 都改用 `media="print"` + `onload` 切回 `all`，並補上 `fonts.gstatic.com` 的 `preconnect crossorigin`（CSS 在 googleapis，實際的 woff2 在 gstatic，只指前者仍要重新握手）。改完後 FCP 與「完全沒有字型 link」的下限相同。

**這裡的 inline `onload` 是允許的例外**：它只碰 `this`，不需要存取 IIFE 內的東西，與「不能用 inline onclick」那條規則的理由不衝突。

### 還沒做、但量過確實有收益的

- **五次重複的 occurrence 展開**：`renderAll()` 在項目安排頁會展開全部項目五次（今天、本週、逾期 90 天、提醒清單、board），其中提醒清單那次與第一次完全重複。收斂成單次記憶化可望把勾選成本再砍一半。
- **board 逐列 append**：300 項時 1264 列一列一列插進活的 DOM，改用 `DocumentFragment` 約省 15–25ms。
- **service worker 導覽改 stale-while-revalidate**：快取裡有完好的 app shell 卻每次都等網路。收益最大，但**代價是部署後要多開一次才看得到新版**——目前刻意維持 network-first，要改必須是明確的決定，不能順手。

## 樣式慣例

型別與顏色的對應寫死在 CSS 變數，改色只改 `:root`：

- `work` → `--teal` #1F8C68（工作項目）
- `meeting` → `--violet` #6C5CE0（會議安排）
- `assignment` → `--amber` #C9822E（作業；同時是介面主色、今日標示、循環徽章色）

class 命名沿用 `type-<type>`（列）與 `type-badge <type>`（徽章）；顯示文字統一走 `typeLabels` / `modeLabels` 兩個 lookup 物件，不要在各處硬寫中文字串。

## 已知限制（刻意為之，回報前先確認是否為此）

1. 未部署時儲存僅限單一瀏覽器；部署後才跨裝置
2. 假日自動判斷週六日；國定假日提供**已公布年度的內建清單**（一鍵載入）與批次貼上，見下方「國定假日」章節。未公布的年度不內建
3. ~~無法表達「週末補班日」~~ 已支援：`customWorkdays`（modal 內「補班日」區）優先於週末判斷。2026 年沒有補班日；之後的年度由 `tools/parse-gov-calendar.py` 一併解析出來
4. 甘特圖長條為靜態百分比定位，不支援拖曳；日期只能透過表格輸入修改
5. 變更循環頻率會重置該項目的各次完成／覆寫／略過紀錄（見上方 occurrence 引擎章節）
6. 檢視狀態（目前頁籤、選取的年／季／月、搜尋與篩選條件）不存檔，重整回到預設；只有資料本身持久化。篩選條件尤其不該存——使用者下次打開會看到一份被篩選過的清單卻不知道為什麼有些項目不見了
7. 分享的資源不會併入自己的項目安排／日曆／指標，只出現在「共享」頁（理由見下方分享章節）
8. 「可操作」不含重新命名、改日期與刪除——那些只有擁有者能做
9. 分享過來的內容沒有本機快取，離線時看不到也改不了

## 尚未做的重構

約 1180 行 JS 目前仍在單一 IIFE 內，靠區段註解分隔。收攏成 `DateUtil`／`OccurrenceEngine`／`Store`／各 View 的 namespace 物件是合理的下一步。occurrence 引擎現在有測試護著，重構它相對安全；其餘部分仍然沒有網，**不該和功能修改混在同一批做**——會讓 diff 大到無法人工審查。要做就單獨一個 commit，且不夾帶任何行為變更。

注意 `tests/occurrence.test.mjs` 是靠區段註解（`// ================= 名稱 =================`）定位原始碼的。重構時若改動區段名稱，測試會直接失敗並指出找不到哪一個區段——這是刻意的，不要改成靜默跳過。

特別值得保護的是：occurrence 引擎目前近乎純函式、零 DOM 依賴，這是全檔最好的設計。模組化時務必維持這個性質。
