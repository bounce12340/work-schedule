# 事故紀錄：線上註冊必定回 Error 1101

- **日期**：2026-07-30
- **影響**：部署後**沒有任何人能註冊或登入**，系統實質完全不可用。`users`／`sessions`／`user_state` 三張表始終 0 筆
- **狀態**：已修復並上線（Worker version `12f265d3`）

---

## 症狀

在 `https://work-schedule.bounceto12340.workers.dev/login` 填完 email 與密碼、Turnstile 也顯示「成功!」之後按下註冊，畫面只回一句 **「發生錯誤，請稍後再試」**。

直接看 Network，`POST /api/auth/register` 的回應不是 JSON，而是 Cloudflare 的 HTML 錯誤頁：

```
Error 1101 — Worker threw exception
Ray ID: a2315556fa0faa0f • 2026-07-30 03:38:56 UTC
```

**本機 `npm run dev` 完全正常**：註冊、建立管理者、登入發 cookie 一路走通。

## 根因

`src/crypto.js` 的 PBKDF2 迭代次數設為 **210,000**（照 OWASP 建議值），但 Workers **正式環境**的 `crypto.subtle.deriveBits` 有硬上限 **100,000**，超過直接丟：

```
NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported (requested 210000).
```

於是 `handleRegister()` 走到 `hashPassword()` 就中斷。例外沒有人接，Worker 直接拋給 Cloudflare，回傳 HTML 錯誤頁；前端 `res.json()` 解析失敗後 fallback 成空物件，最後只顯示通用訊息。

**這個上限只在正式環境強制，本機 workerd 不強制**——所以這是一個本機百分之百測得過、線上百分之百失敗的坑。

## 為什麼難診斷

它完全不像雜湊的問題：

1. **例外在雜湊開始算之前就丟出**，該次請求 CPU 只有 3～5ms（正常跑完 PBKDF2 要 ~74ms），看起來根本沒做什麼事就死了
2. **DB 一筆都沒寫進去**，所以無法從資料反推走到哪一步
3. **錯誤訊息被前端吞掉**（`res.json().catch(() => ({}))`），瀏覽器端連狀態碼都看不到
4. 先前為了防免費方案 CPU 上限而寫下的筆記，反而把注意力誤導到 CPU 時間上——實際上帳號是付費的 `standard`，CPU 從來不是瓶頸

## 診斷過程（這套方法可重複使用）

由外而內逐層排除，每一步都是唯讀探測：

| 探測 | 結果 | 排除了什麼 |
|---|---|---|
| `GET /api/health` | 200 | Worker 本身沒掛 |
| 帶假 cookie 打 `/`（會跑 `sessions JOIN users`） | 302 | D1 綁定正常、兩張表都存在 |
| `POST /api/auth/register` 空 body | 400 JSON | 處理器有執行到 |
| 同上、無 turnstileToken | 403 `missing-token` | Turnstile 設定正確 |
| 本機 dev 完整跑一次註冊 | 全綠 | 程式邏輯本身沒問題 |
| D1 API 查 `sqlite_master` | `users` 為完整 8 欄 | 遠端 schema 沒有過時 |
| D1 API 查三張表筆數 | 全為 0 | INSERT 從未成功 |

到這裡剩下的可能只有 `hashPassword()`。最後兩步定案：

**① GraphQL analytics 區分「丟例外」與「CPU 超限」**

```graphql
{ viewer { accounts(filter: {accountTag: "<account-id>"}) {
    workersInvocationsAdaptive(
      limit: 100,
      filter: {datetime_geq: "...", datetime_leq: "...", scriptName: "work-schedule"},
      orderBy: [datetimeMinute_ASC]
    ) {
      sum { errors requests }
      quantiles { cpuTimeP99 wallTimeP99 }
      dimensions { status datetimeMinute }
    }
} } }
```

