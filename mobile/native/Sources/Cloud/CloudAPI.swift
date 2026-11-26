import Foundation

struct CloudUser: Codable, Equatable, Sendable {
    let email: String
    var id: UUID?
    var role: String?
    var status: String?
    var plan: String?
    var source: String?
    var expiresAt: Int64?
    var appAccountToken: UUID?

    enum CodingKeys: String, CodingKey {
        case email, id, role, status, plan, appAccountToken
        case source = "planSource"
        case expiresAt = "planExpiresAt"
    }

    var isPro: Bool { plan == "pro" }

    func matches(_ other: Self) -> Bool {
        guard email.caseInsensitiveCompare(other.email) == .orderedSame else { return false }
        if let a = appAccountToken ?? id, let b = other.appAccountToken ?? other.id { return a == b }
        return true
    }
}

struct CloudConflict: Equatable, Sendable {
    let remote: JSONObject
    let updatedAt: Int64
    let paths: [String]
}

enum CloudConflictChoice {
    case keepLocal
    case useCloud
}

enum CloudStatus: Equatable {
    case signedOut
    case checking
    case synced
    case pending
    case syncing
    case offline
    case conflict
    case failed
}

enum CloudError: LocalizedError {
    case response(status: Int, message: String)
    case malformedResponse
    case invalidState
    case invalidPushToken
    case pendingSchedule
    case noSession

    var statusCode: Int? {
        if case let .response(status, _) = self { return status }
        return nil
    }

    var errorDescription: String? {
        switch self {
        case .response(_, let message): return message
        case .malformedResponse: return "伺服器傳回無法讀取的資料。"
        case .invalidState: return "無法讀取這個版本的排程資料。"
        case .invalidPushToken: return "這台裝置的推播識別碼尚未就緒。"
        case .pendingSchedule: return "排程尚未同步。請先完成同步，再分享。"
        case .noSession: return "請先登入。"
        }
    }
}

struct CloudAPI: Sendable {
    static let site = URL(string: "https://work-schedule.bounceto12340.workers.dev")!

    let baseURL: URL
    private let session: URLSession
    private let version: String

    init(baseURL: URL = Self.site, session: URLSession? = nil,
         version: String = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown") {
        self.baseURL = baseURL
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.httpShouldSetCookies = false
            config.httpCookieAcceptPolicy = .never
            config.urlCache = nil
            config.timeoutIntervalForRequest = 20
            self.session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
        }
        self.version = version
    }

    struct Reply: Sendable {
        let status: Int
        let data: Data

        func decode<T: Decodable>(_ type: T.Type) throws -> T {
            do { return try JSONDecoder().decode(type, from: data) }
            catch { throw CloudError.malformedResponse }
        }

        func validate() throws {
            guard (200..<300).contains(status) else {
                let body = try? JSONDecoder().decode(JSONObject.self, from: data)
                throw CloudError.response(status: status, message: body?["error"]?.string ?? "服務回應 HTTP \(status)。")
            }
        }
    }

    func send(_ method: String, _ path: String, body: JSONObject? = nil, token: String? = nil) async throws -> Reply {
        // Endpoint paths are fixed by the app. Path identifiers are encoded separately
        // by segment(_:), so even an imported resource ID cannot change the host.
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw CloudError.malformedResponse
        }
        components.percentEncodedPath = path
        guard let url = components.url else { throw CloudError.malformedResponse }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("ios/\(version)", forHTTPHeaderField: "X-App-Client")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw CloudError.malformedResponse }
        return Reply(status: http.statusCode, data: data)
    }

    static func segment(_ id: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        return id.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
