import CryptoKit
import Foundation
import Security

struct SessionVault {
    var read: () throws -> String?
    var write: (String) throws -> Void
    var clear: () throws -> Void

    /// Uses the service and account of the shipped Capacitor native plugin.
    static let keychain = SessionVault(
        read: {
            var item: CFTypeRef?
            var query = keychainQuery
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            let status = SecItemCopyMatching(query as CFDictionary, &item)
            if status == errSecItemNotFound { return nil }
            guard status == errSecSuccess, let data = item as? Data, let token = String(data: data, encoding: .utf8) else {
                throw KeychainIssue(status: status)
            }
            return token
        },
        write: { token in
            let changes = [kSecValueData as String: Data(token.utf8)]
            let status = SecItemUpdate(keychainQuery as CFDictionary, changes as CFDictionary)
            if status == errSecItemNotFound {
                var item = keychainQuery
                item[kSecValueData as String] = Data(token.utf8)
                item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                let added = SecItemAdd(item as CFDictionary, nil)
                guard added == errSecSuccess else { throw KeychainIssue(status: added) }
            } else if status != errSecSuccess {
                throw KeychainIssue(status: status)
            }
        },
        clear: {
            let status = SecItemDelete(keychainQuery as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainIssue(status: status) }
        }
    )

    private static var keychainQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.bounceto.workschedule",
            kSecAttrAccount as String: "sessionToken",
        ]
    }
}

private struct KeychainIssue: LocalizedError {
    let status: OSStatus
    var errorDescription: String? { "系統無法存取登入憑證，請解鎖裝置後重試（\(status)）。" }
}

struct ScheduleCache: Codable {
    var user: CloudUser
    var state: JSONObject
    var base: JSONObject?
    var updatedAt: Int64?
    var dirty: Bool
}

struct CloudDisk {
    private struct SessionIndex: Codable {
        let fingerprint: String
        let email: String
    }

    private let directory: URL

    init(directory: URL? = nil) {
        self.directory = directory ?? URL.applicationSupportDirectory
            .appendingPathComponent("WorkScheduleNative", isDirectory: true)
    }

    func active(token: String) throws -> ScheduleCache? {
        guard let index: SessionIndex = try read(SessionIndex.self, at: indexURL),
              index.fingerprint == Self.fingerprint(token) else { return nil }
        return try load(email: index.email)
    }

    func load(email: String) throws -> ScheduleCache? {
        guard let cache: ScheduleCache = try read(ScheduleCache.self, at: ownerURL(email)),
              cache.user.email.lowercased() == email.lowercased() else { return nil }
        return cache
    }

    func save(_ cache: ScheduleCache, token: String) throws {
        try write(cache, to: ownerURL(cache.user.email))
        try write(SessionIndex(fingerprint: Self.fingerprint(token), email: cache.user.email), to: indexURL)
    }

    func preventLegacyImport() throws {
        try write(true, to: legacyURL)
    }

    func allowsLegacyImport() -> Bool { !FileManager.default.fileExists(atPath: legacyURL.path) }

    func deactivate() throws { try remove(indexURL) }

    func deleteSchedule(email: String) throws { try remove(ownerURL(email)) }

    private var indexURL: URL { directory.appendingPathComponent("active.json") }
    private var legacyURL: URL { directory.appendingPathComponent("legacy-handled.json") }

    private func ownerURL(_ email: String) -> URL {
        directory.appendingPathComponent(Self.fingerprint(email.lowercased()) + ".json")
    }

    private static func fingerprint(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func read<T: Decodable>(_ type: T.Type, at url: URL) throws -> T? {
        do { return try JSONDecoder().decode(type, from: Data(contentsOf: url)) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
    }

    private func write<T: Encodable>(_ value: T, to url: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var cacheDirectory = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try cacheDirectory.setResourceValues(values)
        let data = try JSONEncoder().encode(value)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func remove(_ url: URL) throws {
        do { try FileManager.default.removeItem(at: url) }
        catch let error as CocoaError where error.code == .fileNoSuchFile { }
    }
}
