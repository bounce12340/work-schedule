import StoreKit
import SwiftUI
import UniformTypeIdentifiers

struct SettingsView: View {
    @ObservedObject var store: CloudStore
    @AppStorage("nativePushToken") private var pushToken = ""
    @AppStorage("nativePushOwner") private var pushOwner = ""
    @State private var showConflict = false
    @State private var busy = false
    @State private var notice: String?
    @State private var confirmation: Confirmation?
    @State private var importing = false
    @State private var exporting = false
    @State private var dataToImport: JSONObject?

    private enum Confirmation: String, Identifiable {
        case logout = "登出這台裝置？"
        case restore = "以備份取代目前排程？"
        var id: Self { self }
    }

    var body: some View {
        List {
            Section("帳號") {
                if let user = store.user {
                    LabeledContent("電子郵件", value: user.email)
                    NavigationLink {
                        SubscriptionView(store: store)
                    } label: { LabeledContent("方案", value: user.isPro ? "Pro" : "免費") }
                }
                Button("登出") { confirmation = .logout }
                NavigationLink("密碼與刪除帳號") { AccountView(store: store) }
            }
            Section("雲端同步") {
                Label(syncLabel, systemImage: syncSymbol)
                if let message = store.message { Text(message).font(.footnote).foregroundStyle(.secondary) }
                Button("立即同步") { Task { await store.sync() } }
                    .disabled(store.status == .syncing)
                if store.conflict != nil {
                    Button("處理同步衝突") { showConflict = true }
                }
            }
            Section("排程") {
                NavigationLink("工作分類") { CalendarSettings(store: store, section: .categories) }
                NavigationLink("假日與不在") { CalendarSettings(store: store, section: .holidays) }
                NavigationLink("分享") { SharesView(store: store) }
                Button("啟用這台裝置的推播") {
                    perform {
                        guard let owner = store.user?.email else { return }
                        let generation = store.sessionGeneration
                        guard let token = try await NativeNotifications.shared.requestDeviceToken() else {
                            notice = "通知權限已關閉。可在 iOS 設定中開啟。"
                            return
                        }
                        try await store.registerPush(token: token.token, environment: token.environment, generation: generation)
                        guard store.sessionGeneration == generation else { return }
                        pushOwner = owner
                        pushToken = token.token
                        notice = "已啟用推播。"
                    }
                }
                .disabled(busy)
                if pushOwner == store.user?.email, !pushToken.isEmpty {
                    Button("關閉這台裝置的推播") {
                        perform {
                            try await unregisterPush()
                            notice = "已關閉推播。"
                        }
                    }
                    .disabled(busy)
                }
            }
            Section("備份") {
                Button("匯出排程 JSON") { exporting = true }
                Button("匯入排程 JSON") { importing = true }
            }
            Section("支援") {
                Link("使用說明與支援", destination: StoreLinks.support)
                Link("隱私權政策", destination: StoreLinks.privacy)
                Link("使用條款", destination: StoreLinks.terms)
            }
        }
        .navigationTitle("設定")
        .alert("工作排程", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("確定") { notice = nil }
        } message: { Text(notice ?? "") }
        .confirmationDialog("選擇要保留的版本", isPresented: $showConflict, titleVisibility: .visible) {
            Button("保留這台裝置的變更") { Task { await store.resolveConflict(.keepLocal) } }
            Button("以雲端版本為準", role: .destructive) { Task { await store.resolveConflict(.useCloud) } }
        } message: {
            Text(store.conflict?.paths.prefix(6).joined(separator: "、") ?? "同一欄位在兩台裝置上有不同的變更。")
        }
        .alert(item: $confirmation) { kind in
            switch kind {
            case .logout:
                return Alert(title: Text(kind.rawValue), primaryButton: .destructive(Text("登出")) {
                    perform {
                        let generation = store.sessionGeneration
                        let deviceToken = pushOwner == store.user?.email ? pushToken : nil
                        NativeNotifications.shared.stopReceivingRemoteNotifications()
                        await NativeNotifications.shared.clearLocalReminders()
                        try await store.logout(pushToken: deviceToken, generation: generation)
                        if store.user == nil {
                            pushOwner = ""
                            pushToken = ""
                        }
                    }
                }, secondaryButton: .cancel())
            case .restore:
                return Alert(title: Text(kind.rawValue), message: Text("匯入後將取代目前的資料，並與這個帳號同步。"), primaryButton: .destructive(Text("匯入")) {
                    if let dataToImport { store.updateState { $0 = dataToImport } }
                    dataToImport = nil
                }, secondaryButton: .cancel { dataToImport = nil })
            }
        }
        .fileExporter(isPresented: $exporting, document: ScheduleBackup(state: store.state), contentType: .json,
                      defaultFilename: "工作排程-\(ScheduleDay(Date()).rawValue)") { result in
            if case .failure(let error) = result { notice = error.localizedDescription }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
            do {
                let url = try result.get()
                let hasAccess = url.startAccessingSecurityScopedResource()
                defer { if hasAccess { url.stopAccessingSecurityScopedResource() } }
                let backup = try ScheduleBackup.decode(Data(contentsOf: url))
                dataToImport = backup
                confirmation = .restore
            } catch { notice = error.localizedDescription }
        }
    }

