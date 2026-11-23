-- agent 工作區（第三批 3A）：版本歷史、權限分級的鑰匙、唯讀分享連結、每週摘要信。
-- 設計文件：docs/superpowers/specs/2026-11-21-agent-workspace.md（第三批、甲 2、第 21 件）
-- 執行（**合併 PR 之前**，見 CLAUDE.md〈「部署之前」＝「合併之前」〉）：
--   npx wrangler d1 execute work-schedule-db --remote --file=./migrations/020-history-scope-share.sql
--
-- 哪幾句漏跑會壞（**六句 ALTER，全部是加欄位**）：
--   * `mcp_tokens` 的 `scope`／`project_id`：authenticateMcp 的 SELECT 讀它們，**漏跑的話每一個 MCP 呼叫都失敗**
--     （金鑰與 OAuth 連線都連不進來）。
--   * `oauth_codes` 的 `scope`／`project_id`：授權頁按「允許」的 INSERT 寫它們，漏跑的話 **OAuth 授權整個失敗**。
--   * `reminder_feed` 的 `weekly_mail`／`weekly_mail_week`：`GET/POST /api/reminder` 與每週摘要的 SELECT 讀它們，
--     **漏跑的話「我的帳號」的通知區整個讀不出來**（同 018 的 agent_notify）。
--   * `state_versions`、`project_shares` 是新增資料表：漏跑只讓版本歷史與分享連結那幾條路失敗，其他照常。
--     （版本留存失敗只 console.warn，不會讓任何寫入變成錯誤。）
--
-- SQLite 沒有 ADD COLUMN IF NOT EXISTS，重跑會報 `duplicate column name`——那個錯誤是安全的，
-- 代表那一句已經加過了（下面的 CREATE 都是 IF NOT EXISTS，可以單獨再跑）。
-- 既有的金鑰與 OAuth 連線：scope 預設 'write'、project_id 為空＝行為與以前完全相同。

ALTER TABLE mcp_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'write';
ALTER TABLE mcp_tokens ADD COLUMN project_id TEXT;
ALTER TABLE oauth_codes ADD COLUMN scope TEXT NOT NULL DEFAULT 'write';
ALTER TABLE oauth_codes ADD COLUMN project_id TEXT;
ALTER TABLE reminder_feed ADD COLUMN weekly_mail INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reminder_feed ADD COLUMN weekly_mail_week TEXT;

CREATE TABLE IF NOT EXISTS state_versions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  actor      TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  bytes      INTEGER NOT NULL,
  sha        TEXT
);
CREATE INDEX IF NOT EXISTS idx_state_versions_user ON state_versions(user_id, created_at);

CREATE TABLE IF NOT EXISTS project_shares (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  include_json TEXT NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_project_shares_project ON project_shares(user_id, project_id);
