import SwiftUI

struct ProjectsView: View {
    @ObservedObject var store: CloudStore
    @State private var showNew = false
    @State private var name = ""

    var body: some View {
        let projects = ScheduleDocument(store.state).projects
        List {
            if projects.isEmpty {
                EmptySchedule(label: "還沒有專案", icon: "chart.bar.xaxis", detail: "新增專案後，就能用甘特圖查看時程。")
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
            }
            if !store.canAddProject(in: "ganttProjects") {
                Text("已達免費方案的 3 個甘特專案上限。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(projects) { project in
                NavigationLink {
                    ProjectView(store: store, id: project.id)
                } label: {
                    HStack(spacing: 13) {
                        Image(systemName: "chart.bar.xaxis")
                            .font(.headline).foregroundStyle(WorkspaceStyle.accent)
                            .frame(width: 38, height: 38)
                            .background(WorkspaceStyle.accent.opacity(0.11), in: RoundedRectangle(cornerRadius: 11))
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(project.name).font(.headline)
                            Text("\(project.tasks.filter(\.done).count) / \(project.tasks.count) 項已完成")
                                .font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 3)
                }
            }
        }
        .navigationTitle("專案")
        .refreshable { await store.sync() }
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { name = ""; showNew = true } label: { Label("新增專案", systemImage: "plus") }
                    .disabled(!store.canAddProject(in: "ganttProjects"))
            }
        }
        .alert("新增甘特專案", isPresented: $showNew) {
            TextField("專案名稱", text: $name)
            Button("建立") {
                let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !title.isEmpty else { return }
                store.editSchedule { $0.saveProject(ScheduleProject(name: title)) }
            }
            Button("取消", role: .cancel) {}
        }
    }
}

struct ProjectView: View {
    @ObservedObject var store: CloudStore
    let id: String
    @Environment(\.dismiss) private var dismiss
    @State private var editor: ScheduleTask?
    @State private var showNote = false
    @State private var showRename = false
    @State private var showDelete = false
    @State private var name = ""

    private var project: ScheduleProject? {
        ScheduleDocument(store.state).projects.first { $0.id == id }
    }

    var body: some View {
        Group {
            if let project {
                ScrollView {
                    VStack(alignment: .leading, spacing: 17) {
                        SectionHeading(title: "甘特圖", detail: "\(project.tasks.count) 項任務")
                        if project.tasks.isEmpty {
                            EmptySchedule(label: "還沒有任務", icon: "chart.bar.xaxis")
                        } else {
                            GanttTimeline(tasks: project.tasks) { editor = $0 }
                            SectionHeading(title: "任務")
                            VStack(spacing: 0) {
                                ForEach(project.tasks) { task in
                                    Button { editor = task } label: {
                                        HStack(spacing: 12) {
                                            Image(systemName: task.done ? "checkmark.circle.fill" : "circle")
                                                .foregroundStyle(WorkspaceStyle.accent)
                                            VStack(alignment: .leading, spacing: 4) {
                                                Text(task.name).foregroundStyle(.primary).font(.headline)
                                                Text("\(task.start.rawValue) 至 \(task.end.rawValue)")
                                                    .foregroundStyle(.secondary).font(.caption.monospacedDigit())
                                            }
                                            Spacer()
                                            Text("\(task.progress)%").foregroundStyle(.secondary).font(.subheadline.monospacedDigit())
                                        }
                                        .frame(minHeight: 48)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    if task.id != project.tasks.last?.id { Divider() }
                                }
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 5)
                            .background(WorkspaceStyle.paper, in: RoundedRectangle(cornerRadius: 16))
                        }
                        HStack {
                            Button { showNote = true } label: { Label("專案筆記", systemImage: "note.text") }
                            NavigationLink {
                                ProjectCollaborationView(store: store, projectID: id)
                            } label: {
                                Label("協作", systemImage: "person.2")
                            }
                        }
                        .buttonStyle(.bordered)
                    }
                    .frame(maxWidth: 740)
                    .padding(16)
                    .frame(maxWidth: .infinity)
                }
                .background(WorkspaceStyle.canvas)
            } else {
                EmptySchedule(label: "找不到這個專案", icon: "folder")
                    .padding()
            }
        }
        .navigationTitle(project?.name ?? "專案")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .navigationBarTrailing) {
                if let project {
                    Menu {
                        Button("重新命名", systemImage: "pencil") {
                            name = project.name
                            showRename = true
                        }
                        Button("刪除專案", systemImage: "trash", role: .destructive) { showDelete = true }
                    } label: { Label("專案動作", systemImage: "ellipsis.circle") }
                    Button {
                        let today = ScheduleDay(Date())
                        editor = ScheduleTask(name: "", start: today, end: today)
                    } label: { Label("新增任務", systemImage: "plus") }
                }
            }
        }
        .sheet(item: $editor) { TaskEditor(store: store, projectID: id, task: $0) }
        .sheet(isPresented: $showNote) {
            if let project {
                FormattedNoteEditor(title: "專案筆記", subtitle: project.name, html: project.notes) { value in
                    store.editSchedule { document in
                        guard var latest = document.projects.first(where: { $0.id == id }) else { return }
                        latest.notes = value
                        document.saveProject(latest)
                    }
                    showNote = false
                }
            }
        }
        .alert("重新命名專案", isPresented: $showRename) {
            TextField("專案名稱", text: $name)
            Button("儲存") {
                let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !title.isEmpty else { return }
                store.editSchedule { document in
                    guard var latest = document.projects.first(where: { $0.id == id }) else { return }
                    latest.name = title
                    document.saveProject(latest)
                }
            }
            Button("取消", role: .cancel) {}
        }
        .confirmationDialog("刪除這個專案及其所有任務？", isPresented: $showDelete) {
            Button("刪除專案", role: .destructive) {
                store.editSchedule { $0.removeProject(id: id) }
                dismiss()
            }
        }
    }
}

