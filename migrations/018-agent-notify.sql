-- agent 問了問題／提了提案，要通知到人（第一批 1B，設計文件 5-2）。
-- 設計文件：docs/superpowers/specs/2026-11-21-agent-workspace.md
-- 執行（**合併 PR 之前**，見 CLAUDE.md〈「部署之前」＝「合併之前」〉）：
--   npx wrangler d1 execute work-schedule-db --remote --file=./migrations/018-agent-notify.sql
--
-- 哪幾句漏跑會壞：
--   * `ALTER TABLE reminder_feed ADD COLUMN agent_notify` 是**加欄位**：漏跑的話
--     `GET /api/reminder`、`POST /api/reminder`、逾期提醒的 cron 讀的 SELECT 與 agent 通知
--     全部會失敗——「我的帳號」的通知區整個讀不出來。SQLite 沒有 ADD COLUMN IF NOT EXISTS，
--     重跑會報 `duplicate column name`——那個錯誤是安全的，代表已經加過了
--     （下面的 CREATE 都是 IF NOT EXISTS，可以單獨再跑）。
--   * `agent_notify_state` 是新增資料表：漏跑只讓 agent 通知那一條路失敗（工具本身照常，
--     失敗只 console.warn，不會讓 agent 的提問變成錯誤）。

-- 第六顆通知開關：「agent 問我問題時通知我」。與另外五顆（兩封信、三種推播）互不連坐，預設開。
-- 沒有 reminder_feed 那一列的人也是「開」（同 streak_mail 的處理）。
ALTER TABLE reminder_feed ADD COLUMN agent_notify INTEGER NOT NULL DEFAULT 1;

-- 每個專案的通知節流：同一個專案 30 分鐘內最多一封，多的併進 pending，
-- 之後由下一次提問或每日 cron 合併成「還有 N 件」。
-- last_sent_at 只在**送成功**時寫（沒送成功就不算送過）；project_id 為 '' 代表不屬於任何專案的提案。
CREATE TABLE IF NOT EXISTS agent_notify_state (
  user_id      TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  last_sent_at INTEGER,
  pending      INTEGER NOT NULL DEFAULT 0,
  actor        TEXT,                  -- 最近一次提問的連線名稱（cron 合併成「還有 N 件」時要署名）
  PRIMARY KEY (user_id, project_id)
);
