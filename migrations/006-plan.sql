-- 方案（免費／Pro）：見 docs/superpowers/specs/2026-09-16-subscription-design.md 與 schema.sql 內的說明。
-- 執行（部署新 Worker **之前**）：
--   npx wrangler d1 execute work-schedule-db --remote --file=./migrations/006-plan.sql
-- SQLite 沒有 ADD COLUMN IF NOT EXISTS：重跑會報 duplicate column name，那是安全的，代表已經加過。
ALTER TABLE users ADD COLUMN plan_source        TEXT;
ALTER TABLE users ADD COLUMN plan_expires_at    INTEGER;
ALTER TABLE users ADD COLUMN apple_original_txn TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_original_txn ON users(apple_original_txn);

CREATE TABLE IF NOT EXISTS plan_events (
  id                TEXT PRIMARY KEY,
  user_id           TEXT,
  source            TEXT NOT NULL,
  kind              TEXT NOT NULL,
  original_txn      TEXT,
  notification_uuid TEXT UNIQUE,
  expires_at        INTEGER,
  detail            TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_events_user ON plan_events(user_id, created_at);
