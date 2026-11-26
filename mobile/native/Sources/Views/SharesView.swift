import SwiftUI

struct SharesView: View {
    @ObservedObject var store: CloudStore
    @State private var outgoing: [Share] = []
    @State private var incoming: [Share] = []
    @State private var error: String?
    @State private var revoke: Share?
    @State private var sending = false
    @State private var loading = true

    var body: some View {
        List {
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            if loading { ProgressView() }
            Section("別人分享給我") {
                if incoming.isEmpty, !loading { Text("沒有收到分享").foregroundStyle(.secondary) }
                ForEach(incoming) { share in
                    NavigationLink {
                        SharedResourceView(store: store, share: share, reload: reload)
                    } label: {
                        LabeledContent(share.title, value: share.email)
                    }
                }
            }
            Section("我分享給別人") {
                if outgoing.isEmpty, !loading { Text("尚未分享任何排程").foregroundStyle(.secondary) }
                ForEach(outgoing) { share in
                    Button { revoke = share } label: {
                        LabeledContent(resourceTitle(share), value: share.email)
                    }
                }
            }
        }
        .navigationTitle("分享")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { sending = true } label: { Label("新增分享", systemImage: "plus") }
            }
        }
        .task { await reload() }
        .refreshable { await reload() }
        .sheet(isPresented: $sending, onDismiss: { Task { await reload() } }) {
            ShareEditor(store: store)
        }
        .confirmationDialog("撤銷這筆分享？", isPresented: Binding(get: { revoke != nil }, set: { if !$0 { revoke = nil } })) {
            Button("撤銷分享", role: .destructive) {
                guard let share = revoke else { return }
                Task {
                    do {
                        try await store.deleteShare(id: share.id)
                        await reload()
                    } catch { self.error = error.localizedDescription }
                }
            }
        } message: { Text(revoke?.email ?? "") }
    }

    private func resourceTitle(_ share: Share) -> String {
        ShareResource.list(ScheduleDocument(store.state)).first { $0.key == "\(share.kind):\(share.resourceID ?? "")" }?.title
            ?? "已移除的項目"
    }

    private func reload() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let result = try await store.listShares()
            outgoing = (result["outgoing"]?.array ?? []).compactMap(Share.init)
            incoming = (result["incoming"]?.array ?? []).compactMap(Share.init)
        } catch { self.error = error.localizedDescription }
    }
}

private struct ShareResource: Identifiable {
    let kind: String
    let id: String
    let title: String
    var key: String { "\(kind):\(id)" }

    static func list(_ document: ScheduleDocument) -> [ShareResource] {
        document.items.map { ShareResource(kind: "item", id: $0.id, title: $0.title) }
        + document.projects.map { ShareResource(kind: "gantt", id: $0.id, title: $0.name) }
        + document.categories.map { ShareResource(kind: "major", id: $0.id, title: $0.name) }
    }
}

private struct Share {
    let id: String
    let kind: String
    let permission: String
    let email: String
    let resourceID: String?
    let resource: JSONObject?

    var title: String { resource?["title"]?.string ?? resource?["name"]?.string ?? "已移除的項目" }

    init?(_ value: JSONValue) {
        guard let entry = value.object, let id = entry["id"]?.string, let kind = entry["kind"]?.string,
              let permission = entry["permission"]?.string,
              let email = entry["ownerEmail"]?.string ?? entry["targetEmail"]?.string else { return nil }
        self.id = id
        self.kind = kind
        self.permission = permission
        self.email = email
        resourceID = entry["resourceId"]?.string
        resource = entry["resource"]?.object
    }
}

extension Share: Identifiable {}

private struct ShareEditor: View {
    @ObservedObject var store: CloudStore
    @State private var resourceKey = ""
    @State private var permission = "view"
    @State private var email = ""
    @State private var error: String?
    @State private var sending = false
    @Environment(\.dismiss) private var dismiss

    private var resources: [ShareResource] { ShareResource.list(ScheduleDocument(store.state)) }

    var body: some View {
        NavigationStack {
            Form {
                Picker("分享項目", selection: $resourceKey) {
                    Text("請選擇").tag("")
                    ForEach(resources, id: \.key) { resource in
                        Text(resource.title).tag(resource.key)
                    }
                }
                TextField("對方的帳號電子郵件", text: $email)
                    .keyboardType(.emailAddress).textInputAutocapitalization(.never)
                Picker("權限", selection: $permission) {
                    Text("可檢視").tag("view")
                    Text("可編輯").tag("edit")
                }
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            }
            .navigationTitle("新增分享")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("分享") {
                        guard let resource = resources.first(where: { $0.key == resourceKey }) else { return }
                        sending = true
                        Task {
                            defer { sending = false }
                            do {
                                await store.sync()
                                try await store.createShare(kind: resource.kind, resourceId: resource.id, permission: permission, email: email)
                                dismiss()
                            } catch { self.error = error.localizedDescription }
                        }
                    }
                    .disabled(resourceKey.isEmpty || !email.contains("@") || sending)
                }
            }
        }
    }
}

private struct SharedResourceView: View {
    @ObservedObject var store: CloudStore
    let share: Share
    let reload: () async -> Void
    @State private var draft = ""
    @State private var error: String?
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            LabeledContent("擁有者", value: share.email)
            LabeledContent("權限", value: share.permission == "edit" ? "可編輯" : "唯讀")
            if let resource = share.resource {
                if share.permission == "edit" {
                    TextField("名稱", text: $draft)
                    Button("儲存名稱") { save(resource) }
                        .disabled(saving || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft == share.title)
                }
                switch share.kind {
                case "item":
                    let item = ScheduleItem(raw: resource)
                    LabeledContent("日期", value: item.date.rawValue)
                    LabeledContent("類型", value: WorkspaceStyle.title(item.type))
                    ForEach(item.subtasks) { Text($0.text) }
                case "gantt":
                    let project = ScheduleProject(raw: resource)
                    Section("甘特任務") {
                        ForEach(project.tasks) { task in
                            LabeledContent(task.name, value: "\(task.progress)%")
                        }
                    }
                default:
                    let items = (resource["items"]?.array ?? []).compactMap(\.object).map(ScheduleItem.init)
                    Section("排程") {
                        ForEach(items) { item in
                            LabeledContent(item.title, value: item.date.rawValue)
                        }
                    }
                }
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
        }
        .navigationTitle(share.title)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { draft = share.title }
    }

    private func save(_ resource: JSONObject) {
        let value = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        saving = true
        Task {
            defer { saving = false }
            do {
                var updated = resource
                if share.kind == "major" { updated.removeValue(forKey: "items") }
                updated[share.kind == "item" ? "title" : "name"] = .string(value)
                try await store.updateShared(id: share.id, resource: updated)
                await reload()
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}
