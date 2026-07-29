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

### 優先順序與邊界

- **覆寫日期優先於假日規則**：`getOccurrencesInRange` 內若存在 `overrides[occKey]`，就直接採用該日期，完全跳過 `adjustForHoliday()`
- `isHoliday()` = 週六日 **或** 落在 `customHolidays` Set 內；`adjustForHoliday()` 逐日 ±1 推移直到非假日
- 假日調整**只作用於循環項目**，非循環項目的日期原樣使用
- 展開迴圈有兩道保險：`guard < 800`，以及 `cursorY > rangeEnd.getFullYear() + 2` 就中止。新增循環頻率（例如每週）時必須確認這兩個上限仍然合理，否則會在長區間靜默漏算

## 狀態與資料模型

所有狀態都是 IIFE 內的 module-scoped `let`，**完全沒有持久化**（程式中沒有任何 `localStorage`／`fetch`／IndexedDB 呼叫）。重新整理即全部重置——這是刻意的免費版限制，不是 bug。

檔案最底部的 `seed()` IIFE 會塞入示範資料（兩個大項目、六個小項目、一個含三項任務的甘特專案）。改動資料模型時記得一併更新 seed，否則開啟頁面就會壞。

### 兩套互不相干的「專案」概念（極易混淆）

| 變數 | 出現位置 | 說明 |
|---|---|---|
| `majorProjects` | 項目安排頁的 chip 列 | 純分類標籤，無日期。`item.parentId` 指向它；刪除後底下項目變成獨立項目 |
| `ganttProjects` | 專案頁 | 完全獨立的另一套資料，各自帶 `tasks[]` 與 `notes` |

兩者之間沒有任何關聯，不要試圖合併或互相引用。

### 檢視範圍狀態

`mode`（`'year'|'quarter'|'month'|'date'`）搭配 `selYear`／`selQuarter`／`selMonth`／`selDate` 決定 `currentRange()` 回傳的區間；日曆頁另有獨立的 `calYear`／`calMonth`／`calSelectedDate`，兩套不共用。

## Render 模式

全量重繪，沒有任何 diff 機制。

- `renderScheduleView()` 是主力函式，會連帶重繪 chips、tabs、board、metrics、提醒清單
- 它同時被當成 `onChange` callback 傳進 `buildOccRow(occ, onChange)`——任何列上的勾選／略過／刪除都直接改資料後呼叫它整片重畫
- `renderAll()` 依 `currentView` 分派；`renderNav()` 負責切換 `.active` class 並觸發對應頁面的 render

DOM 建構有兩種寫法，請依情境沿用：

- **互動元素**（列、chip、按鈕）用 `document.createElement` + closure 綁 `.onclick`，例如 `buildOccRow()`
- **大塊靜態內容**用 `innerHTML` 字串拼接，但**使用者輸入必須先過 `escapeHtml()`**（`renderReminderList()`、`renderMetricList()` 是範例）

### 注意：1Hz 全量重算

`tick()` 由 `setInterval(tick, 1000)` 每秒觸發，除了更新時鐘外還會呼叫 `renderMetrics()` 與 `renderReminderList()`，而這兩者都會重新展開當日／當週的所有 occurrence。項目數量放大後這裡會是第一個效能瓶頸；若要加重 occurrence 計算成本，請先處理這個每秒迴圈。

## 樣式慣例

型別與顏色的對應寫死在 CSS 變數，改色只改 `:root`：

- `work` → `--teal` #1F8C68（工作項目）
- `meeting` → `--violet` #6C5CE0（會議安排）
- `assignment` → `--amber` #C9822E（作業；同時是介面主色、今日標示、循環徽章色）

class 命名沿用 `type-<type>`（列）與 `type-badge <type>`（徽章）；顯示文字統一走 `typeLabels` / `modeLabels` 兩個 lookup 物件，不要在各處硬寫中文字串。

## 已知限制（刻意為之，回報前先確認是否為此）

1. 無持久化儲存，重整即清空
2. 假日僅自動判斷週六日，國定假日需使用者手動加進「自訂假日」
3. 甘特圖長條為靜態百分比定位，不支援拖曳；日期只能透過表格輸入修改
