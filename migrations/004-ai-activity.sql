-- AI 小幫手的呼叫記錄（見 schema.sql 內的說明）。
-- 執行：
--   npx wrangler d1 execute work-schedule-db --remote --file=./migrations/004-ai-activity.sql
CREATE TABLE IF NOT EXISTS ai_activity (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  kind              TEXT NOT NULL,
  ok                INTEGER NOT NULL,
  detail            TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_activity_user ON ai_activity(user_id, created_at);
