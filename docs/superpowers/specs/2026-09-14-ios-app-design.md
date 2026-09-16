# iOS app：付費下載、內建前端、購買證明註冊

日期：2026-09-14
狀態：**子專案 A 已實作**（PR 見 git log）；B、C、D 待設計

## 這件事是怎麼變成現在這個形狀的

一開始的問題是「能不能做成 iOS 上也能用的程式」。答案分三層，每一層都改變了設計：

| 使用者的決定 | 對設計的影響 |
|---|---|
| 要**公開上架 App Store**，不是只給自己人 TestFlight | 要過 Apple 審查，尤其是 4.2「最低功能」 |
| **付費下載**，不是訂閱 | 不用做 IAP、不用接刷卡；但後端要能證明「這個帳號是付過錢的人」 |
| 網頁版與 app **同一套帳號、同一份資料** | 認證要能同時走 cookie（網頁）與 token（app） |
| 資料庫**繼續用 Cloudflare D1**，不換 Supabase | 後端沿用，不重寫 |
| Google 日曆讀進來 | **另開子專案**，不與上架綁在一起 |

### 為什麼不是「殼載入線上網站」

第一版推薦是 Capacitor 的 `server.url` 指向線上網站：後端不改、網站更新 app 就更新。查證之後撤回：Ionic 團隊自己說 `server.url` 本來只是給開發時用的；到 2026 年，「把網站包起來」幾乎等於一定被 4.2 退件。所以改成**把 `public/index.html` 內建進 app**。代價是前端每次改版要重新打包送審，而且 app 裡的網頁來源變成 `capacitor://localhost`，對後端來說是另一個網域。這份文件大半在處理這個代價。

### 為什麼不需要 IAP

Apple 3.1.1 要求「app 裡能用到的功能若要收錢，一定走 IAP」。**付費下載本身就是 Apple 收的錢**，下載那一刻就付完了，之後 app 裡沒有任何要另外收費的東西，所以不需要 IAP、不需要訂閱、不需要收據對帳。要做的只有一件事：後端得知道「這個帳號的主人買了 app」，作法見〈購買證明〉。

## 子專案切分

| 順序 | 子專案 | 狀態 |
|---|---|---|
| **A** | **iOS app 基礎**：index.html 內建、app 以 token 登入、以「購買證明＋email 驗證碼」自助註冊並自動核准、刪帳號、隱私頁、自動打包上傳 | 本文件 |
| B | 推播提醒（逾期／即將到期推到手機） | 待設計 |
| C | 上架素材與送審（截圖、文案、審查員帳號） | 待設計 |
| D | Google 日曆讀進來（唯讀） | 待設計 |
| E | **訂閱制**：免費下載＋app 內自動續訂訂閱，免費版專案數上限，既有兩個帳號永久有效 | `2026-09-16-subscription-design.md`（設計中）。**它推翻了本文件「付費下載、不需要 IAP」的前提**：購買證明保留，但角色改為「一個 Apple ID 一個帳號」的防濫用 |

之後可能再開：前端自動更新（app 自己從 Worker 抓新版 index.html，不必每次送審）、網頁版單獨販售、Android。

---

## 一、架構

### 檔案配置

```
mobile/                        iOS 相關的一切；自己的 package.json，Capacitor 只裝在這裡
mobile/capacitor.config.json   appId com.bounceto.workschedule、appName 工作排程、webDir www
mobile/www/                    打包時從 public/ 複製出來，不進 git（.gitignore）
mobile/scripts/prepare-www.mjs 做上面那件事
mobile/ios/App/                Xcode 專案，commit 進 repo
mobile/ios/App/App/NativePlugin.swift   自己寫的 Capacitor 插件（購買證明、Keychain）
.github/workflows/ios.yml      手動觸發的打包與上傳
```

**`mobile/www/` 是建置產物，不是原始碼。** 理由與測試那條相同：不能有第二份 `index.html` 會走鐘。`prepare-www.mjs` 只複製 `public/index.html`（app 用不到 `login.html`、`sw.js`、manifest）。

**根目錄的零相依前提不變。** Capacitor 的套件全部在 `mobile/package.json`，`npm test` 與現有 CI 不碰它。

### 自己寫的 Swift 插件，不裝第三方插件

需要兩個原生能力，市面上的插件要嘛沒有、要嘛帶進一堆用不到的東西：

| 能力 | 方法 | 說明 |
|---|---|---|
| 購買證明 | `getAppTransaction()` → `{ jws }` | `AppTransaction.shared` 的 `jwsRepresentation`（StoreKit 2，iOS 16+） |
| Keychain | `keychainGet/Set/Delete({ key })` | 存 app 的 session token；不放 localStorage |

