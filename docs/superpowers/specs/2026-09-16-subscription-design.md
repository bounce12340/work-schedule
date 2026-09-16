# 子專案 E：訂閱制（免費版有上限，Pro 月付／年付）

日期：2026-09-16
狀態：**設計定案**（三個假設已於 2026-09-16 確認，見最後一節）；E0／E1 實作中

## 使用者的決定

| 問題 | 決定 |
|---|---|
| 價錢與週期 | **月付 US$5、年付 US$50**（年付省兩個月） |
| 免費試用 | **有，而且不設期限**。免費版永遠能用，只是**專案數最多三個**；第四個要訂閱 |
| 沒訂閱的人能做什麼 | 免費版有功能上限（上一條就是那條上限） |
| 網頁版與 app | **同一個帳號、同一份訂閱**：在 app 裡訂了，網頁版也是 Pro |
| 既有的兩個帳號 | **永久有效**，不用付 |
| 沒登入能不能用 | **不能。必須登入才能使用**（見〈E0〉） |

## 這改變了什麼

`2026-09-14-ios-app-design.md` 的第一個前提是「付費下載，不是訂閱」，而那份文件有一整節在解釋**為什麼不需要 IAP**。這個決定把那一節整個翻過來：

| 原本 | 現在 |
|---|---|
| App Store 定價付費下載，下載那一刻收完錢 | **免費下載**，錢在 app 裡以**自動續訂訂閱**（IAP）收 |
| 不需要 IAP | **一定要 IAP**：Apple 3.1.1 規定 app 裡解鎖的功能只能走 IAP |
| 後端只回答「這個帳號的主人買了 app 嗎」 | 後端要回答「這個帳號**現在**是不是 Pro、到什麼時候」，而且答案會隨時間變 |
| 購買證明（AppTransaction）是註冊的門票 | AppTransaction 免費 app 也有，**保留**它當「一個 Apple ID 一個帳號」的防濫用機制（免費版有上限，開十個帳號就是繞過上限的最直接方法）。註冊不再因為「沒付錢」被擋 |

app 還沒送審過（只在 TestFlight），所以**沒有既有付費使用者要過渡**——在第一次送審前把 App Store 的價格改成免費就好。Paid Apps Agreement 與銀行／稅務資料**照樣要填**：IAP 收的錢一樣要有地方匯。

## 一、方案的定義

只有兩個方案，名字寫死在程式裡：

| | `free` | `pro` |
|---|---|---|
| 大項目（`majorProjects`） | **最多 3 個** | 不限 |
| 甘特專案（`ganttProjects`） | **最多 3 個** | 不限 |
| 小項目、日曆、每日記錄、提醒信、ICS、分享、匯出匯入 | 不限 | 不限 |
| AI 小幫手 | **每天 5 次** | 每天 20 次（現況） |

上限集中在一個物件，前端與 Worker 各一份**但形狀相同、有測試比對兩邊一致**：

```js
const PLAN_LIMITS = {
  free: { majorProjects: 3, ganttProjects: 3, aiPerDay: 5 },
  pro:  { majorProjects: Infinity, ganttProjects: Infinity, aiPerDay: 20 },
};
```

「三個以下」的邊界：**3 個可以，第 4 個要訂閱。**

### 降級不刪資料

Pro 到期後變回 `free` 的人可能有 10 個專案。**一個都不刪、一個都不鎖**：全部照常看、照常改、照常勾。只是**不能再新增**，直到數量回到上限以下或重新訂閱。理由與〈刪除一律走 `deleteWithUndo()`〉相同：把人的資料變不見是最壞的事，付費與否都一樣。

因此伺服器端的規則不是「數量 ≤ 上限」，而是：

> 新的數量 ≤ max(上限, 舊的數量)

只有**變多而且超過上限**才擋。這條規則是單一純函式 `exceedsPlanCap(oldState, newState, plan)`，有測試。

### 為什麼伺服器一定要擋，前端擋了還不夠

`public/index.html` 是任何人都下載得到的檔案，前端的「新增」按鈕變灰只是禮貌；改一下 localStorage 再同步上去就繞過了。付費牆若只在前端，等於沒有。所以 `handlePutState` 在寫入前跑一次 `exceedsPlanCap`，超過回 **402**（Payment Required）並附上是哪一種東西超過、上限多少。前端收到 402 不當成同步失敗——那是「你的本機比雲端多了東西、而你沒訂閱」，狀態列要講清楚，並提供「升級」與「刪掉多的」兩個出口。

**三方合併的互動**：被分享者的 `PUT /api/shared/:id` 只能改完成狀態，不會改專案數，不用檢查。擁有者自己兩台裝置各加一個專案到 3+1 也會在 PUT 時被擋，同一條規則。

