# 工作排程 SwiftUI

以 Xcode 開啟 `WorkSchedule.xcodeproj` 並選用 `WorkSchedule` scheme。專案支援 iOS 16 起的 iPhone 與 iPad，沿用 `com.bounceto.workschedule` 與既有 Worker。從 Capacitor 換版後，第一次需連線確認舊快取的帳號，再接回待上傳的離線變更。

## 本機檢查

從儲存庫根目錄執行。

```sh
npm test
xcrun swiftc mobile/native/Sources/Cloud/JSONValue.swift mobile/native/Sources/Schedule/*.swift mobile/native/Tests/ScheduleModelChecks.swift -o /tmp/work-schedule-model && /tmp/work-schedule-model
xcrun swiftc mobile/native/Sources/Cloud/*.swift mobile/native/Sources/Schedule/*.swift mobile/native/Tests/CloudSyncChecks.swift -o /tmp/work-schedule-sync && /tmp/work-schedule-sync
```

Debug 模擬器接受 `--preview-workspace` 啟動參數。示範資料使用獨立快取與模擬 Worker。

## 上傳

選擇 GitHub Actions 的 iOS workflow，設定 `app=native`。先以 `upload=false` 匯出 IPA，或用 `upload=true` 上傳到既有 App Store Connect 記錄。GitHub Actions 的既有簽章設定適用於原生版。若要啟用 Google 登入，在 GitHub repository variable 設定 `GOOGLE_IOS_CLIENT_ID`，並在 Worker 設妥相同的 iOS client。Apple、Google、推播與購買應用簽章後的 TestFlight 驗證。

公開發行前，使用真實 iPhone 由舊版更新一次並檢查離線資料，以及實測登入、帳號刪除、推播、訂閱購買與恢復。App Store 審查專用登入資料保留在 App Store Connect。
