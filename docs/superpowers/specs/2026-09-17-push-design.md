# 子專案 B：推播通知（APNs），以及 F3

日期：2026-09-17
狀態：**設計定案**（三個問題已於 2026-09-17 由使用者裁決，見〈使用者的決定〉）

## 使用者的決定

| 問題 | 決定 |
|---|---|
| 推播要推什麼 | **三種都要**：逾期／即將到期、植物的撒嬌信（F3）、今天有事要做 |
| 推播與 email 的關係 | **兩個獨立開關，各自可開可關** |
| APNs 金鑰 | 還沒建，要一步一步的清單（見〈使用者要做的事〉） |

## 一、為什麼推播值得做，而且為什麼它不取代信

逾期提醒信已經在跑了，而且是對的。推播補的是**時效**：信要打開信箱才看得到，通知會亮在鎖定畫面上。兩者要的行動不同，所以**不是二選一**。

「推播取代 email」被否決的理由要寫下來，因為它看起來比較乾淨：

> 手機換了、app 刪了、通知權限被關掉——三種情況下 token 都會安靜地失效，而**使用者不會知道自己從此收不到任何東西**。信箱是唯一不會這樣消失的管道。

這與〈降級可以，沉默不行〉是同一條：一個管道壞掉不該讓人以為「今天沒事」。

## 二、三種推播，各自的閘門

三種各有一個開關，**與 email 的兩個開關互不相干**（畫面上就是五顆按鈕）。關掉逾期信不代表不想要逾期推播，反過來也一樣。

| 推播 | 內容 | 不推的條件 |
|---|---|---|
| **逾期／即將到期** | 與逾期提醒信同一份 digest 算出來的東西 | 沒有逾期、也沒有即將到期 → **完全不推** |
| **植物的撒嬌信（F3）** | 與 `sendStreakBroken` 同一個判斷 | 沒斷、連續 < 2 天、開關關著 |
| **今天有事要做** | 「今天有 N 件事」 | **N = 0 就不推** |

**「沒事就閉嘴」在推播上比在信上更重要。** 一封沒事的信只是多一列未讀；一則沒事的推播會震動手機。每天一則「你今天沒事」會訓練人把這個 app 的通知整個關掉，然後真的有事時什麼都收不到。

第三種是新的（email 沒有這一種），理由正是通知比信輕：早上八點一則「今天有 3 件事」是有用的，而同樣內容的信只會變成噪音。

## 三、內容一律由前端算好推上來

**與 ICS、逾期提醒信、F2 完全相同的模式，理由也完全相同**：occurrence 引擎只存在 `public/index.html` 裡，在 Worker 重寫一份必然分歧，而**推播推錯日期比沒有推播更糟**——使用者會信任它。

所以 cron 只做「比對日期 → 送出」，用的就是 `reminder_feed.digest` 那一份已經展開的排程（`[{t,d,k,done,ot}]`）。F3 的連續天數也一樣，用前端推上來的 `streak_current`。

`dayReport`、`pickOverdue`、`pickUpcoming` 三個純函式已經存在且有測試，推播直接用它們——**不另外寫一套**。

## 四、資料表

```sql
-- migrations/008-push.sql
CREATE TABLE IF NOT EXISTS device_tokens (
  token        TEXT PRIMARY KEY,     -- APNs device token（hex）
  user_id      TEXT NOT NULL,
  environment  TEXT NOT NULL,        -- 'production' | 'sandbox'（決定打哪一台 APNs）
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);

-- 三個推播開關 + 三個同日去重（與 email 的兩個開關各自獨立）
ALTER TABLE reminder_feed ADD COLUMN push_overdue     INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reminder_feed ADD COLUMN push_streak      INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reminder_feed ADD COLUMN push_today       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reminder_feed ADD COLUMN push_overdue_ymd TEXT;
ALTER TABLE reminder_feed ADD COLUMN push_streak_ymd  TEXT;
ALTER TABLE reminder_feed ADD COLUMN push_today_ymd   TEXT;
```

幾個刻意的決定：

