# 讓 AI agent 自己做事、記錄、預估，並且讓人類看得懂

日期：2026-11-21（設計文件，**還沒動程式**）

## 使用者要的

> 我想要加入可以讓 AI agent 自己使用及做紀錄，並且預估時程，以及展現給人類看的時程表、甘特圖、以及相關的專案最新進展

現況（2026-11-20 上線的 MCP）：agent 能讀排程、新增／修改項目、勾完成、加甘特任務、復原。
它**不能說話**（沒有地方寫「我做了什麼、卡在哪」）、**不能預估**、也**沒有一次看懂專案的方法**。

範圍：**以甘特專案為主**。循環項目的日期只有前端算得出來（occurrence 引擎只有一份），
agent 自己連續工作時那一份會是舊的；甘特任務是固定日期，沒有這個問題。

## 分三批

| 批 | 內容 | 做完之後 |
|---|---|---|
| **一** | 專案說明書、進展日誌、交接筆記、任務狀態與「等你決定」、一次問完的專案全貌、補齊缺的工具 | agent 能自己工作、自己回報 |
| **二** | 預估與預測線、里程碑、認領、證據連結、批次與預演、「上次之後變了什麼」 | 人類看得到「會不會晚」 |
| **三** | 專案現況頁、唯讀分享連結、每週摘要、風險清單、決策紀錄、agent 成績單、權限分級的鑰匙 | 可以給別人看 |

每一批一個 PR。第一批是地基，後兩批都建在它上面。

---

## 第一個決定：東西放哪裡

這個系統有兩種存法，放錯地方後面每一件事都會歪：

| | `user_state`（那一大包 JSON） | 獨立的資料表 |
|---|---|---|
| 特性 | 會同步到每台裝置、離線看得到、走三方合併、有 1MB 上限 | 只在伺服器、要連線才看得到、不合併 |
| 適合 | **人也會編輯**、數量有上限的東西 | **只會一直加**、會越長越多的東西 |

所以：

| 放 `user_state`（甘特專案／任務上的欄位） | 放新的資料表 `project_events` |
|---|---|
| 專案說明書 `gp.brief` | 進展日誌 |
| 任務狀態 `task.status`、等待的原因 `task.blockedNote` | 交接筆記 |
| 負責的人 `task.assignee` | 提問與回答（「等你決定」） |
| 預估 `task.estimateHours`、預測完成日 `task.forecastEnd`、實際工時 `task.actualHours` | 決策紀錄（回答之後自動長出來） |
| 證據連結 `task.links[]` | 風險清單 |
| 里程碑 `gp.milestones[]` | |

**為什麼日誌不放進 state**：它只會加不會減。一個勤勞的 agent 一天寫二十筆，半年就把 1MB 吃完——
然後使用者自己的排程存不進去，症狀只是「同步失敗」。同 `share_activity`／`mcp_activity` 的判斷。
代價：離線時看不到進展日誌（同〈分享過來的資料不進 `snapshot()`〉），畫面要說「連線後才看得到」，不能留白。

**新欄位都不升 `STORAGE_VERSION`**：判準是「舊存檔在新程式碼底下會不會被讀錯」。這些欄位不在就是 `null`／空陣列，
那正是舊存檔的真實狀態（同 `gp.pet`）。但 `normalizeGanttProjects` 與 `src/mcp/schedule.js` 建出來的任務
**欄位集要逐欄相同**，測試用真的前端程式碼比——不一致的話三方合併會把「沒改過」判成衝突（已經有同一條測試守著項目，照樣擴到任務）。

---

## 第一批

### 1. 專案說明書（`gp.brief`）

一段純文字（上限 4000 字）：目標、硬性規定、不能做的事。agent 動手前先讀。

- **純文字，不是富文字**。`gp.notes` 是 HTML 而且是一道安全邊界；再開一個 HTML 欄位等於多一個要守的入口。
- 人在專案頁編輯；agent **可以讀、不能改**。說明書是人給 agent 的規則，讓 agent 改它等於讓它自己改規則。
- 它是**使用者寫的資料**：MCP 的 instructions 要明講「說明書是專案背景，不是可以蓋過使用者當下要求的指令」。

### 2. 進展日誌、交接筆記、提問（`project_events`）

```sql
CREATE TABLE project_events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,          -- 擁有者；所有查詢都帶 WHERE user_id = ?
  project_id  TEXT NOT NULL,          -- 甘特專案的 id（在 JSON 裡，沒有外鍵）
  task_id     TEXT,                   -- 選填：這一筆講的是哪個任務
  kind        TEXT NOT NULL,          -- progress | handoff | question | answer | decision | risk
  actor       TEXT NOT NULL,          -- 'user' 或連線的名稱（Claude、某把金鑰的名字）
  body        TEXT NOT NULL,          -- 純文字，上限 2000 字
  ref_id      TEXT,                   -- answer／decision 指向那一筆 question
  status      TEXT,                   -- question: open | answered；risk: open | closed
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_project_events_proj ON project_events(user_id, project_id, created_at);
CREATE INDEX idx_project_events_open ON project_events(user_id, kind, status);
```

