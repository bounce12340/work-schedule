-- MCP（讓 AI agent 連進來讀寫排程）：見 docs/superpowers/specs/2026-11-20-mcp-server.md。
-- 執行（**合併 PR 之前**，見 CLAUDE.md〈「部署之前」＝「合併之前」〉）：
--   npx wrangler d1 execute work-schedule-db --remote --file=./migrations/015-mcp.sql
-- 全部是新增資料表，重跑安全（IF NOT EXISTS）。
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  name         TEXT,
  client_id    TEXT,
  grant_id     TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user ON mcp_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_grant ON mcp_tokens(grant_id);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at     INTEGER NOT NULL,
  used_at        INTEGER,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_activity (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  actor       TEXT NOT NULL,
  tool        TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  summary     TEXT NOT NULL,
  before      TEXT,
  after       TEXT,
  created_at  INTEGER NOT NULL,
  undone_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mcp_activity_user ON mcp_activity(user_id, created_at);
