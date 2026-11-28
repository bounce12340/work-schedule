import SwiftUI
import UIKit

struct ItemEditor: View {
    @ObservedObject var store: CloudStore
    @Environment(\.dismiss) private var dismiss
    @State var item: ScheduleItem
    @State private var tagText = ""
    @State private var step = ""

    private var schedule: ScheduleDocument { ScheduleDocument(store.state) }

    var body: some View {
        NavigationStack {
            Form {
                Section("基本資料") {
                    TextField("名稱", text: $item.title)
                    Picker("類型", selection: $item.type) {
                        ForEach(ScheduleItem.Kind.allCases) { kind in
                            Text(WorkspaceStyle.title(kind)).tag(kind)
                        }
                    }
                    DatePicker("開始日期", selection: Binding(get: { item.date.date }, set: { value in
                        item.date = ScheduleDay(value)
                        if let end = item.endDate, end < item.date { item.endDate = item.date }
                    }), displayedComponents: .date)
                    Toggle("跨多天", isOn: Binding(get: { item.endDate != nil }, set: {
                        item.endDate = $0 ? item.date : nil
                    }))
                    if item.endDate != nil {
                        DatePicker("結束日期", selection: Binding(get: { (item.endDate ?? item.date).date }, set: {
                            item.endDate = ScheduleDay($0)
                        }), in: item.date.date..., displayedComponents: .date)
                    }
                    if item.type == .meeting {
                        Toggle("指定會議時間", isOn: Binding(get: { item.time?.isEmpty == false }, set: {
                            item.time = $0 ? "09:00" : nil
                        }))
                        if item.time?.isEmpty == false {
                            DatePicker("會議時間", selection: meetingTime, displayedComponents: .hourAndMinute)
                        }
                        TextField("會議連結", text: Binding(get: { item.link ?? "" }, set: { item.link = $0 }))
                            .keyboardType(.URL).textInputAutocapitalization(.never)
                    }
                    Picker("分類", selection: $item.parentID) {
                        Text("未分類").tag(nil as String?)
                        ForEach(schedule.categories) { category in
                            Text(category.name).tag(Optional(category.id))
                        }
                    }
                    TextField("標籤，以逗號分隔", text: $tagText)
                    Toggle("只提示", isOn: $item.noticeOnly)
                }

                Section("循環") {
                    Toggle("重複排程", isOn: Binding(get: { item.recurrence != nil }, set: {
                        item.recurrence = $0 ? ScheduleRecurrence(frequency: .weekly) : nil
                    }))
                    if item.recurrence != nil {
                        RecurrenceFields(recurrence: Binding(
                            get: { item.recurrence ?? .init(frequency: .weekly) },
                            set: { item.recurrence = $0 }
                        ), start: item.date)
                    }
                }

                Section("步驟") {
                    ForEach(item.subtasks) { task in Text(task.text) }
                        .onDelete { item.subtasks.remove(atOffsets: $0) }
                    HStack {
                        TextField("新增步驟", text: $step)
                        Button("加入") {
                            let title = step.trimmingCharacters(in: .whitespacesAndNewlines)
                            guard !title.isEmpty else { return }
                            item.subtasks.append(ScheduleStep(text: title))
                            step = ""
                        }
                        .buttonStyle(.borderless)
                        .disabled(step.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }

                let prerequisites = schedule.items.filter { candidate in
                    candidate.id != item.id && !candidate.noticeOnly
                        && (item.dependsOn.contains(candidate.id) || !hasDependency(candidate.id, on: item.id))
                }
                if !prerequisites.isEmpty {
                    Section("前置作業") {
                        ForEach(prerequisites) { candidate in
                            Toggle(candidate.title, isOn: Binding(
                                get: { item.dependsOn.contains(candidate.id) },
                                set: { enabled in
                                    if enabled { item.dependsOn.append(candidate.id) }
                                    else { item.dependsOn.removeAll { $0 == candidate.id } }
                                }
                            ))
                        }
                    }
                }
            }
            .navigationTitle("排程資料")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("儲存", action: save)
                        .disabled(item.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear { tagText = item.tags.joined(separator: ", ") }
        }
    }

    private func hasDependency(_ source: String, on target: String) -> Bool {
        let items = Dictionary(schedule.items.map { ($0.id, $0.dependsOn) }, uniquingKeysWith: { first, _ in first })
        var pending = items[source, default: []]
        var seen: Set<String> = []
        while let next = pending.popLast() {
            if next == target { return true }
            if seen.insert(next).inserted { pending.append(contentsOf: items[next, default: []]) }
        }
        return false
    }

    private var meetingTime: Binding<Date> {
        let calendar = ScheduleDisplay.calendar
        return Binding {
            let parts = (item.time ?? "09:00").split(separator: ":").compactMap { Int($0) }
            return calendar.date(bySettingHour: parts.first ?? 9, minute: parts.dropFirst().first ?? 0, second: 0, of: item.date.date) ?? item.date.date
        } set: { value in
            let parts = calendar.dateComponents([.hour, .minute], from: value)
            item.time = String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        }
    }

    private func save() {
        item.title = item.title.trimmingCharacters(in: .whitespacesAndNewlines)
        item.tags = tagText.split(whereSeparator: { ",，、".contains($0) })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        store.editSchedule { $0.saveItem(item) }
        dismiss()
    }
}

private struct RecurrenceFields: View {
    @Binding var recurrence: ScheduleRecurrence
    let start: ScheduleDay

    private let weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"]

    var body: some View {
        Picker("頻率", selection: $recurrence.frequency) {
            ForEach(ScheduleRecurrence.Frequency.allCases) { value in
                Text(frequencyTitle(value)).tag(value)
            }
        }
        if recurrence.frequency == .weekly || recurrence.frequency == .biweekly {
            ForEach(Array(weekdays.enumerated()), id: \.offset) { index, label in
                Toggle(label, isOn: Binding(
                    get: { recurrence.weekdays.contains(index) },
                    set: { enabled in
                        if enabled { recurrence.weekdays = (recurrence.weekdays + [index]).sorted() }
                        else { recurrence.weekdays.removeAll { $0 == index } }
                    }
                ))
            }
        } else {
            Picker("日期規則", selection: $recurrence.mode) {
                Text("固定日期").tag(ScheduleRecurrence.Mode.day)
                Text("第幾個星期").tag(ScheduleRecurrence.Mode.nthWeekday)
            }
            if recurrence.mode == .day {
                Stepper("每次第 \(recurrence.day) 日", value: $recurrence.day, in: 1...31)
            } else {
                Picker("週次", selection: $recurrence.nth) {
                    ForEach(1...5, id: \.self) { Text("第 \($0) 個").tag($0) }
                    Text("最後一個").tag(-1)
                }
                Picker("星期", selection: $recurrence.weekday) {
                    ForEach(Array(weekdays.enumerated()), id: \.offset) { index, label in Text(label).tag(index) }
                }
            }
        }
        Picker("遇到假日", selection: $recurrence.holidayRule) {
            Text("維持原日期").tag(ScheduleRecurrence.HolidayRule.none)
            Text("順延至工作日").tag(ScheduleRecurrence.HolidayRule.postpone)
            Text("提前至工作日").tag(ScheduleRecurrence.HolidayRule.advance)
        }
        Toggle("限制結束日期", isOn: Binding(get: { recurrence.until != nil }, set: {
            recurrence.until = $0 ? start : nil
        }))
        if recurrence.until != nil {
            DatePicker("結束日期", selection: Binding(get: { (recurrence.until ?? start).date }, set: {
                recurrence.until = ScheduleDay($0)
            }), in: start.date..., displayedComponents: .date)
        }
        Toggle("限制次數", isOn: Binding(get: { recurrence.count != nil }, set: {
            recurrence.count = $0 ? 10 : nil
        }))
        if recurrence.count != nil {
            Stepper("共 \(recurrence.count ?? 10) 次", value: Binding(
                get: { recurrence.count ?? 10 }, set: { recurrence.count = $0 }
            ), in: 1...500)
        }
    }

    private func frequencyTitle(_ value: ScheduleRecurrence.Frequency) -> String {
        switch value {
        case .weekly: return "每週"
        case .biweekly: return "每兩週"
        case .monthly: return "每月"
        case .quarterly: return "每季"
        case .yearly: return "每年"
        }
    }
}

struct OccurrenceEditor: View {
    @ObservedObject var store: CloudStore
    let occurrence: ScheduleOccurrence
    @Environment(\.dismiss) private var dismiss
    @State private var editItem = false
    @State private var delete = false
    @State private var newDay = Date()

    private var current: ScheduleOccurrence {
        let day = occurrence.date
        return ScheduleDocument(store.state).occurrences(from: day, through: day)
            .first { $0.id == occurrence.id } ?? occurrence
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("類型", value: WorkspaceStyle.title(current.item.type))
                    LabeledContent("日期", value: current.date.rawValue)
                    if let end = current.endDate { LabeledContent("結束日期", value: end.rawValue) }
                    if let time = current.item.time, !time.isEmpty { LabeledContent("時間", value: time) }
                    if let value = current.item.link, let url = URL(string: value),
                       let scheme = url.scheme, ["https", "http"].contains(scheme.lowercased()) {
                        Link("開啟會議連結", destination: url)
                    }
                    if !current.item.noticeOnly {
                        let entry = current
                        Button(entry.done ? "標記未完成" : "標記完成") {
                            store.editSchedule { $0.toggle(entry) }
                        }
                    }
                    Button("編輯排程") { editItem = true }
                }
                let prerequisites = ScheduleDocument(store.state).pendingDependencies(for: current)
                if !prerequisites.isEmpty {
                    Section("待完成的前置作業") {
                        ForEach(prerequisites) { entry in
                            LabeledContent(entry.item.title, value: entry.date.rawValue)
                        }
                    }
                }
                if !current.item.subtasks.isEmpty {
                    Section("步驟") {
                        ForEach(current.item.subtasks) { step in
                            let entry = current
                            Toggle(step.text, isOn: Binding(get: { entry.isStepDone(step.id) }, set: { _ in
                                store.editSchedule { $0.toggleStep(step.id, in: entry) }
                            }))
                        }
                    }
                }
                if current.item.recurrence != nil {
                    Section("單次調整") {
                        DatePicker("改期至", selection: $newDay, displayedComponents: .date)
                        Button("確認改期") {
                            store.editSchedule { $0.reschedule(current, to: ScheduleDay(newDay)) }
                            dismiss()
                        }
                        .disabled(ScheduleDay(newDay) == current.date)
                        Button("略過這一次", role: .destructive) {
                            store.editSchedule { $0.skip(current) }
                            dismiss()
                        }
                    }
                }
                Button("刪除排程", role: .destructive) { delete = true }
            }
            .navigationTitle(current.item.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .onAppear { newDay = occurrence.date.date }
            .sheet(isPresented: $editItem) { ItemEditor(store: store, item: current.item) }
            .confirmationDialog("刪除這項排程及其循環？", isPresented: $delete) {
                Button("刪除排程", role: .destructive) {
                    store.editSchedule { $0.removeItem(id: occurrence.item.id) }
                    dismiss()
                }
            }
        }
    }
}

struct DailyNoteEditor: View {
    @ObservedObject var store: CloudStore
    let day: ScheduleDay
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        FormattedNoteEditor(title: "每日筆記", subtitle: day.rawValue, html: ScheduleDocument(store.state).dailyLog(on: day)) { value in
            store.editSchedule { $0.setDailyLog(value, on: day) }
            dismiss()
        }
    }
}