## 二、權利只有一個真相來源

「這個帳號是不是 Pro」只看 `users` 表上的欄位，**不在請求當下問 Apple**（同〈購買證明〉的離線驗簽：沒有網路依賴、沒有限流、沒有另一把金鑰）。

```sql
-- migrations/006-plan.sql
ALTER TABLE users ADD COLUMN plan_source        TEXT;     -- 'apple' | 'admin'；NULL = 免費
ALTER TABLE users ADD COLUMN plan_expires_at    INTEGER;  -- ms；NULL 而 plan_source 非 NULL = 永久
ALTER TABLE users ADD COLUMN apple_original_txn TEXT;     -- 訂閱的 originalTransactionId
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_original_txn ON users(apple_original_txn);

CREATE TABLE IF NOT EXISTS plan_events (
  id                TEXT PRIMARY KEY,
  user_id           TEXT,                 -- 通知對不到帳號時為 NULL，仍然要記
  source            TEXT NOT NULL,        -- 'app' | 'apple_notification' | 'admin'
  kind              TEXT NOT NULL,        -- 'subscribed' | 'renewed' | 'expired' | 'refunded' | 'revoked' | 'transferred' | 'admin_set'
  original_txn      TEXT,
  notification_uuid TEXT UNIQUE,          -- Apple 通知的去重鍵
  expires_at        INTEGER,
  detail            TEXT,
  created_at        INTEGER NOT NULL
);
```

判斷是純函式：

```js
export function planOf(user, nowMs) {
  if (!user.plan_source) return 'free';
  if (user.plan_expires_at == null) return 'pro';           // 永久（既有的兩個帳號）
  return user.plan_expires_at + GRACE_MS > nowMs ? 'pro' : 'free';
}
```

`GRACE_MS` 是 **3 天**：Apple 續訂失敗有 billing retry，這幾天 Apple 那邊仍算訂閱中；沒有這段的話，信用卡過期當天使用者就被降級，而 Apple 自己還在幫他重試。

`GET /api/state` 順帶回的 `user` 多兩個欄位：`plan` 與 `planExpiresAt`。理由同原本順帶回 `user`：前端啟動時本來就要知道，不必多一趟。

### 既有兩個帳號永久有效

`plan_source = 'admin'`、`plan_expires_at = NULL`，由管理者在 `/admin` 設定，**不寫在 migration 裡**——那會把 email 寫進公開的 repo。`/admin` 的使用者列多一個「方案」控制：免費／Pro 到某日／永久。改動記進 `admin_activity`（描述由伺服器產生：`方案 free → pro（永久）`），理由同其他管理者操作。

管理者手動設定的 Pro **不會被 Apple 的通知蓋掉**：`plan_source = 'admin'` 的列，通知處理器只記 `plan_events`、不改欄位。否則永久帳號的主人只要在 app 裡試訂一次再取消，到期那天就會被降回免費。

## 三、寫入權利的三條路

### 3.1 app 推交易上來（主要路徑）

StoreKit 2 的每一筆交易都是 Apple 簽的 JWS，**與 AppTransaction 同一條憑證鏈、同一種簽章**。`src/apppurchase.js` 的 `verifyAppTransaction` 拆成兩層：底層 `verifyAppleJws(jws, opts)` 只驗鏈、驗簽、驗 bundleId 與環境並回 payload；上層 `verifyAppTransaction` 與新的 `verifySubscriptionTransaction` 各自讀自己的欄位。`tests/fake-apple.mjs` 原樣可用。

```
POST /api/plan/apple          Bearer
{ signedTransaction: "<JWS>" }
→ 200 { plan, planExpiresAt }
→ 400 { error }               驗不過、不是我們的 productId、不是訂閱
→ 409 { error }               這份訂閱綁在別的帳號（見下）
```

伺服器讀 `productId`（必須是兩個已知的 id 之一）、`expiresDate`、`originalTransactionId`、`revocationDate`。寫入規則：

- `revocationDate` 有值（退款）→ 當成到期，`plan_expires_at = revocationDate`
- 否則 `plan_source = 'apple'`、`plan_expires_at = expiresDate`、`apple_original_txn = originalTransactionId`
- **只往後不往前**：送上來的 `expiresDate` 比資料庫的還早就不寫（app 可能送舊交易）。退款是唯一例外

app 在**三個時機**送：購買成功當下、每次啟動時把 `Transaction.currentEntitlements` 全部送一次、按「恢復購買」時。啟動時送是為了讓「在 app 裡續訂、然後只用網頁」的人也拿得到新的到期日——但這條路有個洞，3.2 補它。

