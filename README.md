# 工作排程確認系統

單一 HTML 檔案的工作排程管理工具——工作項目、會議、循環任務、月曆檢視與甘特圖，全部裝在一個檔案裡，下載後用瀏覽器打開就能用。

> 純前端、零依賴、零安裝。不需要 Node.js、不需要伺服器、不需要資料庫。

## 使用方式

### 方式一：單機（零安裝）

1. 下載 [`public/index.html`](./public/index.html)
2. 用任何現代瀏覽器直接開啟

資料存在該瀏覽器的 `localStorage`，重新整理不會遺失。

### 方式二：部署到 Cloudflare（跨裝置同步）

```bash
npm install
npx wrangler d1 create work-schedule-db   # 已建立則跳過，把 id 填入 wrangler.jsonc
npm run db:init                            # 建表
npm run deploy
```

部署後在 Cloudflare Dashboard → Workers & Pages → 選此 Worker → Settings → Domains & Routes，
對 `workers.dev` 點 **Enable Cloudflare Access** 並限定你的 email，然後設定兩個環境變數：

| 變數 | 值 |
|---|---|
| `TEAM_DOMAIN` | `https://<你的團隊名>.cloudflareaccess.com` |
| `POLICY_AUD` | Access 應用程式的 AUD tag |

**這兩個變數未設定時 API 會回 500 而非放行**——避免未設定就等於資料公開。

本機開發用 `.dev.vars` 設 `ALLOW_UNAUTHENTICATED=true` 略過認證（該檔已 gitignore）。

## 功能

### 📋 項目安排
- **大項目**：純分類標籤（無日期），可新增、更名、刪除
- **小項目**：三種類型——🟢 工作項目、🟣 會議安排（含時間）、🟠 作業
- 年度／季度／月份／特定日期四種範圍篩選
- **循環規則**：每月或每季固定日期，遇假日可選「順延／提前至工作天／不調整」，可設循環期限
- 循環的某一次可以單獨改日期或整次略過，不影響其他週期
- 自訂假日清單（週六日已自動視為假日）

### 📅 日曆
- 月曆網格，今日醒目標示
- 會議依時間排序顯示；工作與作業可直接在格子上打勾
- 點選日期展開當日完整項目卡片＋**每日記錄**備忘欄

### 📊 專案（甘特圖）
- 多專案管理，任務時間軸長條含進度百分比與今日標線
- 待辦表格直接編輯日期與進度，即時反映到甘特圖
- 專案筆記自動儲存

### 🔔 儀表板與提醒
- 頂部即時顯示：當日未完成、當週未完成、當日會議
- 開啟頁面自動彈出今日待辦提醒，鈴鐺按鈕含未完成數量角標

### 💾 自動儲存與跨裝置同步
- 所有變更即時存入瀏覽器 `localStorage`，重新整理不會遺失
- 部署到 Cloudflare 後額外啟用雲端同步：`localStorage` 仍是主要儲存（畫面即時、可離線），雲端在背景同步
- 兩台裝置各自改過同一份資料時會**跳出提示讓你選擇保留哪一份**，不會靜默覆蓋
- 偵測不到 API（單機開啟）或環境禁止本機儲存（Claude Artifact 沙盒）時自動降級，功能不受影響
- 頁面底部可一鍵清除所有資料並還原示範內容

## 技術說明

- 前端是零依賴的單一 HTML 檔（HTML + CSS + Vanilla JavaScript），可獨立運作
- 唯一外部資源為 Google Fonts CDN（JetBrains Mono + Noto Sans TC），離線時自動退回系統字型
- 循環項目採用「occurrence 引擎」設計：只儲存錨點日期與規則，每次顯示時即時展開，單次調整以 `occKey` 記錄在母項目上
- 後端為 Cloudflare Worker + D1，僅兩個端點（`GET`/`PUT /api/state`），以 Cloudflare Access 的 JWT 識別使用者

```
public/index.html   前端（單檔，可直接開啟）
src/index.js        Worker 入口與 /api/state
src/auth.js         Cloudflare Access JWT 驗證
schema.sql          D1 資料表
wrangler.jsonc      Worker 設定與綁定
```

詳細架構與資料模型請見 [`工作排程確認系統_專案說明.md`](./工作排程確認系統_專案說明.md)。

## 已知限制

| 限制 | 說明 |
|---|---|
| 單機模式的儲存範圍 | 未部署時資料只存在「這個瀏覽器」，不跨裝置；清除瀏覽器資料會一併清掉 |
| 同步粒度 | 雲端存的是整包狀態，衝突以整份為單位處理，不會逐項合併 |
| 假日判斷 | 僅自動判斷週六日，國定假日需手動加入自訂假日清單 |
| 甘特圖 | 長條不支援拖曳，日期透過表格輸入修改 |
| 變更循環頻率 | 每月 ↔ 每季互換時，各次的完成／覆寫／略過紀錄會重置（存檔時會事先警告） |
