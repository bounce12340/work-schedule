import Foundation
import UIKit
import UserNotifications
import Capacitor
import StoreKit
import Security

/**
 * 這個 app 唯一的原生插件。只做網頁做不到的事：
 *
 *   1. 購買證明：StoreKit 2 的 `AppTransaction.shared`，一段 Apple 簽過名的 JWS。
 *      訂閱制之後它不再是「有沒有付錢」的憑據，而是「一個 Apple ID 一個帳號」的
 *      防濫用機制（免費版有上限，開十個帳號是最直接的繞過方式）。
 *   2. Keychain：存 session token。不放 localStorage——WKWebView 的網頁儲存不受
 *      Keychain 那種保護，而且會跟著「清除網站資料」一起消失。
 *   3. 訂閱（StoreKit 2）：取得商品與本地化價格、購買、目前有效的權利、開系統的
 *      訂閱管理頁。Apple 3.1.1 規定 app 裡解鎖的功能只能走 IAP。
 *
 * 不裝第三方插件：市面上的要嘛沒有 AppTransaction，要嘛帶進一堆用不到的東西。
 *
 * **為什麼沒有 notifyListeners**
 * ---------------------------------------------------------------------------
 * `Transaction.updates` 要監聽（家庭共享、在別台裝置續訂、Ask to Buy 核准都從那裡
 * 進來），但**結果不透過事件送到 JS**。理由有兩個：
 *
 *   - 前端是單檔 HTML，沒有引入 `@capacitor/core`，所以沒有 `addListener`。真機上
 *     注入的 bridge 與 core 給的東西不一樣——那正是 build 7～10 追了四輪的那個
 *     bug class（見 docs/postmortems/2026-09-16-app-silent-standalone.md）。
 *   - `currentEntitlements()` 本來就回「現在有效的全部」。JS 在啟動與回到前景時各
 *     問一次，涵蓋的情況與事件完全相同，而且**測得到**（假的 Capacitor 也能回答）。
 *
 * 所以原生這側的監聽器只負責 StoreKit 要求的那件事：把交易 `finish()` 掉，否則它
 * 會一直重送。
 *
 * 註冊方式見 MainViewController.swift（bridge.registerPluginInstance）。
 */
