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

-- 行事曆訂閱（ICS feed）。內容由前端產生、同步時推上來，伺服器只負責保存與供應。
--
-- 這樣做的原因：occurrence 引擎（含假日順延）只存在於前端單檔內，Workers 端
-- 重新實作一份等於維護兩套必然分歧的邏輯；而且順延規則本來就無法用 RRULE 表達，
-- 展開成靜態事件才是正確的。代價是使用者一段時間沒開啟 app，feed 會停在最後
-- 一次同步的內容——對行事曆訂閱來說可以接受。
--
-- token 只存雜湊：feed URL 等同於長期有效的唯讀憑證，DB 外洩時不能直接拿來訂閱。
CREATE TABLE IF NOT EXISTS ics_feed (
  user_id    TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  ics        TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ics_token ON ics_feed(token_hash);

-- 逾期提醒。內容與 ICS 同一個模式：**由前端產生、同步時推上來**，cron 只負責
-- 「比對日期 → 寄信」。
--
-- 不在 Worker 展開循環規則，理由與 ICS 完全相同：occurrence 引擎（含假日順延、
-- 單次覆寫、略過）只存在前端單檔內，在這裡重新實作一份等於維護兩套必然分歧的
-- 邏輯——而「提醒寄錯日期」比「沒有提醒」更糟，因為使用者會信任它。
--
-- digest 存的是**已展開的**排程：[{ t:標題, d:'YYYY-MM-DD', k:類型, done:0|1 }]。
-- 刻意不存「已經算好的逾期清單」：逾期與否隨日期改變，今天不逾期的項目後天就
-- 逾期了。存展開後的日期，cron 每天自己比對，前端沒開也不影響正確性。
--
-- last_sent_ymd 讓同一天不會因為 cron 重試而寄第二封。
--
-- lead_days：提前幾天開始提醒。0 代表只在逾期時寄——那是原本的行為，保留給
-- 「不想被事前打擾」的人。預設 3 天：提醒的價值本來就在事前，只在逾期時才說
-- 等於永遠慢一步。
--
-- enabled 預設為 1：提醒的價值在於「不必記得去看」，而預設關閉等於要求使用者
-- 先知道有這個功能、再自己去打開——真正需要提醒的人往往就是不會去翻設定的人。
-- 信只寄到本人的註冊信箱、而且沒事就完全不寄，所以預設開啟的打擾成本很低。
-- 不想收的人按一下就關掉，那個選擇會被完整尊重（見 handleReminderPut）。
CREATE TABLE IF NOT EXISTS reminder_feed (
  user_id       TEXT PRIMARY KEY,
  enabled       INTEGER NOT NULL DEFAULT 1,
  digest        TEXT NOT NULL DEFAULT '[]',
  last_sent_ymd TEXT,
  lead_days     INTEGER NOT NULL DEFAULT 3,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reminder_enabled ON reminder_feed(enabled);

-- 密碼重設的一次性 token。
--
-- 為什麼需要這張表：ADMIN_EMAILS 名單內的帳號**連管理者都不能重設密碼**（那是
-- 防止另一位管理者橫向接管帳號的最後保險）。但那道保險把「本人忘記密碼」也一起
-- 擋死了——四條路全部封閉：管理者重設回 403、變更密碼要輸入舊密碼、登入頁沒有
-- 忘記密碼、就算裝置還登著也一樣。實際踩過：唯一的救法是去改 Cloudflare 的環境
-- 變數，而那個繞路本身也有地雷（把人從名單拿掉之後忘記加回去，防線就靜靜消失）。
--
-- 自助重設**不會在那道保險上打洞**，因為它擋的是完全不同的東西：名單防的是
-- 「另一個管理者」的橫向接管，而收得到這封信等於證明自己就是帳號本人。因此
-- 這條路徑刻意**不檢查 ADMIN_EMAILS**。
--
-- token 只存 SHA-256：這張表外洩時，裡面的值不能直接拿去重設別人的密碼。
-- 與 sessions、ics_feed 同一個原則。
--
-- used_at 標記已使用而不是直接刪除：連結被重複點（郵件用戶端預抓、使用者按上一頁）
-- 時，「這個連結已經用過了」與「查無此連結」要能分辨，才給得出看得懂的訊息。
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id, created_at);

-- 登入失敗次數。Turnstile 擋得住機器人大軍，擋不住有耐心的人慢慢試——
-- 前者是「一秒鐘一萬次」，後者是「一分鐘三次、試一整天」，兩者要分開擋。
--
-- key 同時用於 email 與 IP 兩種維度（前綴區分）：只擋 email 的話，換一個 email
-- 就能繼續打；只擋 IP 的話，同一間辦公室的人會互相牽連。兩個都擋、任一超限就停。
--
-- 刻意不做成「鎖定帳號」而是「這個窗口內先擋著」：真的鎖定帳號的話，攻擊者
-- 只要一直打錯就能把別人鎖在門外，那反而變成一種阻斷服務。
CREATE TABLE IF NOT EXISTS login_attempts (
  key          TEXT PRIMARY KEY,   -- 'email:someone@x.test' 或 'ip:1.2.3.4'
  fails        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

-- 管理者操作記錄。
--
-- 原本只有 share_activity（別人動我的分享資源），管理者停用帳號、改角色、重設
-- 密碼卻一筆都沒留。系統有兩位以上管理者時，「是誰把我停用的」必須答得出來。
--
-- 記 actor_email 與 target_email 的**當下快照**而不是只存 id：帳號被刪掉之後，
-- 記錄仍然要讀得懂當時動的是誰。理由與 share_activity 的 resource_name 相同。
CREATE TABLE IF NOT EXISTS admin_activity (
  id           TEXT PRIMARY KEY,
  actor_id     TEXT NOT NULL,
  actor_email  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  target_email TEXT NOT NULL,
  action       TEXT NOT NULL,      -- 人可讀的簡述
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_activity_time ON admin_activity(created_at);