struct FormattedNoteEditor: View {
    let title: String
    let subtitle: String
    let html: String
    let save: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""

    private var hasExistingContent: Bool { !html.isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                if hasExistingContent {
                    Section(subtitle) {
                        Text(Self.display(html))
                    }
                }
                Section(hasExistingContent ? "補充內容" : subtitle) {
                    TextEditor(text: $text).frame(minHeight: 180).accessibilityLabel("筆記內容")
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("儲存") { save(html + "<p>" + Self.escape(text) + "</p>") }
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private static func display(_ html: String) -> AttributedString {
        let elements = try? NSRegularExpression(pattern: "<[^>]*>")
        let allowed = Set(["b", "strong", "i", "em", "u", "s", "strike", "br", "p", "div", "ul", "ol", "li", "blockquote"])
        let source = html as NSString
        let safe = NSMutableString(string: html)
        for match in (elements?.matches(in: html, range: NSRange(location: 0, length: source.length)) ?? []).reversed() {
            let tag = source.substring(with: match.range).dropFirst().dropLast()
                .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let name = tag.drop(while: { $0 == "/" }).prefix(while: { $0.isASCII && $0.isLetter })
            let replacement = allowed.contains(String(name)) ? "<" + (tag.hasPrefix("/") ? "/" : "") + name + ">" : ""
            safe.replaceCharacters(in: match.range, with: replacement)
        }
        let data = Data((safe as String).utf8)
        let options: [NSAttributedString.DocumentReadingOptionKey: Any] = [
            .documentType: NSAttributedString.DocumentType.html,
            .characterEncoding: String.Encoding.utf8.rawValue
        ]
        if let styled = try? NSAttributedString(data: data, options: options, documentAttributes: nil),
           let text = try? AttributedString(styled, including: \.uiKit) {
            return text
        }
        return AttributedString(html)
    }

    private static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\n", with: "<br>")
    }
}