@objc(WorkScheduleNativePlugin)
public class WorkScheduleNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WorkScheduleNativePlugin"
    public let jsName = "WorkScheduleNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getAppTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keychainGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keychainSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keychainDelete", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "currentEntitlements", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "manageSubscriptions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPush", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pushStatus", returnType: CAPPluginReturnPromise),
    ]

    private let service = "com.bounceto.workschedule"

    /// 兩個 product id。**必須與 src/handlers/planapple.js 的 PRODUCT_IDS 以及
    /// App Store Connect 裡建的逐字相同**——打錯的症狀是「買得下去，但買完還是免費版」。
    /// tools/check-native-plugin.mjs 比對前兩者。
    private let productIds = [
        "com.bounceto.workschedule.pro.monthly",
        "com.bounceto.workschedule.pro.yearly",
    ]

    /// StoreKit 要求 app 一啟動就監聽；不 finish 的交易會被一直重送。
    private var updatesTask: Task<Void, Never>?

    override public func load() {
        if #available(iOS 15.0, *) {
            let ids = productIds
            updatesTask = Task.detached {
                for await update in Transaction.updates {
                    guard case .verified(let tx) = update else { continue }
                    if ids.contains(tx.productID) {
                        // 權利本身由 JS 在啟動／回到前景時用 currentEntitlements 推上去；
                        // 這裡只做 StoreKit 要求的收尾。
                        await tx.finish()
                    }
                }
            }
        }
    }

    deinit { updatesTask?.cancel() }

    // MARK: - 購買證明

    /// 回 { jws }。拿不到（模擬器、非 App Store 安裝、使用者取消登入）就 reject，
    /// 由網頁那一側提示「請從 App Store 或 TestFlight 安裝」。
    @objc func getAppTransaction(_ call: CAPPluginCall) {
        if #available(iOS 16.0, *) {
            Task {
                do {
                    let result = try await AppTransaction.shared
                    switch result {
                    case .verified(let tx):
                        call.resolve(["jws": result.jwsRepresentation, "environment": String(describing: tx.environment)])
                    case .unverified(_, let error):
                        // 裝置端驗不過就不送：伺服器端也會再驗一次，這裡只是提早失敗
                        call.reject("purchase proof failed device verification: \(error)")
                    }
                } catch {
                    call.reject("purchase proof unavailable: \(error.localizedDescription)")
                }
            }
        } else {
            call.reject("iOS 16 or later required")
        }
    }

    // MARK: - 訂閱（StoreKit 2）

    /// 回 { products: [{ id, displayPrice, period, displayName, description }] }。
    ///
    /// **價格一定要從 StoreKit 拿，不能寫死 US$4.99**：各國幣別與 Apple 的匯率換算
    /// 都在那裡，而且 Apple 審查會看訂閱畫面上的價格對不對。
    @objc func getProducts(_ call: CAPPluginCall) {
        guard #available(iOS 15.0, *) else { call.reject("iOS 15 or later required"); return }
        Task {
            do {
                let products = try await Product.products(for: productIds)
                let out: [[String: Any]] = products.map { p in
                    var period = ""
                    if let sub = p.subscription {
                        let n = sub.subscriptionPeriod.value
                        switch sub.subscriptionPeriod.unit {
                        case .day:   period = n == 1 ? "day" : "\(n)days"
                        case .week:  period = n == 1 ? "week" : "\(n)weeks"
                        case .month: period = n == 1 ? "month" : "\(n)months"
                        case .year:  period = n == 1 ? "year" : "\(n)years"
                        @unknown default: period = ""
                        }
                    }
                    return [
                        "id": p.id,
                        "displayPrice": p.displayPrice,
                        "displayName": p.displayName,
                        "description": p.description,
                        "period": period,
                    ]
                }
                // 拿到空清單不是成功：App Store Connect 還沒建 product、或還沒同意
                // Paid Apps Agreement 時就是這個形狀，而畫面上會變成「一片空白」。
                if out.isEmpty {
                    call.reject("no products returned by StoreKit (check App Store Connect products and the Paid Apps agreement)")
                    return
                }
                call.resolve(["products": out])
            } catch {
                call.reject("getProducts failed: \(error.localizedDescription)")
            }
        }
    }

    /// 買。成功回 { jws }；使用者自己取消回 { cancelled: true }（**不是錯誤**，
    /// 畫面上不該跳紅字說失敗）。
    @objc func purchase(_ call: CAPPluginCall) {
        guard #available(iOS 15.0, *) else { call.reject("iOS 15 or later required"); return }
        guard let productId = call.getString("productId"), productIds.contains(productId) else {
            call.reject("unknown productId"); return
        }
        Task {
            do {
                let products = try await Product.products(for: [productId])
                guard let product = products.first else { call.reject("product not found"); return }
                let result = try await product.purchase()
                switch result {
                case .success(let verification):
                    switch verification {
                    case .verified(let tx):
                        let jws = verification.jwsRepresentation
                        await tx.finish()
                        call.resolve(["jws": jws])
                    case .unverified(_, let error):
                        call.reject("purchase failed device verification: \(error)")
                    }
                case .userCancelled:
                    call.resolve(["cancelled": true])
                case .pending:
                    // Ask to Buy：家長還沒核准。核准之後從 Transaction.updates 進來，
                    // 下一次 currentEntitlements 就看得到。
                    call.resolve(["pending": true])
                @unknown default:
                    call.reject("unknown purchase result")
                }
            } catch {
                call.reject("purchase failed: \(error.localizedDescription)")
            }
        }
    }

    /// 回 { jws: [...] }：目前有效的全部權利。啟動、回到前景、按「恢復購買」都用它。
    /// 一筆都沒有時回空陣列，**不是錯誤**——沒訂閱的人就是這樣。
    @objc func currentEntitlements(_ call: CAPPluginCall) {
        guard #available(iOS 15.0, *) else { call.reject("iOS 15 or later required"); return }
        Task {
            var out: [String] = []
            for await entitlement in Transaction.currentEntitlements {
                guard case .verified(let tx) = entitlement else { continue }
                if productIds.contains(tx.productID) { out.append(entitlement.jwsRepresentation) }
            }
            call.resolve(["jws": out])
        }
    }

    /// 開 iOS 的訂閱管理頁。**取消一定要在那裡做**，Apple 不讓 app 自己取消。
    @objc func manageSubscriptions(_ call: CAPPluginCall) {
        guard #available(iOS 15.0, *) else { call.reject("iOS 15 or later required"); return }
        DispatchQueue.main.async {
            guard let scene = self.bridge?.viewController?.view.window?.windowScene else {
                call.reject("no window scene"); return
            }
            Task {
                do {
                    try await AppStore.showManageSubscriptions(in: scene)
                    call.resolve()
                } catch {
                    call.reject("showManageSubscriptions failed: \(error.localizedDescription)")
                }
            }
        }
    }

    // MARK: - 推播（子專案 B）

    /// 還在等 device token 的那一通電話。AppDelegate 收到之後從這裡 resolve。
    /// static 是因為 AppDelegate 拿不到插件的實例——那條接線只能靠一個共用的位置。
    private static var pendingPushCall: CAPPluginCall?
    private static let pushLock = NSLock()

    /// AppDelegate 專用。**成功與失敗都要呼叫**：不呼叫的話那通電話永遠不會 settle，
    /// 而那種故障沒有任何事件（沒有例外、沒有 rejection、沒有紅字）。
    static func deliverPushToken(_ token: String?, error: String?) {
        pushLock.lock()
        let call = pendingPushCall
        pendingPushCall = nil
        pushLock.unlock()
        guard let call = call else { return }
        if let token = token {
            call.resolve(["granted": true, "token": token, "environment": apsEnvironment()])
        } else {
            call.reject("push registration failed: \(error ?? "unknown")")
        }
    }

    /// 讀 `aps-environment` entitlement。**決定 Worker 要打 sandbox 還是正式的 APNs**，
    /// 搞錯的症狀是 400 BadDeviceToken——而那看起來像「token 壞了」，會往錯的方向查。
    private static func apsEnvironment() -> String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    /// 要權限 → 註冊 remote notifications → 等 AppDelegate 把 token 送回來。
    ///
    /// **只在使用者按下「開啟推播」時才呼叫**，不在啟動時呼叫：iOS 只讓你問一次，
    /// 開機就問的轉換率遠低於「他自己按了那顆按鈕」之後才問。
    @objc func requestPush(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error = error {
                call.reject("notification permission failed: \(error.localizedDescription)")
                return
            }
            guard granted else {
                // 被拒絕**不是錯誤**，是一個要說出來的答案：畫面上要提示「到設定裡打開」，
                // 而不是讓開關默默彈回去。
                call.resolve(["granted": false, "token": NSNull(), "environment": Self.apsEnvironment()])
                return
            }
            Self.pushLock.lock()
            // 前一通還在等就先收掉，免得堆積
            Self.pendingPushCall?.reject("superseded by a newer requestPush")
            Self.pendingPushCall = call
            Self.pushLock.unlock()
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    /// 只問現況，**不跳權限對話框**。帳號頁要顯示「目前是開還是關」時用。
    @objc func pushStatus(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let authorized = settings.authorizationStatus == .authorized
                || settings.authorizationStatus == .provisional
                || settings.authorizationStatus == .ephemeral
            call.resolve(["authorized": authorized, "environment": Self.apsEnvironment()])
        }
    }

    // MARK: - Keychain

    @objc func keychainGet(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { call.reject("key required"); return }
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query(key, extra: [
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]) as CFDictionary, &item)
        if status == errSecItemNotFound { call.resolve(["value": NSNull()]); return }
        guard status == errSecSuccess, let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
            call.reject("keychain read failed: \(status)"); return
        }
        call.resolve(["value": value])
    }

    @objc func keychainSet(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else { call.reject("key and value required"); return }
        let data = Data(value.utf8)
        // 先刪再加：SecItemAdd 對既有項目回 duplicate，SecItemUpdate 對不存在的回 notFound，
        // 兩步比在兩者之間挑一個再處理錯誤來得直接
        SecItemDelete(query(key) as CFDictionary)
        let status = SecItemAdd(query(key, extra: [
            kSecValueData as String: data,
            // 只在裝置解鎖後可讀、不進 iCloud 備份：token 換一台裝置就該重新登入
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]) as CFDictionary, nil)
        if status != errSecSuccess { call.reject("keychain write failed: \(status)"); return }
        call.resolve()
    }

    @objc func keychainDelete(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { call.reject("key required"); return }
        let status = SecItemDelete(query(key) as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound { call.reject("keychain delete failed: \(status)"); return }
        call.resolve()
    }

    private func query(_ key: String, extra: [String: Any] = [:]) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        for (k, v) in extra { q[k] = v }
        return q
    }
}
