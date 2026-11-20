# 讓 AI agent 連進來（MCP 伺服器）

日期：2026-11-20

## 使用者的裁決

> 能否幫這個系統加上 mcp，讓各家 agent 可以連進來，自己建立、讀取、調動後台數據？

| 問題 | 選擇 |
|---|---|
| 怎麼登入 | **兩種都做**：OAuth（Claude、ChatGPT 這類「加一個連接器」的介面會自己走完）＋個人 API 金鑰（給腳本與只吃 Bearer 的 agent） |
| 能不能直接改 | **可以直接改，但每一筆都留紀錄、可以一鍵復原** |
| 誰能用 | **只給 Pro** |

## 形狀

- 端點：`POST /mcp`，Streamable HTTP、**無狀態**（不發 session id、不開 SSE）。JSON-RPC 2.0：`initialize`、`ping`、`tools/list`、`tools/call`；通知回 202；GET 回 405；不收批次。
- 協定版本：`2025-06-18`、`2025-03-26`、`2024-11-05`。
- 程式在 `src/mcp/`：`schedule.js`（純函式：讀、寫、復原）、`auth.js`（金鑰、OAuth）、`server.js`（JSON-RPC 與工具）。

### 工具

| 讀 | 寫 |
|---|---|
| `get_overview`、`list_items`、`get_schedule`、`list_gantt_projects`、`list_recent_changes` | `create_item`、`update_item`、`set_done`、`delete_item`、`create_major_project`、`add_gantt_task`、`update_gantt_task`、`undo_change` |

## 不能拿掉的判斷

| 決定 | 理由 |
|---|---|
| **`get_schedule` 讀的是前端推上來的 `reminder_feed.digest`**，不在 Worker 展開循環 | occurrence 引擎只在 `index.html` 裡。同 ICS、提醒信、AI 小幫手：兩份必然分歧，而「agent 根據錯的日期做事」比沒有 agent 更糟。代價是使用者很久沒開 app 時排程是舊的——`get_overview` 回 `scheduleComputedAt` 讓 agent 看得到多舊 |
| **`get_schedule` 的完成狀態疊上當下的 state**（日期仍信 digest），digest 之後刪掉或略過的不列 | 上線後實測：agent 勾完再查，digest 還是舊的「沒完成」——它會以為沒勾到。dates 只能等前端重算，所以 digest 比資料舊時回一句 `note` |
| digest 每一筆多帶 `i`（item id）與 `o`（occKey） | 沒有這兩個，agent 看得到「哪天有什麼」卻勾不了它 |
| **伺服器建出來的項目要與前端 `normalizeItems` 的輸出逐欄相同** | 欄位集不一致時 `stableStringify` 比出差異，三方合併會把「沒改過」判成「兩邊都改過」，使用者下次打開就跳一個不存在的衝突。測試把伺服器建的項目丟進**真的**前端程式碼比對 |
| `normalizeRecurrence` 是前端那一份的移植，**測試逐案比對** | 同上 |
| 改循環頻率清掉 done/doneMap/doneAt/overrides/skipped/subDone | 同前端 `btnConfirmItem`：occKey 的格式跟頻率綁在一起 |
| 寫入是「讀 → 純函式 → 帶條件的 UPDATE，最多重試三次」 | 同〈樂觀鎖必須是單句 SQL〉。agent 與使用者自己的裝置會同時寫同一列 |
| **寫入也套免費版上限、每天 500 次、整份 1MB** | 伺服器本來就擋得住的東西，不能因為換一個入口就擋不住 |
| 每一筆寫入記 `mcp_activity`：**只記那一個東西的前後**，不記整份 | 復原只需要那一個；整份存起來是把所有人的排程複製到另一張表 |
| **復原只在「它現在還是 agent 改完的樣子」時才做** | 使用者之後自己又改過的話，復原會把他的修改蓋掉——那是在他沒看的時候改掉他填的東西。拒絕並說明「之後又被改過了」 |
| 前端 `cloudRefresh()`：回到前景（30 秒節流）與復原之後重新拉一次，版本變了就走三方合併 | agent 改的是雲端；不拉的話使用者開著的那個分頁下一次推送會撞 409 |
| 金鑰與 token **只存 sha256**；`wsk_`／`wsa_`／`wsr_` 前綴 | 同 session。前綴讓外洩掃描認得出來 |
| OAuth：PKCE S256 必填、只收 public client、redirect 只收 https 或 localhost、code 10 分鐘單次（帶條件的 UPDATE 搶） | MCP 規格的要求。redirect_uri 對不上時**不轉址**，直接 400——轉過去就是 open redirect |
| refresh 會**換一組新的**（舊的當場失效），access 1 小時、refresh 60 天，同一組共用 `grant_id`，撤銷以 grant 為單位 | 撤銷「Claude」要讓它手上的 access 與 refresh 一起失效 |
| **Pro 每一次 `tools/call` 都檢查**，不是只在發 token 時 | 訂閱到期之後，手上還有 60 天 refresh 的 agent 不該繼續改資料 |
| 免費帳號在授權頁看得到說明但按不了「允許」，伺服器也回 402 | 前端只是禮貌 |
| CORS `*` 只開在 `/mcp`、`/oauth/*`、`/.well-known/*`，**不開 credentials** | 那幾條只認 Bearer。主站的 cookie 不能被別的網站帶著打 |
| 刪帳號時一起刪 `mcp_tokens`、`oauth_codes`、`mcp_activity` | Apple 5.1.1(v)：刪掉就是全部刪掉 |

## 使用者要做的事

1. 合併之前跑 `migrations/015-mcp.sql`（四張新表，重跑安全）。
2. 在 agent 裡加一個連接器，網址是 `https://<你的網址>/mcp`。會跳到授權頁，按「允許」。
3. 不支援 OAuth 的 agent：「我的帳號 › 連接 AI agent」建一把金鑰，設成 `Authorization: Bearer wsk_…`。金鑰只顯示一次。

## 驗證

- `tests/mcp.test.mjs`（22 條）。突變驗證九種改法各自會紅：拿掉 Pro 檢查、拿掉 PKCE、code 可重用、open redirect、復原蓋掉使用者的修改、不重試競態、撤銷不連坐 grant、項目形狀走鐘、OAuth 核准不查 Pro。
- `tools/smoke.mjs`：Pro 那一輪看得到網址、連線清單、復原鈕；免費那一輪看不到設定、只看到說明。
