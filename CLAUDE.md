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
src/handlers/          auth / state / admin 三組 API
schema.sql             D1 資料表
wrangler.jsonc         Worker 設定與綁定
```

**前端沒有 build step，也沒有測試框架。** 唯一的前端外部資源是 Google Fonts CDN，離線時退回系統字型但功能不受影響。

### 不可破壞的前提

**`public/index.html` 必須永遠能單獨雙擊開啟使用。** 雲端同步是漸進增強：偵測不到 `/api/state` 就靜默降級為純 localStorage。任何讓前端「非得有後端才能跑」的改動都違反這個前提。

### 常用指令

```bash
npm run dev            # wrangler dev，本機起 Worker + 靜態資產
npm run db:init:local  # 對本機 miniflare D1 建表（--local 的資料庫與遠端各自獨立）
npm run db:init        # 對遠端 D1 建表
npm run deploy         # 部署
```

本機開發需要 `.dev.vars`（已 gitignore），內含 Turnstile 官方測試金鑰與測試用 `ADMIN_EMAILS`。

**改完 `.dev.vars` 一定要完整重啟 dev server。** `wrangler dev` 只在啟動時讀一次該檔，而且 TaskStop 之類的終止方式殺不掉 wrangler 的子進程樹——留下的 workerd 孤兒會繼續佔住 port，造成「原始碼熱重載了、環境變數卻停在舊值」這種極難診斷的狀況（開發時實際踩過，繞很久）。重啟前先確認 port 真的空了：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*wrangler*" -and $_.CommandLine -like "*work-schedule*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

殺 workerd 之前要先殺它的 node 父進程，否則會被重新拉起。懷疑環境變數沒進去時，最快的定位法是讓 Worker 暫時回傳 `Object.keys(env)`（只回 key 不回值）。

### 驗證方式

沒有測試框架，改動一律靠實測：

1. 前端語法檢查——抽出 `<script>` 內容後 `node --check`
2. `npx wrangler deploy --dry-run` 驗證 wrangler 設定
3. 起 `npm run dev`，用瀏覽器實際操作三個頁籤，確認 console 無錯誤

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
- 每月循環：`'YYYY-MM'`
- 每季循環：`'YYYY-QN'`

所有「單次」狀態都以 occKey 為 key 掛在**母項目**上，而不是複製出獨立項目：

- `item.done`（單次）／ `item.doneMap[occKey]`（循環）— 完成狀態
- `item.overrides[occKey]` — 覆寫該次日期
- `item.skipped[occKey]` — 略過該次

這就是為什麼調整或略過某一次不會影響其他週期。任何新增的 per-occurrence 功能都應遵循同一模式（掛一個新的 `occKey -> value` map 在 item 上），不要為了單次差異而 fork 出新 item。

**但這也是最容易踩的坑**：occKey 的格式跟頻率綁定，頻率一改（每月 ↔ 每季 ↔ 不循環）舊 key 全部對不上。因此 `btnConfirmItem` 在偵測到頻率變更時會清空 `done`／`doneMap`／`overrides`／`skipped`（modal 內有 `#recurChangeWarn` 事先警告）。若未來新增循環頻率，**必須同步更新這段清除邏輯**，否則會留下孤兒資料——症狀是改回原頻率時舊紀錄整批「復活」。

### 優先順序與邊界

- **覆寫日期優先於假日規則**：`getOccurrencesInRange` 內若存在 `overrides[occKey]`，就直接採用該日期，完全跳過 `adjustForHoliday()`
- `isHoliday()` = 週六日 **或** 落在 `customHolidays` Set 內；`adjustForHoliday()` 逐日 ±1 推移直到非假日
- 假日調整**只作用於循環項目**，非循環項目的日期原樣使用
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

### applySnapshot 一定要正規化，不能只檢查 version

