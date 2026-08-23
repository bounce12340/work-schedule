-- 既有資料庫用。schema.sql 的 CREATE TABLE IF NOT EXISTS 不會替已經存在的表加欄位。
--
--   npx wrangler d1 execute work-schedule-db --remote --file=./migrations/002-session-device.sql
--
-- SQLite 沒有 ADD COLUMN IF NOT EXISTS，重跑會報 "duplicate column name"——
-- 那個錯誤是安全的，代表已經加過了。
--
-- 兩個欄位都允許 NULL：加欄位之前就存在的 session 會是 NULL，前端顯示為
-- 「未知裝置」。不設 NOT NULL DEFAULT 是刻意的——那會讓所有舊 session 假裝
-- 自己「剛剛才被使用過」，而那是不實的資訊。
ALTER TABLE sessions ADD COLUMN user_agent   TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
