import Combine
import Foundation

@MainActor
final class CloudStore: ObservableObject {
    @Published private(set) var state: JSONObject = CloudStore.emptySnapshot()
    @Published private(set) var user: CloudUser?
    @Published private(set) var status: CloudStatus = .signedOut
    @Published private(set) var message: String?
    @Published private(set) var conflict: CloudConflict?

    private let api: CloudAPI
    private let disk: CloudDisk
    private let vault: SessionVault
    private let readLegacy: @MainActor () async -> LegacyScheduleProbe
    private var token: String?
    private(set) var sessionGeneration = UUID()
    private var base: JSONObject?
    private var updatedAt: Int64?
    private var dirty = false
    private var syncTask: Task<Void, Never>?
    private var managingSession = false
    private var syncing = false

    init(api: CloudAPI = CloudAPI(), disk: CloudDisk = CloudDisk(),
         vault: SessionVault = .keychain, readLegacy: (@MainActor () async -> LegacyScheduleProbe)? = nil) {
        self.api = api
        self.disk = disk
        self.vault = vault
        self.readLegacy = readLegacy ?? { await LegacyScheduleReader().read() }
    }

    static func supports(_ snapshot: JSONObject) -> Bool {
        guard let version = snapshot["version"]?.int else { return false }
        return (1...3).contains(version)
    }

    static func emptySnapshot() -> JSONObject {
        let year = Calendar(identifier: .gregorian).component(.year, from: Date())
        return [
            "version": .number(3),
            "majorProjects": .array([]),
            "items": .array([]),
            "ganttProjects": .array([]),
            "dailyLogs": .object([:]),
            "customHolidays": .array([]),
            "customWorkdays": .array([]),
            "absences": .object([:]),
            "selectedGanttProjectId": .null,
            "availableYears": .array(((year - 1)...(year + 2)).map { .number(Double($0)) }),
        ]
    }

    func start() async {
        guard user == nil, !managingSession else { return }
        let generation = sessionGeneration
        managingSession = true
        defer { if sessionGeneration == generation { managingSession = false } }
        status = .checking
        do {
            guard let savedToken = try vault.read() else {
                status = .signedOut
                return
            }
            token = savedToken
            do {
                if let cache = try disk.active(token: savedToken), Self.supports(cache.state) {
                    apply(cache)
                }
            } catch {
                message = error.localizedDescription
            }
            try await synchronize(generation: generation)
        } catch {
            if sessionGeneration == generation { report(error) }
        }
    }

    func retryConnection() async {
        if user == nil { await start() }
        else { await sync() }
    }

    func login(email: String, password: String) async throws {
        try await authenticate("/api/auth/app/login", body: ["email": .string(email), "password": .string(password)])
    }

    func sendRegistrationCode(email: String) async throws {
        let reply = try await api.send("POST", "/api/auth/app/code", body: ["email": .string(email)])
        try reply.validate()
    }

    func register(email: String, code: String, password: String, appTransactionJWS: String) async throws {
        try await authenticate("/api/auth/app/register", body: [
            "email": .string(email), "code": .string(code), "password": .string(password),
            "appTransactionJws": .string(appTransactionJWS),
        ])
    }

    func signInWithApple(idToken: String, authorizationCode: String?, nonce: String) async throws {
        try await authenticate("/api/auth/app/oauth", body: Self.appleBody(idToken, authorizationCode, nonce))
    }

    func signInWithGoogle(authorizationCode: String, codeVerifier: String, redirectURI: String) async throws {
        try await authenticate("/api/auth/app/oauth", body: Self.googleBody(authorizationCode, codeVerifier, redirectURI))
    }

    func logout(pushToken: String? = nil, generation: UUID? = nil) async throws {
        if let generation, sessionGeneration != generation { throw CloudError.noSession }
        let previousToken = token
        // Drop access locally before waiting for the best-effort revoke.
        // Any previous async operation now belongs to a retired session.
        try clearSession()
        if let previousToken {
            if let pushToken, let value = try? Self.pushToken(pushToken) {
                _ = try? await api.send("DELETE", "/api/push/register", body: ["token": .string(value)], token: previousToken)
            }
            _ = try? await api.send("POST", "/api/auth/logout", token: previousToken)
        }
    }

