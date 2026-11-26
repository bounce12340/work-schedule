import SwiftUI

struct MonthView: View {
    @ObservedObject var store: CloudStore
    @State private var selected = ScheduleDay(Date())
    @State private var sheet: AgendaSheet?

    private let weekdays = ["日", "一", "二", "三", "四", "五", "六"]
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 3), count: 7)

    var body: some View {
        let schedule = ScheduleDocument(store.state)
        let month = ScheduleDisplay.calendar.dateInterval(of: .month, for: selected.date)
        let first = ScheduleDay(month?.start ?? selected.date)
        let last = ScheduleDisplay.add(.day, -1, to: ScheduleDay(month?.end ?? selected.date))
        let records = schedule.occurrences(from: first, through: max(first, last))
        let selectedRecords = records.filter { $0.date <= selected && ($0.endDate ?? $0.date) >= selected }
        ScrollView {
            VStack(spacing: 18) {
                VStack(spacing: 12) {
                    monthHeader
                    LazyVGrid(columns: columns, spacing: 7) {
                        ForEach(weekdays, id: \.self) { weekday in
                            Text(weekday).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                .accessibilityHidden(true)
                        }
                        let preceding = ScheduleDisplay.calendar.component(.weekday, from: first.date) - 1
                        ForEach(0..<preceding, id: \.self) { _ in Color.clear.frame(height: 44) }
                        let count = ScheduleDisplay.calendar.range(of: .day, in: .month, for: first.date)?.count ?? 0
                        ForEach(0..<count, id: \.self) { offset in
                            let date = ScheduleDisplay.add(.day, offset, to: first)
                            dayCell(offset + 1, date: date, count: records.filter {
                                $0.date <= date && ($0.endDate ?? $0.date) >= date
                            }.count)
                        }
                    }
                }
                .padding(14)
                .background(WorkspaceStyle.paper, in: RoundedRectangle(cornerRadius: 18))

                SectionHeading(title: ScheduleDisplay.label(selected, format: "M 月 d 日 EEEE"), detail: "\(selectedRecords.count) 筆")
                if selectedRecords.isEmpty {
                    EmptySchedule(label: "沒有排程", icon: "calendar", detail: "可新增工作、會議或交辦。")
                } else {
                    VStack(spacing: 0) {
                        ForEach(selectedRecords) { occurrence in
                            OccurrenceRow(occurrence: occurrence) {
                                store.editSchedule { $0.toggle(occurrence) }
                            } open: { sheet = .occurrence(occurrence) }
                        }
                    }
                    .background(WorkspaceStyle.paper, in: RoundedRectangle(cornerRadius: 18))
                }
                Button { sheet = .note(selected) } label: { Label("每日筆記", systemImage: "note.text") }
                    .buttonStyle(.bordered)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: 690)
            .padding(16)
            .frame(maxWidth: .infinity)
        }
        .background(WorkspaceStyle.canvas)
        .navigationTitle("月曆")
        .toolbar {
            ToolbarItemGroup(placement: .navigationBarTrailing) {
                Button("今天") { selected = ScheduleDay(Date()) }
                Button { sheet = .item(ScheduleItem(title: "", date: selected)) } label: {
                    Label("新增排程", systemImage: "plus")
                }
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

    private var monthHeader: some View {
        HStack {
            Button { selected = ScheduleDisplay.add(.month, -1, to: selected) } label: {
                Image(systemName: "chevron.left").frame(width: 44, height: 44)
            }
            .accessibilityLabel("上個月")
            Spacer()
            Text(ScheduleDisplay.label(selected, format: "yyyy 年 M 月"))
                .font(.title3.weight(.bold)).accessibilityAddTraits(.isHeader)
            Spacer()
            Button { selected = ScheduleDisplay.add(.month, 1, to: selected) } label: {
                Image(systemName: "chevron.right").frame(width: 44, height: 44)
            }
            .accessibilityLabel("下個月")
        }
        .buttonStyle(.plain)
    }

    private func dayCell(_ number: Int, date: ScheduleDay, count: Int) -> some View {
        Button { selected = date } label: {
            VStack(spacing: 4) {
                Text(number.formatted()).font(.subheadline.monospacedDigit().weight(.semibold))
                Circle().fill(count > 0 ? (selected == date ? .white : WorkspaceStyle.accent) : .clear)
                    .frame(width: 4, height: 4)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(selected == date ? WorkspaceStyle.accent : .clear, in: RoundedRectangle(cornerRadius: 9))
            .foregroundStyle(selected == date ? .white : .primary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(ScheduleDisplay.label(date, format: "M 月 d 日 EEEE"))
        .accessibilityValue("\(count) 筆排程")
        .accessibilityAddTraits(selected == date ? .isSelected : [])
    }
}
