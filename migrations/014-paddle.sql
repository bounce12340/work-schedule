-- 網頁版訂閱（Paddle）：見 docs/superpowers/specs/2026-11-14-web-subscription-paddle.md。
-- 執行（**合併 PR 之前**，見 CLAUDE.md〈「部署之前」＝「合併之前」〉）：
--   npx wrangler d1 execute work-schedule-db --remote --file=./migrations/014-paddle.sql
-- SQLite 沒有 ADD COLUMN IF NOT EXISTS：重跑會報 duplicate column name，那是安全的，代表已經加過。
ALTER TABLE users ADD COLUMN paddle_subscription_id TEXT;
ALTER TABLE users ADD COLUMN paddle_customer_id     TEXT;
ALTER TABLE users ADD COLUMN paddle_event_at        INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_paddle_subscription ON users(paddle_subscription_id);
