import SwiftUI

struct ProjectCollaborationView: View {
    @ObservedObject var store: CloudStore
    let projectID: String

    @State private var events: ProjectLoad<[ProjectEvent]> = .loading
    @State private var pullRequests: ProjectLoad<[ProjectPullRequest]> = .loading
    @State private var selectedRisk: ProjectEvent?
    @State private var actionError: String?
    @State private var closingRisk = false

    private var project: ScheduleProject? {
        ScheduleDocument(store.state).projects.first { $0.id == projectID }
    }

    var body: some View {
        List {
            if let project {
                Section(project.name) {
                    NavigationLink {
                        ProjectMembersView(store: store, projectID: projectID)
                    } label: {
                        Label("以帳號共享", systemImage: "person.2")
                    }
                    NavigationLink {
                        ProjectPublicShareView(store: store, projectID: projectID)
                    } label: {
                        Label("公開唯讀連結", systemImage: "link")
                    }
                    NavigationLink {
                        ProjectVersionsView(store: store, projectID: projectID)
                    } label: {
                        Label("排程版本歷史", systemImage: "clock.arrow.circlepath")
                    }
                }
                milestones(project)
                riskSection
                eventSection
                pullRequestSection
            } else {
                Text("這個專案已移除或目前無法開啟。").foregroundStyle(.secondary)
            }
        }
        .navigationTitle("專案協作")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: projectID) { await load() }
        .refreshable { await load() }
        .confirmationDialog("關閉這個風險？", isPresented: Binding(
            get: { selectedRisk != nil }, set: { if !$0 { selectedRisk = nil } }
        ), titleVisibility: .visible) {
            if let risk = selectedRisk {
                Button("關閉風險") { Task { await close(risk) } }
            }
            Button("取消", role: .cancel) { selectedRisk = nil }
        } message: {
            Text("關閉後會從未解決風險中移除，並在進展日誌留下紀錄。")
        }
    }

    private func milestones(_ project: ScheduleProject) -> some View {
        let milestones = project.raw.records("milestones", make: ProjectMilestone.init(raw:))
            .filter { $0.date != nil }.sorted { ($0.date ?? ScheduleDay(.now)) < ($1.date ?? ScheduleDay(.now)) }
        return Section("里程碑") {
            if milestones.isEmpty { Text("還沒有里程碑。").foregroundStyle(.secondary) }
            ForEach(milestones) { milestone in
                if let date = milestone.date {
                    let today = ScheduleDay(.now)
                    let pending = project.tasks.filter { !$0.done && $0.end <= date }
                    let late = pending.contains { ($0.raw.scheduleDay("forecastEnd") ?? date) > date }
                    VStack(alignment: .leading, spacing: 5) {
                        Label(milestone.name, systemImage: "diamond")
                            .font(.headline)
                        Text(date.rawValue)
                            .font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                        if late || (!pending.isEmpty && today > date) {
                            Label(late ? "有任務的預測完成日超過里程碑" : "已過里程碑日，還有任務沒完成",
                                  systemImage: "exclamationmark.triangle")
                                .font(.footnote).foregroundStyle(.orange)
                        }
                    }
                    .padding(.vertical, 3)
                }
            }
        }
    }

    private var riskSection: some View {
        Section("未解決風險") {
            switch events {
            case .loading: ProgressView("載入中")
            case .failed(let message): Text(message).foregroundStyle(.secondary)
            case .loaded(let entries):
                let open = entries.filter { $0.kind == "risk" && $0.status == "open" && !$0.redacted }
                if open.isEmpty { Text("近期沒有未解決的風險。").foregroundStyle(.secondary) }
                ForEach(open) { risk in
                    ProjectEventRow(event: risk)
                    Button("關閉風險") { selectedRisk = risk }
                        .disabled(closingRisk)
                }
                if closingRisk { ProgressView("更新風險") }
                if let actionError { Text(actionError).foregroundStyle(.red) }
            }
        }
    }

    private var eventSection: some View {
        Section("Agent 工作紀錄") {
            if let brief = project?.brief, !brief.isEmpty {
                NavigationLink("專案說明書") {
                    ScrollView {
                        Text(verbatim: brief).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading).padding()
                    }
                    .navigationTitle("專案說明書")
                }
            }
            switch events {
            case .loading: ProgressView("載入中")
            case .failed: Button("重新載入工作紀錄") { Task { await load() } }
            case .loaded(let entries):
                if entries.isEmpty { Text("還沒有工作紀錄。").foregroundStyle(.secondary) }
                else {
                    NavigationLink {
                        List(entries) { ProjectEventRow(event: $0) }
                            .navigationTitle("近期進展、問答與決策")
                    } label: {
                        LabeledContent("近期進展、問答與決策", value: "\(entries.count) 筆")
                    }
                }
            }
        }
    }

    private var pullRequestSection: some View {
        Section("GitHub") {
            switch pullRequests {
            case .loading: ProgressView("載入中")
            case .failed(let message): Text(message).foregroundStyle(.secondary)
            case .loaded(let requests):
                if requests.isEmpty { Text("這個專案還沒有相關的 Pull Request。").foregroundStyle(.secondary) }
                else {
                    NavigationLink {
                        List(requests) { ProjectPullRequestRow(request: $0) }
                            .navigationTitle("Pull Requests")
                    } label: {
                        LabeledContent("Pull Requests", value: "\(requests.count) 筆")
                    }
                }
            }
        }
    }

    private func load() async {
        let path = "/api/projects/\(CloudAPI.segment(projectID))"
        async let activity = loadProjectResource {
            let data = try await store.authorized("GET", path + "/events")
            return data.records("events", make: ProjectEvent.init(raw:))
        }
        async let prs = loadProjectResource {
            let data = try await store.authorized("GET", path + "/prs")
            return data.records("prs", make: ProjectPullRequest.init(raw:))
                .sorted { ($0.sortPriority, -$0.modified) < ($1.sortPriority, -$1.modified) }
        }
        let (eventResult, prResult) = await (activity, prs)
        guard !Task.isCancelled else { return }
        events = eventResult
        pullRequests = prResult
    }

    private func close(_ risk: ProjectEvent) async {
        guard !closingRisk else { return }
        closingRisk = true
        defer { closingRisk = false }
        actionError = nil
        do {
            _ = try await store.authorized("POST", "/api/projects/events/\(CloudAPI.segment(risk.id))/close-risk")
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }
}

