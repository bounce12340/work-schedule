-- 推播（子專案 B）：見 docs/superpowers/specs/2026-09-17-push-design.md 與 schema.sql 內的說明。
-- 執行（部署新 Worker **之前**）：
--   npx wrangler d1 execute work-schedule-db --remote --file=./migrations/008-push.sql
-- SQLite 沒有 ADD COLUMN IF NOT EXISTS：重跑會報 duplicate column name，那是安全的，代表已經加過。
CREATE TABLE IF NOT EXISTS device_tokens (
  token        TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  environment  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);

ALTER TABLE reminder_feed ADD COLUMN push_overdue     INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reminder_feed ADD COLUMN push_streak      INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reminder_feed ADD COLUMN push_today       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reminder_feed ADD COLUMN push_overdue_ymd TEXT;
ALTER TABLE reminder_feed ADD COLUMN push_streak_ymd  TEXT;
ALTER TABLE reminder_feed ADD COLUMN push_today_ymd   TEXT;
