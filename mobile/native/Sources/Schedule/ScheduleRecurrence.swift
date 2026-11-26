import Foundation

struct ScheduleRecurrence: Equatable, Sendable {
    enum Frequency: String, CaseIterable, Identifiable, Sendable {
        case weekly, biweekly, monthly, quarterly, yearly
        var id: Self { self }
    }

    enum HolidayRule: String, CaseIterable, Identifiable, Sendable {
        case none, postpone, advance
        var id: Self { self }
    }

    enum Mode: String, CaseIterable, Identifiable, Sendable {
        case day, nthWeekday
        var id: Self { self }
    }

    var raw: JSONObject

    init?(raw: JSONObject) {
        guard raw["freq"]?.string.flatMap(Frequency.init(rawValue:)) != nil else { return nil }
        self.raw = raw
    }

    init(
        frequency: Frequency,
        day: Int = 1,
        holidayRule: HolidayRule = .none,
        until: ScheduleDay? = nil,
        count: Int? = nil,
        weekdays: [Int] = [],
        mode: Mode = .day,
        nth: Int = 1,
        weekday: Int = 0
    ) {
        raw = [:]
        self.frequency = frequency
        self.day = day
        self.holidayRule = holidayRule
        self.until = until
        self.count = count
        self.weekdays = weekdays
        self.mode = mode
        self.nth = nth
        self.weekday = weekday
    }

    var frequency: Frequency {
        get { raw["freq"]?.string.flatMap(Frequency.init(rawValue:)) ?? .monthly }
        set { raw["freq"] = .string(newValue.rawValue) }
    }
    var day: Int {
        get { min(31, max(1, raw["day"]?.int ?? 1)) }
        set { raw["day"] = .number(Double(min(31, max(1, newValue)))) }
    }
    var holidayRule: HolidayRule {
        get { raw["holidayRule"]?.string.flatMap(HolidayRule.init(rawValue:)) ?? .none }
        set { raw["holidayRule"] = .string(newValue.rawValue) }
    }
    var until: ScheduleDay? {
        get { raw.scheduleDay("until") }
        set { raw["until"] = newValue.map { .string($0.rawValue) } ?? .null }
    }
    var count: Int? {
        get { raw["count"]?.int.flatMap { $0 > 0 ? min(500, $0) : nil } }
        set { raw["count"] = newValue.flatMap { $0 > 0 ? .number(Double(min(500, $0))) : nil } ?? .null }
    }
    var weekdays: [Int] {
        get { Array(Set(raw["weekdays"]?.array?.compactMap(\.int).filter { (0...6).contains($0) } ?? [])).sorted() }
        set {
            let days = Array(Set(newValue.filter { (0...6).contains($0) })).sorted()
            raw["weekdays"] = days.isEmpty ? .null : .array(days.map { .number(Double($0)) })
        }
    }
    var mode: Mode {
        get { raw["mode"]?.string.flatMap(Mode.init(rawValue:)) ?? .day }
        set { raw["mode"] = .string(newValue.rawValue) }
    }
    var nth: Int {
        get {
            let value = raw["nth"]?.int ?? 1
            return value == -1 ? -1 : min(5, max(1, value))
        }
        set { raw["nth"] = .number(Double(newValue == -1 ? -1 : min(5, max(1, newValue)))) }
    }
    var weekday: Int {
        get { min(6, max(0, raw["weekday"]?.int ?? 0)) }
        set { raw["weekday"] = .number(Double(min(6, max(0, newValue)))) }
    }
}

extension ScheduleRecurrence {
    func occurrences(
        of item: ScheduleItem,
        from: ScheduleDay,
        through: ScheduleDay,
        holidays: Set<ScheduleDay>,
        workdays: Set<ScheduleDay>
    ) -> [ScheduleOccurrence] {
        let overrides = item.raw["overrides"]?.object ?? [:]
        let skipped = item.raw["skipped"]?.object ?? [:]
        let done = item.raw["doneMap"]?.object ?? [:]
        let anchor = item.date
        var candidates: [String: ScheduleDay] = [:]
        let earliest = holidayRule == .postpone ? from.adding(days: -40) : from
        let latest = holidayRule == .advance ? through.adding(days: 40) : through

        func collect(rawFrom: ScheduleDay, rawThrough: ScheduleDay, onlyKey: String? = nil) {
            let lower = max(anchor, rawFrom)
            let upper = min(rawThrough, until ?? rawThrough)
            guard lower <= upper else { return }
            var made = 0
            visitDates(from: count == nil ? lower : anchor, through: upper, anchoredAt: anchor) { day, key in
                made += 1
                if day >= lower, onlyKey == nil || key == onlyKey { candidates[key] = day }
                return made < (count ?? .max)
            }
        }

        collect(rawFrom: earliest, rawThrough: latest)
        // An occurrence moved into this window may originally be months or years away.
        for (key, value) in overrides where candidates[key] == nil {
            guard let date = value.string.flatMap(ScheduleDay.init(rawValue:)), (from...through).contains(date),
                  let period = rawPeriod(for: key) else { continue }
            collect(rawFrom: period.lowerBound, rawThrough: period.upperBound, onlyKey: key)
        }

        return candidates.compactMap { key, original in
            guard !skipped[key].isMarked else { return nil }
            let date = overrides.scheduleDay(key) ?? adjusted(original, holidays: holidays, workdays: workdays)
            guard (from...through).contains(date) else { return nil }
            return ScheduleOccurrence(item: item, date: date, endDate: nil, key: key, done: done[key].isMarked)
        }
    }

