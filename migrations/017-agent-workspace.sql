-- agent 工作區（第一批）：進展日誌／提問、連線設定、提案、專案消失追蹤。
-- 設計文件：docs/superpowers/specs/2026-11-21-agent-workspace.md
-- 執行（**合併 PR 之前**，見 CLAUDE.md〈「部署之前」＝「合併之前」〉）：
--   npx wrangler d1 execute work-schedule-db --remote --file=./migrations/017-agent-workspace.sql
--
-- 哪幾句漏跑會壞：
--   * `ALTER TABLE mcp_activity ADD COLUMN conn_id` 是**加欄位**：漏跑的話新程式碼寫
--     mcp_activity 的 INSERT 直接失敗，**每一個 agent 的寫入工具都會 500／工具錯誤**。
--     SQLite 沒有 ADD COLUMN IF NOT EXISTS，重跑會報 `duplicate column name`——那個錯誤是安全的，
--     代表已經加過了（那一句之後的 CREATE 都是 IF NOT EXISTS，可以單獨再跑）。
--   * `mcp_connections` 漏跑：每一條連線都被當成「查不到設定 → 暫停」，**所有 agent 寫不進去**。
--     下面的回填（INSERT OR IGNORE ... SELECT）把既有的每一條連線補成 direct 模式，
--     否則上線那一刻所有現存的 agent 連線都會被暫停。
--   * 其餘兩張是新增資料表：漏跑只讓用到它的工具／端點失敗，其他照常。

ALTER TABLE mcp_activity ADD COLUMN conn_id TEXT;
CREATE INDEX IF NOT EXISTS idx_mcp_activity_conn ON mcp_activity(conn_id, undone_at);

-- 進展日誌、交接筆記、提問與回答、決策、風險。只能加不能改不能刪（owner 只能「遮蔽」：body 清空）。
CREATE TABLE IF NOT EXISTS project_events (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,        -- 擁有者；所有查詢都帶 WHERE user_id = ?
  project_id    TEXT NOT NULL,        -- 甘特專案的 id（在 JSON 裡，沒有外鍵）
  task_id       TEXT,
  kind          TEXT NOT NULL,        -- progress | handoff | question | answer | decision | risk | withdraw
  actor         TEXT NOT NULL,        -- 'user' 或連線的名稱（由伺服器填）
  body          TEXT NOT NULL,        -- 純文字，agent 寫的上限 2000 字
  ref_id        TEXT,                 -- answer／decision／withdraw 指向那一筆 question
  status        TEXT,                 -- question: open | answered | withdrawn；risk: open | closed
  options       TEXT,                 -- question 的選項（JSON 陣列，2～4 個）
  default_after TEXT,                 -- question 的期限 YYYY-MM-DD
  redacted_at   INTEGER,              -- 擁有者遮蔽的時間；有值代表 body 已清空
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_events_proj ON project_events(user_id, project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_project_events_open ON project_events(user_id, kind, status);

-- 專案從 state 裡消失的時間：日誌留 30 天才清（刪除有復原、三方合併可能救回來）。
-- 每日 cron 維護：專案在 state 裡 → 刪掉這一列；不在 → 補一列（只補不覆蓋）。
CREATE TABLE IF NOT EXISTS project_absent (
  user_id       TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  missing_since INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id)
);

-- 連線的設定放在「連線」上，不是放在 token 那一列：OAuth 每次更新 token 都是刪舊插新，
-- 放在 token 上設定會每小時自己消失。id＝OAuth 的 grant_id（輪替時不變），或個人金鑰那一列的 id。
CREATE TABLE IF NOT EXISTS mcp_connections (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  mode              TEXT NOT NULL DEFAULT 'direct',   -- direct | review
  paused            INTEGER NOT NULL DEFAULT 0,
  needs_acceptance  INTEGER NOT NULL DEFAULT 0,
  paused_reason     TEXT,                              -- owner | auto
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_connections_user ON mcp_connections(user_id);

-- 回填：既有的每一條連線補一列 direct（維持現狀）。查不到設定列的連線會被當成暫停，
-- 不回填的話上線那一刻所有現存連線都寫不進去。
INSERT OR IGNORE INTO mcp_connections (id, user_id, mode, paused, needs_acceptance, created_at, updated_at)
SELECT COALESCE(grant_id, id), user_id, 'direct', 0, 0, MIN(created_at), CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM mcp_tokens
 GROUP BY COALESCE(grant_id, id), user_id;

-- 修改要先審核（提案）：存的是「要做什麼」（tool＋args），同意時在當下的資料上重新套。
CREATE TABLE IF NOT EXISTS mcp_proposals (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  conn_id     TEXT,
  actor       TEXT NOT NULL,
  title       TEXT NOT NULL,
  ops         TEXT NOT NULL,          -- JSON：[{ tool, args }]
  status      TEXT NOT NULL,          -- open | approved | rejected | withdrawn | stale
  note        TEXT,                   -- 退回的理由，或 stale 時說出哪一個操作套不上去
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mcp_proposals_user ON mcp_proposals(user_id, status);
