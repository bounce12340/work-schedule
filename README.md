# 工作排程確認系統

單一 HTML 檔案的工作排程管理工具——工作項目、會議、循環任務、月曆檢視與甘特圖，全部裝在一個檔案裡，下載後用瀏覽器打開就能用。

> 純前端、零依賴、零安裝。不需要 Node.js、不需要伺服器、不需要資料庫。

## 使用方式

### 方式一：單機（零安裝）

1. 下載 [`public/index.html`](./public/index.html)
2. 用任何現代瀏覽器直接開啟

資料存在該瀏覽器的 `localStorage`，重新整理不會遺失。

### 方式二：部署到 Cloudflare（多使用者 + 跨裝置同步）

```bash
npm install
npx wrangler d1 create work-schedule-db   # 已建立則跳過，把 id 填入 wrangler.jsonc
npm run db:init                            # 建表
```

建立 Turnstile widget（真人驗證）：

```bash
npx wrangler turnstile widget create "work-schedule" --domain <你的網域> --domain localhost --domain 127.0.0.1 --mode managed
```

指令會印出 **sitekey**（公開，填進 `public/login.html` 的 `SITEKEY`）與 **secret**（機密）。
接著設定兩個 secret：

```bash
npx wrangler secret put TURNSTILE_SECRET
```

```bash
npx wrangler secret put ADMIN_EMAILS
```

`ADMIN_EMAILS` 是逗號分隔的管理者 email 清單，名單內的帳號**註冊後自動成為已核准的管理者**。
沒有它就沒有人能核准第一個帳號，系統會死鎖。

> 這兩項走 secret 而非 `vars`：`vars` 會被寫進版控（公開 repo 等於公開你的 email），
> 且在 Dashboard 改的 `vars` 會被下次 `deploy` 覆蓋。

最後部署：

```bash
npm run deploy
```

**`TURNSTILE_SECRET` 未設定時所有註冊與登入都會被拒絕**，而不是放行——未設定就放行等於真人驗證形同虛設。

本機開發不需要真的金鑰，`.dev.vars` 已使用 Cloudflare 官方測試金鑰（該檔已 gitignore）。

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

### 👥 多使用者與權限（部署後才啟用）
- 使用者自行以 email + 密碼註冊，註冊頁有 Cloudflare Turnstile 真人驗證
- **註冊後需管理者核准才能使用**，未核准者連 session 都拿不到
- 兩種角色：**使用者**（只能用自己的排程）與**管理者**（另可管理帳號）
- 管理者可核准／拒絕／停用／刪除帳號、升降角色；**看不到任何人的排程內容**
- 停用或刪除帳號會立即讓對方所有裝置登出，不需等待其重新登入
- 密碼以 PBKDF2-SHA256（210,000 迭代）雜湊儲存，永不存明文

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
- 後端為 Cloudflare Worker + D1，自建 email/密碼認證，session 存於資料庫（僅存 token 雜湊）以便即時撤銷

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

詳細架構與資料模型請見 [`工作排程確認系統_專案說明.md`](./工作排程確認系統_專案說明.md)。

## 已知限制

| 限制 | 說明 |
|---|---|
| 單機模式的儲存範圍 | 未部署時資料只存在「這個瀏覽器」，不跨裝置；清除瀏覽器資料會一併清掉 |
| 同步粒度 | 雲端存的是整包狀態，衝突以整份為單位處理，不會逐項合併 |
| 假日判斷 | 僅自動判斷週六日，國定假日需手動加入自訂假日清單 |
| 甘特圖 | 長條不支援拖曳，日期透過表格輸入修改 |
| 變更循環頻率 | 每月 ↔ 每季互換時，各次的完成／覆寫／略過紀錄會重置（存檔時會事先警告） |
