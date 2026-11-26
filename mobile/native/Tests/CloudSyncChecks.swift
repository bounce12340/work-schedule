import Foundation

final class MockTransport: URLProtocol {
    struct Exchange {
        let check: (URLRequest) throws -> (Int, Data)
    }

    private static let lock = NSLock()
    private static var replies: [Exchange] = []

    static func enqueue(_ exchange: @escaping (URLRequest) throws -> (Int, Data)) {
        lock.lock()
        defer { lock.unlock() }
        replies.append(Exchange(check: exchange))
    }

    static var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return replies.count
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        guard !Self.replies.isEmpty else {
            Self.lock.unlock()
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let next = Self.replies.removeFirst()
        Self.lock.unlock()
        do {
            let (status, data) = try next.check(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

@MainActor
private final class LegacyProbeGate {
    private var reply: CheckedContinuation<LegacyScheduleProbe, Never>?
    private var observer: CheckedContinuation<Void, Never>?

    func pause() async -> LegacyScheduleProbe {
        await withCheckedContinuation { continuation in
            reply = continuation
            observer?.resume()
            observer = nil
        }
    }

    func waitForProbe() async {
        if reply != nil { return }
        await withCheckedContinuation { observer = $0 }
    }

    func release(_ result: LegacyScheduleProbe) {
        reply?.resume(returning: result)
        reply = nil
    }
}

@main
struct CloudCheck {
    @MainActor
    static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let disk = CloudDisk(directory: root)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockTransport.self]
        let api = CloudAPI(baseURL: URL(string: "https://work-schedule-test.invalid")!, session: URLSession(configuration: configuration), version: "1.4.0")
        var savedToken: String?
        let vault = SessionVault(read: { savedToken }, write: { savedToken = $0 }, clear: { savedToken = nil })
        let a = "8C9E1C03-E2B8-4C47-BBCB-992F52F005A0"
        let b = "10BD1C48-5ED4-4856-806A-43F326DED5F1"
        let store = CloudStore(api: api, disk: disk, vault: vault, readLegacy: { .absent })
        var initial = CloudStore.emptySnapshot()
        initial["extensionFromWeb"] = .object(["agent": .bool(true)])
        MockTransport.enqueue { request in
            precondition(request.httpMethod == "POST" && request.url?.path == "/api/auth/app/login")
            precondition(request.value(forHTTPHeaderField: "X-App-Client") == "ios/1.4.0")
            return (200, Data("""
            {"ok":true,"token":"first-account-token","user":{"id":"\(a)","email":"first@example.invalid","role":"user"}}
            """.utf8))
        }
        MockTransport.enqueue { request in
            precondition(request.value(forHTTPHeaderField: "Authorization") == "Bearer first-account-token")
            return try stateReply(userID: a, email: "first@example.invalid", snapshot: initial, updatedAt: 100)
        }
        try await store.login(email: "first@example.invalid", password: "fixture-only")
        precondition(store.status == .synced && store.user?.appAccountToken?.uuidString == a)
        precondition(store.state["extensionFromWeb"] == initial["extensionFromWeb"])
        print("PASS bearer/client headers, approved account, and unknown JSON fields")

        var concurrent = initial
        concurrent["remoteChange"] = .string("keep")
        store.updateState { $0["localChange"] = .bool(true) }
        MockTransport.enqueue { request in
            precondition(request.httpMethod == "PUT")
            let params = try body(request)
            precondition(params["baseUpdatedAt"] == .number(100) && params["state"]?["localChange"] == .bool(true))
            return try conflictReply(snapshot: concurrent, updatedAt: 101)
        }
        MockTransport.enqueue { request in
            let params = try body(request)
            precondition(params["baseUpdatedAt"] == .number(101))
            precondition(params["state"]?["localChange"] == .bool(true) && params["state"]?["remoteChange"] == .string("keep"))
            precondition(params["state"]?["extensionFromWeb"]?["agent"] == .bool(true))
            return (200, Data("{\"ok\":true,\"updatedAt\":102}".utf8))
        }
        await store.sync()
        precondition(store.status == .synced && store.conflict == nil)
        print("PASS compare-and-swap guarded automatic merge preserves both branches")

        var disputed = concurrent
        disputed["localChange"] = .bool(true)
        disputed["sharedField"] = .string("remote")
        disputed["extraField"] = .number(3)
        store.updateState { $0["sharedField"] = .string("local") }
        MockTransport.enqueue { _ in try conflictReply(snapshot: disputed, updatedAt: 103) }
        await store.sync()
        precondition(store.status == .conflict && store.conflict?.paths == ["sharedField"])
        precondition(store.state["sharedField"] == .string("local"))
        precondition(MockTransport.count == 0)
        await store.resolveConflict(.useCloud)
        precondition(store.status == .synced && store.state["extraField"] == .number(3))
        print("PASS overlapping edits pause writes until a conflict resolution")

        store.updateState { $0["offlineDraft"] = .bool(true) }
        MockTransport.enqueue { _ in throw URLError(.notConnectedToInternet) }
        await store.sync()
        precondition(store.status == .offline)
        MockTransport.enqueue { _ in throw URLError(.notConnectedToInternet) }
        let reboot = CloudStore(api: api, disk: disk, vault: vault, readLegacy: { .absent })
        await reboot.start()
        precondition(reboot.status == .offline && reboot.state["offlineDraft"] == .bool(true))
        print("PASS pending edits survive relaunch with no internet")

        MockTransport.enqueue { request in
            precondition(request.url?.path == "/api/auth/logout")
            return (200, Data("{\"ok\":true}".utf8))
        }
        try await reboot.logout()
        precondition(reboot.user == nil && reboot.state["offlineDraft"] == nil && savedToken == nil)
        MockTransport.enqueue { _ in
            (200, Data("""
            {"ok":true,"token":"second-account-token","user":{"id":"\(b)","email":"second@example.invalid","role":"user"}}
            """.utf8))
        }
        MockTransport.enqueue { _ in try stateReply(userID: b, email: "second@example.invalid", snapshot: nil, updatedAt: nil) }
        try await reboot.login(email: "second@example.invalid", password: "fixture-only")
        precondition(reboot.status == .synced && reboot.state["offlineDraft"] == nil)
        precondition(reboot.user?.appAccountToken?.uuidString == b && MockTransport.count == 0)
        print("PASS logout and switching accounts never expose the previous account's offline draft")

        let upgradeDisk = CloudDisk(directory: root.appendingPathComponent("legacy-upgrade"))
        savedToken = "legacy-keychain-token"
        var probeCount = 0
        let upgrading = CloudStore(api: api, disk: upgradeDisk, vault: vault, readLegacy: {
            probeCount += 1
            return .unavailable
        })
        MockTransport.enqueue { _ in throw URLError(.notConnectedToInternet) }
        await upgrading.start()
        precondition(upgrading.user == nil && probeCount == 0 && upgrading.status == .failed)
        precondition(upgrading.state["unuploadedLegacyEdit"] == nil && upgradeDisk.allowsLegacyImport())

        var oldBase = CloudStore.emptySnapshot()
        oldBase["existing"] = .string("base")
        var online = oldBase
        online["latestWebEdit"] = .bool(true)
        MockTransport.enqueue { request in
            precondition(request.value(forHTTPHeaderField: "Authorization") == "Bearer legacy-keychain-token")
            return try stateReply(userID: a, email: "first@example.invalid", snapshot: online, updatedAt: 250)
        }
        await upgrading.retryConnection()
        precondition(upgrading.user?.appAccountToken?.uuidString == a && probeCount == 1)
        precondition(upgrading.status == .synced && upgrading.state["latestWebEdit"] == .bool(true))
        precondition(upgradeDisk.allowsLegacyImport())
        print("PASS first native startup stays gated offline and retry verifies the saved session")

        var oldDraft = oldBase
        oldDraft["unuploadedLegacyEdit"] = .string("recover")
        let reopened = CloudStore(api: api, disk: upgradeDisk, vault: vault, readLegacy: {
            probeCount += 1
            return .found(ScheduleCache(user: CloudUser(email: "first@example.invalid"), state: oldDraft,
                                        base: oldBase, updatedAt: 200, dirty: true))
        })
        MockTransport.enqueue { _ in
            try stateReply(userID: a, email: "first@example.invalid", snapshot: online, updatedAt: 250)
        }
        MockTransport.enqueue { request in
            let params = try body(request)
            precondition(request.httpMethod == "PUT" && params["baseUpdatedAt"] == .number(250))
            precondition(params["state"]?["latestWebEdit"] == .bool(true))
            precondition(params["state"]?["unuploadedLegacyEdit"] == .string("recover"))
            return (200, Data("{\"ok\":true,\"updatedAt\":251}".utf8))
        }
        await reopened.start()
        precondition(reopened.status == .synced && probeCount == 2)
        precondition(!upgradeDisk.allowsLegacyImport() && reopened.state["unuploadedLegacyEdit"] == .string("recover"))
        print("PASS failed legacy probe retries after cold launch and merges its draft with newer cloud data")

        let wrongOwnerDisk = CloudDisk(directory: root.appendingPathComponent("legacy-isolation"))
        savedToken = "unrelated-keychain-token"
        let unrelated = CloudStore(api: api, disk: wrongOwnerDisk, vault: vault, readLegacy: {
            .found(ScheduleCache(user: CloudUser(email: "first@example.invalid"), state: oldDraft,
                                 base: oldBase, updatedAt: 200, dirty: true))
        })
        MockTransport.enqueue { _ in try stateReply(userID: b, email: "second@example.invalid", snapshot: nil, updatedAt: nil) }
        await unrelated.start()
        precondition(unrelated.user?.appAccountToken?.uuidString == b && unrelated.state["unuploadedLegacyEdit"] == nil)
        precondition(wrongOwnerDisk.allowsLegacyImport() && MockTransport.count == 0)
        print("PASS account mismatch never displays or uploads a legacy draft")

        let raceDisk = CloudDisk(directory: root.appendingPathComponent("logout-while-starting"))
        let probeGate = LegacyProbeGate()
        var firstProbe = true
        savedToken = "startup-account-token"
        let switching = CloudStore(api: api, disk: raceDisk, vault: vault, readLegacy: {
            guard firstProbe else { return .absent }
            firstProbe = false
            return await probeGate.pause()
        })
        MockTransport.enqueue { _ in
            try stateReply(userID: a, email: "first@example.invalid", snapshot: online, updatedAt: 250)
        }
        let firstStartup = Task { await switching.start() }
        await probeGate.waitForProbe()
        precondition(switching.user?.appAccountToken?.uuidString == a)

        MockTransport.enqueue { request in
            precondition(request.url?.path == "/api/auth/logout")
            precondition(request.value(forHTTPHeaderField: "Authorization") == "Bearer startup-account-token")
            return (200, Data("{\"ok\":true}".utf8))
        }
        try await switching.logout()
        precondition(switching.user == nil && savedToken == nil && switching.status == .signedOut,
                     "Logout must clear the active account while startup is waiting on a legacy probe")

        MockTransport.enqueue { _ in
            (200, Data("""
            {"ok":true,"token":"new-account-token","user":{"id":"\(b)","email":"second@example.invalid","role":"user"}}
            """.utf8))
        }
        MockTransport.enqueue { _ in
            try stateReply(userID: b, email: "second@example.invalid", snapshot: nil, updatedAt: nil)
        }
        try await switching.login(email: "second@example.invalid", password: "fixture-only")
        precondition(switching.user?.appAccountToken?.uuidString == b && savedToken == "new-account-token")

        probeGate.release(.found(ScheduleCache(user: CloudUser(email: "first@example.invalid"), state: oldDraft,
                                             base: oldBase, updatedAt: 200, dirty: true)))
        await firstStartup.value
        precondition(switching.user?.appAccountToken?.uuidString == b && switching.status == .synced)
        precondition(switching.state["unuploadedLegacyEdit"] == nil && savedToken == "new-account-token")
        precondition(MockTransport.count == 0)
        print("PASS logout invalidates an in-flight startup and permits another account before the old probe returns")


    }

    static func body(_ request: URLRequest) throws -> JSONObject {
        if let data = request.httpBody { return try JSONDecoder().decode(JSONObject.self, from: data) }
        guard let stream = request.httpBodyStream else { throw URLError(.badURL) }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bytes = UnsafeMutablePointer<UInt8>.allocate(capacity: 1024)
        defer { bytes.deallocate() }
        while case let count = stream.read(bytes, maxLength: 1024), count > 0 {
            data.append(bytes, count: count)
        }
        return try JSONDecoder().decode(JSONObject.self, from: data)
    }

    static func stateReply(userID: String, email: String, snapshot: JSONObject?, updatedAt: Double?) throws -> (Int, Data) {
        let response: JSONObject = [
            "user": .object(["email": .string(email), "status": .string("approved"), "plan": .string("free"), "appAccountToken": .string(userID)]),
            "state": snapshot.map(JSONValue.object) ?? .null, "updatedAt": updatedAt.map(JSONValue.number) ?? .null,
        ]
        return (200, try JSONEncoder().encode(response))
    }

    static func conflictReply(snapshot: JSONObject, updatedAt: Double) throws -> (Int, Data) {
        (409, try JSONEncoder().encode(["remote": JSONValue.object(["state": .object(snapshot), "updatedAt": .number(updatedAt)])]))
    }
}