    private var syncLabel: String {
        switch store.status {
        case .signedOut: return "未登入"
        case .checking: return "正在檢查帳號"
        case .synced: return "已與雲端同步"
        case .pending: return "變更等待同步"
        case .syncing: return "正在同步"
        case .offline: return "離線，變更保留在這台裝置"
        case .conflict: return "有兩個不同版本"
        case .failed: return "同步失敗"
        }
    }

    private var syncSymbol: String {
        switch store.status {
        case .synced: return "checkmark.icloud"
        case .failed, .conflict, .offline: return "exclamationmark.icloud"
        default: return "icloud"
        }
    }

    private func unregisterPush() async throws {
        guard pushOwner == store.user?.email, !pushToken.isEmpty else { return }
        try await store.unregisterPush(token: pushToken)
        NativeNotifications.shared.stopReceivingRemoteNotifications()
        pushOwner = ""
        pushToken = ""
    }

    private func perform(_ request: @escaping () async throws -> Void) {
        busy = true
        Task {
            defer { busy = false }
            do { try await request() }
            catch { notice = error.localizedDescription }
        }
    }
}

private struct ScheduleBackup: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    let state: JSONObject

    init(state: JSONObject) { self.state = state }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents else { throw BackupError.invalid }
        state = try Self.decode(data)
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return FileWrapper(regularFileWithContents: try encoder.encode(state))
    }

    static func decode(_ data: Data) throws -> JSONObject {
        let state = try JSONDecoder().decode(JSONObject.self, from: data)
        guard let version = state["version"]?.int, (1...3).contains(version),
              state["items"]?.array != nil, state["ganttProjects"]?.array != nil else {
            throw BackupError.invalid
        }
        return ScheduleDocument(state).state
    }

    private enum BackupError: LocalizedError {
        case invalid
        var errorDescription: String? { "這個檔案不是支援的工作排程備份。" }
    }
}

private struct AccountView: View {
    @ObservedObject var store: CloudStore
    @StateObject private var identity = NativeIdentity()
    @State private var oldPassword = ""
    @State private var newPassword = ""
    @State private var visible = false
    @State private var busy = false
    @State private var notice: String?