- **token 是主鍵，不是 (user_id, token)。** 同一支手機換人登入時，那個 token 屬於**後登入的人**——`INSERT … ON CONFLICT(token) DO UPDATE SET user_id = ?` 一句就把它搬過去。若允許同一個 token 對兩個 user，前一位使用者的排程會推到現在這個人的鎖定畫面上，那是資料外洩。
- **逾期與植物預設開、「今天有事」預設關。** 前兩者是「有事才響」，預設開的理由同逾期提醒信（真正需要提醒的人往往不會去翻設定）。第三種每天固定時間會響，那種東西預設開是打擾。
- **不記 IP、不記裝置名稱。** 同〈登入中的裝置〉：這張表要回答的只有「推到哪裡」。
- 刪除帳號時 `device_tokens` 要一起清（`handleDeleteAccount` 的清單多一張表）。

## 五、Worker 怎麼打 APNs

```
POST https://api.push.apple.com/3/device/<token>
  authorization: bearer <JWT>
  apns-topic: com.bounceto.workschedule
  apns-push-type: alert
  apns-priority: 10
  apns-collapse-id: <kind>            ← 同一種通知只留最新一則
  { "aps": { "alert": { "title": …, "body": … }, "sound": "default" } }
```

JWT 是 **ES256**，用 App Store Connect 的 `.p8` 金鑰簽：`{ alg:'ES256', kid:<APNS_KEY_ID> }` / `{ iss:<APNS_TEAM_ID>, iat:<now> }`。**WebCrypto 直接做得到**——`importKey('pkcs8', …, {name:'ECDSA', namedCurve:'P-256'})` 再 `sign`，與 `src/apppurchase.js` 驗 Apple 簽章用的是同一套 API，不必引進任何套件。

- **JWT 要快取。** Apple 要求同一把金鑰的 token 至少 20 分鐘才換一次，而且上限是 60 分鐘。快取 **50 分鐘**，存在模組變數裡（Worker 的隔離區會重用，重建就重簽，沒有正確性問題）。
- **`apns-collapse-id`**：同一種通知只留最新一則。cron 重試時不該在鎖定畫面上疊三則一樣的。
- **410 Gone → 刪掉那個 token。** 那是 Apple 在說「這支手機上已經沒有你的 app 了」。不刪的話，這張表會慢慢長滿再也送不到的 token，而每天都會為它們各打一次 API。
- **400 BadDeviceToken 也刪。** 同上，只是原因不同（token 格式不對或環境搞錯）。
- **其他錯誤只記不刪**：一次 5xx 不代表這支手機不見了。

### 最大的技術風險：Workers 打得到 APNs 嗎

**APNs 只收 HTTP/2。** Cloudflare Workers 的 `fetch()` 對外連線由 Cloudflare 自己協商協定，而它支援 HTTP/2 到來源——所以這條路應該通，但**我沒有辦法在這個環境裡證明它**（需要真的 `.p8` 金鑰與真的 device token）。

所以這件事不靠祈禱，靠**讓它第一天就說得出話**：

- `POST /api/admin/push-test`（管理者）：對自己的裝置立刻送一則，把 APNs 回的狀態碼與 body 原樣回給管理頁。設定完成當天就能證明它通不通，不必等到隔天早上八點才發現一片安靜。
- cron 的推播那一步走 `step()`，成功與失敗都寫進 `cron_runs`，`/admin` 看得到。理由同〈看得見的備份才是備份〉。
- 若真的不通（協定被拒），**退路是 Cloudflare Queues 或一台小中繼**，但那要等證明不通之後再說——現在先不為它設計。

## 六、app 那一側

Swift 插件多兩個方法（名字與 `index.html` 逐字相同，`tools/check-native-plugin.mjs` 比對）：

| 方法 | 做什麼 |
|---|---|
| `requestPush()` | 要通知權限 → 註冊 remote notifications → 回 `{ granted, token, environment }` |
| `pushStatus()` | 只問現況，不跳權限對話框：回 `{ authorized, token }` |