    func deleteAccount(password: String) async throws {
        try await removeAccount(body: ["password": .string(password)])
    }

    func deleteAccountWithApple(idToken: String, authorizationCode: String?, nonce: String, generation: UUID) async throws {
        try await removeAccount(body: Self.appleBody(idToken, authorizationCode, nonce), generation: generation)
    }

    func deleteAccountWithGoogle(authorizationCode: String, codeVerifier: String, redirectURI: String, generation: UUID) async throws {
        try await removeAccount(body: Self.googleBody(authorizationCode, codeVerifier, redirectURI), generation: generation)
    }

    func changePassword(oldPassword: String, newPassword: String) async throws {
        _ = try await authorized("POST", "/api/auth/password", body: [
            "oldPassword": .string(oldPassword), "newPassword": .string(newPassword),
        ])
    }

    private static let cappedScheduleCollections = ["majorProjects", "ganttProjects"]
    private static let freeProjectLimit = 3

    func canAddProject(in collection: String) -> Bool {
        user?.isPro == true || (state[collection]?.array?.count ?? 0) < Self.freeProjectLimit
    }

    func updateState(_ edit: (inout JSONObject) -> Void) {
        guard user != nil, token != nil else { return }
        var next = state
        edit(&next)
        guard next != state, Self.supports(next) else { return }
        if user?.isPro != true, Self.cappedScheduleCollections.contains(where: { key in
            let previousCount = state[key]?.array?.count ?? 0
            return (next[key]?.array?.count ?? 0) > max(previousCount, Self.freeProjectLimit)
        }) {
            message = "免費方案最多可新增 3 個工作分類及 3 個甘特專案。"
            return
        }
        state = next
        dirty = true
        if conflict == nil { status = .pending }
        message = nil
        do { try persist() }
        catch { report(error) }
        scheduleSync()
    }

    func sync() async {
        await sync(generation: sessionGeneration)
    }

    private func sync(generation: UUID) async {
        do { try await synchronize(generation: generation) }
        catch {
            if sessionGeneration == generation { report(error) }
        }
    }

    func resolveConflict(_ choice: CloudConflictChoice) async {
        guard let conflict else { return }
        let generation = sessionGeneration
        let merged = SnapshotMerge.merge(base: base, local: state, remote: conflict.remote, choice: choice)
        adoptResolution(merged.state, against: conflict.remote, at: conflict.updatedAt)
        do {
            try persist()
            if dirty { try await synchronize(generation: generation) }
        } catch {
            if sessionGeneration == generation { report(error) }
        }
    }

    func listShares() async throws -> JSONObject {
        try await authorized("GET", "/api/shares")
    }

    func createShare(kind: String, resourceId: String, permission: String, email: String, generation: UUID? = nil) async throws {
        let generation = generation ?? sessionGeneration
        try await flushBeforeSharing(generation: generation)
        _ = try await authorized("POST", "/api/shares", body: [
            "kind": .string(kind), "resourceId": .string(resourceId), "permission": .string(permission), "email": .string(email),
        ], generation: generation)
    }

    func deleteShare(id: String) async throws {
        _ = try await authorized("DELETE", "/api/shares/\(CloudAPI.segment(id))")
    }

    func updateShared(id: String, resource: JSONObject) async throws {
        _ = try await authorized("PUT", "/api/shared/\(CloudAPI.segment(id))", body: ["resource": .object(resource)])
    }

    func projectShareStatus(projectId: String) async throws -> JSONObject? {
        try await authorized("GET", Self.projectSharePath(projectId))["active"]?.object
    }

