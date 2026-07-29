# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案性質

單一檔案的純前端應用：`工作排程確認系統.html`（約 1250 行，CSS + HTML + JavaScript 全在一個檔案裡）。

**沒有 build、沒有套件管理、沒有測試框架、沒有後端。** 唯一的外部依賴是 Google Fonts CDN（JetBrains Mono + Noto Sans TC），離線時會退回系統字型但功能不受影響。

執行方式：直接用瀏覽器開啟該 HTML 檔。

```bash
Start-Process "D:\Project\work-schedule\工作排程確認系統.html"
```

驗證改動只能靠手動操作瀏覽器 + DevTools console。修改後請實際開啟頁面確認三個頁籤（項目安排／日曆／專案）都還能正常 render，再宣告完成。

`工作排程確認系統_專案說明.md` 是給使用者看的功能總覽與交接文件；改動功能時應同步更新它。

## 檔案內部結構

| 行數範圍 | 內容 |
|---|---|
| 10–290 | `<style>`。`:root` 的 CSS 變數是所有顏色的唯一來源 |
| 292–491 | `<body>` 靜態骨架。**所有 modal 都預先寫死在 markup 裡**，靠 `.overlay` 的 class 切換顯示 |
| 493–1253 | 單一 `<script>`，整段包在一個 IIFE 內 |

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

### 儲存層的兩個設計約束

1. **所有 `localStorage` 存取都必須包 try/catch。** Claude Artifact 的沙盒 iframe 會封鎖 localStorage 並拋 `SecurityError`，沒包就整個 app 當場掛掉。失敗時降級為記憶體模式（footer 會自動改文案），功能全部照常。
2. **`persist()` 每次都實際嘗試寫入**，不拿 `storageAvailable` 當開關跳過。配額滿是可恢復的錯誤，使用者刪掉資料後應該自動恢復存檔；一次失敗就永久停用會讓存檔靜默死掉。`storageAvailable` 只用來決定 footer 文案。

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

1. 儲存僅限單一瀏覽器，不跨裝置（要跨裝置需接後端／雲端，`commit()` 就是掛載點）
2. 假日僅自動判斷週六日，國定假日需使用者手動加進「自訂假日」
3. 甘特圖長條為靜態百分比定位，不支援拖曳；日期只能透過表格輸入修改
4. 變更循環頻率會重置該項目的各次完成／覆寫／略過紀錄（見上方 occurrence 引擎章節）
5. 檢視狀態（目前頁籤、選取的年／季／月）不存檔，重整回到預設；只有資料本身持久化

## 尚未做的重構

760 行 JS 目前仍在單一 IIFE 內，靠區段註解分隔。收攏成 `DateUtil`／`OccurrenceEngine`／`Store`／各 View 的 namespace 物件是合理的下一步，但**沒有測試網的情況下不該和功能修改混在同一批做**——會讓 diff 大到無法人工審查。要做就單獨一個 commit，且不夾帶任何行為變更。

特別值得保護的是：occurrence 引擎目前近乎純函式、零 DOM 依賴，這是全檔最好的設計。模組化時務必維持這個性質。
