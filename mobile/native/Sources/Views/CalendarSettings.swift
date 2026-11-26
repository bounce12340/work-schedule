import SwiftUI

struct CalendarSettings: View {
    enum SectionType { case categories, holidays }

    @ObservedObject var store: CloudStore
    let section: SectionType
    @State private var label = ""
    @State private var category: ScheduleCategory?
    @State private var showCategory = false
    @State private var deleteCategory: ScheduleCategory?
    @State private var date = Date()

    var body: some View {
        let schedule = ScheduleDocument(store.state)
        let day = ScheduleDay(date)
        Form {
            switch section {
            case .categories:
                Section("工作分類") {
                    ForEach(schedule.categories) { entry in
                        Button(entry.name) {
                            category = entry
                            label = entry.name
                            showCategory = true
                        }
                        .swipeActions {
                            Button("刪除", role: .destructive) { deleteCategory = entry }
                        }
                    }
                    Button("新增分類", systemImage: "plus") {
                        category = nil
                        label = ""
                        showCategory = true
                    }
                    .disabled(!store.canAddProject(in: "majorProjects"))
                    if !store.canAddProject(in: "majorProjects") {
                        Text("已達免費方案的 3 個工作分類上限。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
            case .holidays:
                Section("工作日與假日") {
                    DatePicker("日期", selection: $date, displayedComponents: .date)
                    Toggle("自訂假日", isOn: Binding(get: { schedule.customHolidays.contains(day) }, set: { enabled in
                        store.editSchedule { $0.setHoliday(day, enabled: enabled) }
                    }))
                    Toggle("指定工作日", isOn: Binding(get: { schedule.customWorkdays.contains(day) }, set: { enabled in
                        store.editSchedule { $0.setWorkday(day, enabled: enabled) }
                    }))
                    if ScheduleDocument.taiwanHolidays[day.year] != nil {
                        Button("載入 \(day.year) 台灣國定假日") {
                            store.editSchedule { $0.loadTaiwanHolidays(year: day.year) }
                        }
                    }
                }
                Section("不在") {
                    let current = schedule.absences(on: day)
                    ForEach(Array(current.enumerated()), id: \.offset) { index, entry in
                        HStack {
                            Label(entry.kind == .away ? "外出" : "休假", systemImage: "figure.walk")
                            Spacer()
                            if let from = entry.from { Text(from).foregroundStyle(.secondary) }
                            if let to = entry.to { Text(to).foregroundStyle(.secondary) }
                            Button("移除", systemImage: "minus.circle", role: .destructive) {
                                var updated = current
                                updated.remove(at: index)
                                store.editSchedule { $0.setAbsences(updated, on: day) }
                            }
                            .labelStyle(.iconOnly)
                            .buttonStyle(.borderless)
                        }
                    }
                    Button("新增全天外出") {
                        store.editSchedule { $0.setAbsences(current + [ScheduleAbsence(kind: .away)], on: day) }
                    }
                    Button("新增全天休假") {
                        store.editSchedule { $0.setAbsences(current + [ScheduleAbsence(kind: .leave)], on: day) }
                    }
                }
            }
        }
        .navigationTitle(section == .categories ? "工作分類" : "假日與不在")
        .alert(category == nil ? "新增分類" : "重新命名分類", isPresented: $showCategory) {
            TextField("分類名稱", text: $label)
            Button("儲存") {
                let title = label.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !title.isEmpty else { return }
                var updated = category ?? ScheduleCategory(name: title)
                updated.name = title
                store.editSchedule { $0.saveCategory(updated) }
            }
            Button("取消", role: .cancel) {}
        }
        .confirmationDialog("刪除分類？", isPresented: Binding(get: { deleteCategory != nil }, set: { if !$0 { deleteCategory = nil } })) {
            Button("刪除分類", role: .destructive) {
                guard let entry = deleteCategory else { return }
                store.editSchedule { $0.removeCategory(id: entry.id) }
                deleteCategory = nil
            }
        } message: {
            Text("分類底下的排程會保留。")
        }
    }
}