    func createProjectShare(projectId: String, include: [String] = []) async throws -> URL {
        let generation = sessionGeneration
        try await flushBeforeSharing(generation: generation)
        let result = try await authorized("POST", Self.projectSharePath(projectId),
                                          body: ["include": .array(include.map(JSONValue.string))], generation: generation)
        guard let rawURL = result["url"]?.string, let url = URL(string: rawURL), url.scheme == "https" else {
            throw CloudError.malformedResponse
        }
        return url
    }

    func revokeProjectShare(projectId: String) async throws {
        _ = try await authorized("DELETE", Self.projectSharePath(projectId))
    }

    func syncAppleEntitlements(_ signedTransactions: [String], generation: UUID? = nil) async throws {
        guard !signedTransactions.isEmpty else { return }
        let generation = generation ?? sessionGeneration
        for start in stride(from: 0, to: signedTransactions.count, by: 20) {
            let batch = signedTransactions[start ..< min(start + 20, signedTransactions.count)]
            let plan = try await authorized("POST", "/api/plan/apple",
                                            body: ["signedTransactions": .array(batch.map(JSONValue.string))], generation: generation)
            guard sessionGeneration == generation, var current = user else { throw CloudError.noSession }
            current.plan = plan["plan"]?.string
            current.source = plan["planSource"]?.string
            current.expiresAt = plan["planExpiresAt"]?.int.map(Int64.init)
            user = current
            try persist()
        }
    }

    func registerPush(token: String, environment: String, generation: UUID) async throws {
        let value = try Self.pushToken(token)
        _ = try await authorized("POST", "/api/push/register", body: ["token": .string(value), "environment": .string(environment)],
                                 generation: generation)
    }

    func unregisterPush(token: String) async throws {
        let value = try Self.pushToken(token)
        _ = try await authorized("DELETE", "/api/push/register", body: ["token": .string(value)])
    }

    private struct Authentication: Decodable {
        let token: String
        let user: CloudUser
    }

    private struct Remote: Decodable {
        let user: CloudUser
        let state: JSONObject?
        let updatedAt: Int64?
    }

    private struct WriteResult: Decodable {
        let updatedAt: Int64
    }

    private struct VersionedState: Decodable {
        let state: JSONObject
        let updatedAt: Int64
    }

    private struct WriteConflict: Decodable {
        let remote: VersionedState
    }

    private func authenticate(_ path: String, body: JSONObject) async throws {
        guard !managingSession, user == nil else { return }
        let generation = sessionGeneration
        managingSession = true
        defer { if sessionGeneration == generation { managingSession = false } }
        let reply = try await api.send("POST", path, body: body)
        guard sessionGeneration == generation else { throw CancellationError() }
        try reply.validate()
        let authorization = try reply.decode(Authentication.self)
        try vault.write(authorization.token)
        token = authorization.token
        user = authorization.user
        status = .checking
        let cache = try? disk.load(email: authorization.user.email)
        if let cache, cache.user.matches(authorization.user), Self.supports(cache.state),
           authorization.user.id != nil {
            apply(cache)
        }
        do { try await synchronize(generation: generation, verifyingUser: true) }
        catch {
            if sessionGeneration == generation { report(error) }
        }
    }

