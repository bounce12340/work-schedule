-- 連續斷掉時由角色寄信（子專案 F2，見 docs/superpowers/specs/2026-09-16-gamification-design.md）。
-- 執行（部署新 Worker **之前**）：
--   npx wrangler d1 execute work-schedule-db --remote --file=./migrations/007-streak-mail.sql
-- SQLite 沒有 ADD COLUMN IF NOT EXISTS：重跑會報 duplicate column name，那是安全的，代表已經加過。
ALTER TABLE reminder_feed ADD COLUMN streak_mail     INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reminder_feed ADD COLUMN streak_mail_ymd TEXT;
ALTER TABLE reminder_feed ADD COLUMN streak_current  INTEGER NOT NULL DEFAULT 0;