**同一份訂閱綁到第二個帳號**（`apple_original_txn` UNIQUE 撞到）：訂閱屬於 Apple ID 不屬於我們的帳號，使用者換帳號登入再「恢復購買」是 Apple 設想中的正常操作。所以**不是拒絕，是搬過去**：舊帳號的 `plan_source`／`plan_expires_at`／`apple_original_txn` 清空，新帳號接手，`plan_events` 記一筆 `transferred`（兩邊的 user_id 都記在 detail）。代價是兩個人共用一個 Apple ID 可以互相搶，那要先共用 Apple ID，不是我們該擋的。UNIQUE 索引還是要：它擋的是「同一筆交易被兩個帳號同時算成 Pro」，搬移用單句帶條件的 UPDATE，理由同〈樂觀鎖必須是單句 SQL〉。

### 3.2 Apple 的伺服器通知（補洞）

「取消訂閱、再也不開 app」**不是**洞：資料庫存的是到期日，到了那天自然變回 free。真正的洞反過來：**Apple 續訂成功、使用者只用網頁、從不開 app** → 資料庫的到期日沒有人更新 → 網頁版把付了錢的人降級。收了錢還關門是最糟的形狀，所以這條列在 v1 而不是「之後再說」。

App Store Server Notifications V2 送到 `POST /api/apple/notifications`（不需要登入，Apple 打的）。payload 是 `signedPayload` JWS，**同一套 `verifyAppleJws` 驗**；裡面的 `data.signedTransactionInfo` 又是一個 JWS，再驗一次。處理：

- 驗不過 → 401，什麼都不寫（Apple 會重送，重送也驗不過就算了）
- `notificationUUID` 已在 `plan_events` → 200，不重做（Apple 會重送）
- 以 `originalTransactionId` 找帳號；找不到 → 200 並記 `plan_events`（user_id NULL）——找不到不是錯誤，可能是使用者先訂了還沒註冊
- `DID_RENEW`／`SUBSCRIBED` → 更新到期日（同 3.1 的「只往後」規則）
- `EXPIRED`／`REFUND`／`REVOKE`／`GRACE_PERIOD_EXPIRED` → 到期日設成通知裡的時間
- `DID_CHANGE_RENEWAL_STATUS`（取消自動續訂）→ **不改任何欄位**，只記事件：已付的那一期到期前仍是 Pro
- 其他型別 → 200 並記事件

**一律回 200 除了驗簽失敗**：回 5xx Apple 會重送，而「這筆我不認得」重送十次也不會變成認得。

App Store Connect 要填 URL：`https://work-schedule.bounceto12340.workers.dev/api/apple/notifications`，Production 與 Sandbox 各一格（填同一個）。

### 3.3 管理者手動（永久帳號、客服）

見第二節。`PATCH /api/admin/users/:id` 多收 `plan: { source: 'admin'|null, expiresAt: number|null }`。

## 四、上限的執行

### 前端

- `renderScheduleView()` 的「＋ 大項目」與 `renderGanttView()` 的「＋ 專案」：**數量到上限且方案是 free 時，按鈕仍在、仍可點**，點下去開「升級」說明而不是新增表單。按鈕消失會讓人以為功能不見了（同〈「我的帳號」分頁〉在單機模式仍存在的理由）。
- 「我的帳號」分頁多一區「方案」：目前方案、到期日、（app 內）訂閱／管理訂閱／恢復購買三顆按鈕；（網頁）一行說明「在 iPhone app 裡訂閱，網頁版會一起變成 Pro」。
- `cloudPush()` 收到 402 → 狀態列顯示「超過免費版上限，這次沒有同步」並開同一個升級說明。**不是**單機降級、也**不是**衝突對話框，是第三種狀態，`cloudPull`／`cloudPush` 的 `kind` 多一個 `'capped'`。

### 單機檔（file:// 或未部署）

**不能用**：使用者的裁決是「必須登入才能使用」，見〈E0〉。上限因此只有一種執行環境（登入後），不必分單機與雲端兩套。

### Worker

`handlePutState` 在樂觀鎖的 UPDATE 之前：

```js
const plan = planOf(user, Date.now());
const over = exceedsPlanCap(oldSnapshot, newSnapshot, plan);   // null 或 { kind:'majorProjects', count, limit }
if (over) return json({ error: '超過免費版上限', over }, 402);
```

`oldSnapshot` 是這次 PUT 帶的 `baseUpdatedAt` 對應的那一份——樂觀鎖本來就要讀它。AI 的每日上限改成依方案查 `PLAN_LIMITS[plan].aiPerDay`，其餘不動。