約 60 行 Swift，最低 iOS 16。

### 打包：GitHub 的 Mac

`.github/workflows/ios.yml`，**只在手動觸發（`workflow_dispatch`）或推 `ios-v*` tag 時跑**，不佔每個 PR 的時間。跑在 GitHub 的 `macos-26` 映像上（Xcode 26.x 正式版）。實作時原本選 `xcode-27`，那是「預覽」映像、只有 beta——build 上傳得了但 App Store Connect 拒收（「Unsupported SDK or Xcode version」），所以換成正式版的映像。

步驟：`mobile/` 內 `npm ci` → `prepare-www` → `cap sync ios` → 把 `.p8` 寫成檔案 → `xcodebuild archive`（自動簽章，`-allowProvisioningUpdates` 帶 App Store Connect API 金鑰；Apple 那邊沒有憑證就自己建）→ `xcodebuild -exportArchive`，`method: app-store-connect`、`destination: upload`，一步直接上傳。

| GitHub Secret | 內容 |
|---|---|
| `ASC_KEY_ID` | App Store Connect API 金鑰的 Key ID |
| `ASC_ISSUER_ID` | Issuer ID |
| `ASC_API_KEY_P8` | `.p8` 檔的完整內容 |
| `APPLE_TEAM_ID` | 開發者帳號的 Team ID |

版本號從 `mobile/package.json` 的 `version` 讀（1.0.0 起），build 號用 GitHub 的 `run_number`，永不重複。金鑰只活在那台機器的那幾分鐘，不寫進 log，不進 artifact。

---

## 二、前端在 app 裡怎麼跑

### 偵測原生環境，只在那時候改行為

Capacitor 會把 `window.Capacitor` 注入頁面。`index.html` 新增區段 `// ===== 原生外殼 =====`，在 IIFE 最前面判斷 `window.Capacitor?.isNativePlatform?.()`，為真才啟用以下全部；為假（網頁版、雙擊開啟）**一個 byte 的行為都不變**。

### 為什麼是包一層 `fetch`，不是改三十處呼叫

前端所有 API 呼叫都是相對路徑（`fetch('/api/...')`，三十餘處），在 `capacitor://localhost` 底下會全部打錯地方。兩條路：

| 作法 | 代價 |
|---|---|
| 逐處改成 `apiFetch('/api/...')` | 三十幾行 diff；而且這種大範圍機械式改名正是〈多語系〉那節遮蔽事故的形狀 |
| **在 IIFE 內把 `fetch` 包一層** | 一個地方；只在原生環境生效 |

採後者：`/api/`、`/ics/` 開頭的路徑補上 `API_BASE`（`https://work-schedule.bounceto12340.workers.dev`），並加 `Authorization: Bearer <token>`。Google Fonts 之類的絕對網址不動。這是全檔唯一一處改寫全域行為的地方，理由記在 CLAUDE.md。

### `cloudPull()` 的 `absent` 分支不會誤觸

`absent` 的判斷是「端點不存在（404）」。在 app 裡 base 是線上網址，端點永遠存在；沒網路是 `failed`，狀態列顯示「連線失敗，暫時只用本機資料」——正確。

### 只在 app 裡出現的登入／註冊畫面

`login.html` 依賴 Turnstile，而 Turnstile 在非 http 網域跑不起來，所以 app 不用它。`index.html` 新增 `#appAuthView`（只在原生且 Keychain 沒有 token 時顯示）：

- **登入**：email＋密碼 → `POST /api/auth/app/login` → token 存 Keychain → 進入主畫面並跑 `initCloudSync()`。
- **註冊**：三步。輸入 email → 「寄驗證碼」；輸入六碼＋設定密碼 → app 從插件拿購買證明 → `POST /api/auth/app/register` → token。
- **忘記密碼**：以 Safari 開網頁版 `/login`，走既有的信件重設流程。app 不重做一份。
- **token 過期（401）**：清 Keychain、回到 `#appAuthView`。**不能**像網頁版那樣導向 `/login`（app 裡沒有那一頁）。

### 離線

`index.html` 是本機檔案，沒網路照常開，看到的是 localStorage 的資料，勾選照常寫本機，網路回來後 `pushSoon()` 推上去。這與單檔雙擊開啟是同一條路徑。service worker 在 `capacitor://` 下本來就不註冊（既有的 `http(s)` 守衛），不需要動。

---

## 三、後端

### Bearer token 與 cookie 並存