    private func synchronize(generation: UUID, verifyingUser: Bool = false) async throws {
        guard sessionGeneration == generation, let token, !syncing, conflict == nil else { return }
        syncing = true
        defer { if sessionGeneration == generation { syncing = false } }
        status = .syncing
        message = nil
        if !dirty || user == nil || verifyingUser {
            let reply = try await api.send("GET", "/api/state", token: token)
            guard sessionGeneration == generation else { return }
            try validateSession(reply)
            let remote = try reply.decode(Remote.self)
            if let remoteState = remote.state, !Self.supports(remoteState) { throw CloudError.invalidState }
            if let previous = user, !previous.matches(remote.user) {
                try clearSession()
                throw CloudError.noSession
            }
            if user == nil, let cache = try? disk.load(email: remote.user.email),
               cache.user.matches(remote.user), Self.supports(cache.state) {
                apply(cache)
            }
            user = remote.user
            if let remoteState = remote.state, let remoteDate = remote.updatedAt {
                mergeRemote(remoteState, at: remoteDate)
            }
            try persist()
        }
        try await pushPending(for: token, generation: generation)
        guard sessionGeneration == generation, !dirty, conflict == nil else { return }
        if disk.allowsLegacyImport() {
            let probe = await readLegacy()
            guard sessionGeneration == generation else { return }
            // A user can edit the native schedule while WebKit is opening its
            // old store. Settle those edits before comparing the legacy branch.
            try await pushPending(for: token, generation: generation)
            guard sessionGeneration == generation, !dirty, conflict == nil else { return }
            try reconcileLegacy(probe)
            try await pushPending(for: token, generation: generation)
        }
        if sessionGeneration == generation, !dirty, conflict == nil { status = .synced }
    }

    private func pushPending(for token: String, generation: UUID) async throws {
        var retriedConflict = false
        while sessionGeneration == generation, dirty, conflict == nil {
            let sent = state
            let reply = try await api.send("PUT", "/api/state", body: [
                "state": .object(sent), "baseUpdatedAt": updatedAt.map { .number(Double($0)) } ?? .null,
            ], token: token)
            guard sessionGeneration == generation else { return }
            if reply.status == 409 {
                let remote = try reply.decode(WriteConflict.self).remote
                guard Self.supports(remote.state) else { throw CloudError.invalidState }
                mergeRemote(remote.state, at: remote.updatedAt)
                try persist()
                if !dirty || conflict != nil || retriedConflict { return }
                // Keep the latest safe merge, but only retry once in this pass.
                retriedConflict = true
                continue
            }
            try validateSession(reply)
            updatedAt = try reply.decode(WriteResult.self).updatedAt
            base = sent
            dirty = state != sent
            try persist()
        }
    }

    private func reconcileLegacy(_ probe: LegacyScheduleProbe) throws {
        switch probe {
        case .unavailable:
            return
        case .absent:
            try disk.preventLegacyImport()
        case .found(let legacy):
            guard let user, legacy.user.matches(user) else { return }
            let legacyState = ScheduleDocument(legacy.state).state
            let legacyBase = legacy.base.map { ScheduleDocument($0).state }
            if let updatedAt, legacyState != legacyBase {
                let remote = state
                let merge = SnapshotMerge.merge(base: legacyBase, local: legacyState, remote: remote)
                if merge.conflicts.isEmpty {
                    adoptResolution(merge.state, against: remote, at: updatedAt)
                } else {
                    state = legacyState
                    base = legacyBase
                    // A relaunch must rediscover the conflict before it can
                    // write again, even if the old version number was missing.
                    self.updatedAt = nil
                    dirty = true
                    conflict = CloudConflict(remote: remote, updatedAt: updatedAt, paths: merge.conflicts)
                    status = .conflict
                }
            } else if updatedAt == nil, state != legacyState {
                state = legacyState
                dirty = true
                status = .pending
            }
            // Mark completion only after any recovered draft is durable.
            try persist()
            try disk.preventLegacyImport()
        }
    }

    private func mergeRemote(_ remote: JSONObject, at version: Int64) {
        let remote = ScheduleDocument(remote).state
        guard dirty else {
            adoptResolution(remote, against: remote, at: version)
            return
        }
        let merge = SnapshotMerge.merge(base: base, local: state, remote: remote)
        if merge.conflicts.isEmpty {
            adoptResolution(merge.state, against: remote, at: version)
        } else {
            conflict = CloudConflict(remote: remote, updatedAt: version, paths: merge.conflicts)
            status = .conflict
        }
    }

    private func adoptResolution(_ resolved: JSONObject, against remote: JSONObject, at version: Int64) {
        state = resolved
        base = remote
        updatedAt = version
        dirty = resolved != remote
        conflict = nil
        status = dirty ? .pending : .synced
    }

