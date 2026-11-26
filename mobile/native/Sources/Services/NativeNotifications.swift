import Foundation
import UIKit
import UserNotifications

@MainActor
final class NativeNotifications {
    static let shared = NativeNotifications()

    struct DeviceToken {
        let token: String
        let environment: String
    }

    enum NotificationError: LocalizedError {
        case registering, registrationTimedOut, dateInPast

        var errorDescription: String? {
            switch self {
            case .registering: "正在向 Apple 註冊這台裝置。"
            case .registrationTimedOut: "Apple 尚未回傳裝置憑證，請稍後再試。"
            case .dateInPast: "提醒時間必須晚於現在。"
            }
        }
    }

    private static let reminderPrefix = "work-schedule.reminder."
    private let center = UNUserNotificationCenter.current()
    private var registration: (id: UUID, continuation: CheckedContinuation<DeviceToken, Error>)?
    private var timeout: Task<Void, Never>?
    private var isRequesting = false

    private init() {}

    func authorizationStatus() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    func requestPermission() async throws -> Bool {
        try await center.requestAuthorization(options: [.alert, .sound, .badge])
    }

    func requestDeviceToken() async throws -> DeviceToken? {
        guard !isRequesting else { throw NotificationError.registering }
        isRequesting = true
        defer { isRequesting = false }
        guard try await requestPermission() else { return nil }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                registration = (id, continuation)
                timeout = Task {
                    do {
                        try await Task.sleep(for: .seconds(20))
                        finishRegistration(.failure(NotificationError.registrationTimedOut), id: id)
                    } catch {
                        // The device-token callback resolved the request first.
                    }
                }
                UIApplication.shared.registerForRemoteNotifications()
            }
        } onCancel: {
            Task { @MainActor in self.finishRegistration(.failure(CancellationError()), id: id) }
        }
    }

    func stopReceivingRemoteNotifications() {
        UIApplication.shared.unregisterForRemoteNotifications()
    }

    func scheduleReminder(id: String, title: String, message: String, at date: Date) async throws {
        guard date > .now else { throw NotificationError.dateInPast }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = message
        content.sound = .default

        let components = Calendar.current.dateComponents([.calendar, .timeZone, .year, .month, .day, .hour, .minute, .second], from: date)
        let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
        try await center.add(UNNotificationRequest(identifier: Self.reminderPrefix + id, content: content, trigger: trigger))
    }

    func cancelReminder(id: String) {
        let identifier = Self.reminderPrefix + id
        center.removePendingNotificationRequests(withIdentifiers: [identifier])
        center.removeDeliveredNotifications(withIdentifiers: [identifier])
    }

    func clearLocalReminders() async {
        let pending = await center.pendingNotificationRequests()
        let delivered = await center.deliveredNotifications()
        center.removePendingNotificationRequests(withIdentifiers: pending.map(\.identifier).filter { $0.hasPrefix(Self.reminderPrefix) })
        center.removeDeliveredNotifications(withIdentifiers: delivered.map(\.request.identifier).filter { $0.hasPrefix(Self.reminderPrefix) })
    }

    fileprivate func receiveDeviceToken(_ data: Data) {
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        let token = data.map { String(format: "%02x", $0) }.joined()
        finishRegistration(.success(DeviceToken(token: token, environment: environment)))
    }

    fileprivate func receiveRegistrationError(_ error: Error) {
        finishRegistration(.failure(error))
    }

    private func finishRegistration(_ result: Result<DeviceToken, Error>, id: UUID? = nil) {
        guard let pending = registration, id == nil || pending.id == id else { return }
        registration = nil
        timeout?.cancel()
        timeout = nil
        pending.continuation.resume(with: result)
    }
}

@MainActor
final class WorkScheduleAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NativeNotifications.shared.receiveDeviceToken(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NativeNotifications.shared.receiveRegistrationError(error)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }
}
