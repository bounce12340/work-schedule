-- MCP 寫入防重複：見 docs/superpowers/specs/2026-11-21-agent-workspace.md 第零批 0-2。
-- 執行（**合併 PR 之前**，見 CLAUDE.md〈「部署之前」＝「合併之前」〉）：
--   npx wrangler d1 execute work-schedule-db --remote --file=./migrations/016-mcp-requests.sql
-- 新增資料表，重跑安全（IF NOT EXISTS）。**漏跑會讓帶 requestId 的寫入工具失敗**
-- （不帶 requestId 的照常）——所以仍然要在合併之前跑。
CREATE TABLE IF NOT EXISTS mcp_requests (
  user_id     TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  fingerprint TEXT NOT NULL,     -- 工具名與參數（不含 requestId）的雜湊：同一個 id 拿去做別的事要擋
  result      TEXT,              -- 第一次的結果（JSON）；NULL＝還在處理中
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, request_id)
);
