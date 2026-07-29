-- 工作排程確認系統 — D1 schema
--
-- 階段一刻意採「整包 JSON 存一列」而非拆成正規表格：
--   * 前端的 persist() 本來就是把整個 state 序列化成一個 JSON 字串，
--     直接對應到這裡，前端只需改 persist()/loadState() 兩個函式。
--   * 資料量極小（實測示範資料約 1.8 KB），拆表在此階段沒有效益。
--   * 未來要拆成 items / major_projects / gantt_projects 等正規表格時，
--     API 介面（GET/PUT /api/state）不需改變，前端也不用重寫。
--
-- 每個使用者一列，user_id 取自 Cloudflare Access JWT 的 email。

CREATE TABLE IF NOT EXISTS user_state (
  user_id    TEXT PRIMARY KEY,
  state      TEXT NOT NULL,           -- 整包 state 的 JSON 字串
  updated_at INTEGER NOT NULL,        -- epoch 毫秒；同時作為樂觀鎖的版本號
  created_at INTEGER NOT NULL
);
