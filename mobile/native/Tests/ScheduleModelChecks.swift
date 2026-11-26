import Foundation

@main
enum ScheduleModelChecks {
    static func main() {
        checkDateAndRange()
        checkWeeklyCycle()
        checkMonthAndYearCycles()
        checkOverridesAndCompletion()
        checkSnapshotUpgradesAndDrafts()
        checkProjects()
        print("6 native scheduling model checks passed")
    }

    private static func day(_ raw: String) -> ScheduleDay {
        guard let day = ScheduleDay(rawValue: raw) else { preconditionFailure("Invalid test date: \(raw)") }
        return day
    }

    private static func checkDateAndRange() {
        precondition(ScheduleDay(rawValue: "2026-02-29") == nil)
        precondition(day("2024-02-29").adding(days: 1) == day("2024-03-01"))
        precondition(day("2026-03-07").days(to: day("2026-03-10")) == 3)
        var document = ScheduleDocument()
        var item = ScheduleItem(title: "Trip", date: day("2026-08-22"))
        item.endDate = day("2026-08-26")
        document.saveItem(item)
        let entries = document.occurrences(from: day("2026-08-24"), through: day("2026-08-24"))
        precondition(entries.map(\.key) == ["single"])
        precondition(entries.first?.endDate == day("2026-08-26"))
    }

    private static func checkWeeklyCycle() {
        var document = ScheduleDocument()
        var item = ScheduleItem(title: "Biweekly", date: day("2026-02-04"))
        item.recurrence = ScheduleRecurrence(frequency: .biweekly, count: 4, weekdays: [1, 3, 5])
        document.saveItem(item)
        let entries = document.occurrences(from: day("2026-02-01"), through: day("2026-03-31"))
        precondition(entries.map(\.key) == ["W2026-02-04", "W2026-02-06", "W2026-02-16", "W2026-02-18"])
        document.skip(entries[1])
        let remaining = document.occurrences(from: day("2026-02-01"), through: day("2026-03-31"))
        precondition(remaining.map(\.key) == ["W2026-02-04", "W2026-02-16", "W2026-02-18"])
    }

    private static func checkMonthAndYearCycles() {
        var document = ScheduleDocument()
        var item = ScheduleItem(title: "Monthly", date: day("2026-01-31"))
        item.recurrence = ScheduleRecurrence(frequency: .monthly, day: 31, holidayRule: .advance)
        document.saveItem(item)
        let february = document.occurrences(from: day("2026-02-27"), through: day("2026-02-27"))
        precondition(february.map(\.key) == ["2026-02"])

        var nth = ScheduleItem(title: "Fifth Monday", date: day("2026-01-01"))
        nth.recurrence = ScheduleRecurrence(frequency: .monthly, count: 2, mode: .nthWeekday, nth: 5, weekday: 1)
        document.saveItem(nth)
        let fifth = document.occurrences(from: day("2026-01-01"), through: day("2026-12-31"))
            .filter { $0.item.id == nth.id }
        precondition(fifth.map(\.date.rawValue) == ["2026-03-30", "2026-06-29"])

        let oldDay = day("1960-02-29")
        var annual = ScheduleItem(title: "Annual", date: oldDay)
        annual.recurrence = ScheduleRecurrence(frequency: .yearly, day: 29)
        document.saveItem(annual)
        let future = document.occurrences(from: day("2071-02-01"), through: day("2071-02-28"))
        precondition(future.first { $0.item.id == annual.id }?.date == day("2071-02-28"))
    }

