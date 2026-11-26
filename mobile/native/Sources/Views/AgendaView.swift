import SwiftUI

struct AgendaView: View {
    private enum Period: String, CaseIterable, Identifiable {
        case day = "日", week = "週", month = "月", quarter = "季", year = "年"
        var id: Self { self }

        func days(around day: ScheduleDay) -> (ScheduleDay, ScheduleDay) {
            let calendar = ScheduleDisplay.calendar
            let component: Calendar.Component
            switch self {
            case .day: return (day, day)
            case .week: component = .weekOfYear
            case .month: component = .month
            case .year: component = .year
            case .quarter:
                let startOfMonth = calendar.dateInterval(of: .month, for: day.date)?.start ?? day.date
                let offset = (calendar.component(.month, from: day.date) - 1) % 3
                let start = ScheduleDisplay.add(.month, -offset, to: ScheduleDay(startOfMonth))
                return (start, ScheduleDisplay.add(.day, -1, to: ScheduleDisplay.add(.month, 3, to: start)))
            }
            guard let dates = calendar.dateInterval(of: component, for: day.date) else { return (day, day) }
            return (ScheduleDay(dates.start), ScheduleDisplay.add(.day, -1, to: ScheduleDay(dates.end)))
        }
    }

    @ObservedObject var store: CloudStore
    @State private var day = ScheduleDay(Date())
    @State private var period = Period.week
    @State private var filter: ScheduleItem.Kind?
    @State private var category: String?
    @State private var query = ""
    @State private var hideCompleted = false
    @State private var sheet: AgendaSheet?

    private var schedule: ScheduleDocument { ScheduleDocument(store.state) }

    private var occurrences: [ScheduleOccurrence] {
        let (start, end) = period.days(around: day)
        return schedule.occurrences(from: start, through: end).filter { occurrence in
            (filter == nil || filter == occurrence.item.type)
                && (category == nil || category == occurrence.item.parentID)
                && (!hideCompleted || !occurrence.done)
                && (query.isEmpty || ([occurrence.item.title] + occurrence.item.tags)
                    .contains { $0.localizedCaseInsensitiveContains(query) })
        }
    }

    var body: some View {
        let visible = occurrences
        let groups = Dictionary(grouping: visible, by: \.date)
        ScrollView {
            VStack(spacing: 18) {
                header
                if visible.isEmpty {
                    EmptySchedule(label: "這段期間沒有排程", icon: "calendar.badge.checkmark", detail: "點右上角的加號新增，或調整日期與篩選條件。")
                }
                ForEach(groups.keys.sorted(), id: \.self) { date in
                    VStack(alignment: .leading, spacing: 8) {
                        SectionHeading(title: ScheduleDisplay.label(date, format: "M 月 d 日 EEEE"))
                        VStack(spacing: 0) {
                            ForEach(groups[date, default: []]) { occurrence in
                                OccurrenceRow(occurrence: occurrence) {
                                    store.editSchedule { $0.toggle(occurrence) }
                                } open: { sheet = .occurrence(occurrence) }
                                if occurrence.id != groups[date]?.last?.id { Divider().padding(.leading, 52) }
                            }
                        }
                        .background(WorkspaceStyle.paper, in: RoundedRectangle(cornerRadius: 17))
                    }
                }
            }
            .frame(maxWidth: 690)
            .padding(16)
            .frame(maxWidth: .infinity)
        }
        .background(WorkspaceStyle.canvas)
        .navigationTitle("工作排程")
        .searchable(text: $query, prompt: "搜尋工作或標籤")
        .refreshable { await store.sync() }
        .toolbar {
            ToolbarItemGroup(placement: .navigationBarTrailing) {
                Menu {
                    Picker("工作類型", selection: $filter) {
                        Text("所有類型").tag(nil as ScheduleItem.Kind?)
                        ForEach(ScheduleItem.Kind.allCases) { kind in
                            Text(WorkspaceStyle.title(kind)).tag(Optional(kind))
                        }
                    }
                    Picker("工作分類", selection: $category) {
                        Text("所有分類").tag(nil as String?)
                        ForEach(schedule.categories) { item in Text(item.name).tag(Optional(item.id)) }
                    }
                    Toggle("隱藏已完成", isOn: $hideCompleted)
                } label: { Label("篩選", systemImage: "line.3.horizontal.decrease.circle") }
                Button {
                    sheet = .item(ScheduleItem(title: "", date: day))
                } label: { Label("新增排程", systemImage: "plus") }
            }
        }
        .sheet(item: $sheet) { item in
            switch item {
            case .item(let value): ItemEditor(store: store, item: value)
            case .occurrence(let value): OccurrenceEditor(store: store, occurrence: value)
            case .note(let value): DailyNoteEditor(store: store, day: value)
            }
        }
    }

    private var header: some View {
        let (first, last) = period.days(around: day)
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("排程總覽").font(.title2.weight(.bold)).accessibilityAddTraits(.isHeader)
                    Text(first == last ? first.rawValue : "\(first.rawValue) 至 \(last.rawValue)")
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Spacer()
                DatePicker(
                    "選擇日期",
                    selection: Binding(get: { day.date }, set: { day = ScheduleDay($0) }),
                    displayedComponents: .date
                )
                .labelsHidden()
                .accessibilityLabel("選擇日期")
            }
            Picker("顯示範圍", selection: $period) {
                ForEach(Period.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            Button {
                sheet = .note(day)
            } label: { Label("每日筆記", systemImage: "note.text") }
            .buttonStyle(.bordered)
        }
        .padding(17)
        .background(WorkspaceStyle.paper, in: RoundedRectangle(cornerRadius: 18))
    }
}

enum AgendaSheet: Identifiable {
    case item(ScheduleItem), occurrence(ScheduleOccurrence), note(ScheduleDay)

    var id: String {
        switch self {
        case .item(let value): return "item-\(value.id)"
        case .occurrence(let value): return "occurrence-\(value.id)"
        case .note(let value): return "note-\(value.rawValue)"
        }
    }
}

struct OccurrenceRow: View {
    let occurrence: ScheduleOccurrence
    let toggle: () -> Void
    let open: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            if occurrence.item.noticeOnly {
                Image(systemName: "bell")
                    .frame(width: 36, height: 44)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("只提示")
            } else {
                Button(action: toggle) {
                    Image(systemName: occurrence.done ? "checkmark.circle.fill" : "circle")
                        .font(.title2)
                        .foregroundStyle(WorkspaceStyle.color(occurrence.item.type))
                        .frame(width: 36, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(occurrence.done ? "標記未完成" : "標記完成")
            }
            Button(action: open) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(occurrence.item.title)
                            .font(.body.weight(.semibold))
                            .strikethrough(occurrence.done)
                            .foregroundStyle(.primary)
                        Text(description)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                }
                .frame(minHeight: 46)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private var description: String {
        let item = occurrence.item
        return ([WorkspaceStyle.title(item.type), item.time,
                 item.recurrence == nil ? nil : "循環",
                 item.tags.isEmpty ? nil : item.tags.joined(separator: "、")])
            .compactMap { $0 }.joined(separator: " · ")
    }
}
