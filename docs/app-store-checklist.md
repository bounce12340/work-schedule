# App Store 上架清單

這份文件是給 Josh 的手動清單。它不會建立 Apple 帳號、不會替你接受合約，也不會自動送審。

## 已決定的產品與建置設定

- 路徑：Capacitor 原生 iOS 外殼，主畫面是 `public/index.html`；原生能力只用 Swift plugin（Keychain、StoreKit 2、APNs、AppTransaction）。
- 為什麼不選 Expo／React Native：repo 已有可用的 Capacitor + Swift 專案、原生接線、StoreKit 2、APNs 與 GitHub macOS workflow；改成另一個前端棧會重寫登入、離線同步與訂閱整合，增加而不是降低上架風險。
- 建置不需要 Josh 自己有 Mac：`.github/workflows/ios.yml` 在 GitHub macOS runner 上執行 `npm ci`、`npm run sync`、`xcodebuild archive`、export 與可選的 App Store Connect upload。
- Bundle ID：`com.bounceto.workschedule`（請先確認這個 ID 是 Josh 所有的 Apple Developer team；若不是，必須在上架前一起更換 Xcode、Worker 驗證與 App Store 設定）。
- Display name：`工作排程`。
- 最低版本：iOS 16。
- 目前 marketing version：`1.3.0`，來源是 `mobile/package.json`；每次前端 release 要提高它，build number 由 workflow 的 GitHub run number 產生。
- 法律頁：`https://work-schedule.bounceto12340.workers.dev/privacy.html` 與 `/terms.html`。若正式網域不同，請在 App Store Connect 改成正式 URL，並確認公開可讀、不需登入。

## Josh 必須自己完成的 Apple／商店設定

- [ ] 申請並維持 Apple Developer Program 會員；接受 Paid Apps Agreement、稅務與銀行合約。免費 app 加上自動續訂訂閱仍需要可用的付費合約。
- [ ] 在 Apple Developer 建立或確認 App ID `com.bounceto.workschedule`，開啟 Push Notifications capability。
- [ ] 在 App Store Connect 建立 iOS App record，選正確的 Bundle ID、語言（繁體中文／英文）與 SKU。
- [ ] 建立一個 Pro subscription group，建立兩個 auto-renewable products：
  - `com.bounceto.workschedule.pro.monthly`
  - `com.bounceto.workschedule.pro.yearly`
- [ ] 為兩個訂閱填名稱、描述、價格、地區、審查截圖與本地化資料，並送交 Apple 審核商品。程式不寫死價格，會從 StoreKit 讀取。
- [ ] 在 App Store Server Notifications 設定 production 與 sandbox URL：
  `https://work-schedule.bounceto12340.workers.dev/api/apple/notifications`
- [ ] 建立 App Store Connect API key。角色要能讓 Xcode 使用 cloud-managed distribution certificates；目前 workflow 預期 `Admin`。
- [ ] 在 GitHub repository secrets 設定：
  - `ASC_KEY_ID`
  - `ASC_ISSUER_ID`
  - `ASC_API_KEY_P8`（完整 `.p8` 內容，含 BEGIN／END）
  - `APPLE_TEAM_ID`
- [ ] 在正式 Worker 完成 `migrations/001` 到 `migrations/012`，至少確認 `012-unsub-token.sql` 已執行；部署前先備份 D1。
- [ ] 設定正式 Worker secrets／vars：Turnstile、AgentMail（若啟用）、`APP_URL`、APNs 三個 secret（`APNS_KEY_ID`、`APNS_TEAM_ID`、`APNS_P8`），以及 Apple sandbox 開關。`APP_PURCHASE_ALLOW_SANDBOX=1` 只能在 TestFlight／sandbox 測試期間開啟，上架前要關閉。

## 建置與 TestFlight 驗收

- [ ] 先在 PR 等 CI 的 unit、syntax、browser smoke、native wiring 與 mobile web bundle 檢查全部通過。
- [ ] 用 GitHub Actions 的 `workflow_dispatch` 執行 iOS workflow；第一次可把 `upload` 設為 `false` 只產生 `.ipa` artifact，確認設定後再上傳。
- [ ] 上傳版本在 App Store Connect 完成 processing 後，加入 Internal Testing；不要把「upload success」當成「可審查」。
- [ ] 在真實 iPhone／TestFlight 測試：
  - [ ] 註冊、email 驗證碼登入、登出、忘記密碼。
  - [ ] 關掉 app 後重開仍保留登入；打開飛航模式時既有資料仍可用。
  - [ ] 新增工作、會議、循環任務、日曆、甘特專案、筆記與同步。
  - [ ] iOS app 與網頁登入同一帳號後資料一致；換另一個帳號不能看到前一位使用者的資料。
  - [ ] 訂閱商品顯示 Apple 實際價格與週期；購買後 Pro 權利出現；恢復購買、取消續訂、到期／退款狀態都符合預期。
  - [ ] 允許推播後收到一則 admin test push；拒絕權限時畫面明確說明，不是假裝成功。
  - [ ] 訂閱畫面的使用條款與隱私權連結在 app 內、離線時也能開啟。
  - [ ] 帳號刪除會清除帳號、排程、分享、session 與推播 token。