    private func removeAccount(body: JSONObject, generation: UUID? = nil) async throws {
        let generation = generation ?? sessionGeneration
        guard sessionGeneration == generation, let email = user?.email, !managingSession else { throw CloudError.noSession }
        managingSession = true
        defer { if sessionGeneration == generation { managingSession = false } }
        _ = try await authorized("DELETE", "/api/auth/account", body: body, generation: generation)
        guard sessionGeneration == generation else { throw CloudError.noSession }
        let clear = Result { try clearSession() }
        try disk.deleteSchedule(email: email)
        try clear.get()
    }

    func authorized(_ method: String, _ path: String, body: JSONObject? = nil, generation: UUID? = nil) async throws -> JSONObject {
        let generation = generation ?? sessionGeneration
        guard sessionGeneration == generation, let token, user != nil else { throw CloudError.noSession }
        let reply = try await api.send(method, path, body: body, token: token)
        guard sessionGeneration == generation else { throw CloudError.noSession }
        try validateSession(reply)
        return try reply.decode(JSONObject.self)
    }

    private func validateSession(_ reply: CloudAPI.Reply) throws {
        if reply.status == 401 {
            try clearSession()
            message = "登入憑證已過期，請重新登入。"
        }
        try reply.validate()
    }

    private func apply(_ cache: ScheduleCache) {
        state = ScheduleDocument(cache.state).state
        user = cache.user
        base = cache.base.map { ScheduleDocument($0).state }
        updatedAt = cache.updatedAt
        dirty = cache.dirty && state != base
    }

    private func persist() throws {
        guard let user, let token else { return }
        try disk.save(ScheduleCache(user: user, state: state, base: base, updatedAt: updatedAt, dirty: dirty), token: token)
    }

    private func clearSession() throws {
        sessionGeneration = UUID()
        managingSession = false
        syncTask?.cancel()
        syncTask = nil
        syncing = false
        token = nil
        user = nil
        state = Self.emptySnapshot()
        base = nil
        updatedAt = nil
        dirty = false
        conflict = nil
        status = .signedOut
        message = nil
        let clearCredential = Result { try vault.clear() }
        let hideCache = Result { try disk.deactivate() }
        try clearCredential.get()
        try hideCache.get()
    }

    private func report(_ error: Error) {
        if error is CancellationError || (error as? URLError)?.code == .cancelled {
            if status == .syncing { status = user == nil ? .signedOut : .pending }
            return
        }
        status = error is URLError && user != nil ? .offline : .failed
        message = error.localizedDescription
    }

    private func scheduleSync() {
        guard conflict == nil else { return }
        let generation = sessionGeneration
        syncTask?.cancel()
        syncTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: 1_200_000_000) }
            catch { return }
            guard let self, self.sessionGeneration == generation, !Task.isCancelled else { return }
            self.syncTask = nil
            await self.sync(generation: generation)
        }
    }

    private func flushBeforeSharing(generation: UUID) async throws {
        if dirty { await sync(generation: generation) }
        guard sessionGeneration == generation, user != nil else { throw CloudError.noSession }
        guard !dirty else { throw CloudError.pendingSchedule }
    }

    private static func pushToken(_ token: String) throws -> String {
        let token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { throw CloudError.invalidPushToken }
        return token
    }

    private static func projectSharePath(_ projectId: String) -> String {
        "/api/projects/\(CloudAPI.segment(projectId))/share"
    }

    private static func appleBody(_ idToken: String, _ code: String?, _ nonce: String) -> JSONObject {
        var body: JSONObject = ["provider": .string("apple"), "idToken": .string(idToken), "nonce": .string(nonce)]
        if let code { body["authorizationCode"] = .string(code) }
        return body
    }

    private static func googleBody(_ code: String, _ verifier: String, _ uri: String) -> JSONObject {
        ["provider": .string("google"), "authorizationCode": .string(code), "codeVerifier": .string(verifier), "redirectUri": .string(uri)]
    }
}