    private func visitDates(
        from: ScheduleDay,
        through: ScheduleDay,
        anchoredAt anchor: ScheduleDay,
        visit: (ScheduleDay, String) -> Bool
    ) {
        switch frequency {
        case .weekly, .biweekly:
            let step = frequency == .weekly ? 7 : 14
            let selectedDays = weekdays
            let weekDays = selectedDays.isEmpty ? [anchor.weekday] : selectedDays
            let firstWeek = anchor.adding(days: -anchor.weekday)
            var week = firstWeek.adding(days: (firstWeek.days(to: from) / step) * step)
            while week <= through {
                for weekday in weekDays {
                    let day = week.adding(days: weekday)
                    if day < from { continue }
                    if day > through || !visit(day, "W" + day.rawValue) { return }
                }
                let next = week.adding(days: step)
                guard next > week else { return }
                week = next
            }
        case .monthly, .quarterly, .yearly:
            let step = frequency == .monthly ? 1 : frequency == .quarterly ? 3 : 12
            let delta = (from.year - anchor.year) * 12 + from.month - anchor.month
            var month = anchor.firstOfMonth.adding(months: (delta / step) * step)
            while month <= through {
                if let scheduled = date(in: month), scheduled >= from {
                    if scheduled > through || !visit(scheduled, key(for: month)) { return }
                }
                let next = month.adding(months: step)
                guard next > month else { return }
                month = next
            }
        }
    }

    private func date(in month: ScheduleDay) -> ScheduleDay? {
        guard frequency == .monthly, mode == .nthWeekday else {
            return month.adding(days: min(day, month.daysInMonth) - 1)
        }
        let intendedWeekday = weekday
        if nth == -1 {
            let last = month.adding(days: month.daysInMonth - 1)
            return last.adding(days: -((last.weekday - intendedWeekday + 7) % 7))
        }
        let offset = (intendedWeekday - month.weekday + 7) % 7 + (nth - 1) * 7
        return offset < month.daysInMonth ? month.adding(days: offset) : nil
    }

    private func key(for month: ScheduleDay) -> String {
        switch frequency {
        case .monthly: return String(month.rawValue.prefix(7))
        case .quarterly: return "\(month.year)-Q\((month.month - 1) / 3 + 1)"
        default: return "Y\(month.year)"
        }
    }

    private func rawPeriod(for key: String) -> ClosedRange<ScheduleDay>? {
        switch frequency {
        case .weekly, .biweekly:
            guard key.first == "W", let date = ScheduleDay(rawValue: String(key.dropFirst())) else { return nil }
            return date...date
        case .monthly:
            guard let start = ScheduleDay(rawValue: key + "-01") else { return nil }
            return start...start.adding(days: start.daysInMonth - 1)
        case .quarterly:
            let parts = key.components(separatedBy: "-Q")
            guard parts.count == 2, let year = Int(parts[0]), let quarter = Int(parts[1]), (1...4).contains(quarter),
                  let start = ScheduleDay(year: year, month: (quarter - 1) * 3 + 1, day: 1) else { return nil }
            let last = start.adding(months: 2)
            return start...last.adding(days: last.daysInMonth - 1)
        case .yearly:
            guard key.first == "Y", let year = Int(key.dropFirst()),
                  let start = ScheduleDay(year: year, month: 1, day: 1),
                  let end = ScheduleDay(year: year, month: 12, day: 31) else { return nil }
            return start...end
        }
    }

    private func adjusted(_ original: ScheduleDay, holidays: Set<ScheduleDay>, workdays: Set<ScheduleDay>) -> ScheduleDay {
        guard holidayRule != .none else { return original }
        let direction = holidayRule == .postpone ? 1 : -1
        var date = original
        for _ in 0..<40 {
            if workdays.contains(date) || (!(date.weekday == 0 || date.weekday == 6) && !holidays.contains(date)) { break }
            date = date.adding(days: direction)
        }
        return date
    }
}
