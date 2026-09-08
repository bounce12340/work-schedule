-- 每日 cron 的執行記錄（見 schema.sql 內的說明）。
--
-- 新增「資料表」其實不需要 migration——db:init 重跑 schema.sql 就會建，
-- 因為那份檔案全部是 CREATE TABLE IF NOT EXISTS。這裡仍然留一支，是為了讓
-- 「這次上線改了資料庫的什麼」在 migrations/ 底下看得到一份完整的時間序，
-- 不必去 diff schema.sql 才知道。
--
-- 執行：
--   npx wrangler d1 execute work-schedule-db --remote --file=./migrations/003-cron-runs.sql
CREATE TABLE IF NOT EXISTS cron_runs (
  id         TEXT PRIMARY KEY,
  step       TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  detail     TEXT,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_time ON cron_runs(started_at);