    private static func checkOverridesAndCompletion() {
        var document = ScheduleDocument()
        var item = ScheduleItem(title: "Monday", date: day("2026-02-16"))
        item.recurrence = ScheduleRecurrence(frequency: .weekly, holidayRule: .postpone, count: 2)
        let step = ScheduleStep(text: "Review")
        item.subtasks = [step]
        document.loadTaiwanHolidays(year: 2026)
        document.saveItem(item)
        let entries = document.occurrences(from: day("2026-02-23"), through: day("2026-02-23"))
        precondition(entries.map(\.key) == ["W2026-02-16", "W2026-02-23"])
        let moved = entries[0]
        document.toggleStep(step.id, in: moved)
        document.toggle(moved, completedAt: Date(timeIntervalSince1970: 100))
        document.reschedule(moved, to: day("2031-01-01"))
        let future = document.occurrences(from: day("2031-01-01"), through: day("2031-01-01"))
        precondition(future.count == 1 && future[0].done && future[0].isStepDone(step.id))
        precondition(future[0].item.raw["doneAt"]?["W2026-02-16"]?.int == 100_000)
        document.clearReschedule(future[0])
        let restored = document.occurrences(from: day("2026-02-23"), through: day("2026-02-23"))
        precondition(restored.count == 2 && restored[0].done && !restored[1].isStepDone(step.id))

        let workday = day("2026-02-21")
        document.setWorkday(workday, enabled: true)
        let adjusted = document.occurrences(from: workday, through: workday)
        precondition(adjusted.map(\.key) == ["W2026-02-16"])
        precondition(adjusted[0].done)

        var changesCadence = document.items[0]
        changesCadence.recurrence?.frequency = .monthly
        document.saveItem(changesCadence)
        let changed = document.items[0]
        precondition(changed.raw["doneMap"]?.object?.isEmpty == true)
        precondition(changed.raw["subDone"]?.object?.isEmpty == true)
        precondition(changed.subtasks.first?.id == step.id)
    }

    private static func checkSnapshotUpgradesAndDrafts() {
        let raw: JSONObject = [
            "version": .number(1),
            "awayDates": .array([.string("2026-01-01")]),
            "dailyLogs": .object(["2026-01-01": .string("<行程>\n明天")]),
            "futureField": .object(["pets": .array([.string("cat")])])
        ]
        var document = ScheduleDocument(raw)
        precondition(document.state["version"]?.int == ScheduleDocument.version)
        precondition(document.state["awayDates"] == nil)
        precondition(document.absences(on: day("2026-01-01")).map(\.kind) == [.away])
        precondition(document.dailyLog(on: day("2026-01-01")) == "&lt;行程&gt;<br>明天")

        let item = ScheduleItem(title: "Initial title", date: day("2026-02-16"))
        document.saveItem(item)
        var stale = document.items[0]
        var incoming = document.items[0]
        incoming.raw["unknownRemoteField"] = .string("keep me")
        document.saveItem(incoming)
        let occurrence = document.occurrences(from: item.date, through: item.date)[0]
        document.toggle(occurrence)
        stale.title = "New title"
        document.saveItem(stale)
        precondition(document.items[0].title == "New title")
        precondition(document.items[0].raw["unknownRemoteField"]?.string == "keep me")
        precondition(document.occurrences(from: item.date, through: item.date)[0].done)
        precondition(document.state["futureField"] == raw["futureField"])
        document.removeItem(id: stale.id)
        document.saveItem(stale)
        precondition(document.items.isEmpty)
    }

    private static func checkProjects() {
        var document = ScheduleDocument()
        var project = ScheduleProject(name: "Release")
        project.raw["pet"] = .string("fox")
        document.saveProject(project)
        var task = ScheduleTask(name: "Verify", start: day("2026-05-01"), end: day("2026-05-04"))
        task.todos = [ScheduleTodo(text: "Review", done: true), ScheduleTodo(text: "Build")]
        task.raw["forecastEnd"] = .string("2026-05-05")
        document.saveTask(task, projectID: project.id)
        var existing = document.projects[0].tasks[0]
        precondition(existing.progress == 50 && !existing.done)
        existing.todos[1].done = true
        document.saveTask(existing, projectID: project.id)
        let saved = document.projects[0]
        precondition(saved.raw["pet"]?.string == "fox")
        precondition(saved.tasks[0].raw["forecastEnd"]?.string == "2026-05-05")
        precondition(saved.tasks[0].done && saved.tasks[0].progress == 100)
    }
}
