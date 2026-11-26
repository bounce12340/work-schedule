import Foundation

struct ScheduleDocument: Sendable {
    static let version = 3
    private(set) var state: JSONObject

    init(_ state: JSONObject = [:]) {
        self.state = Self.upgrading(state)
    }

    var items: [ScheduleItem] {
        state.records("items", make: ScheduleItem.init(raw:)).filter { $0.raw.scheduleDay("date") != nil }
    }
    var categories: [ScheduleCategory] { state.records("majorProjects", make: ScheduleCategory.init(raw:)) }
    var projects: [ScheduleProject] { state.records("ganttProjects", make: ScheduleProject.init(raw:)) }
    var customHolidays: [ScheduleDay] { days(at: "customHolidays") }
    var customWorkdays: [ScheduleDay] { days(at: "customWorkdays") }

    func occurrences(from: ScheduleDay, through: ScheduleDay) -> [ScheduleOccurrence] {
        guard from <= through else { return [] }
        let holidays = Set(customHolidays)
        let workdays = Set(customWorkdays)
        return items.flatMap {
            occurrences(of: $0, from: from, through: through, holidays: holidays, workdays: workdays)
        }.sorted {
            if $0.date != $1.date { return $0.date < $1.date }
            if $0.item.time != $1.item.time { return ($0.item.time ?? "") < ($1.item.time ?? "") }
            return $0.id < $1.id
        }
    }

    func pendingDependencies(for occurrence: ScheduleOccurrence) -> [ScheduleOccurrence] {
        let holidays = Set(customHolidays)
        let workdays = Set(customWorkdays)
        let tasks = items
        return occurrence.item.dependsOn.compactMap { id in
            guard let dependency = tasks.first(where: { $0.id == id }) else { return nil }
            let from = dependency.recurrence == nil
                ? dependency.date : max(dependency.date.adding(days: -45), occurrence.date.adding(days: -400))
            guard from <= occurrence.date,
                  let previous = occurrences(of: dependency, from: from, through: occurrence.date, holidays: holidays, workdays: workdays)
                    .max(by: { $0.date < $1.date }),
                  !previous.done else { return nil }
            return previous
        }
    }

    private func occurrences(
        of item: ScheduleItem,
        from: ScheduleDay,
        through: ScheduleDay,
        holidays: Set<ScheduleDay>,
        workdays: Set<ScheduleDay>
    ) -> [ScheduleOccurrence] {
        if let recurrence = item.recurrence {
            return recurrence.occurrences(of: item, from: from, through: through, holidays: holidays, workdays: workdays)
        }
        let end = item.endDate.flatMap { $0 >= item.date ? $0 : nil }
        guard item.date <= through, (end ?? item.date) >= from else { return [] }
        return [ScheduleOccurrence(item: item, date: item.date, endDate: end, key: "single", done: item.raw["done"].isMarked)]
    }

    mutating func saveItem(_ item: ScheduleItem) {
        var raw = item.raw
        let latest = items.first { $0.id == item.id }
        let editsRecurrence = item.original?["recurrence"] != raw["recurrence"]
        let editsRange = item.original?["endDate"] != raw["endDate"] || item.original?["date"] != raw["date"]
        if editsRecurrence, let latest, latest.recurrence?.frequency != item.recurrence?.frequency {
            // Changing frequency invalidates the keys for per-occurrence state.
            raw["done"] = .bool(false)
            for key in ["doneMap", "doneAt", "overrides", "skipped", "subDone"] {
                raw[key] = .object([:])
            }
            // Use the latest metadata as the comparison base for these explicit resets.
            var original = item.original ?? [:]
            for key in ["done", "doneMap", "doneAt", "overrides", "skipped", "subDone"] {
                original[key] = latest.raw[key]
            }
            if item.recurrence != nil { raw["endDate"] = .null }
            update(records: "items", id: item.id, raw: raw, original: original)
            return
        }
        if editsRecurrence || editsRange,
           item.recurrence != nil || item.endDate.map({ $0 <= item.date }) == true {
            raw["endDate"] = .null
        }
        update(records: "items", id: item.id, raw: raw, original: item.original)
    }

    mutating func removeItem(id: String) {
        remove(records: "items", id: id)
        for var item in items where item.dependsOn.contains(id) {
            item.dependsOn = item.dependsOn.filter { $0 != id }
            saveItem(item)
        }
    }

    mutating func toggle(_ occurrence: ScheduleOccurrence, completedAt: Date = .now) {
        guard var item = item(for: occurrence), !item.noticeOnly else { return }
        let key = occurrence.key
        var completionDates = item.raw["doneAt"]?.object ?? [:]
        let complete: Bool
        if key == "single" {
            complete = !item.raw["done"].isMarked
            item.raw["done"] = .bool(complete)
        } else {
            var completion = item.raw["doneMap"]?.object ?? [:]
            complete = !completion[key].isMarked
            completion[key] = .bool(complete)
            item.raw["doneMap"] = .object(completion)
        }
        completionDates[key] = complete ? .number((completedAt.timeIntervalSince1970 * 1_000).rounded(.down)) : nil
        item.raw["doneAt"] = .object(completionDates)
        saveItem(item)
    }