## 五、app 端（Swift 插件加四個方法）

`WorkScheduleNativePlugin.swift` 加 StoreKit 2：

| 方法 | 做什麼 |
|---|---|
| `getProducts()` | 回兩個 product 的本地化價格與週期，給訂閱畫面顯示（**價格一定要從 StoreKit 拿**，不能寫死 US$5：各國幣別與 Apple 的匯率換算都在那裡） |
| `purchase({ productId })` | 買；成功回 `jwsRepresentation`，前端送 `/api/plan/apple` |
| `currentEntitlements()` | 回目前有效的所有交易 JWS，啟動時與「恢復購買」用 |
| `manageSubscriptions()` | 開 iOS 的訂閱管理頁（取消要在那裡做，Apple 不讓 app 自己做取消） |

`Transaction.updates` 監聽器在 app 啟動時掛上：家庭共享、在別台裝置續訂、Ask to Buy 核准後都從這裡進來，收到就推 `/api/plan/apple`。

前端 `nativePlugin()` 多四個 `call(...)`，走既有的 `nativePromise`。

Product ID：`com.bounceto.workschedule.pro.monthly`、`com.bounceto.workschedule.pro.yearly`，同一個訂閱群組 `Pro`。價格點：Apple 只能從價格表選，最接近的是 **US$4.99 與 US$49.99**（台灣區由 Apple 換算，約 NT$150／NT$1,490）。

### Apple 審查對訂閱 app 的硬規定（缺一個就退件）

- 訂閱畫面上要有：價格、週期、「自動續訂、可隨時在設定裡取消」的說明、**隱私權政策與使用條款的連結**。使用條款目前沒有，要加 `public/terms.html`（同 `privacy.html` 不用登入）
- 一定要有「恢復購買」按鈕
- App Store 的 metadata 也要填兩個連結
- app 裡**不能提到**「網頁上訂比較便宜」或連到外部付款（台灣不在美國那條例外裡）。v1 沒有網頁付款，所以沒這個問題

## 六、E0：必須登入才能使用

原本的「不可破壞的前提」是 `index.html` 雙擊就能用、雲端只是漸進增強。使用者的裁決把它改掉了：**沒登入就不能用**。理由是付費牆——單機檔沒有上限、也不用帳號，等於免費版的上限只要「不要登入」就繞過去了。

**誠實的邊界**：`index.html` 是任何人都下載得到的檔案，前端的閘門在瀏覽器裡改一行就拆得掉，所以它擋的是「順手」而不是「刻意」。真正擋得住的是伺服器端：同步、分享、提醒、AI 都要帳號，上限在 `PUT /api/state` 執行。閘門的用途是讓「不登入」不再是一條**好走**的路。

規則只有一條，寫在 `runCloudSync` 的 `absent` 分支與開機腳本：

> 後端不存在（file:// 或 404）**而且**這台裝置從來沒有登入過（`cloudMeta.owner` 為空）→ 顯示全螢幕的「請登入」，什麼都不 seed、不 persist。

- **登入過、只是現在斷線**（`failed`）照舊：本機資料繼續用，理由同〈降級可以，沉默不行〉。離線後仍能看排程是 PWA 的價值，不能為了閘門砍掉。
- app（Capacitor）不走這條：`nativeBoot` 本來就沒 token 就顯示登入畫面。
- 線上網頁本來就由 Worker 的 302 擋著，閘門在那裡永遠不會出現；它只會在「把檔案存下來雙擊」或「放到別的靜態主機」時出現。
- 示範資料 `seed()` **只在閘門沒關上時**才跑——閘門關著還 seed 等於把示範資料寫進一個永遠用不到的 localStorage。

**對工具的影響**：`tools/` 底下九支瀏覽器腳本都是起一個「`/api/*` 回 404」的靜態伺服器，改完之後全部會撞到閘門。它們改成先把 `cloudMeta.owner` 寫好（共用的 `tools/lib/signed-in.mjs`）——測的是「登入過、後端不在」的狀態，那正是這些工具原本就在測的形狀（本機資料、沒有同步）。`smoke.mjs` 的「單檔開啟」兩輪改成驗閘門：中英文各一次，閘門要出現、零錯誤、而且 `localStorage` 裡**不能有** `workSchedule.v1`（證明沒有 seed）。

## 七、子專案切分

