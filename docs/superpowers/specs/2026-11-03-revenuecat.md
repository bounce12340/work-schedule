# 工作排程確認系統改接 RevenueCat：計畫

狀態：**計畫，還沒動任何程式。** 使用者 2026-11-03 選了「讓工作排程確認系統改用 RevenueCat 收費」（不是另建的「藍綠攻防戰」專案）。

## 現在的樣子（不要弄壞的東西）

收費已經是我們自己做好的一整條路，而且有測試守著：

| 段落 | 在哪裡 | 做什麼 |
|---|---|---|
| 買 | `mobile/ios/App/App/WorkScheduleNativePlugin.swift` 的 `purchase` | StoreKit 2，**一定帶 `appAccountToken`**（= 我們的 user id），買完回 JWS |
| 驗 | `src/apppurchase.js` | 離線驗 Apple 的憑證鏈與簽章，不打 Apple 的 API |
| 記 | `src/handlers/planapple.js` 的 `applyEntitlement` | 寫 `users.plan_source` / `plan_expires_at` / `apple_original_txn`：只往後、退款往前、`admin` 不被蓋掉、搬移 |
| 續訂與退款 | `POST /api/apple/notifications` | Apple 的伺服器通知，網頁版的人不開 app 也會被續上 |
| 判斷 Pro | `src/plan.js` 的 `planOf` | 只看那兩個欄位，3 天寬限 |

商品：`com.bounceto.workschedule.pro.monthly`（US$10）、`com.bounceto.workschedule.pro.yearly`（US$100）。App Store Connect 的上架清單（`docs/app-store-checklist.md`）還沒勾完，**app 還沒正式收過錢**——現在換最便宜，沒有舊訂閱戶要搬。

**`planOf` 只看資料庫的兩個欄位**這件事不改。不管選哪個方案，RevenueCat 都只是「告訴 Worker 該寫什麼」的另一個來源，Worker 永遠不在請求當下去問 RevenueCat（同〈方案與上限〉：沒有網路依賴、沒有限流）。

## 兩個方案

### 方案甲：RevenueCat 當「記帳本」（建議先做這個）

買東西、驗收據、寫權利，**全部照舊**。只是讓 RevenueCat 也看得到每一筆，換到它的圖表、客戶清單、流失分析。

1. **iOS**：加 RevenueCat iOS SDK（Swift Package），在 `WorkScheduleNativePlugin` 裡設定
   `Purchases.configure(withAPIKey: <公開 SDK key>, appUserID: <user id>)` 並加上
   `.with(purchasesAreCompletedBy: .myApp, storeKitVersion: .storeKit2)`——意思是「買是我們自己買，你看著就好」。
   登入／換人時 `Purchases.shared.logIn(user.id)`，登出時 `logOut()`。
   買完之後多叫一次 `Purchases.shared.recordPurchase(...)`，讓它當場就知道。
   **JS 那一側一個字都不用改**：還是同一組 `nativePromise('WorkScheduleNativePlugin', …)` 方法名（〈跨語言的接線〉那一條）。
2. **Apple 伺服器通知**：App Store Connect 填 RevenueCat 給的網址，再在 RevenueCat 的 app 設定裡把
   「Apple Server Notification Forwarding URL」設成我們的 `/api/apple/notifications`。
   RevenueCat 官方文件建議這個方向（Apple 只收一個網址）。我們的端點照舊驗 Apple 的簽章，所以轉手一次不會變得比較不安全。
3. **Worker**：不改。

代價：iOS 多一個第三方套件（app 的 `mobile/` 有自己的 `package.json`／Xcode 專案，根目錄零相依不受影響）；RevenueCat 公開 SDK key 會在 app 裡（它本來就是給 app 用的公開 key，不是秘密）。

拿不到的：RevenueCat 的付費牆、A/B 價格實驗、Android／網頁收費——那些要方案乙。

### 方案乙：RevenueCat 當「收銀機」

1. **iOS**：同樣在自己的 Swift 插件裡用 RevenueCat SDK，但改成由它來買（`Purchases.shared.purchase(package:)`）。**不用** `@revenuecat/purchases-capacitor` 的 JS 那一層：單檔 HTML 沒有 `@capacitor/core`，那正是 build 7～10 追了四輪的 bug class。
2. **Worker**：新增 `POST /api/revenuecat/webhook`，收 RevenueCat 的 webhook（`INITIAL_PURCHASE`／`RENEWAL`／`CANCELLATION`／`EXPIRATION`／`BILLING_ISSUE`／`TRANSFER`…），照樣寫 `plan_source` / `plan_expires_at`。「只往後」「`admin` 不被蓋」「退款往前」這些規則要搬過去一份，`tests/plan-apple.test.mjs` 那一批測試要照抄成 webhook 版。
   webhook 的驗證靠 RevenueCat 送來的 `Authorization` 標頭（在 RevenueCat 後台設定，值放 Worker secret `REVENUECAT_WEBHOOK_AUTH`，**不進對話、不進 repo**）。
3. `src/apppurchase.js` 的訂閱驗簽與 `/api/plan/apple` 留到確認沒有人走之後再拆。**購買證明（AppTransaction，一個 Apple ID 一個帳號）不動**，那是防濫用，跟收費無關。

代價：大約一個完整的 PR，等於把 E2／E3 重做一次；webhook 的語意與 Apple 通知不一樣（例如 `CANCELLATION` 是「不續訂」，不是「立刻失效」——同〈`DID_CHANGE_RENEWAL_STATUS` 一個欄位都不改〉），每一條都要重新想、重新測。

## 建議

**先做甲。** app 還沒上架，現有那條路有測試、有突變驗證；甲只加東西不拆東西，壞了也只是 RevenueCat 那邊少了資料，使用者照樣買得到、照樣是 Pro。等上架後真的需要付費牆或 Android，再從甲升級到乙——甲做的 SDK 設定、`logIn(user.id)`、商品對照在乙裡全部沿用。

## RevenueCat 後台要準備的（兩個方案都一樣）

| 項目 | 值 | 誰做 |
|---|---|---|
| 新專案 | 「工作排程確認系統」（**不要用「藍綠攻防戰」那個**） | Claude 透過 MCP，等使用者同意 |
| App Store app | bundle id `com.bounceto.workschedule` | Claude 透過 MCP，等使用者同意 |
| In-App Purchase Key（`.p8`）、App Store Connect API key | 上傳到那個 app 的設定頁 | **使用者自己在 RevenueCat 後台上傳**——秘密不經過對話 |
| 會員資格（entitlement） | `pro` | Claude |
| 商品 | 上面那兩個 product id，掛到 `pro` | Claude（只在 RevenueCat 登記，不動 App Store） |
| 商品組合（offering） | `default`，`$rc_monthly`／`$rc_annual` 兩個 package | Claude |
| 公開 SDK key | 從那個 app 讀出來，寫進 Swift（公開的，可以進 repo） | Claude |

**「藍綠攻防戰」那個專案保持原樣**，不刪不改。

## 驗證

- 甲：`tools/check-native-plugin.mjs` 照跑（方法名沒變）；本機 Mac 編一次（〈開發者有 Mac 了〉）；TestFlight 買一次，RevenueCat 的客戶清單裡要出現那個 user id，而且 `/admin` 上那個帳號仍是 Pro——**兩邊都要看到才算數**。
- 乙：上面全部，再加 webhook 的單元測試（照 `tests/plan-apple.test.mjs` 的八條規則各一條、各做一次突變驗證）。
