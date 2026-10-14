# App Store Connect 新手設定指南

這份指南是給已經有 Apple Developer Program 的 Josh。它只說明需要在 Apple、Google 與 Cloudflare 後台手動完成的設定。程式不會替你建立帳號、接受合約或送出審查。

## 先記下這些固定值

請逐字輸入，不要自行改大小寫。

| 欄位 | 值 |
|---|---|
| App 名稱 | `工作排程` |
| Bundle ID | `com.bounceto.workschedule` |
| 最低 iOS | `16.0` |
| App Store Server Notifications | `https://work-schedule.bounceto12340.workers.dev/api/apple/notifications` |
| 支援網址 | `https://work-schedule.bounceto12340.workers.dev/support.html` |
| 行銷網址 | `https://work-schedule.bounceto12340.workers.dev/support.html` |
| 隱私權政策網址 | `https://work-schedule.bounceto12340.workers.dev/privacy.html` |
| Pro 訂閱群組 ID | `pro` |
| Pro 每月商品 ID | `com.bounceto.workschedule.pro.monthly` |
| Pro 每年商品 ID | `com.bounceto.workschedule.pro.yearly` |

目前沒有 lifetime 商品。Pro 只有兩個自動續訂商品：

- 每月 US$10.00
- 每年 US$100.00

程式會從 StoreKit 讀取實際本地化價格，商店價格欄位是預設美國價格。台灣商店的顯示金額由 Apple 管理。

## 一、建立 App Store Connect App record

