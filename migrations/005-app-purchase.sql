-- iOS app 付費下載的購買證明與 email 驗證碼（見 schema.sql 內的說明）。
-- 執行：
--   npx wrangler d1 execute work-schedule-db --remote --file=./migrations/005-app-purchase.sql
-- SQLite 沒有 ADD COLUMN IF NOT EXISTS：重跑會報 duplicate column name，那是安全的，代表已經加過。
ALTER TABLE users ADD COLUMN purchase_source    TEXT;
ALTER TABLE users ADD COLUMN app_transaction_id TEXT;
ALTER TABLE users ADD COLUMN purchased_at       INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_app_transaction ON users(app_transaction_id);

CREATE TABLE IF NOT EXISTS email_codes (
  email      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