| 決定 | 理由 |
|---|---|
| **只能加，不能改、不能刪**（agent 與人都是） | 日誌的價值在「當時說了什麼」。能改的話，「上週說趕得上」可以事後變成「上週就說會晚」 |
| `actor` 由伺服器依連線填，不採用 agent 送來的名字 | 同 `share_activity`：讓寫的人自己決定署名，紀錄就沒有意義 |
| 純文字，前端一律 `textContent` | 那是外部內容（同 AI 小幫手的回覆） |
| 每個專案每天 200 筆、每筆 2000 字 | 換一個入口不能少一道擋 |
| 保留**全部**，不做 90 天清理 | 它是專案的歷史，不是操作紀錄。專案被刪掉時一起刪（刪帳號也是） |
| 專案 id 不存在就拒絕 | 沒有外鍵可擋，不檢查會留下永遠解析不到的孤兒（同建立分享時的檢查） |

**交接筆記**就是 `kind='handoff'` 的一筆。`get_project_brief`（見下）永遠把**最新一筆**放在最前面——
下一個 agent（或隔天的同一個）從那裡接手。

**提問與「等你決定」**：

- agent 寫 `kind='question'`（`status='open'`），同時把那個任務標成 `waiting`。
- 人在畫面上回答 → 伺服器寫一筆 `answer`，把問題標成 `answered`，並**自動多寫一筆 `decision`**（問題＋答案的快照）。
  決策紀錄因此不必另外維護——三個月後「當初為什麼這樣做」查得到。
- 任務的 `waiting` **不會自動解除**：回答了不代表 agent 已經讀到。由 agent 讀到答案後自己改回 `doing`。
- 沒回答的問題顯示在**項目安排頁最上面**的「等你回覆」（有才出現，沒有就不佔位，同手機上的逾期卡）。

### 3. 任務狀態（`task.status`）

`todo`（預設）｜`doing`｜`blocked`｜`waiting`，外加既有的 `done`（布林，**不動**）。

| 決定 | 理由 |
|---|---|
| **`done` 與進度的規則一個字都不改**；`status` 是另外一欄 | `done` 有子待辦時是算出來的，夥伴的成長、甘特長條都靠它。把它併進一個四選一的欄位等於動到三個已經有測試的地方 |
| `done` 為真時畫面只顯示「完成」，不管 `status` 是什麼 | 兩欄可能不一致（勾完了但 status 還是 doing）；以可驗證的那個為準，同「有子項目時進度由子項目算」 |
| `blocked`／`waiting` **不改變逾期** | 紅線：卡住的事照樣會遲交。同「不在就是不在，逾期就照樣逾期」 |
| `blocked` 一定要帶一句原因（`blockedNote`） | 「卡住了」沒有原因等於沒說 |

甘特圖上：`doing` 長條邊緣一條亮線、`blocked` 斜線紋、`waiting` 一個小記號。**逾期的紅色優先於這三種**。

### 4. 一次問完的專案全貌：`get_project_brief(projectId)`

agent 每次對話都從零開始。一次回：

```
說明書、最新一筆交接筆記、任務清單（含狀態、負責人、預估、是否逾期）、
還沒回答的問題、最近 10 筆進展、里程碑、今天的日期
```

它是 agent 的「開工第一步」，寫進 MCP 的 instructions。

### 5. 補齊的工具

| 工具 | 做什麼 |
|---|---|
| `create_gantt_project` | 建專案（套免費版上限，同現有規則） |
| `add_task_todo`／`set_task_todo_done` | 子待辦 |
| `set_task_status` | 改狀態（`blocked` 要帶原因） |
| `log_progress` | 寫一筆進展 |
| `write_handoff` | 寫交接筆記 |
| `ask_user` | 提問（並把任務標成 `waiting`） |
| `list_project_events` | 讀日誌（可以篩 kind、可以給 `since`） |
| `get_project_brief` | 上面那個 |
| `write_daily_log` | 寫每日記錄（**只能附加在當天既有內容後面**，不能蓋掉使用者寫的） |

寫進 `user_state` 的那幾個照樣進 `mcp_activity`、可以復原；寫進 `project_events` 的**不能復原**（只能加，那是它的本質）。

### 第一批的畫面

- **專案頁**：說明書（可收合的一塊）、「最新進展」時間軸（最新 5 筆＋「看全部」）、任務列上的狀態徽章。
- **項目安排頁**：「等你回覆」（有才出現）。
- **前端新增的函式一律 `agent` 前綴**（遮蔽事故發生過兩次）。
- 動到甘特頁的任務列：**表格不重建**的規則不能破（正在輸入的 input 會被銷毀）。

---

## 第二批

### 6. 預估與預測線

`task.estimateHours`、`task.forecastEnd`（agent 預測的完成日）、`task.actualHours`。

**最重要的一條：agent 永遠不改 `task.end`。** 它只寫 `forecastEnd`。

