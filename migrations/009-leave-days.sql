-- 休假那幾天閉嘴（七項改動的 C-3，見 docs/superpowers/specs/2026-09-17-seven-changes-design.md〈C-5〉）。
-- 執行（部署新 Worker **之前**）：
--   npx wrangler d1 execute work-schedule-db --remote --file=./migrations/009-leave-days.sql
-- 欄位不在的話，sendOverdueReminders／sendStreakBroken／sendPushes 的 SELECT 會直接失敗，
-- 而那三件事都在 cron 裡——症狀是「今天的信與推播整批沒出去」。順序不能反。
-- SQLite 沒有 ADD COLUMN IF NOT EXISTS：重跑會報 duplicate column name，那是安全的，代表已經加過。
ALTER TABLE reminder_feed ADD COLUMN leave_days TEXT NOT NULL DEFAULT '[]';
