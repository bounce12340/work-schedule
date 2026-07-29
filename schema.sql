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
