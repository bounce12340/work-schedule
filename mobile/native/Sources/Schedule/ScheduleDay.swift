import Foundation

struct ScheduleDay: Hashable, Comparable, RawRepresentable, Sendable {
    private let canonical: Date

    static var localCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .autoupdatingCurrent
        return calendar
    }

    private static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        return calendar
    }()

    init(_ date: Date) {
        let components = Self.localCalendar.dateComponents([.year, .month, .day], from: date)
        self.canonical = Self.calendar.date(from: components) ?? date
    }

    init?(rawValue: String) {
        guard rawValue.utf8.count == 10 else { return nil }
        let parts = rawValue.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
              let value = Self(year: year, month: month, day: day),
              value.rawValue == rawValue else { return nil }
        self = value
    }

    init?(year: Int, month: Int, day: Int) {
        guard (1...9999).contains(year), (1...12).contains(month), (1...31).contains(day),
              let date = Self.calendar.date(from: DateComponents(year: year, month: month, day: day)),
              Self.calendar.component(.day, from: date) == day else { return nil }
        canonical = date
    }

    private init(canonical: Date) {
        self.canonical = canonical
    }

    var rawValue: String { String(format: "%04d-%02d-%02d", year, month, day) }
    var date: Date { Self.localCalendar.date(from: components) ?? canonical }
    var year: Int { Self.calendar.component(.year, from: canonical) }
    var month: Int { Self.calendar.component(.month, from: canonical) }
    var day: Int { Self.calendar.component(.day, from: canonical) }
    var weekday: Int { Self.calendar.component(.weekday, from: canonical) - 1 }
    var daysInMonth: Int { Self.calendar.range(of: .day, in: .month, for: canonical)?.count ?? 31 }
    var firstOfMonth: Self { Self(year: year, month: month, day: 1) ?? self }

    private var components: DateComponents {
        Self.calendar.dateComponents([.year, .month, .day], from: canonical)
    }

    static func < (lhs: Self, rhs: Self) -> Bool { lhs.canonical < rhs.canonical }

    func adding(days: Int) -> Self {
        adding(.day, value: days)
    }

    func adding(months: Int) -> Self {
        adding(.month, value: months)
    }

    func days(to other: Self) -> Int {
        Self.calendar.dateComponents([.day], from: canonical, to: other.canonical).day ?? 0
    }

    private func adding(_ component: Calendar.Component, value: Int) -> Self {
        guard let newDate = Self.calendar.date(byAdding: component, value: value, to: canonical),
              Self.calendar.component(.era, from: newDate) == 1,
              Self.calendar.component(.year, from: newDate) <= 9999 else { return self }
        return Self(canonical: newDate)
    }
}