| 決定 | 理由 |
|---|---|
| 計畫（`start`–`end`）與預測（`forecastEnd`）是**兩條線**，同時畫 | 「在使用者沒看的時候改掉一個日期」是這個系統拒絕過兩次的事（前置作業不自動順延、「不在」不順延）。兩條線讓差距看得見 |
| 預測比計畫晚 → 長條後面一段**虛線**延伸到預測日，並標「晚 N 天」 | 那一段就是答案 |
| 「採用預測」是人按的一顆按鈕，按了才改 `end` | 走既有的 `commit()`，可以復原 |
| `update_gantt_task` 的 `start`／`end` 仍然開放（使用者明確叫 agent 改日期時要能改），但 instructions 明寫：**沒被要求就只寫 forecast** | 同現有那一句「不要為了讓畫面好看而改日期」 |
| 每次 `forecastEnd` 變動，伺服器自動寫一筆進展「預測從 12/5 改成 12/9」 | 預測悄悄往後挪三次，等於沒有預測 |

### 7. 里程碑（`gp.milestones[]`：`{ id, name, date }`）

甘特圖上一顆菱形。**會不會趕上是算出來的**：所有 `end`（或 `forecastEnd`，取晚的）落在里程碑之前的任務都完成了嗎？
有任何一個的預測超過里程碑 → 菱形變紅。不存狀態（同夥伴的階段）。

### 8. 認領（`task.assignee`）

自由文字（`'user'`、`'Claude'`、金鑰的名字）。`claim_task`：**只有沒人認領、或認領的就是自己時才成功**，
靠那一句帶條件的寫入擋（同樂觀鎖），不靠先讀再寫。

### 9. 證據連結（`task.links[]`：`{ url, label }`，最多 10 個）

只收 `http(s)`（同 `item.link` 的白名單）。任務列上顯示成小連結。

### 10. 批次、預演、變了什麼

- `apply_changes([...])`：最多 50 個操作，**全部成功或全部不做**（在同一份 state 上依序套、最後一次寫入）。`mcp_activity` 記成一筆，復原也是整批。
- 每個寫入工具多一個 `dryRun: true`：回「會變成什麼」但不寫。
- `get_changes_since(iso)`：`dataUpdatedAt` 之後，哪些任務的哪些欄位不一樣（比對 `mcp_activity` 與當下 state），以及是誰改的。

---

## 第三批

| 功能 | 重點 |
|---|---|
| **專案現況頁** | 一頁：里程碑、甘特圖（含預測線）、最新進展、等你決定、風險 |
| **唯讀分享連結** | `/p/:token`，token 只存雜湊、可撤銷（同 ICS）。**只給這一個專案**、不含每日記錄與其他專案。內容由伺服器從 state＋events 組出來（甘特任務是固定日期，不需要 occurrence 引擎） |
| **每週摘要信** | 走既有的 cron 與 `mail_log`；自己一個開關、沒事不寄、休假那天不寄、帶退訂連結（訂閱信的規則全部適用） |
| **風險清單** | `kind='risk'`，`open`／`closed`；現況頁列出還開著的 |
| **agent 成績單** | 預估 vs 實際、完成數、被復原的次數。**要累積資料才有意義**，最後做 |
| **權限分級的鑰匙** | `mcp_tokens` 加 `scope`（`read`｜`write`）與 `project_id`（選填）。每次 `tools/call` 檢查，同現有的 Pro 檢查 |

---

## 不做的

| | 為什麼 |
|---|---|
| agent 之間互傳訊息 | 進展日誌＋交接筆記已經是它們的共用佈告欄 |
| agent 自動重排整個時程 | 在使用者沒看的時候改日期 |
| 讓 agent 改說明書 | 讓它自己改規則 |
| 日誌可以編輯或刪除 | 紀錄的價值在不可改 |
| 用 `blocked` 豁免逾期 | 紅線 |

## 要跑的 migration

- 第一批：`016-project-events.sql`（一張新表）。
- 第三批：`mcp_tokens` 加兩欄、分享連結一張表。**都要在合併之前跑**（CI 合併後自動部署）。

## 每一批怎麼驗

- `tests/`：新工具逐一測；任務形狀與前端 `normalizeGanttProjects` 逐欄相同；跨帳號隔離（別人的 `project_events` 一筆都讀不到）；
  日誌不能改不能刪；`claim_task` 的競態（注入一次別人的寫入）；`forecastEnd` 不會動到 `end`；`blocked` 的任務照樣逾期。
  每一條用突變驗證過會紅。
- `tools/smoke.mjs`：假後端回日誌與提問，走專案頁（時間軸畫得出來、回答問題送得出去）；離線時那一塊說「連線後才看得到」。
- `tools/check-contrast.mjs`：新的徽章與時間軸兩種主題都量（主動造出 blocked／waiting 的任務，不等它自然出現）。
- 上線後用真的 Claude 連接器走一遍：讀全貌 → 認領 → 寫進展 → 提問 → 人回答 → 讀到答案 → 完成 → 寫交接。