private struct ProjectPublicShareView: View {
    @ObservedObject var store: CloudStore
    let projectID: String
    @State private var active: ProjectLoad<PublicProjectLink?> = .loading
    @State private var additional: Set<ProjectPublicContent> = []
    @State private var shareURL: URL?
    @State private var confirmation: ShareAction?
    @State private var busy = false
    @State private var actionError: String?

    var body: some View {
        Form {
            Section("連結狀態") {
                switch active {
                case .loading: ProgressView("載入中")
                case .failed(let message):
                    Text(message).foregroundStyle(.secondary)
                    Button("重新載入") { Task { await load() } }
                case .loaded(let link):
                    Text(link == nil ? "目前沒有公開連結。" : "目前有一個公開連結。")
                    if let link {
                        if let date = link.date {
                            LabeledContent("建立時間", value: date.formatted(date: .abbreviated, time: .shortened))
                        }
                        if !link.additional.isEmpty {
                            LabeledContent("額外公開內容", value: link.additional.map(\.title).joined(separator: "、"))
                        }
                    }
                    if let shareURL {
                        ShareLink(item: shareURL) { Label("分享新連結", systemImage: "square.and.arrow.up") }
                        Button("收起網址") { self.shareURL = nil }
                        Text("請先分享或複製新連結。離開後只能重新產生。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            if case .loaded(let link) = active {
                Section("公開內容") {
                    Text("知道網址的人可以瀏覽專案名稱、里程碑、任務名稱、日期、狀態、進度與預測完成日。")
                        .font(.subheadline).foregroundStyle(.secondary)
                    ForEach(ProjectPublicContent.allCases) { option in
                        Toggle(option.title, isOn: Binding(
                            get: { additional.contains(option) },
                            set: { enabled in
                                if enabled { additional.insert(option) }
                                else { additional.remove(option) }
                            }
                        ))
                    }
                }
                Section {
                    Button(link == nil ? "產生公開連結" : "重新產生連結") { confirmation = .create }
                    if link != nil {
                        Button("撤銷公開連結", role: .destructive) { confirmation = .revoke }
                    }
                    if busy { ProgressView("更新連結") }
                    if let actionError { Text(actionError).foregroundStyle(.red) }
                }
                .disabled(busy)
            }
        }
        .navigationTitle("公開唯讀連結")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onDisappear { shareURL = nil }
        .onChange(of: store.user?.email) { _ in shareURL = nil }
        .confirmationDialog("變更公開連結？", isPresented: Binding(
            get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }
        ), titleVisibility: .visible) {
            if let confirmation {
                Button(confirmation == .revoke ? "撤銷連結" : "產生連結",
                       role: confirmation == .revoke ? .destructive : nil) {
                    Task { await apply(confirmation) }
                }
            }
            Button("取消", role: .cancel) { confirmation = nil }
        } message: {
            if confirmation == .revoke {
                Text("舊網址會立即失效。")
            } else if case .loaded(let link) = active, link != nil {
                Text("產生新網址會撤銷原有網址。收到新網址的人可以瀏覽選取的內容。")
            } else {
                Text("任何知道網址的人都能瀏覽選取的內容。")
            }
        }
    }

    private enum ShareAction { case create, revoke }

    private func load() async {
        let state = await loadProjectResource {
            try await store.projectShareStatus(projectId: projectID).map(PublicProjectLink.init(raw:))
        }
        guard !Task.isCancelled else { return }
        if case .loaded(let link) = state { additional = Set(link?.additional ?? []) }
        active = state
    }

    private func apply(_ action: ShareAction) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        actionError = nil
        do {
            switch action {
            case .create:
                let selection = ProjectPublicContent.allCases.filter(additional.contains)
                let url = try await store.createProjectShare(projectId: projectID, include: selection.map(\.rawValue))
                shareURL = url
                active = .loaded(PublicProjectLink(date: .now, additional: selection))
            case .revoke:
                try await store.revokeProjectShare(projectId: projectID)
                shareURL = nil
                active = .loaded(nil)
            }
        } catch {
            actionError = error.localizedDescription
        }
    }
}

private struct ProjectMembersView: View {
    @ObservedObject var store: CloudStore
    let projectID: String
    @State private var members: ProjectLoad<[ProjectMember]> = .loading
    @State private var email = ""
    @State private var permission = "view"
    @State private var busy = false
    @State private var actionError: String?
    @State private var selectedMember: ProjectMember?

