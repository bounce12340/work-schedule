-- 工作排程確認系統 — D1 schema

-- 使用者。email 一律小寫正規化後儲存，避免 A@x.com 與 a@x.com 被當成兩個帳號。
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,        -- pbkdf2$<iterations>$<salt_b64>$<hash_b64>
  role          TEXT NOT NULL DEFAULT 'user',      -- 'user' | 'admin'
  status        TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'approved' | 'rejected' | 'suspended'
  created_at    INTEGER NOT NULL,
  approved_at   INTEGER,
  approved_by   TEXT
);

-- Session。只存 token 的 SHA-256，不存原文：DB 若外洩，裡面的值無法直接拿來登入。
-- 選 DB session 而非無狀態 JWT，是為了讓管理者停用帳號能立即生效。
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 排程資料，每個使用者一列。
--
-- 階段一刻意採「整包 JSON 存一列」而非拆成正規表格：
--   * 前端的 persist() 本來就是把整個 state 序列化成一個 JSON 字串，
--     直接對應到這裡，前端只需改 persist()/loadState() 兩個函式。
--   * 資料量極小（實測示範資料約 1.8 KB），拆表在此階段沒有效益。
--   * 未來要拆成 items / major_projects / gantt_projects 等正規表格時，
--     API 介面（GET/PUT /api/state）不需改變，前端也不用重寫。
--
-- user_id 參照 users.id 而非 email：email 之後可能允許變更。
CREATE TABLE IF NOT EXISTS user_state (
  user_id    TEXT PRIMARY KEY,
  state      TEXT NOT NULL,           -- 整包 state 的 JSON 字串
  updated_at INTEGER NOT NULL,        -- epoch 毫秒；同時作為樂觀鎖的版本號
  created_at INTEGER NOT NULL
);

-- 分享。一列＝「擁有者把某一個資源分享給某一位使用者」。
--
-- 刻意不複製資源內容，只記指標（kind + resource_id）：資源本身仍然只有一份，
-- 存在擁有者的 user_state 裡。複製一份給對方的話，兩邊會立刻各自漂移，
-- 而「分享」的語意就是雙方看到同一個東西。
--
-- resource_id 沒有外鍵可指——資源在 JSON blob 裡而不是獨立表格。因此建立分享時
-- 由 API 負責確認該資源真的存在於擁有者的 state，避免留下永遠解析不到的孤兒列。
--
-- UNIQUE 讓「重複分享給同一人」變成更新權限而非新增一列。
CREATE TABLE IF NOT EXISTS shares (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  resource_kind TEXT NOT NULL,        -- 'item'（小項目）| 'gantt'（專案）
  resource_id   TEXT NOT NULL,
  permission    TEXT NOT NULL,        -- 'view'（唯讀）| 'edit'（可操作）
  created_at    INTEGER NOT NULL,
  UNIQUE(owner_id, resource_kind, resource_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_shares_target ON shares(target_id);
CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares(owner_id);

-- 共享資源的操作記錄。只記「被分享者對別人的資源做了什麼」——擁有者改自己的
-- 東西不需要記錄，那是他自己的資料，記了只會把真正需要注意的事情淹沒。
--
-- resource_name 是當下的名稱快照，刻意不正規化：資源被改名或刪除之後，
-- 記錄仍然要讀得懂「當時動的是哪一個項目」，指過去只會得到一個空值。
CREATE TABLE IF NOT EXISTS share_activity (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,      -- 資源擁有者
  actor_id      TEXT NOT NULL,      -- 實際動手的人
  resource_kind TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  resource_name TEXT NOT NULL,      -- 當下的名稱快照
  action        TEXT NOT NULL,      -- 人可讀的簡述
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_owner ON share_activity(owner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_actor ON share_activity(actor_id, created_at);
