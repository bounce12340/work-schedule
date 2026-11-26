import Foundation

struct ScheduleItem: Identifiable, Equatable, Sendable {
    enum Kind: String, CaseIterable, Identifiable, Sendable {
        case work, meeting, assignment
        var id: Self { self }
    }

    var raw: JSONObject
    let original: JSONObject?

    init(raw: JSONObject) {
        self.raw = raw
        original = raw
    }

    init(id: String = UUID().uuidString, title: String, date: ScheduleDay, type: Kind = .work) {
        raw = ["id": .string(id), "title": .string(title), "date": .string(date.rawValue), "type": .string(type.rawValue)]
        original = nil
    }

    var id: String { raw["id"]?.string ?? "" }
    var title: String {
        get { raw["title"]?.string ?? "" }
        set { raw["title"] = .string(newValue) }
    }
    var date: ScheduleDay {
        get { raw.scheduleDay("date") ?? ScheduleDay(.now) }
        set { raw["date"] = .string(newValue.rawValue) }
    }
    var endDate: ScheduleDay? {
        get { raw.scheduleDay("endDate") }
        set { raw["endDate"] = newValue.map { .string($0.rawValue) } ?? .null }
    }
    var type: Kind {
        get { raw["type"]?.string.flatMap(Kind.init(rawValue:)) ?? .work }
        set { raw["type"] = .string(newValue.rawValue) }
    }
    var parentID: String? {
        get { raw["parentId"]?.string }
        set { raw["parentId"] = newValue.map(JSONValue.string) ?? .null }
    }
    var time: String? {
        get { raw["meetingTime"]?.string }
        set { raw["meetingTime"] = newValue.map(JSONValue.string) ?? .null }
    }
    var link: String? {
        get { raw["link"]?.string }
        set { raw["link"] = newValue.map(JSONValue.string) ?? .null }
    }
    var tags: [String] {
        get { raw["tags"]?.array?.compactMap(\.string) ?? [] }
        set { raw["tags"] = .array(Array(Set(newValue)).sorted().map(JSONValue.string)) }
    }
    var noticeOnly: Bool {
        get { raw["noticeOnly"].isMarked }
        set { raw["noticeOnly"] = .bool(newValue) }
    }
    var recurrence: ScheduleRecurrence? {
        get { raw["recurrence"]?.object.flatMap(ScheduleRecurrence.init(raw:)) }
        set { raw["recurrence"] = newValue.map { .object($0.raw) } ?? .null }
    }
    var subtasks: [ScheduleStep] {
        get { raw.records("subtasks", make: ScheduleStep.init(raw:)) }
        set { raw["subtasks"] = .array(newValue.map { .object($0.raw) }) }
    }
    var dependsOn: [String] {
        get { raw["dependsOn"]?.array?.compactMap(\.string) ?? [] }
        set { raw["dependsOn"] = .array(Array(Set(newValue.filter { $0 != id })).sorted().map(JSONValue.string)) }
    }
}

struct ScheduleOccurrence: Identifiable, Equatable, Sendable {
    var id: String { item.id + "/" + key }
    let item: ScheduleItem
    let date: ScheduleDay
    let endDate: ScheduleDay?
    let key: String
    let done: Bool

    func isStepDone(_ id: String) -> Bool {
        item.raw["subDone"]?.object?[key]?.object?[id].isMarked ?? false
    }
}

struct ScheduleStep: Identifiable, Equatable, Sendable {
    var raw: JSONObject

    init(raw: JSONObject) { self.raw = raw }
    init(id: String = UUID().uuidString, text: String) {
        raw = ["id": .string(id), "text": .string(text)]
    }

    var id: String { raw["id"]?.string ?? "" }
    var text: String {
        get { raw["text"]?.string ?? "" }
        set { raw["text"] = .string(newValue) }
    }
}

struct ScheduleCategory: Identifiable, Equatable, Sendable {
    var raw: JSONObject
    let original: JSONObject?

    init(raw: JSONObject) {
        self.raw = raw
        original = raw
    }

    init(id: String = UUID().uuidString, name: String) {
        raw = ["id": .string(id), "name": .string(name)]
        original = nil
    }

    var id: String { raw["id"]?.string ?? "" }
    var name: String {
        get { raw["name"]?.string ?? "" }
        set { raw["name"] = .string(newValue) }
    }
}

struct ScheduleProject: Identifiable, Equatable, Sendable {
    var raw: JSONObject
    let original: JSONObject?