    mutating func toggleStep(_ id: String, in occurrence: ScheduleOccurrence) {
        guard var item = item(for: occurrence), item.subtasks.contains(where: { $0.id == id }) else { return }
        var allChecks = item.raw["subDone"]?.object ?? [:]
        var checks = allChecks[occurrence.key]?.object ?? [:]
        checks[id] = checks[id].isMarked ? nil : .number(1)
        allChecks[occurrence.key] = checks.isEmpty ? nil : .object(checks)
        item.raw["subDone"] = .object(allChecks)
        saveItem(item)
    }

    mutating func reschedule(_ occurrence: ScheduleOccurrence, to day: ScheduleDay) {
        guard var item = item(for: occurrence) else { return }
        if occurrence.key == "single" {
            let duration = item.endDate.map { item.date.days(to: $0) }
            item.date = day
            item.endDate = duration.map { day.adding(days: $0) }
        } else {
            var overrides = item.raw["overrides"]?.object ?? [:]
            overrides[occurrence.key] = .string(day.rawValue)
            item.raw["overrides"] = .object(overrides)
        }
        saveItem(item)
    }

    mutating func clearReschedule(_ occurrence: ScheduleOccurrence) {
        guard occurrence.key != "single", var item = item(for: occurrence),
              var overrides = item.raw["overrides"]?.object,
              overrides.removeValue(forKey: occurrence.key) != nil else { return }
        item.raw["overrides"] = .object(overrides)
        saveItem(item)
    }

    mutating func skip(_ occurrence: ScheduleOccurrence) {
        guard occurrence.key != "single", var item = item(for: occurrence) else { return }
        var skipped = item.raw["skipped"]?.object ?? [:]
        skipped[occurrence.key] = .bool(true)
        item.raw["skipped"] = .object(skipped)
        saveItem(item)
    }

    private func item(for occurrence: ScheduleOccurrence) -> ScheduleItem? {
        items.first {
            $0.id == occurrence.item.id && ($0.recurrence == nil) == (occurrence.key == "single")
        }
    }

    mutating func saveCategory(_ category: ScheduleCategory) {
        update(records: "majorProjects", id: category.id, raw: category.raw, original: category.original)
    }

    mutating func removeCategory(id: String) {
        remove(records: "majorProjects", id: id)
        for var item in items where item.parentID == id {
            item.parentID = nil
            saveItem(item)
        }
    }

    mutating func saveProject(_ project: ScheduleProject) {
        update(records: "ganttProjects", id: project.id, raw: project.raw, original: project.original)
    }

    mutating func removeProject(id: String) {
        remove(records: "ganttProjects", id: id)
        if state["selectedGanttProjectId"]?.string == id {
            state["selectedGanttProjectId"] = projects.first.map { .string($0.id) } ?? .null
        }
    }

    mutating func saveTask(_ task: ScheduleTask, projectID: String) {
        guard var project = projects.first(where: { $0.id == projectID }) else { return }
        var raw = task.raw
        if task.end < task.start { raw["end"] = .string(task.start.rawValue) }
        project.raw["tasks"] = .array(Self.updating(
            project.raw["tasks"]?.array ?? [], id: task.id, raw: raw, original: task.original
        ))
        saveProject(project)
    }

    mutating func removeTask(id: String, projectID: String) {
        guard var project = projects.first(where: { $0.id == projectID }) else { return }
        project.raw["tasks"] = .array((project.raw["tasks"]?.array ?? []).filter { $0["id"]?.string != id })
        saveProject(project)
    }

    func dailyLog(on day: ScheduleDay) -> String {
        state["dailyLogs"]?.object?[day.rawValue]?.string ?? ""
    }

    mutating func setDailyLog(_ html: String, on day: ScheduleDay) {
        var logs = state["dailyLogs"]?.object ?? [:]
        logs[day.rawValue] = html.isEmpty ? nil : .string(html)
        state["dailyLogs"] = .object(logs)
    }

    func absences(on day: ScheduleDay) -> [ScheduleAbsence] {
        state["absences"]?.object?[day.rawValue]?.array?.compactMap {
            $0.object.flatMap(ScheduleAbsence.init(raw:))
        } ?? []
    }

    mutating func setAbsences(_ entries: [ScheduleAbsence], on day: ScheduleDay) {
        var dates = state["absences"]?.object ?? [:]
        let sorted = entries.sorted { ($0.kind.rawValue, $0.from ?? "") < ($1.kind.rawValue, $1.from ?? "") }
        dates[day.rawValue] = sorted.isEmpty ? nil : .array(sorted.map { .object($0.raw) })
        state["absences"] = .object(dates)
    }

    mutating func setHoliday(_ day: ScheduleDay, enabled: Bool) {
        setDay(day, enabled: enabled, key: "customHolidays")
    }

    mutating func setWorkday(_ day: ScheduleDay, enabled: Bool) {
        setDay(day, enabled: enabled, key: "customWorkdays")
    }