| 順序 | 內容 | 可以不靠 Apple 測嗎 |
|---|---|---|
| **E0** | 登入閘門（上一節）、`CLAUDE.md` 前提改寫、工具改用 `signed-in.mjs` | **可以** |
| **E1** | migration 006、`planOf`／`exceedsPlanCap`、`PUT /api/state` 回 402、AI 上限依方案、`/admin` 方案控制、`user.plan` 隨 `/api/state` 回來、前端上限與升級說明、帳號頁「方案」區、`terms.html` | **可以**。全部是 D1 與純函式，`tests/plan.test.mjs` 涵蓋；瀏覽器用假的 402 走一遍 |
| **E2** | `verifyAppleJws` 抽層、`verifySubscriptionTransaction`、`POST /api/plan/apple`（含搬移）、Swift 四個方法、訂閱畫面、啟動時推 entitlements | 驗簽與端點靠 `fake-apple.mjs`；購買流程要 TestFlight＋Sandbox 測試帳號 |
| **E3** | `POST /api/apple/notifications`、App Store Connect 填 URL | 處理器靠 `fake-apple.mjs` 簽假通知；線上用 App Store Connect 的「傳送測試通知」 |
| E4（之後） | 網頁付款（Stripe），給沒有 iPhone 的人 | — |

**E1 先做而且可以先上線**：上線那天所有帳號都是 free、兩個既有帳號設成永久，沒有任何人的體驗改變（兩個帳號都是永久，其餘帳號不存在）。E2 才開始有人能付錢。

**部署順序**：migration 006 → E1 的 Worker → `/admin` 把兩個帳號設永久。前兩步順序理由同 005；第三步若漏掉，兩位使用者的第四個專案會被擋——症狀明顯，當場就會知道。

App Store Connect 的設定（E2 前）：價格改免費、建訂閱群組與兩個 product、填審查用的截圖與說明、Paid Apps Agreement。

## 八、測試計畫

`tests/plan.test.mjs`（E1）：

- `planOf`：NULL → free；永久 → pro；到期前 → pro；到期後 3 天內 → pro（grace）；3 天後 → free
- `exceedsPlanCap`：3 → 4 擋；4 → 5（降級後）擋；5 → 5 不擋；5 → 4 不擋；pro 不擋；只看數量不看內容
- `handlePutState`：free 帳號 3 → 4 回 402 **而且資料庫那一列沒動**（樂觀鎖的 updated_at 也沒動）；pro 帳號同樣的 PUT 回 200
- 前後端的 `PLAN_LIMITS` 逐字相同（從 `index.html` 抽出來比）
- `/admin` 設方案：`admin_activity` 有描述；非管理者 403；ADMIN_EMAILS 名單內的帳號**可以**被設方案（這不是停用也不是降級，是給東西）

`tests/plan-apple.test.mjs`（E2／E3）：

- 假 Apple 簽的訂閱交易：對的 productId 寫進去；不認得的 productId 400；舊到期日不往前寫；退款寫成到期
- 搬移：帳號 B 送 A 的訂閱 → A 清空、B 接手、`plan_events` 一筆 `transferred`
- 通知：重複的 `notificationUUID` 不重做；`admin` 來源不被蓋；找不到帳號回 200 並記事件；驗簽失敗 401 且 `plan_events` 零筆

**突變驗證**（加完測試要做）：把 `exceedsPlanCap` 的 `max(limit, oldCount)` 改回 `limit`——降級測試要紅；把 grace 拿掉——grace 測試要紅；通知處理器拿掉 `admin` 判斷——永久帳號測試要紅。

瀏覽器（`tools/smoke.mjs` 已登入那一輪）：假的 `/api/state` 回 `plan: 'free'` 與三個大項目，按「＋ 大項目」要開升級說明而不是表單；回 `plan: 'pro'` 要開表單。

## 九、刻意不做的事

- **不接 App Store Server API**（主動查 Apple）：通知＋app 推送已經涵蓋，多一把金鑰多一個會壞的地方
- **不做促銷碼、免費月、介紹價**：先看有沒有人付
- **不在網頁上收錢**（E4 之後再說）：Apple 3.1.3(b) 允許「在別處買的訂閱在 app 裡用」，前提是 app 裡也買得到——所以 IAP 一定先於 Stripe，順序不能反
- **不做「免費版只能唯讀」**：那是把人的資料扣住當人質
- 退款後帳號仍在（同原本的決定），只是變回 free

## 十、三個原本沒說的地方，使用者的裁決

| | 原本我選的 | **裁決** |
|---|---|---|
| **A. 「專案」是哪一個** | 大項目與甘特專案各自最多 3 個 | **同**：兩種各 3 個 |
| **B. AI 在免費版** | 每天 3 次 | **每天 5 次** |
| **C. 單機檔（雙擊開啟、沒登入）** | 沒有上限 | **必須登入才能使用**——單機檔不再是一種使用方式（見〈E0〉） |