    var body: some View {
        Form {
            Section("已共享的帳號") {
                switch members {
                case .loading: ProgressView("載入中")
                case .failed(let message):
                    Text(message).foregroundStyle(.secondary)
                    Button("重新載入") { Task { await load() } }
                case .loaded(let people):
                    if people.isEmpty { Text("目前沒有共享的帳號。").foregroundStyle(.secondary) }
                    ForEach(people) { member in
                        LabeledContent(member.email, value: member.permission == "edit" ? "可操作" : "可檢視")
                            .swipeActions {
                                Button("移除", role: .destructive) { selectedMember = member }
                            }
                            .contextMenu {
                                Button("移除共享", role: .destructive) { selectedMember = member }
                            }
                    }
                }
            }
            Section("新增帳號或更新權限") {
                TextField("對方的帳號 Email", text: $email)
                    .keyboardType(.emailAddress).textContentType(.emailAddress)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                Picker("權限", selection: $permission) {
                    Text("可檢視").tag("view")
                    Text("可操作").tag("edit")
                }
                Button("儲存共享權限") {
                    let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
                    let access = permission
                    Task {
                        await mutate {
                            try await store.createShare(kind: "gantt", resourceId: projectID, permission: access, email: address)
                            if email.trimmingCharacters(in: .whitespacesAndNewlines) == address { email = "" }
                        }
                    }
                }
                .disabled(!email.contains("@"))
                if busy { ProgressView("更新共享中") }
                if let actionError { Text(actionError).foregroundStyle(.red) }
            }
            .disabled(busy)
        }
        .navigationTitle("以帳號共享")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .confirmationDialog("移除這個帳號的共享權限？", isPresented: Binding(
            get: { selectedMember != nil }, set: { if !$0 { selectedMember = nil } }
        ), titleVisibility: .visible) {
            if let member = selectedMember {
                Button("移除共享", role: .destructive) {
                    Task { await mutate { try await store.deleteShare(id: member.id) } }
                }
            }
            Button("取消", role: .cancel) { selectedMember = nil }
        }
    }

    private func load() async {
        let result = await loadProjectResource {
            let data = try await store.listShares()
            return data.records("outgoing", make: ProjectMember.init(raw:)).filter {
                $0.raw["kind"]?.string == "gantt" && $0.raw["resourceId"]?.string == projectID
            }
        }
        if !Task.isCancelled { members = result }
    }