    mutating func loadTaiwanHolidays(year: Int) {
        guard let builtIn = Self.taiwanHolidays[year] else { return }
        let existing = (state["customHolidays"]?.array ?? []).compactMap(\.string)
        state["customHolidays"] = .array(Set(existing + builtIn).sorted().map(JSONValue.string))
    }

    private func days(at key: String) -> [ScheduleDay] {
        (state[key]?.array ?? []).compactMap { $0.string.flatMap(ScheduleDay.init(rawValue:)) }.sorted()
    }

    private mutating func setDay(_ day: ScheduleDay, enabled: Bool, key: String) {
        var values = Set((state[key]?.array ?? []).compactMap(\.string))
        if enabled { values.insert(day.rawValue) }
        else { values.remove(day.rawValue) }
        state[key] = .array(values.sorted().map(JSONValue.string))
    }

    private mutating func remove(records key: String, id: String) {
        guard let records = state[key]?.array else { return }
        state[key] = .array(records.filter { $0["id"]?.string != id })
    }

    private mutating func update(records key: String, id: String, raw: JSONObject, original: JSONObject?) {
        guard !id.isEmpty else { return }
        state[key] = .array(Self.updating(state[key]?.array ?? [], id: id, raw: raw, original: original))
    }

    private static func updating(_ records: [JSONValue], id: String, raw: JSONObject, original: JSONObject?) -> [JSONValue] {
        var records = records
        guard let index = records.firstIndex(where: { $0["id"]?.string == id }),
              var latest = records[index].object else {
            if original == nil { records.append(.object(raw)) }
            return records
        }
        // A draft may stay open while cloud synchronization adds fields or changes completion.
        // Apply only fields the draft actually changed to the latest copy of the record.
        if let original {
            for key in Set(raw.keys).union(original.keys) where raw[key] != original[key] {
                latest[key] = raw[key]
            }
        } else {
            latest.merge(raw) { _, new in new }
        }
        records[index] = .object(latest)
        return records
    }

    private static func upgrading(_ state: JSONObject) -> JSONObject {
        var state = state
        if state["version"] == nil { state["version"] = .number(Double(version)) }
        if state["version"]?.int == 1 {
            state["dailyLogs"] = .object((state["dailyLogs"]?.object ?? [:]).mapValues(asHTML))
            state["ganttProjects"] = .array((state["ganttProjects"]?.array ?? []).map { entry in
                guard var project = entry.object else { return entry }
                project["notes"] = asHTML(project["notes"] ?? .null)
                return .object(project)
            })
            state["version"] = .number(2)
        }
        if state["version"]?.int == 2 {
            if state["absences"]?.object == nil {
                var absences = JSONObject()
                for value in state["awayDates"]?.array ?? [] {
                    if let date = value.string, ScheduleDay(rawValue: date) != nil {
                        absences[date] = .array([.object(ScheduleAbsence(kind: .away).raw)])
                    }
                }
                state["absences"] = .object(absences)
            }
            state.removeValue(forKey: "awayDates")
            state["version"] = .number(Double(version))
        }
        return state
    }

    private static func asHTML(_ value: JSONValue) -> JSONValue {
        .string((value.string ?? "")
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
            .replacingOccurrences(of: "\r\n", with: "<br>")
            .replacingOccurrences(of: "\n", with: "<br>"))
    }

    // Published Directorate-General of Personnel Administration dates maintained by the web app.
    static let taiwanHolidays = [
        2026: [
            "2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18",
            "2026-02-19", "2026-02-20", "2026-02-27", "2026-04-03",
            "2026-04-06", "2026-05-01", "2026-06-19", "2026-09-25",
            "2026-09-28", "2026-10-09", "2026-10-26", "2026-12-25"
        ],
        2027: [
            "2027-01-01", "2027-02-04", "2027-02-05", "2027-02-08",
            "2027-02-09", "2027-02-10", "2027-03-01", "2027-04-05",
            "2027-04-06", "2027-04-30", "2027-06-09", "2027-09-15",
            "2027-09-28", "2027-10-11", "2027-10-25", "2027-12-24",
            "2027-12-31"
        ]
    ]
}

struct ScheduleAbsence: Equatable, Sendable {
    enum Kind: String, CaseIterable, Identifiable, Sendable {
        case away, leave
        var id: Self { self }
    }

    var raw: JSONObject

    init?(raw: JSONObject) {
        guard let value = raw["kind"]?.string, Kind(rawValue: value) != nil else { return nil }
        self.raw = raw
    }

    init(kind: Kind, from: String? = nil, to: String? = nil, icon: String? = nil) {
        raw = ["kind": .string(kind.rawValue), "from": from.map(JSONValue.string) ?? .null,
               "to": to.map(JSONValue.string) ?? .null]
        if kind == .leave, let icon { raw["icon"] = .string(icon) }
    }

    var kind: Kind { raw["kind"]?.string.flatMap(Kind.init(rawValue:)) ?? .away }
    var from: String? { raw["from"]?.string }
    var to: String? { raw["to"]?.string }
    var icon: String? { raw["icon"]?.string }
}