1. 登入 [App Store Connect](https://appstoreconnect.apple.com/)。
2. 選「我的 App」。
3. 按右上角「＋」並選「新增 App」。
4. 填入：
   - 「平台」：`iOS`
   - 「名稱」：`工作排程`
   - 「主要語言」：`繁體中文`
   - 「套件組合 ID」：選 `com.bounceto.workschedule`
   - 「SKU」：`work-schedule-ios`
   - 「使用者存取權」：依 Josh 的團隊權限選擇
5. 按「建立」。
6. 在「App 資訊」填：
   - 「隱私權政策 URL」：`https://work-schedule.bounceto12340.workers.dev/privacy.html`
   - 「支援 URL」：`https://work-schedule.bounceto12340.workers.dev/support.html`
   - 「行銷 URL」：`https://work-schedule.bounceto12340.workers.dev/support.html`
7. App 是通用 App，因為 Xcode target 同時包含 iPhone 與 iPad。準備 iPhone 6.9 吋、6.7 吋與 iPad 13 吋截圖，最後以 App Store Connect 顯示的必要尺寸為準。

## 二、Apple Developer 的 App ID 與 Sign in with Apple

1. 登入 [Apple Developer Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list)。
2. 找到或建立 App ID：
   - 「Description」：`Work Schedule`
   - 「Bundle ID」：`com.bounceto.workschedule`
3. 勾選：
   - `Push Notifications`
   - `Sign in with Apple`
4. 按「Save」。
5. 在 App Store Connect 的 App 版本頁，確認登入方式包含「Sign in with Apple」。
6. Sign in with Apple 的服務設定需使用同一個 App ID。若之後需要網頁版 OAuth，再另外建立 Service ID；不要把 Service ID 當成 iOS Bundle ID。

程式會把 Apple `sub` 存在 `oauth_identities`，而不是只相信 email。帳號刪除時，Worker 會用儲存的 Apple refresh token 呼叫 Apple revoke endpoint；因此下面的 Apple server secret 必須設定。

## 三、建立 Google OAuth iOS client

Google 登入使用原生 `ASWebAuthenticationSession` 與 PKCE，不在 app 裡放 Google client secret。

1. 開啟 [Google Cloud Console](https://console.cloud.google.com/)。
2. 建立或選取專案，例如：
   - Project name：`Work Schedule`
3. 到「APIs & Services」→「OAuth consent screen」：
   - User type：依 Josh 的帳號類型選 `External` 或 `Internal`
   - App name：`工作排程`
   - User support email：Josh 的客服 email
   - Developer contact information：`bounceto12340@gmail.com`
   - Authorized domains：`bounceto12340.workers.dev`
   - Privacy policy URL：`https://work-schedule.bounceto12340.workers.dev/privacy.html`
   - Application home page：`https://work-schedule.bounceto12340.workers.dev/support.html`
4. 到「APIs & Services」→「Credentials」→「Create Credentials」→「OAuth client ID」。
5. Application type 選 `iOS`。
6. 填入：
   - Name：`Work Schedule iOS`
   - Bundle ID：`com.bounceto.workschedule`
7. 按「Create」並複製產生的 iOS client ID。它的形狀通常是 `1234567890-xxxxx.apps.googleusercontent.com`。
8. 將 client ID 填到：
   - `public/index.html` 的 `GOOGLE_IOS_CLIENT_ID`
   - `mobile/ios/App/App.xcodeproj/project.pbxproj` Debug 與 Release 的 `GOOGLE_REVERSED_CLIENT_ID`，格式為 `com.googleusercontent.apps.<client-id 去掉 .apps.googleusercontent.com 後的反向值>`。實際值請以 Google Console 顯示的 reversed client ID 為準。
   - Worker 的 `GOOGLE_IOS_CLIENT_ID`
9. 這個 app 使用的 redirect URI 是：
   `com.googleusercontent.apps.REPLACE_WITH_GOOGLE_IOS_CLIENT_ID:/oauth2redirect/google`
   將其中的 placeholder 替換成實際 reversed client ID，同時更新 `public/index.html` 的 `GOOGLE_REDIRECT_URI` 與 Worker 的 `GOOGLE_IOS_REDIRECT_URI`。
10. 在 Google OAuth consent screen 按「Publish App」。如果暫時維持 Testing，必須把 Josh 的 Google 帳號加入「Test users」。

Google 回傳的 ID token 會在 Worker 端驗證 audience、issuer、subject、email 與 email_verified。app 不會把 Google client secret 打包進去。

## 四、建立 Pro 訂閱群組與兩個商品

1. 回到 App Store Connect，打開「工作排程」App。
2. 選「功能」→「App 內購買項目」。
3. 按「建立」→「訂閱群組」。
4. 填：
   - Reference Name：`Pro`
   - Group ID：`pro`
5. 在這個群組按「建立訂閱」：

### 商品一：Pro 每月

- Reference Name：`Pro Monthly`
- Product ID：`com.bounceto.workschedule.pro.monthly`
- Subscription Duration：`1 Month`
- Price：`US$10.00`，Tier 請選出現 US$10.00 的價格級別
- Family Sharing：`Off`
- 繁體中文顯示名稱：`Pro 每月方案`
- 繁體中文描述：`每月自動續訂，解鎖 Pro 上限。`
- English Display Name：`Pro Monthly`
- English Description：`Unlocks Pro limits with automatic monthly renewal.`

### 商品二：Pro 每年

- Reference Name：`Pro Yearly`
- Product ID：`com.bounceto.workschedule.pro.yearly`
- Subscription Duration：`1 Year`
- Price：`US$100.00`，Tier 請選出現 US$100.00 的價格級別
- Family Sharing：`Off`
- 繁體中文顯示名稱：`Pro 每年方案`
- 繁體中文描述：`每年自動續訂，解鎖 Pro 上限。`
- English Display Name：`Pro Yearly`
- English Description：`Unlocks Pro limits with automatic yearly renewal.`

6. 確認兩個商品都在同一個 `Pro` subscription group。
7. 上傳 IAP review screenshot。截圖必須顯示 app 內的訂閱畫面、商品名稱、Apple 顯示的價格與「恢復購買」按鈕，不要只上傳 App Store 商品管理頁。
8. 按「Submit for Review」送出兩個 IAP。IAP 可以和 app build 一起審查，也可以先送商品審查。

程式的 StoreKit 本機設定檔在 `mobile/ios/App/App/Configuration.storekit`，包含以上兩個商品、US$10／US$100 測試價格、月／年週期與中英文文案。Xcode 本機測試時，在 Scheme → Run → Options → StoreKit Configuration 選這個檔案。

## 五、Paid Apps、稅務與銀行

1. 在 App Store Connect 打開「商務」→「協議、稅務與銀行」。
2. 接受「Paid Apps Agreement」。
3. 完成：
   - Contact Information
   - Banking Information
   - Tax Forms
4. 確認合約狀態是 `Active`，再測 StoreKit 商品。合約未生效時，app 可能拿到空的商品清單。

## 六、App Privacy 填寫方向

在 App Store Connect「App 隱私權」按「開始」：

- 「資料收集」：選擇有收集。
- Email Address：
  - 用途：`App Functionality`
  - 與使用者連結：`Yes`
  - 用於追蹤：`No`
- User ID：
  - 用途：`App Functionality`
  - 與使用者連結：`Yes`
  - 用於追蹤：`No`
- Device ID／APNs token：
  - 用途：`App Functionality`
  - 與使用者連結：`Yes`
  - 用於追蹤：`No`
- Purchase History／subscription transaction identifier：
  - 用途：`App Functionality`
  - 與使用者連結：`Yes`
  - 用於追蹤：`No`
- User Content：
  - 內容包含排程、專案、每日記錄與筆記
  - 用途：`App Functionality`
  - 與使用者連結：`Yes`
  - 用於追蹤：`No`
- 「追蹤」：`No`
- 「第三方廣告」：`No`

這些答案要和 [`public/privacy.html`](../public/privacy.html) 以及 `mobile/ios/App/App/PrivacyInfo.xcprivacy` 一致。若 Josh 新增分析 SDK、廣告或其他第三方服務，必須重新填寫。

## 七、年齡分級

在「App 資訊」→「年齡分級」按「編輯」，依實際內容回答。這是工作與生產力工具，不含公開社群、賭博、暴力或成人內容。不要為了得到較低分級而隱瞞使用者可能輸入的工作文字。

## 八、上傳 build、測試並送審

1. 先確認 Worker 已完成 `migrations/001` 到 `migrations/013`，並設定：
   - `GOOGLE_IOS_CLIENT_ID`
   - `GOOGLE_IOS_REDIRECT_URI`
   - `APPLE_SIGN_IN_TEAM_ID`
   - `APPLE_SIGN_IN_KEY_ID`
   - `APPLE_SIGN_IN_PRIVATE_KEY`
   - `APPLE_SIGN_IN_CLIENT_ID=com.bounceto.workschedule`
2. 在 GitHub Actions 手動執行 iOS workflow。第一次可把 `upload` 設為 `false`，確認 archive；正式上傳再設為 `true`。
3. 等 build 在 App Store Connect 完成 processing。
4. 加入 TestFlight Internal Testing，驗證：
   - Google 登入
   - Sign in with Apple
   - 關閉 app 後重新開啟
   - 同一帳號在另一台裝置登入
   - Pro 每月與 Pro 每年購買
   - 原生「恢復購買」按鈕
   - 網頁登入後仍看到 Pro
   - app 內刪除帳號後 Apple credential 被撤銷
5. 在「App Store」頁完成：
   - 繁體中文與英文名稱、subtitle、description、keywords
   - iPhone 6.9 吋與 6.7 吋截圖
   - iPad 13 吋截圖
   - App Privacy、年齡分級、支援網址、行銷網址、隱私權政策網址
   - App Review Notes
6. App Review Notes 建議填：
   - 測試帳號：提供可以用 Google 或 Apple 登入的測試帳號
   - 測試方式：進入「我的帳號」→「方案」，測試兩個訂閱與「恢復購買」
   - 說明：訂閱權利綁定 app 帳號 UUID，不綁定單一裝置；同帳號在另一台裝置或網頁可看到 Pro
   - 支援頁：`https://work-schedule.bounceto12340.workers.dev/support.html`
7. 確認兩個 IAP 都在本次版本選取後，按「Add for Review」。
8. 按「Submit for Review」。截至目前尚未送出審查。