    private func mutate(_ operation: @MainActor () async throws -> Void) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        actionError = nil
        do {
            try await operation()
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }
}

private struct ProjectVersionsView: View {
    @ObservedObject var store: CloudStore
    let projectID: String
    @State private var entries: ProjectLoad<[ProjectVersion]> = .loading
    @State private var configured = true

    var body: some View {
        List {
            Section {
                switch entries {
                case .loading: ProgressView("載入中")
                case .failed(let message): Text(message).foregroundStyle(.secondary)
                case .loaded(let versions):
                    if versions.isEmpty {
                        Text(configured ? "目前沒有已儲存的版本。" : "目前未啟用版本留存。").foregroundStyle(.secondary)
                    }
                    ForEach(versions) { version in
                        NavigationLink {
                            ProjectVersionChangesView(store: store, projectID: projectID, version: version)
                        } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(verbatim: version.summary).font(.headline)
                                if let date = version.date {
                                    Text(date, format: .dateTime.year().month().day().hour().minute())
                                        .font(.footnote).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            } header: {
                Text("帳號排程的版本")
            } footer: {
                Text("選取一個版本，即可查看該版本與目前專案的差異。")
            }
        }
        .navigationTitle("排程版本歷史")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            let data = try await store.authorized("GET", "/api/history/versions")
            guard !Task.isCancelled else { return }
            configured = data["configured"]?.bool ?? false
            entries = .loaded(data.records("versions", make: ProjectVersion.init(raw:)))
        } catch {
            if !Task.isCancelled { entries = .failed(error.localizedDescription) }
        }
    }
}

private struct ProjectVersionChangesView: View {
    @ObservedObject var store: CloudStore
    let projectID: String
    let version: ProjectVersion
    @State private var differences: ProjectLoad<[JSONObject]> = .loading
    @State private var truncated = false

    var body: some View {
        List {
            switch differences {
            case .loading: ProgressView("載入差異")
            case .failed(let message): Text(message).foregroundStyle(.secondary)
            case .loaded(let rows):
                if truncated {
                    Text("伺服器僅提供部分差異，專案其餘變動可能未顯示。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if rows.isEmpty {
                    Text("目前顯示的差異裡沒有這個專案的變動。").foregroundStyle(.secondary)
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(verbatim: row["name"]?.string ?? "").font(.headline)
                        Text(verbatim: Self.fieldName(row["field"]?.string ?? ""))
                            .font(.footnote).foregroundStyle(.secondary)
                        LabeledContent("該版本", value: row["before"]?.string ?? "無")
                        LabeledContent("目前", value: row["after"]?.string ?? "無")
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .navigationTitle("專案版本差異")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: version.id) { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            let data = try await store.authorized("GET", "/api/history/versions/\(CloudAPI.segment(version.id))/diff")
            guard !Task.isCancelled else { return }
            truncated = data["truncated"]?.bool ?? false
            let rows = data["rows"]?.array?.compactMap(\.object) ?? []
            differences = .loaded(rows.filter { row in
                let id = row["id"]?.string ?? ""
                switch row["entity"]?.string {
                case "ganttProject": return id == projectID
                case "ganttTask": return id.hasPrefix(projectID + "/")
                default: return false
                }
            })
        } catch {
            if !Task.isCancelled { differences = .failed(error.localizedDescription) }
        }
    }

    private static func fieldName(_ name: String) -> String {
        [
            "name": "名稱", "notes": "筆記", "brief": "專案說明書", "start": "開始日",
            "end": "結束日", "progress": "進度", "done": "完成狀態", "todos": "子待辦",
            "milestones": "里程碑", "forecastEnd": "預測完成日", "status": "任務狀態",
            "estimateHours": "預估時數", "actualHours": "實際時數", "links": "證據連結",
        ][name] ?? name
    }
}

private enum ProjectLoad<Value: Sendable>: Sendable {
    case loading, loaded(Value), failed(String)
}

@MainActor
private func loadProjectResource<Value: Sendable>(_ request: @MainActor () async throws -> Value) async -> ProjectLoad<Value> {
    do { return .loaded(try await request()) }
    catch { return .failed(error.localizedDescription) }
}

private enum ProjectPublicContent: String, CaseIterable, Identifiable, Sendable {
    case events, questions, decisions, risks, prs
    var id: Self { self }
    var title: String {
        switch self {
        case .events: return "進展與交接"
        case .questions: return "提問與回答"
        case .decisions: return "決策"
        case .risks: return "未解決風險"
        case .prs: return "Pull Request 標題與狀態"
        }
    }
}

private struct PublicProjectLink: Sendable {
    let date: Date?
    let additional: [ProjectPublicContent]

    init(date: Date?, additional: [ProjectPublicContent]) {
        self.date = date
        self.additional = additional
    }

    init(raw: JSONObject) {
        date = recordDate(raw["createdAt"])
        additional = (raw["include"]?.array ?? []).compactMap {
            $0.string.flatMap(ProjectPublicContent.init(rawValue:))
        }
    }
}

private struct ProjectMilestone: Identifiable {
    let raw: JSONObject
    var id: String { raw["id"]?.string ?? "" }
    var name: String { raw["name"]?.string ?? "" }
    var date: ScheduleDay? { raw.scheduleDay("date") }
}

private struct ProjectMember: Identifiable, Sendable {
    let raw: JSONObject
    var id: String { raw["id"]?.string ?? "" }
    var email: String { raw["targetEmail"]?.string ?? "" }
    var permission: String { raw["permission"]?.string ?? "view" }
}

private struct ProjectEvent: Identifiable, Sendable {
    let raw: JSONObject
    var id: String { raw["id"]?.string ?? "" }
    var kind: String { raw["kind"]?.string ?? "" }
    var status: String? { raw["status"]?.string }
    var redacted: Bool { recordDate(raw["redactedAt"]) != nil }
    var date: Date? { recordDate(raw["createdAt"]) }
    var body: String { redacted ? "這筆紀錄已遮蔽。" : raw["body"]?.string ?? "" }
    var label: String {
        ["progress": "進展", "handoff": "交接", "question": "提問", "answer": "回答",
         "decision": "決策", "risk": "風險", "withdraw": "撤回"][kind] ?? "紀錄"
    }
    var actor: String { raw["actor"]?.string == "user" ? "擁有者" : raw["actor"]?.string ?? "" }
}

private struct ProjectEventRow: View {
    let event: ProjectEvent

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(event.label).font(.headline)
            if !event.actor.isEmpty { Text(verbatim: event.actor).font(.subheadline).foregroundStyle(.secondary) }
            if let date = event.date {
                Text(date, format: .dateTime.year().month().day().hour().minute())
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if !event.body.isEmpty { Text(verbatim: event.body).textSelection(.enabled) }
        }
        .padding(.vertical, 4)
    }
}

private struct ProjectPullRequest: Identifiable, Sendable {
    let raw: JSONObject
    var id: String { raw["id"]?.string ?? "" }
    var title: String { raw["title"]?.string ?? "" }
    var repository: String { raw["repo"]?.string ?? "" }
    var number: Int { raw["number"]?.int ?? 0 }
    var modified: Double { raw["updatedAt"]?.number ?? 0 }
    var sortPriority: Int {
        if state == "open" || state == "draft" { return checks == "failure" ? 0 : 1 }
        return 2
    }
    var url: URL? {
        guard let text = raw["url"]?.string, let url = URL(string: text), url.scheme?.lowercased() == "https" else { return nil }
        return url
    }
    var state: String { raw["state"]?.string ?? "" }
    var checks: String { raw["checks"]?.string ?? "" }
    var stateName: String {
        ["draft": "草稿", "open": "開啟中", "merged": "已合併", "closed": "已關閉"][state] ?? "狀態未知"
    }
    var checksName: String? {
        ["pending": "檢查中", "success": "檢查通過", "failure": "檢查失敗"][checks]
    }
}

private struct ProjectPullRequestRow: View {
    let request: ProjectPullRequest

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !request.title.isEmpty { Text(verbatim: request.title).font(.headline) }
            Text("\(request.repository) #\(request.number)")
                .font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
            Text([request.stateName, request.checksName].compactMap { $0 }.joined(separator: " · "))
                .font(.footnote)
                .foregroundStyle(request.checks == "failure" ? .red : .secondary)
            if let url = request.url { Link("檢視 Pull Request", destination: url) }
        }
        .padding(.vertical, 4)
    }
}

private struct ProjectVersion: Identifiable, Sendable {
    let raw: JSONObject
    var id: String { raw["id"]?.string ?? "" }
    var date: Date? { recordDate(raw["createdAt"]) }
    var summary: String { raw["summary"]?.string ?? "排程版本" }
}

private func recordDate(_ value: JSONValue?) -> Date? {
    value?.number.map { Date(timeIntervalSince1970: $0 / 1_000) }
}