    var body: some View {
        Form {
            Section("變更密碼") {
                SecureField("目前密碼", text: $oldPassword).textContentType(.password)
                SecureField("新密碼（至少 10 個字元）", text: $newPassword).textContentType(.newPassword)
                Button("更新密碼") {
                    perform {
                        try await store.changePassword(oldPassword: oldPassword, newPassword: newPassword)
                        oldPassword = ""
                        newPassword = ""
                        notice = "密碼已更新。"
                    }
                }
                .disabled(busy || oldPassword.isEmpty || newPassword.utf16.count < 10)
            }
            Section("刪除帳號") {
                Button("永久刪除帳號", role: .destructive) { visible = true }
                    .disabled(busy)
                Text("刪除後會清除雲端排程和分享。若有 Apple 自動續訂，請先到訂閱管理取消。")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("管理 Apple 訂閱") { perform { try await NativeSubscriptions.manage() } }
            }
            if let notice { Text(notice).font(.footnote) }
            if busy { ProgressView() }
        }
        .navigationTitle("帳號安全")
        .confirmationDialog("永久刪除帳號與排程？", isPresented: $visible, titleVisibility: .visible) {
            if !oldPassword.isEmpty {
                Button("用目前密碼確認刪除", role: .destructive) {
                    perform { try await store.deleteAccount(password: oldPassword); await cleanNotifications() }
                }
            }
            Button("用 Apple 驗證並刪除", role: .destructive) {
                perform {
                    let generation = store.sessionGeneration
                    let credential = try await identity.appleCredential()
                    try await store.deleteAccountWithApple(idToken: credential.idToken,
                                                           authorizationCode: credential.authorizationCode,
                                                           nonce: credential.nonce, generation: generation)
                    await cleanNotifications()
                }
            }
            if NativeIdentity.isGoogleConfigured {
                Button("用 Google 驗證並刪除", role: .destructive) {
                    perform {
                        let generation = store.sessionGeneration
                        let credential = try await identity.googleCredential()
                        try await store.deleteAccountWithGoogle(authorizationCode: credential.authorizationCode,
                                                                codeVerifier: credential.codeVerifier,
                                                                redirectURI: credential.redirectURI, generation: generation)
                        await cleanNotifications()
                    }
                }
            }
        } message: { Text("如果使用電子郵件登入，請先填寫上方的目前密碼。") }
    }

    private func cleanNotifications() async {
        NativeNotifications.shared.stopReceivingRemoteNotifications()
        await NativeNotifications.shared.clearLocalReminders()
    }

    private func perform(_ request: @escaping () async throws -> Void) {
        busy = true
        notice = nil
        Task {
            defer { busy = false }
            do { try await request() }
            catch { notice = error.localizedDescription }
        }
    }
}

private struct SubscriptionView: View {
    @ObservedObject var store: CloudStore
    @State private var products: [Product] = []
    @State private var busy = false
    @State private var notice: String?

    var body: some View {
        List {
            Section("工作排程 Pro") {
                Text("升級後可新增更多排程和專案，並使用進階協作功能。")
                if products.isEmpty, !busy { Text("目前無法取得訂閱方案。").foregroundStyle(.secondary) }
                ForEach(products, id: \.id) { product in
                    Button {
                        perform {
                            let generation = store.sessionGeneration
                            let result = try await NativeSubscriptions.purchase(product, accountToken: store.user?.appAccountToken) {
                                try await store.syncAppleEntitlements($0, generation: generation)
                            }
                            switch result {
                            case .completed: notice = "購買完成。"
                            case .pending: notice = "購買正在等待 Apple 確認。"
                            case .cancelled: break
                            }
                        }
                    } label: {
                        LabeledContent(product.displayName, value: "\(product.displayPrice) / \(product.id.hasSuffix(".monthly") ? "月" : "年")")
                    }
                    .disabled(busy || store.user?.appAccountToken == nil)
                }
                Text("訂閱會自動續訂。可在 Apple 帳號的訂閱管理中取消。")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("恢復購買") {
                    perform {
                        let generation = store.sessionGeneration
                        let restored = try await NativeSubscriptions.restore(accountToken: store.user?.appAccountToken) {
                            try await store.syncAppleEntitlements($0, generation: generation)
                        }
                        notice = restored ? "已恢復購買。" : "這個帳號沒有可恢復的訂閱。"
                    }
                }
                .disabled(busy || store.user?.appAccountToken == nil)
                Button("管理訂閱") { perform { try await NativeSubscriptions.manage() } }
                Link("使用條款", destination: StoreLinks.terms)
                Link("隱私權政策", destination: StoreLinks.privacy)
            }
            if busy { ProgressView() }
            if let notice { Text(notice).font(.footnote) }
        }
        .navigationTitle("訂閱")
        .task {
            busy = true
            defer { busy = false }
            do { products = try await NativeSubscriptions.products() }
            catch { notice = error.localizedDescription }
        }
    }

    private func perform(_ request: @escaping () async throws -> Void) {
        busy = true
        notice = nil
        Task {
            defer { busy = false }
            do { try await request() }
            catch { notice = error.localizedDescription }
        }
    }
}
