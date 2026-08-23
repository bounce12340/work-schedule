-- 既有資料庫用。schema.sql 的 CREATE TABLE IF NOT EXISTS 不會替已經存在的表加欄位，
-- 所以新增欄位必須單獨跑一次。SQLite 沒有 ADD COLUMN IF NOT EXISTS，重跑會報
-- "duplicate column name: lead_days"——那個錯誤是安全的，代表已經加過了。
--
--   npx wrangler d1 execute work-schedule-db --remote --file=./migrations/001-lead-days.sql
ALTER TABLE reminder_feed ADD COLUMN lead_days INTEGER NOT NULL DEFAULT 3;