`getSessionUser` 先讀 cookie；沒有就讀 `Authorization: Bearer`。**同一張 `sessions` 表**，同樣只存 SHA-256。差別只有效期：app 的 session 180 天（`createSession` 多一個參數），網頁的照現在。列在「登入中的裝置」時 app 的 user agent 由前端在呼叫時帶 `X-App-Client: ios/<version>`，伺服器存成 user_agent 的一部分，顯示成「iPhone app」。

`handleLogin`（網頁）不動。新的 `handleAppLogin` 回 `{ token, expiresAt, user }`，**不發 cookie**。

### 購買證明的驗證（`src/apppurchase.js`）

`AppTransaction` 的 JWS 是 Apple 簽的，可以**離線驗**，不用打 Apple 的 API：

1. header 的 `x5c` 是憑證鏈（leaf → intermediate → root）。逐段驗簽，root 必須與內建的 **Apple Root CA - G3** 相同（DER 內建在模組裡）。
2. 用 leaf 的公開金鑰驗 JWS 本體（ES256）。
3. payload 檢查：`bundleId === 'com.bounceto.workschedule'`；`receiptType`／`environment` 為 `Production`，或 `Sandbox` 且 `APP_PURCHASE_ALLOW_SANDBOX=1`（TestFlight 測試期間開，上架後關）。
4. 回 `{ ok, appTransactionId, originalPurchaseDate }` 或 `{ ok:false, reason: 'signature' | 'chain' | 'bundle' | 'environment' }`。

**驗證器接受注入的根憑證**，只為了測試：測試自己產一組 EC 金鑰與自簽根，簽出 JWS，才能驗「正確通過、改一個 byte 失敗、bundleId 不對失敗、Sandbox 未放行失敗」。正式碼路徑永遠用內建的 Apple 根。

### email 驗證碼取代 Turnstile

| | 說明 |
|---|---|
| `POST /api/auth/app/code` | body `{ email }`。產六碼、存 `email_codes`（**只存雜湊**）、10 分鐘有效、AgentMail 寄出。走 `throttle.js` 限 email 與 IP。無論結果一律回 200（理由同忘記密碼：不當帳號列舉工具）；寄信失敗 `console.error` |
| 驗證 | 比對雜湊；每筆最多試 5 次，超過作廢；用過即刪 |
| 索取新碼 | 刪掉舊的（同密碼重設連結的理由） |

### 註冊：`POST /api/auth/app/register`

body `{ email, code, password, appTransactionJws }`。順序：

1. 驗證碼對不對（錯就回 400，**不消耗購買證明**）
2. 密碼長度（同網頁註冊的規則）
3. 購買證明驗過（`ok:false` 回 403，訊息只給原因類別，不轉發 Apple 原文）
4. `app_transaction_id` 沒被用過（UNIQUE；用過回 409「這次購買已經建立過帳號」）
5. 建帳號：`status='approved'`、`purchase_source='ios_app'`、`app_transaction_id`、`purchased_at`；`ADMIN_EMAILS` 名單內仍然自動成為管理者
6. 建 session（180 天）、回 token

**一次購買一個帳號。** 同一個 Apple ID 重灌 app 拿到的是同一個 `appTransactionId`，所以換手機不會被擋（登入即可）；刪掉帳號後那個 id 就空出來，可以再註冊。這是刻意的取捨：擋的是「買一份、開十個帳號」。

### 資料表變更（`migrations/005-app-purchase.sql`）

```sql
ALTER TABLE users ADD COLUMN purchase_source TEXT;       -- 'ios_app' | NULL（既有帳號，視同管理者核准）
ALTER TABLE users ADD COLUMN app_transaction_id TEXT;    -- 另建 UNIQUE INDEX
ALTER TABLE users ADD COLUMN purchased_at INTEGER;
CREATE TABLE IF NOT EXISTS email_codes (
  email      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
```

`schema.sql` 同步更新（新資料庫用它；既有資料庫**部署前**先跑 migration，順序不能反，理由見 CLAUDE.md〈資料庫結構變更〉）。`email_codes` 過期的列由每日 cron 的 `purgeExpired` 順手清。

### 刪除我的帳號：`DELETE /api/auth/account`

Apple 5.1.1(v)：有註冊就要能在 app 裡自己刪。body `{ password }`。

1. 密碼不對回 403。
2. **先**在 `admin_activity` 記一筆 `self_delete`（actor 與 target 都是本人，email 快照）——刪完就沒地方讀 email 了，理由同管理者刪帳號。
3. 刪：`user_state`、`shares`（`owner_id = ?` 或 `grantee_id = ?`）、`sessions`、`ics_feed`、`reminder_feed`、`password_resets`、`email_codes`、最後 `users`。`share_activity` 保留（是別人的紀錄，email 是當下快照）。
4. 回 200。前端 `clearLocalData()`，app 清 Keychain 回 `#appAuthView`，網頁版導向 `/login`。