    init(raw: JSONObject) {
        self.raw = raw
        original = raw
    }

    init(id: String = UUID().uuidString, name: String) {
        raw = ["id": .string(id), "name": .string(name), "notes": .string(""), "tasks": .array([])]
        original = nil
    }

    var id: String { raw["id"]?.string ?? "" }
    var name: String {
        get { raw["name"]?.string ?? "" }
        set { raw["name"] = .string(newValue) }
    }
    var notes: String {
        get { raw["notes"]?.string ?? "" }
        set { raw["notes"] = .string(newValue) }
    }
    var brief: String {
        get { raw["brief"]?.string ?? "" }
        set { raw["brief"] = .string(newValue) }
    }
    var tasks: [ScheduleTask] {
        get { raw.records("tasks", make: ScheduleTask.init(raw:)) }
        set { raw["tasks"] = .array(newValue.map { .object($0.raw) }) }
    }
}

struct ScheduleTask: Identifiable, Equatable, Sendable {
    var raw: JSONObject
    let original: JSONObject?

    init(raw: JSONObject) {
        self.raw = raw
        original = raw
    }

    init(id: String = UUID().uuidString, name: String, start: ScheduleDay, end: ScheduleDay) {
        raw = [
            "id": .string(id), "name": .string(name), "start": .string(start.rawValue), "end": .string(end.rawValue),
            "progress": .number(0), "done": .bool(false), "todos": .array([])
        ]
        original = nil
    }

    var id: String { raw["id"]?.string ?? "" }
    var name: String {
        get { raw["name"]?.string ?? "" }
        set { raw["name"] = .string(newValue) }
    }
    var start: ScheduleDay {
        get { raw.scheduleDay("start") ?? ScheduleDay(.now) }
        set { raw["start"] = .string(newValue.rawValue) }
    }
    var end: ScheduleDay {
        get { raw.scheduleDay("end") ?? start }
        set { raw["end"] = .string(newValue.rawValue) }
    }
    var progress: Int {
        get {
            let list = todos
            if list.isEmpty { return min(100, max(0, raw["progress"]?.int ?? 0)) }
            let doneCount = list.filter(\.done).count
            return Int((Double(doneCount) / Double(list.count) * 100).rounded())
        }
        set {
            guard todos.isEmpty else { return }
            let percent = min(100, max(0, newValue))
            raw["progress"] = .number(Double(percent))
            raw["done"] = .bool(percent == 100)
        }
    }
    var done: Bool {
        get { todos.isEmpty ? raw["done"].isMarked : todos.allSatisfy(\.done) }
        set {
            guard todos.isEmpty else { return }
            raw["done"] = .bool(newValue)
            if newValue || progress == 100 {
                raw["progress"] = .number(newValue ? 100 : 0)
            }
        }
    }
    var todos: [ScheduleTodo] {
        get { raw.records("todos", make: ScheduleTodo.init(raw:)) }
        set {
            raw["todos"] = .array(newValue.map { .object($0.raw) })
            if !newValue.isEmpty {
                raw["progress"] = .number(Double(progress))
                raw["done"] = .bool(done)
            }
        }
    }
}

struct ScheduleTodo: Identifiable, Equatable, Sendable {
    var raw: JSONObject

    init(raw: JSONObject) { self.raw = raw }
    init(id: String = UUID().uuidString, text: String, done: Bool = false) {
        raw = ["id": .string(id), "text": .string(text), "done": .bool(done)]
    }

    var id: String { raw["id"]?.string ?? "" }
    var text: String {
        get { raw["text"]?.string ?? "" }
        set { raw["text"] = .string(newValue) }
    }
    var done: Bool {
        get { raw["done"].isMarked }
        set {
            raw["done"] = .bool(newValue)
            if newValue, raw["review"].isMarked {
                raw["review"] = .bool(false)
            }
        }
    }
}

extension JSONObject {
    func scheduleDay(_ key: String) -> ScheduleDay? {
        self[key]?.string.flatMap(ScheduleDay.init(rawValue:))
    }

    func records<T>(_ key: String, make: (JSONObject) -> T) -> [T] {
        self[key]?.array?.compactMap { value in
            guard let raw = value.object, let id = raw["id"]?.string, !id.isEmpty else { return nil }
            return make(raw)
        } ?? []
    }
}

extension Optional where Wrapped == JSONValue {
    var isMarked: Bool {
        self?.bool ?? ((self?.int ?? 0) != 0)
    }
}