private struct GanttTimeline: View {
    let tasks: [ScheduleTask]
    let open: (ScheduleTask) -> Void

    var body: some View {
        if let first = tasks.map(\.start).min(), let last = tasks.map(\.end).max() {
            let span = max(1, dayCount(from: first, to: last) + 1)
            let unit = max(2.1, min(19, 680 / Double(span)))
            let tick = max(1, Int((65 / unit).rounded(.up)))
            let width = CGFloat(span) * unit
            ScrollView(.horizontal) {
                VStack(alignment: .leading, spacing: 10) {
                    ZStack(alignment: .topLeading) {
                        ForEach(Array(stride(from: 0, to: span, by: tick)), id: \.self) { offset in
                            Text(ScheduleDisplay.label(ScheduleDisplay.add(.day, offset, to: first), format: "M/d"))
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(.secondary)
                                .offset(x: CGFloat(offset) * unit)
                        }
                    }
                    .frame(width: width + 40, height: 14, alignment: .leading)
                    ForEach(tasks) { task in
                        let barWidth = max(14, CGFloat(dayCount(from: task.start, to: task.end) + 1) * unit)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(task.name).font(.caption.weight(.semibold)).lineLimit(1)
                            ZStack(alignment: .leading) {
                                RoundedRectangle(cornerRadius: 4)
                                    .fill(WorkspaceStyle.accent.opacity(0.18))
                                RoundedRectangle(cornerRadius: 4)
                                    .fill(WorkspaceStyle.accent)
                                    .frame(width: barWidth * CGFloat(min(100, max(0, task.progress))) / 100)
                            }
                            .frame(width: barWidth, height: 10)
                            .offset(x: CGFloat(dayCount(from: first, to: task.start)) * unit)
                        }
                        .frame(width: width + 40, alignment: .leading)
                        .contentShape(Rectangle())
                        .onTapGesture { open(task) }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(task.name)
                        .accessibilityValue("\(task.start.rawValue) 至 \(task.end.rawValue)，完成 \(task.progress)%")
                        .accessibilityAddTraits(.isButton)
                        .accessibilityAction { open(task) }
                    }
                }
                .padding(14)
            }
            .background(WorkspaceStyle.paper, in: RoundedRectangle(cornerRadius: 16))
        }
    }

    private func dayCount(from first: ScheduleDay, to last: ScheduleDay) -> Int {
        ScheduleDisplay.calendar.dateComponents([.day], from: first.date, to: last.date).day ?? 0
    }
}

private struct TaskEditor: View {
    @ObservedObject var store: CloudStore
    let projectID: String
    @State var task: ScheduleTask
    @Environment(\.dismiss) private var dismiss
    @State private var entry = ""
    @State private var askDelete = false

    var body: some View {
        NavigationStack {
            Form {
                Section("時程") {
                    TextField("任務名稱", text: $task.name)
                    DatePicker("開始", selection: Binding(get: { task.start.date }, set: {
                        task.start = ScheduleDay($0)
                        if task.end < task.start { task.end = task.start }
                    }), displayedComponents: .date)
                    DatePicker("結束", selection: Binding(get: { task.end.date }, set: {
                        task.end = ScheduleDay($0)
                    }), in: task.start.date..., displayedComponents: .date)
                    if task.todos.isEmpty {
                        Stepper("進度 \(task.progress)%", value: Binding(get: { task.progress }, set: {
                            task.progress = $0
                            task.done = $0 == 100
                        }), in: 0...100, step: 5)
                    } else {
                        LabeledContent("進度", value: "\(task.progress)%")
                    }
                }
                Section("待辦清單") {
                    ForEach($task.todos) { $todo in
                        Toggle(todo.text, isOn: Binding(get: { todo.done }, set: {
                            todo.done = $0
                            updateProgress()
                        }))
                    }
                    .onDelete { offsets in
                        task.todos.remove(atOffsets: offsets)
                        updateProgress()
                    }
                    HStack {
                        TextField("新增待辦", text: $entry)
                        Button("加入") {
                            let title = entry.trimmingCharacters(in: .whitespacesAndNewlines)
                            guard !title.isEmpty else { return }
                            task.todos.append(ScheduleTodo(text: title))
                            entry = ""
                            updateProgress()
                        }
                        .buttonStyle(.borderless)
                    }
                }
                if ScheduleDocument(store.state).projects.first(where: { $0.id == projectID })?
                    .tasks.contains(where: { $0.id == task.id }) == true {
                    Button("刪除任務", role: .destructive) { askDelete = true }
                }
            }
            .navigationTitle("專案任務")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("儲存") {
                        task.name = task.name.trimmingCharacters(in: .whitespacesAndNewlines)
                        store.editSchedule { $0.saveTask(task, projectID: projectID) }
                        dismiss()
                    }
                    .disabled(task.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .confirmationDialog("刪除這項任務？", isPresented: $askDelete) {
                Button("刪除任務", role: .destructive) {
                    store.editSchedule { $0.removeTask(id: task.id, projectID: projectID) }
                    dismiss()
                }
            }
        }
    }

    private func updateProgress() {
        guard !task.todos.isEmpty else { return }
        task.progress = Int((100 * Double(task.todos.filter(\.done).count) / Double(task.todos.count)).rounded())
        task.done = task.progress == 100
    }
}