`dimensions.status` 回 **`scriptThrewException`**（而非 `exceededCpu`），且 `cpuTimeP99` 僅 3,088–5,153µs。兩者合起來說明：是程式丟例外，而且死在雜湊真正開始運算之前。

> 這兩個 status 的處理方向完全不同，先分清楚再往下查，可以省掉大量時間。

**② 用臨時 Worker 在正式環境實測**

Workers Logs 當時因 API token 權限不足讀不到，改用一個不含任何 binding 的臨時 Worker，直接量測各迭代次數的行為：

| iterations | 結果 |
|---|---|
| 1,000 / 50,000 / 100,000 | 通過 |
| 100,001 / 150,000 / 210,000 | `NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported` |

上限確認為 100,000，測完即刪除該 Worker。

## 修正

| 檔案 | 改動 |
|---|---|
| `src/crypto.js` | 新增 `MAX_ITERATIONS = 100000` 並以此為產生時的迭代次數。`verifyPassword()` 對超過上限的既有雜湊回 `false` 並 `console.warn`，而不是讓請求 500——那種雜湊只可能來自不受限的本機 |
| `src/index.js` | 路由主體抽成 `route()`，`fetch` 外層包 try/catch。例外一律 `console.error`（含 Ray ID／method／path／stack）並回 500 JSON，附上 `ref` 讓畫面上的錯誤能對到 Workers Logs 那一筆 |
| `public/login.html` | 回應不是 JSON 時顯示 HTTP 狀態碼，有 `ref` 就一併顯示 |
| `CLAUDE.md` / `README.md` / `wrangler.jsonc` | 更新迭代次數，並把「CPU 時間是真實限制」一節改寫為平台硬上限（原本的前提是錯的） |

儲存格式 `pbkdf2$<iterations>$<salt>$<hash>` 本來就帶著迭代次數，所以平台哪天放寬上限，只要調高 `MAX_ITERATIONS`，舊密碼仍然驗得過。

## 驗證

- 正式環境臨時 Worker 實測上限（見上表）
- `node` 直接跑 `hashPassword` / `verifyPassword` round-trip：通過，耗時 37ms；超上限雜湊回 `false`
- `npx wrangler deploy --dry-run` 通過
- 部署後確認 `ADMIN_EMAILS`、`TURNSTILE_SECRET` 兩個 secret 仍在（`wrangler deploy` 不會清除 secret，但會覆蓋 `vars`）
- 冒煙測試：`/api/health` 200、未登入導向 `/login`、register 400／403 分支正常、`/api/state` 無 session 回 401
- **端對端**：實際註冊成功，D1 出現兩筆 `role=admin`／`status=approved`／`approved_by=bootstrap` 的資料，`password_hash` 前綴為 `pbkdf2$100000$`

## 教訓

1. **「本機全綠」不等於「線上會動」。** 平台限制（PBKDF2 迭代上限、CPU 時間）多半只在正式環境強制。凡是碰到 Web Crypto、CPU、記憶體的參數，本機測過之後仍必須在線上驗一次。
2. **絕不讓 Worker 把例外拋給 Cloudflare。** 一旦拋出去就變成 HTML 錯誤頁，前端拿不到 JSON，錯誤原因在瀏覽器端徹底消失。頂層 try/catch 是必要的基礎建設，不是可有可無的防禦。
3. **前端不要靜默吞掉解析失敗。** `res.json().catch(() => ({}))` 很方便，但至少要把 HTTP 狀態碼顯示出來，否則使用者回報的資訊量等於零。
4. **筆記寫錯方向比沒寫更糟。** 舊版 CLAUDE.md 把 PBKDF2 的風險記成「CPU 時間」，直接把排查引導到錯誤的方向。事後修正文件與修正程式同樣重要。
5. **診斷「只在線上壞」的問題，先看 `workersInvocationsAdaptive` 的 `status`。** 它能在讀不到日誌的情況下區分例外與資源超限。
