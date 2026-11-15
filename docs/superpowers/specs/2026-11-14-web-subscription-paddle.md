# 網頁版訂閱（Paddle）

狀態：**程式寫好了（PR 裡），Paddle 那邊還沒設定，所以上線後網頁版的訂閱鈕不會出現**，要等下面〈使用者要做的事〉做完才會出現。

使用者 2026-11-14 的裁決：

- 用 **Paddle** 收錢。Stripe 不收台灣登記的商家；Paddle 是經銷商（Merchant of Record），各國的稅與收據它處理。
- 價格**跟 app 一樣**：每月 US$10、每年 US$100。

## 形狀

| 段落 | 在哪裡 | 做什麼 |
|---|---|---|
| 問能不能訂 | `GET /api/state` 的 `user.webBilling`（只有網頁版有） | Paddle 的設定齊了才是 true。**沒設定就整塊不顯示**：按下去才說「尚未開放」的按鈕比沒有更糟 |
| 按鈕 | `index.html` 的 `#acctWebSub`（「我的帳號 › 方案」） | 免費版：兩顆連結，連到 `/subscribe.html?plan=…`。網頁訂的 Pro：「管理訂閱」 |
| 結帳頁 | `public/subscribe.html` | 選月／年 → `POST /api/plan/paddle/checkout` → 載入 Paddle.js、打開結帳視窗 → 付完等 webhook 到了再回首頁 |
| 開結帳 | `POST /api/plan/paddle/checkout` | 伺服器開一筆 Paddle transaction，**user id 由伺服器寫進 `custom_data`** |
| 寫權利 | `POST /api/paddle/webhook` | 驗 `Paddle-Signature`，把訂閱事件寫成 `plan_source='paddle'`、`plan_expires_at` |
| 取消／換卡 | `POST /api/plan/paddle/portal` | 開 Paddle 的客戶頁，回網址。不自己做取消流程 |
| 判斷 Pro | `src/plan.js` 的 `planOf` | **一個字都沒改**，仍然只看資料庫的兩個欄位 |

## 不能拿掉的判斷

| 決定 | 理由 |
|---|---|
| **Paddle.js 只在 `subscribe.html` 載入** | `index.html` 的「零外部相依」是前提。付款整個隔離在另一頁，主畫面一行外部 script 都沒多 |
| **app 裡完全不出現網頁版的訂閱** | Apple 3.1.1：app 裡解鎖的東西只能走 IAP，連「去網頁訂」都不能提。前端用 `NATIVE` 擋、後端在 app 的請求裡不回 `webBilling`，兩邊都擋。`tools/smoke.mjs` 的 app 那一輪用**免費版**跑：用 Pro 跑的話「app 裡不准出現」是空斷言 |
| **user id 由伺服器寫進 `custom_data`** | 前端送來的 id 能把付的錢記到別人身上。測試送一個假的 `user_id` 進去，斷言 Paddle 收到的還是本人的 |
| webhook **驗 HMAC，而且時間戳超過 5 分鐘不收** | 少了驗簽，任何人 POST 一則假的 `subscription.created` 就是 Pro。時間戳擋重放。比對用 `crypto.subtle.verify`（constant-time），不自己比字串 |
| 一律回 200，**除了驗簽失敗** | 同 Apple 的通知：回 5xx 對方會一直重送，而「這筆我不認得」重送幾次也不會變成認得 |
| 比的是**事件發生的時間**（`occurred_at` → `paddle_event_at`），不是「只往後」 | Paddle 不保證送達順序，所以舊事件晚到時要不理；但同一份訂閱的「取消」必須能把到期日往前寫。只往後的話，取消了的人永遠是 Pro |
| **取消自動續訂不改到期日** | Paddle 的取消先是 `subscription.updated` 帶 `scheduled_change`，status 仍是 active：已付的那一期用到最後一天，到期時才來 `subscription.canceled`。同 Apple 的 `DID_CHANGE_RENEWAL_STATUS` |
| `past_due` 仍算這一期 | Paddle 在重試扣款；到期後 `planOf` 的 3 天寬限照樣適用（同 Apple 的 billing retry） |
| **管理者的永久方案不被蓋掉** | 同 Apple 那一條 |
| **結束類事件只結束網頁那一份** | `plan_source` 不是 `paddle`、或訂閱 id 對不上就不動。否則在網頁取消一份舊訂閱，會把 app 那一份撐著的 Pro 一起關掉 |
| **網頁那一份不縮短 Apple 那一份**，但記下訂閱 id | 兩邊都付了錢的人，Pro 取比較長的那一份。記下 id 他才進得了客戶頁去取消多付的那一份 |
| 已經是 Pro 的人**不給開結帳**（409） | 不讓同一個人付兩份錢（例如 app 裡已經訂了） |
| **price 白名單**（`PADDLE_PRICE_MONTHLY`／`_YEARLY`） | 同一個 Paddle 帳號底下有別的產品（KiddieFinance Daily）。不檢查的話，別的產品的訂閱事件只要剛好帶著這邊的 user id 就會解鎖 Pro |
| API key 與 webhook secret **永遠不出 Worker** | 前端只拿得到 client token（Paddle 設計給瀏覽器用的公開 token）。測試斷言 config 的回應裡沒有那兩個字串 |
| Paddle API 的錯誤原文**只進 console** | 同 AI 端點：上游的錯誤原文是最容易漏東西的一條路 |
| 退款**不自動收回 Pro** | Paddle 的退款是 adjustment，不會自己取消訂閱。要收回就在 Paddle 後台把那份訂閱「立即取消」，`subscription.canceled` 會把到期日往前寫。adjustment 事件照樣記進 `plan_events` |
| 刪除帳號**不會**自動取消 Paddle 的訂閱 | 帳號刪掉之後 webhook 找不到人，只記一筆「找不到對應帳號」。之後要在刪帳號那一步提醒，或自動呼叫取消（還沒做） |

