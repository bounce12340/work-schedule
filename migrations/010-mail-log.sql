-- 寄信記錄（見 schema.sql 的 mail_log）。
--
-- 這一支是**新增資料表**，不是新增欄位，所以嚴格說起來重跑 db:init 也會建。
-- 留一支單獨的 SQL 是為了讓「既有的資料庫要做什麼」在 migrations/ 裡看得完整，
-- 不必去比對 schema.sql 的哪幾行是新的。
--
-- 部署順序：**先跑這一支，再部署 Worker。** 新的 sendMail 會寫這張表；
-- 表不在的話每一次寄信都會多一行 console.warn（信照樣寄得出去，因為寫記錄
-- 失敗刻意不讓已經成功的操作變成錯誤），但那正好是這張表要消滅的那種沉默。
CREATE TABLE IF NOT EXISTS mail_log (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  to_email   TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mail_log_time ON mail_log(created_at);