`applySnapshot()` 收到的資料可能來自舊版存檔、另一台還沒更新的裝置，或已損毀的雲端資料。缺 `date` 的 item 會讓 occurrence 展開時 `parseYMD` 直接拋錯——而雲端載入走 async，錯誤會變成 unhandled rejection：**畫面停在舊狀態、console 沒有明顯線索、使用者完全不知道發生什麼事**（開發時實際踩過）。

因此 `normalizeItems()` / `normalizeGanttProjects()` 會在套用前過濾掉缺少必要欄位的資料並補齊其餘欄位。新增欄位時記得一併更新這兩個函式。

## 雲端同步

只有部署後才啟用。`initCloudSync()` 偵測不到 `/api/state` 就靜默降級，這是前面說的「不可破壞的前提」。

`workSchedule.v1.cloudMeta` 記錄「上次成功同步到的雲端版本」，是判斷衝突的關鍵——沒有它就無法區分「本機比雲端新」和「兩邊都改過」。

啟動時的四條分支（改動時每條都要測）：

| 本機 | 雲端 | 行為 |
|---|---|---|
| 空 | 空 | seed 後推上雲端 |
| 有 | 空 | 推上雲端 |
| 空 | 有 | 採用雲端（不可重新 seed） |
| 有 | 有 | `cloudMeta.updatedAt === 遠端` → 本機較新，推上去；否則為**真衝突**，跳對話框讓使用者選 |

加上「本機編輯後 1.5s 自動推送」與「file:// 開啟時完全靜默」，共六個情境。

**衝突絕不能靜默挑邊**——兩台裝置各自編輯過時，任何自動選擇都會讓某一方的資料無聲消失。Worker 端以 `updated_at` 做樂觀鎖，`baseUpdatedAt` 對不上就回 409 並附上遠端資料。

### Worker 端

- 查無使用者資料時回 `state: null` 而非 404，代表「尚未同步過」，前端應沿用本地資料。
- 401 在前端代表 session 過期，必須導向 `/login`，**不能當成單機模式靜默降級**——那會讓使用者以為還在同步，實際上變更只留在本機。

### 換人登入的隱私防線

`cloudMeta` 除了版本號還記錄 `owner`。同一台電腦換人登入時，localStorage 仍是前一位使用者的資料；若不比對 owner，衝突對話框會讓新使用者有機會把別人的排程覆蓋進自己的雲端帳號。載入時 owner 不符即清空本地並重新 seed，登出時也一併清除——兩道防線都要保留，不要因為「登出已經清過」就移除 owner 比對（session 過期、cookie 被替換等情況不會經過登出流程）。

## 認證與權限

流程：Turnstile 真人驗證 → email + 密碼 → 管理者核准 → 使用。

| 規則 | 理由 |
|---|---|
| `TURNSTILE_SECRET` 未設定時**一律擋下**註冊與登入 | 未設定就放行，等於真人驗證形同虛設 |
| 密碼用 PBKDF2-SHA256 210,000 迭代，比對走 constant-time | 用 `===` 比字串會提早回傳，洩漏正確前綴長度 |
| session 在 DB 只存 token 的 SHA-256 | DB 外洩時裡面的值無法直接拿來登入 |
| 用 DB session 而非無狀態 JWT | 管理者停用帳號要能**立即**生效 |
| 登入失敗一律回「email 或密碼錯誤」，帳號不存在時仍跑一次雜湊 | 避免被用來列舉哪些 email 有註冊；兩條路徑耗時要接近 |
| 帳號狀態只在密碼正確後才揭露 | 此時對方已證明是帳號持有人 |
| 註冊時 email 重複則明說 | 比照登入回模糊訊息會讓使用者卡在「註冊沒反應」 |
| 未核准帳號登入時**不發 session** | 因此不需要 `/pending` 頁面，對方根本進不了站 |
| 管理者不能變更自己的角色或狀態 | 避免手滑把自己降級，導致無人能管理系統 |
| `ADMIN_EMAILS` 名單內的帳號無法從介面停用／降級／刪除 | 系統的最後保險，即使操作者是另一位管理者 |
| 狀態一旦不是 `approved` 就銷毀該使用者所有 session | 否則對方在下次登入前仍能繼續使用，停用形同虛設 |

