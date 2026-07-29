# 多使用者認證與權限設計

日期：2026-07-29
狀態：已核准，實作中

## 目標

把單人系統擴充為多使用者：使用者自行註冊，管理者核准後才能使用，並區分「使用者」與「管理者」兩種角色。

## 已確認的需求

| 項目 | 決定 |
|---|---|
| 管理者權限 | **只管帳號**——核准／拒絕／停用、指派角色。看不到任何人的排程內容 |
| 使用者規模 | 十幾人以內 |
| 認證方式 | 自建 email + 密碼，前面加一層 Turnstile 真人驗證 |
| Cloudflare Access | **不使用**。會擋在最前面導致自建登入頁進不去 |

## 不可破壞的前提

`public/index.html` 必須永遠能單獨雙擊開啟使用。整條認證判斷鏈都活在 Worker 裡，`file://` 開啟時沒有 Worker、沒有導向、沒有 Turnstile（Turnstile 本來就不支援 `file://`），主應用照舊以純 localStorage 運作。

這是選擇「多頁」而非「單頁內嵌登入」的主因：把登入塞進 `index.html` 會讓單機模式出現一個永遠壞掉的 Turnstile 元件。

## 資料模型

```sql
users
  id            TEXT PK          -- uuid
  email         TEXT UNIQUE      -- 一律小寫正規化後儲存
  password_hash TEXT             -- pbkdf2$iterations$salt$hash（base64）
  role          TEXT             -- 'user' | 'admin'
  status        TEXT             -- 'pending' | 'approved' | 'rejected' | 'suspended'
  created_at, approved_at, approved_by

sessions
  token_hash    TEXT PK          -- SHA-256(token)，不存原文
  user_id       TEXT
  created_at, expires_at

user_state
  user_id       TEXT PK          -- 改為參照 users.id（原本是 email）
```

遷移成本為零：`user_state` 目前 0 列。

## 路由

| 路徑 | 誰能到 | 說明 |
|---|---|---|
| `/login` | 公開 | 登入 + 註冊，Turnstile 掛此頁 |
| `/pending` | 已登入未核准 | 等待核准說明 |
| `/` | approved | 主應用 |
| `/admin` | admin | 帳號管理 |
| `POST /api/auth/register`、`/login` | 公開 | 需通過 Turnstile |
| `POST /api/auth/logout`、`GET /api/auth/me` | 已登入 | |
| `GET`/`PUT /api/state` | approved | 沿用既有介面，只換認證方式 |
| `GET /api/admin/users`、`PATCH /api/admin/users/:id` | admin | |

判斷順序：公開路徑？→ 有有效 session？→ status 已核准？→ 需要 admin？

### run_worker_first 是必要的

Workers 預設「靜態資產優先於 Worker」。不設定的話 `/` 會直接回 `index.html`，Worker 沒機會檢查 session。需設定：

```jsonc
"run_worker_first": ["/", "/index.html", "/admin", "/admin.html", "/api/*"]
```

**`/login` 絕不能列入**，否則登入頁自己也要 session，直接死鎖。

### 安全邊界在 API，不在 HTML

即使有人繞過導向直接取得 `admin.html`，那只是一個沒有資料的空殼。沒有有效 session + `role=admin`，`/api/admin/*` 一律 403。HTML 內不放任何機密，導向只是體驗而非防線。

## 安全決策

- **密碼**：PBKDF2-SHA256（Workers 原生 Web Crypto，不需 WASM），比對用 constant-time
- **session token 存雜湊而非原文**：DB 外洩時不能直接拿來登入。選 DB session 而非無狀態 JWT，是為了讓管理者停用帳號能**立即**生效
- **cookie**：HttpOnly + Secure + SameSite=Lax
- **登入失敗一律回「email 或密碼錯誤」**，不透露帳號是否存在；註冊時 email 重複則直接告知，否則使用者無從理解
- **Turnstile siteverify 需驗證回傳的 hostname**，避免 token 被挪用
- 暫不做登入失敗鎖定：Turnstile 已擋機器人，先 YAGNI

## 第一個管理者（bootstrap）

`ADMIN_EMAILS` secret（逗號分隔）。名單內的 email 註冊後自動 `role=admin` + `status=approved`。

**未設定此變數則無人能核准任何人，系統死鎖**——因此管理端點在未設定時必須回明確錯誤，而非靜默失敗。

`ADMIN_EMAILS` 走 secret 而非 `vars`：repo 是 public 的，`vars` 會公開 email；且 Dashboard 上改的 `vars` 會被下次 deploy 覆蓋。

## 設定值

- Turnstile sitekey（公開，寫死在 `public/login.html`）：`0x4AAAAAAEAkXN86cczJTf84`
- `TURNSTILE_SECRET`、`ADMIN_EMAILS`：由使用者以 `wrangler secret put` 設定，不進 git

## 施工順序（每步一 commit）

1. schema 擴充 + 密碼雜湊與 session 工具
2. Turnstile 驗證 + 註冊／登入／登出 API
3. 授權中介層 + 路由改造 + `/api/state` 改用 session
4. 登入頁與待核准頁
5. 管理者介面 + `/api/admin/*`
6. 主應用整合（顯示登入者、登出、admin 入口）
7. 文件更新
8. 部署與線上驗證