## 使用者要做的事（秘密一律不貼進對話）

1. **Paddle 後台**（同一個帳號底下已經有 KiddieFinance Daily，可以共用；Paddle 會要你為新網域再做一次網站審核）：
   - Catalog：建一個產品「工作排程確認系統 Pro」，兩個價格：US$10／月、US$100／年。記下兩個 `pri_…`。
   - Checkout › Website approval：加上這個網站的網域。
   - Developer tools › Authentication：建一把**只給這個網站用**的 API key，與一個 client-side token。
   - Developer tools › Notifications：新增一個目的地 `https://<網站>/api/paddle/webhook`，勾 `subscription.*` 與 `adjustment.*`，記下它的 secret key。
2. **Cloudflare**（全部用 secret 存，`keep_vars` 不會清掉 secret）：
   ```bash
   npx wrangler secret put PADDLE_API_KEY
   npx wrangler secret put PADDLE_WEBHOOK_SECRET
   npx wrangler secret put PADDLE_CLIENT_TOKEN
   npx wrangler secret put PADDLE_PRICE_MONTHLY
   npx wrangler secret put PADDLE_PRICE_YEARLY
   npx wrangler secret put PADDLE_ENV          # sandbox 或 production
   ```
   六個都設了 `webBilling` 才會是 true。先用 **sandbox** 試一次（Paddle 的測試卡 `4242 4242 4242 4242`），確認 `/admin` 上那個帳號變成 Pro、Paddle 後台看得到那份訂閱，再換成 production 的四個值。
3. **資料庫**：`migrations/014-paddle.sql` 要在**合併之前**跑（加欄位，漏跑的話 `/api/state` 不會壞，但 webhook 與結帳會 500）。
4. **RevenueCat**（選做）：RevenueCat 支援接 Paddle，接上之後網頁版的訂閱也會出現在同一份圖表裡。

## 驗證

- `tests/plan-paddle.test.mjs` 18 條。突變驗證八種改法各自會紅：拿掉驗簽、拿掉 admin 保護、拿掉舊事件判斷、拿掉「只結束網頁那一份」、讓網頁縮短 Apple、拿掉 price 白名單、改用前端送的 user id、config 回應夾帶 API key。
- `tools/smoke.mjs`：免費版的網頁看得到兩顆訂閱鈕而且連對地方；管理者給的 Pro 看不到；**app 裡（免費版）看不到**。突變驗證：拿掉 `!NATIVE`、讓 Pro 也看得到，各自會紅。
- `subscribe.html` 在亮色與暗色、390px 寬下看過；409 的說明照原話顯示。
- **還沒驗的**：真的打 Paddle sandbox 走完一次付款（要使用者先完成上面第 1、2 步）。