- [ ] 確認 production Worker 的 `APP_PURCHASE_ALLOW_SANDBOX` 已關閉，再進行正式購買驗收。不要把 sandbox transaction 帶到 production。

## App Store Connect 的人工欄位

- [ ] 填 App Privacy nutrition labels，依目前產品至少檢查：email address、user ID／account identifier、device ID／push token、purchase history／subscription identifiers、user content（排程與筆記）。所有項目目前都應標示「linked to identity」但「not used for tracking」；請以 Apple 當下表單定義及實際資料流覆核。
- [ ] 填 age rating。這是排程／生產力工具，不含使用者產生的公開社群內容；仍請 Josh 依實際上線內容回答 Apple 問卷。
- [ ] 上傳 App Store screenshots。因目前 target 同時包含 iPhone 與 iPad，請準備 App Store Connect 顯示的必要尺寸；至少預期要覆蓋最新 iPhone 6.9-inch、6.7-inch 與 iPad 13-inch 類別，並以 ASC 當下要求為準。
- [ ] 準備 App Review notes：測試帳號、測試步驟、訂閱測試說明、為何需要 email 驗證碼、法律頁 URL、若推播需先按哪個設定。不要提供真實密碼到 repo。
- [ ] 填 Support URL、Marketing URL（若有）、Privacy Policy URL，並確認這些頁面不需要登入。
- [ ] 上傳後在 App Store Connect 手動按「Submit for Review」。這個 workflow 不會自動送審，也不會自動發布。

## 商店文案草稿

送出前請 Josh 依實際產品名稱、客服信箱、訂閱價格與 Apple 欄位限制覆核。App Store 欄位通常有名稱 30 字、subtitle 30 字、keywords 100 字與 description 4000 字限制，實際以 ASC 當下介面為準。

### 繁體中文（台灣）

- **名稱**：工作排程
- **副標題**：把每天該做的事看清楚
- **關鍵字**：排程,待辦,行事曆,專案,甘特圖,循環任務,提醒,工作效率
- **描述**：

  工作排程確認系統，把工作、會議與專案集中在一個清楚的畫面。

  - 用年度、季度、月份或指定日期查看待辦
  - 每週、每兩週、每月、每季與每年循環任務
  - 假日順延、單次改期、略過某一次
  - 月曆檢視、會議時間、跨多天事項與甘特圖
  - 步驟清單、前置作業、標籤與搜尋篩選
  - 每日記錄與專案筆記的格式設定
  - 登入後跨裝置同步；曾登入的裝置可離線查看與編輯
  - 免費版先從基本上限開始，Pro 以 App 內自動續訂訂閱解鎖更高上限

  你的資料屬於你。服務不含廣告與第三方追蹤；完整資料處理方式請見隱私權政策。訂閱價格與週期以 App Store 顯示為準，可在 Apple 帳號的訂閱設定中取消。

### English

- **Name**: Work Schedule
- **Subtitle**: See what needs doing
- **Keywords**: schedule,tasks,calendar,project,gantt,recurring,reminders,productivity
- **Description**:

  Work Schedule Control keeps work, meetings, and projects in one clear place.

  - Review work by year, quarter, month, or a selected date
  - Weekly, fortnightly, monthly, quarterly, and yearly recurring tasks
  - Holiday adjustment, one-off rescheduling, and skipped occurrences
  - Month calendar, meeting times, multi-day items, and Gantt projects
  - Checklists, prerequisites, tags, search, and filters
  - Rich daily notes and project notes
  - Sign in to sync across devices; previously signed-in devices keep working offline
  - Start with the free plan, then use an auto-renewable in-app Pro subscription for higher limits

  Your data is yours. The service has no ads or third-party tracking; see the Privacy Policy for details. Subscription prices and periods are shown by Apple, and subscriptions can be cancelled from Apple Account settings.

## 尚待 Josh 決定的問題

- [ ] `com.bounceto.workschedule` 是否已屬於要上架的 Apple Developer team？若不是，正式 bundle ID 與 Worker 驗證要一起改。
- [ ] 商店正式名稱是否用「工作排程」／「Work Schedule」，或要加入「確認系統」以利搜尋？
- [ ] 是否真的要支援 iPad？目前 Xcode target 是 iPhone + iPad；若不支援，需在送審前調整 target、截圖與商店裝置設定。
- [ ] Pro 月／年價格、免費版上限、銷售地區與是否提供 promo offer。
- [ ] 正式客服信箱、Support URL、Marketing URL 與 privacy URL 是否使用目前 bounceto12340.workers.dev 網域。
- [ ] 目標使用者是否包含一般消費者，還是只供 Josh／特定團隊使用？這會影響商店文案、審查測試帳號與是否需要更完整的企業資料處理說明。