`ADMIN_EMAILS` 名單內的帳號**也可以刪自己**：名單防的是另一位管理者的橫向操作，本人拿密碼刪自己是直向的，與〈忘記密碼〉那節的判斷相同。刪了之後再註冊仍會自動成為管理者，系統不會死鎖。

R2 每日備份裡的舊資料會在 14 天輪替後消失，隱私頁寫明。

### 隱私權政策頁 `public/privacy.html`

加進 `servePage` 的公開路徑（同 `/login`、`/reset`）。中英文各一段，內容：存什麼（排程、email、密碼雜湊、登入裝置類型與時間）、存哪裡（Cloudflare，資料庫在亞太區）、誰看得到（本人與被分享者；管理者只看得到帳號狀態，看不到內容）、怎麼刪（我的帳號 → 刪除我的帳號；備份 14 天後消失）、不記 IP、無第三方追蹤或廣告、AI 小幫手會把排程送到 DeepSeek 處理、聯絡方式。

### AI 每日上限 50 → 20

付費下載是一次收、永遠用，AI 每次呼叫要付 DeepSeek 錢。以 `deepseek-v4-flash` 的價格，一人每天問滿 20 次，一年約台幣幾十元，一次收費不會賠。每分鐘 5 次不動。

---

## 四、錯誤處理

| 情況 | 行為 |
|---|---|
| app 第一次開沒網路 | `index.html` 是本機的，照常開；`#appAuthView` 按下登入才顯示「連線失敗」 |
| 驗證碼寄不出去 | 回 200（不洩漏帳號存在），`console.error`；畫面提示「沒收到可以重寄」 |
| 購買證明驗不過 | 403，訊息只有原因類別；Apple 原文只留 console |
| 同一購買重複註冊 | 409，提示「這次購買已建立帳號，請直接登入」 |
| token 過期 | 401 → 清 Keychain → `#appAuthView` |
| 插件拿不到購買證明（模擬器、未從 App Store 安裝） | 前端提示「請從 App Store 或 TestFlight 安裝」；Sandbox 環境由伺服器旗標決定放不放行 |

所有降級都要 `console.error`（〈降級可以，沉默不行〉）。

---

## 五、測試

| 檔案 | 驗什麼 |
|---|---|
| `tests/appauth.test.mjs` | Bearer 被接受、cookie 照舊、兩者都沒有回 null；驗證碼錯／過期／第 6 次拒絕／用過即刪；購買證明四種失敗與一種成功（注入測試根憑證）；同一 `app_transaction_id` 第二次註冊 409；註冊成功 `status='approved'` |
| `tests/account-delete.test.mjs` | 密碼錯 403 且什麼都沒刪；刪完相關表為空；**另一使用者每一列原樣**；所有 session 失效；`admin_activity` 有 `self_delete` |
| `tools/smoke.mjs` 新一輪 | `addInitScript` 塞假的 `window.Capacitor`（`isNativePlatform` 為真、假插件）：`#appAuthView` 出現、`fetch` 被改寫成絕對路徑並帶 Bearer、登入後主畫面出現 |
| `tools/smoke.mjs` | `/privacy` 打得開、零 pageerror |
| 突變驗證 | 每條新斷言至少一種改法會紅 |
| 真機（TestFlight） | Sandbox 註冊、登入、關網路重開、刪帳號、外部連結跳 Safari |

`tests/d1.mjs` 的 D1 外殼沿用：驗的是「帶條件的 SQL 有沒有改到那一列」，假物件測不出來。

---

## 六、使用者要做的事（與程式平行）

1. App Store Connect 建 API 金鑰（團隊金鑰、App 管理權限），四個值放進 GitHub Secrets，名字如上。**內容不貼進對話。**
2. App Store Connect 建 app：Bundle ID `com.bounceto.workschedule`，名字「工作排程確認系統」（撞名再換），價格自訂。
3. 建一個審查員帳號並核准（子專案 C 送審時用）。
4. 第一次打包成功後在 iPhone 裝 TestFlight 版實測第五節那六件事。

## 已知限制

- Apple 退款後帳號仍在（v1 不接 App Store Server Notifications）。
- 前端每次改版要重新打包送審（自動更新是之後的子專案）。
- Android 不在範圍內。
- 網頁上不開放陌生人自己註冊；註冊只在 app 裡發生。既有的管理者核准路留給例外。
- 4.2 仍有被退的可能。我們的立足點：內建離線、本機資料、帳號同步、推播（子專案 B）。被退就依審查意見補，最壞的情況是 B 提前做。