### CPU 時間是真實限制

密碼雜湊是純 CPU 運算。PBKDF2 210,000 迭代實測約 74ms，而 Workers **免費方案上限是每請求 10ms**——本專案帳號為 `workers_paid`（上限 30 秒）才能這樣用。

**這個限制只在線上強制，本機開發不強制**，所以本機永遠測不出來。若日後改到免費方案，登入會直接被終止且錯誤訊息模糊。調整迭代次數前先確認方案。`wrangler.jsonc` 的 `limits.cpu_ms = 500` 是成本防護，不是效能上限。

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
- `renderNav()` — 切換 `.active` class 後呼叫 `renderAll()`

DOM 建構有兩種寫法，請依情境沿用：

- **互動元素**（列、chip、按鈕）用 `document.createElement` + closure 綁 `.onclick`，例如 `buildOccRow()`
- **大塊靜態內容**用 `innerHTML` 字串拼接，但**使用者輸入必須先過 `escapeHtml()`**（`renderReminderList()`、`renderMetricList()` 是範例）

### 時鐘與資料重算已解耦

`tick()` 每秒只更新時鐘文字。metrics 與提醒改由 `commit()` 驅動，另外記 `lastTickYmd` 偵測跨日才觸發一次 `renderAll()`。**不要把資料重算加回 `tick()`**——那等於每秒把所有循環項目展開一次，成本隨項目數線性放大。

### 甘特頁的例外：表格不重建

這是全量重繪策略唯一開的洞，而且是必要的。表格內的名稱／日期／進度欄位若在編輯時重建整張表，正在輸入的 input 會被銷毀，Tab 換欄位和連續輸入都會斷掉。

因此表格內編輯一律呼叫 `refreshGanttChart(gp)`——只替換 `#ganttChartWrap`，表格原地不動；名稱改動則透過 `.gantt-row-label[data-task-id]` 就地更新圖表文字。只有**新增／刪除任務**（行數改變）才走完整的 `commit()` → `renderGanttView()`。

## 樣式慣例

型別與顏色的對應寫死在 CSS 變數，改色只改 `:root`：

- `work` → `--teal` #1F8C68（工作項目）
- `meeting` → `--violet` #6C5CE0（會議安排）
- `assignment` → `--amber` #C9822E（作業；同時是介面主色、今日標示、循環徽章色）

class 命名沿用 `type-<type>`（列）與 `type-badge <type>`（徽章）；顯示文字統一走 `typeLabels` / `modeLabels` 兩個 lookup 物件，不要在各處硬寫中文字串。

## 已知限制（刻意為之，回報前先確認是否為此）

1. 未部署時儲存僅限單一瀏覽器；部署後才跨裝置
2. 假日僅自動判斷週六日，國定假日需使用者手動加進「自訂假日」
3. 甘特圖長條為靜態百分比定位，不支援拖曳；日期只能透過表格輸入修改
4. 變更循環頻率會重置該項目的各次完成／覆寫／略過紀錄（見上方 occurrence 引擎章節）
5. 檢視狀態（目前頁籤、選取的年／季／月）不存檔，重整回到預設；只有資料本身持久化

## 尚未做的重構

約 1180 行 JS 目前仍在單一 IIFE 內，靠區段註解分隔。收攏成 `DateUtil`／`OccurrenceEngine`／`Store`／各 View 的 namespace 物件是合理的下一步，但**沒有測試網的情況下不該和功能修改混在同一批做**——會讓 diff 大到無法人工審查。要做就單獨一個 commit，且不夾帶任何行為變更。

特別值得保護的是：occurrence 引擎目前近乎純函式、零 DOM 依賴，這是全檔最好的設計。模組化時務必維持這個性質。
