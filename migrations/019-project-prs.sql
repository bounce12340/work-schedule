-- agent 工作區（第二批 2A）：批次復原、任務連到 GitHub 的 PR、GitHub webhook。
-- 設計文件：docs/superpowers/specs/2026-11-21-agent-workspace.md（第 10 項、乙 1、乙 2）
-- 執行（**合併 PR 之前**，見 CLAUDE.md〈「部署之前」＝「合併之前」〉）：
--   npx wrangler d1 execute work-schedule-db --remote --file=./migrations/019-project-prs.sql
--
-- 哪幾句漏跑會壞：
--   * `ALTER TABLE mcp_activity ADD COLUMN batch_id` 是**加欄位**：漏跑的話新程式碼寫
--     mcp_activity 的 INSERT 直接失敗，**每一個 agent 的寫入工具都會失敗**（同 017 的 conn_id）。
--     只有這一句是加欄位。SQLite 沒有 ADD COLUMN IF NOT EXISTS，重跑會報 `duplicate column name`——
--     那個錯誤是安全的，代表已經加過了（下面的 CREATE 都是 IF NOT EXISTS，可以單獨再跑）。
--   * `project_prs`、`github_hooks` 是新增資料表：漏跑只讓 PR 相關的工具／端點失敗，其他照常。
--
-- 這兩張表**刻意不進每日備份**（見 handlers/backup.js）：project_prs 是 GitHub 資料的快取（webhook 與
-- agent 會再送一次）；github_hooks 帶著 webhook 的簽章密鑰，備份檔不該多一份憑證。

ALTER TABLE mcp_activity ADD COLUMN batch_id TEXT;
CREATE INDEX IF NOT EXISTS idx_mcp_activity_batch ON mcp_activity(user_id, batch_id);

-- 任務（或只是專案）連到的 GitHub PR。放獨立的表而不是 user_state：webhook 是伺服器自己收到的，
-- 沒有前端在場可以合併；而且它是別人家的資料的快取。
CREATE TABLE IF NOT EXISTS project_prs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,          -- 擁有者；所有查詢都帶 WHERE user_id = ?
  project_id  TEXT NOT NULL,
  task_id     TEXT,                   -- 可以不綁任務，只掛在專案上
  repo        TEXT NOT NULL,          -- owner/name（小寫）
  number      INTEGER,                -- PR 編號；只綁分支時為 NULL
  branch      TEXT,
  title       TEXT,                   -- 外部內容：去換行、截 200 字
  state       TEXT,                   -- draft | open | merged | closed
  checks      TEXT,                   -- passing | failing | pending | none
  review      TEXT,                   -- approved | changes_requested | pending | none
  author      TEXT,
  url         TEXT NOT NULL,          -- 只收 https://github.com/ 開頭
  source      TEXT NOT NULL,          -- agent | webhook：這一列最後是誰更新的
  updated_at  INTEGER NOT NULL,
  UNIQUE (user_id, repo, number)
);
CREATE INDEX IF NOT EXISTS idx_project_prs_project ON project_prs(user_id, project_id, state);

-- GitHub webhook 的接收端：網址帶一個 token（只存雜湊，可重新產生＝撤銷舊的），簽章驗 X-Hub-Signature-256。
-- 驗 HMAC 必須有密鑰的原文，所以 secret 存明碼（同 reminder_feed.unsub_token 的取捨）：
-- 外洩時拿到它的人只能往「已經連過的 PR」那幾列寫狀態，而且還要同時知道網址裡的 token。
CREATE TABLE IF NOT EXISTS github_hooks (
  user_id     TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  secret      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
