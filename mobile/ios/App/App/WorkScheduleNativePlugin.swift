import Foundation
import Capacitor
import StoreKit
import Security

/**
 * 這個 app 唯一的原生插件。只做兩件事，兩件都是網頁做不到的：
 *
 *   1. 購買證明：StoreKit 2 的 `AppTransaction.shared`，一段 Apple 簽過名的 JWS。
 *      app 是付費下載，後端拿它離線驗簽（src/apppurchase.js）就能確認「這個人買了」，
 *      註冊時自動核准，不必等管理者。
 *   2. Keychain：存 session token。不放 localStorage——WKWebView 的網頁儲存不受
 *      Keychain 那種保護，而且會跟著「清除網站資料」一起消失。
 *
 * 不裝第三方插件：市面上的要嘛沒有 AppTransaction，要嘛帶進一堆用不到的東西。
 * 這裡約 60 行，看得完。
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
    ]

    private let service = "com.bounceto.workschedule"

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