- **權限對話框只在使用者按下「開啟推播」時才跳**，不在啟動時跳。iOS 只讓你問一次，開機就問的轉換率遠低於「他自己按了那顆按鈕」之後才問。
- `environment` 讀 `aps-environment` entitlement（`development` / `production`），決定 Worker 要打 sandbox 還是正式的 APNs。**搞錯的症狀是 400 BadDeviceToken**，而那看起來像「token 壞了」，會往完全錯誤的方向查。
- `AppDelegate` 要實作 `didRegisterForRemoteNotificationsWithDeviceToken`。這是**又一條跨檔案的接線**，與 build 7～10 那次同一個形狀，所以 `check-native-plugin.mjs` 也要驗它在不在。
- Xcode 專案要開 **Push Notifications capability**，`App.entitlements` 要有 `aps-environment`。

前端：帳號頁的「提醒」區多三個推播開關；按下去先要權限，拿到 token 就 `POST /api/push/register`。**權限被拒絕時要說出來**（「iOS 的通知權限被關掉了，要到設定裡打開」），不能只是開關彈回去——那是最典型的沉默。

## 七、使用者要做的事（依序）

1. **Apple Developer → Certificates, Identifiers & Profiles → Keys → 新增一把金鑰**，勾 **Apple Push Notifications service (APNs)**，下載 `.p8`（**只能下載一次**）
2. 記下 **Key ID**（10 碼）與 **Team ID**（10 碼）
3. **Identifiers → 你的 App ID → 勾選 Push Notifications**
4. 把三個值設成 Worker 的 secret（**不要貼進對話**）：
   ```
   npx wrangler secret put APNS_KEY_ID
   npx wrangler secret put APNS_TEAM_ID
   npx wrangler secret put APNS_P8        # .p8 檔案的完整內容，含 BEGIN/END 那兩行
   ```
5. 跑 migration：`npx wrangler d1 execute work-schedule-db --remote --file=./migrations/008-push.sql`（**部署新 Worker 之前**，理由同〈資料庫結構變更〉）
6. 部署 → 在 app 裡打開推播 → 到 `/admin` 按「送一則測試推播」確認真的收得到

**沒設 secret 時推播那一步要安靜地跳過並記成「未設定」，不是失敗。** 同 `TURNSTILE_SECRET` 未設定時擋下註冊的反向：那個沒設定會讓防線失效，所以要擋；這個沒設定只是功能還沒開，把它記成紅色會讓管理頁天天發假警報。

## 八、測試計畫

`tests/push.test.mjs`：

- APNs JWT：header 的 `alg`/`kid`、payload 的 `iss`/`iat`，而且**同一分鐘內第二次呼叫不重簽**（快取）
- `POST /api/push/register`：同一個 token 換人登入 → `user_id` 被搬走，不是長出第二列
- 410 與 400 BadDeviceToken → 那一列被刪；500 → 留著
- 三個開關各自獨立：關掉 `push_overdue` 不影響 `push_streak`（同 email 那兩個）
- 「沒事就不推」：沒有逾期也沒有即將到期 → 一次 fetch 都沒發
- 同一天只推一次（`push_*_ymd`）；**送失敗刻意不寫那個欄位**（同 `last_sent_ymd`）
- 刪除帳號 → `device_tokens` 清空，**別人的每一列原樣**

**突變驗證**：拿掉 410 的刪除 → 那條紅；把三個開關合成一個 → 獨立性那條紅；拿掉「沒事就不推」→ 那條紅；把 JWT 快取拿掉 → 快取那條紅。

`tools/check-native-plugin.mjs` 多驗：`requestPush`／`pushStatus` 兩側名稱一致、`AppDelegate` 有 `didRegisterForRemoteNotificationsWithDeviceToken`、entitlements 有 `aps-environment`。

真機只能靠 TestFlight，而驗收同〈事故紀錄的結案〉那條：**要指名看哪裡**——`/admin` 的測試推播收得到，而且隔天早上八點真的有一則。

## 九、刻意不做的事

- **不做推播的「稍後提醒」與互動按鈕**：那要 Notification Service Extension，而且要處理「在通知上勾完成」之後的同步衝突。先看有沒有人用。
- **不做 Android／Web Push**：目前只有 iOS app。Web Push 要另一套金鑰與另一條 service worker 路徑。
- **不推任何排程內容以外的東西**（行銷、公告）：這個 app 的通知只講「你有事要做」。一旦開始推別的，使用者會整個關掉。
- **通知內容不含項目標題以外的細節**：鎖定畫面是別人也看得到的地方。
