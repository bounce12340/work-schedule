#if DEBUG && targetEnvironment(simulator)
import Foundation

@MainActor
enum PreviewWorkspace {
    static func store() -> CloudStore {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PreviewWorker.self]
        let session = URLSession(configuration: configuration)
        let url = URL(string: "https://preview.work-schedule.invalid")!
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("PreviewWorkspace", isDirectory: true)
        var fixtureToken: String? = "preview-only"
        return CloudStore(
            api: CloudAPI(baseURL: url, session: session),
            disk: CloudDisk(directory: folder),
            vault: SessionVault(read: { fixtureToken }, write: { fixtureToken = $0 }, clear: { fixtureToken = nil }),
            readLegacy: { .absent }
        )
    }

    static func snapshot() -> JSONObject {
        let today = ScheduleDay(Date())
        var document = ScheduleDocument(CloudStore.emptySnapshot())
        let category = ScheduleCategory(id: "editorial", name: "網站改版")
        document.saveCategory(category)
        var review = ScheduleItem(id: "review", title: "網站改版設計審查", date: today, type: .meeting)
        review.parentID = category.id
        review.time = "10:30"
        review.tags = ["設計"]
        review.subtasks = [
            ScheduleStep(id: "review-copy", text: "確認首頁文案"),
            ScheduleStep(id: "review-flow", text: "檢查 iPhone 與 iPad 的版面")
        ]
        document.saveItem(review)
        var schedule = ScheduleItem(id: "weekly", title: "整理每週專案進度", date: today, type: .work)
        schedule.recurrence = ScheduleRecurrence(frequency: .weekly)
        schedule.tags = ["例行"]
        document.saveItem(schedule)
        let tomorrow = today.adding(days: 1)
        document.saveItem(ScheduleItem(id: "assignment", title: "確認上線檢查表", date: tomorrow, type: .assignment))
        let project = ScheduleProject(id: "website", name: "網站改版")
        document.saveProject(project)
        for (id, title, start, end, progress) in [
            ("content", "整理內容與導覽", -3, 1, 100),
            ("design", "設計與介面驗收", -1, 5, 60),
            ("release", "上線測試", 4, 10, 15)
        ] {
            var task = ScheduleTask(id: id, name: title, start: today.adding(days: start), end: today.adding(days: end))
            task.progress = progress
            task.done = progress == 100
            document.saveTask(task, projectID: project.id)
        }
        return document.state
    }
}

private final class PreviewWorker: URLProtocol, @unchecked Sendable {
    private static var state: JSONObject?
    private static var version: Int64 = 100

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "preview.work-schedule.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Task { @MainActor in
            guard let url = request.url else { return }
            var status = 200
            var result: JSONObject
            switch (request.httpMethod, url.path) {
            case ("GET", "/api/state"):
                result = [
                    "user": .object(["email": .string("demo@example.invalid"), "plan": .string("pro")]),
                    "state": .object(Self.state ?? PreviewWorkspace.snapshot()),
                    "updatedAt": .number(Double(Self.version))
                ]
            case ("PUT", "/api/state"):
                if let data = request.httpBody, let decoded = try? JSONDecoder().decode(JSONObject.self, from: data) {
                    Self.state = decoded["state"]?.object
                }
                Self.version += 1
                result = ["ok": .bool(true), "updatedAt": .number(Double(Self.version))]
            case ("GET", "/api/shares"):
                result = ["incoming": .array([]), "outgoing": .array([])]
            default:
                status = 404
                result = ["error": .string("模擬資料未提供這項操作。")]
            }
            guard let reply = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                              headerFields: ["Content-Type": "application/json"]),
                  let data = try? JSONEncoder().encode(result) else { return }
            client?.urlProtocol(self, didReceive: reply, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}
#endif
