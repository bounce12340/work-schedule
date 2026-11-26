import Foundation

/// Three-way merging keeps unrelated edits and fields the native app cannot
/// display. An explicit choice is required before replacing a changed value.
struct SnapshotMerge {
    struct Result {
        let state: JSONObject
        let conflicts: [String]
    }

    static func merge(base: JSONObject?, local: JSONObject, remote: JSONObject,
                      choice: CloudConflictChoice? = nil) -> Result {
        if base == nil {
            if local == remote { return Result(state: local, conflicts: []) }
            return Result(state: choice == .useCloud ? remote : local, conflicts: ["全部資料"])
        }
        var conflicts: [String] = []
        let value = resolve(base: base.map(JSONValue.object), local: .object(local), remote: .object(remote),
                            keys: [], choice: choice, conflicts: &conflicts)
        return Result(state: value?.object ?? local, conflicts: conflicts)
    }

    private static func resolve(base: JSONValue?, local: JSONValue?, remote: JSONValue?, keys: [String],
                                choice: CloudConflictChoice?, conflicts: inout [String]) -> JSONValue? {
        if local == remote || remote == base { return local }
        if local == base { return remote }
        if let b = base?.object, let l = local?.object, let r = remote?.object {
            let allKeys = Set(b.keys).union(l.keys).union(r.keys).sorted()
            var result = JSONObject()
            for key in allKeys {
                result[key] = resolve(base: b[key], local: l[key], remote: r[key], keys: keys + [key],
                                      choice: choice, conflicts: &conflicts)
            }
            return .object(result)
        }
        if let b = IndexedArray(base), let l = IndexedArray(local), let r = IndexedArray(remote),
           b.hasSameOrder(as: l), b.hasSameOrder(as: r) {
            var seen: Set<String> = []
            let ids = (b.ids + l.ids + r.ids).filter { seen.insert($0).inserted }
            if l.preservesOrder(in: ids), r.preservesOrder(in: ids) {
                return .array(ids.compactMap { id in
                    resolve(base: b.values[id], local: l.values[id], remote: r.values[id],
                            keys: keys + [id], choice: choice, conflicts: &conflicts)
                })
            }
        }
        conflicts.append(keys.joined(separator: " / "))
        return choice == .useCloud ? remote : local
    }

    private struct IndexedArray {
        let values: [String: JSONValue]
        let ids: [String]

        init?(_ value: JSONValue?) {
            guard let array = value?.array else { return nil }
            var values: [String: JSONValue] = [:]
            var ids: [String] = []
            for row in array {
                guard let id = row["id"]?.string, values[id] == nil else { return nil }
                values[id] = row
                ids.append(id)
            }
            self.values = values
            self.ids = ids
        }

        func preservesOrder(in mergedIDs: [String]) -> Bool {
            mergedIDs.filter { values[$0] != nil } == ids
        }

        func hasSameOrder(as branch: IndexedArray) -> Bool {
            // Existing lists often append records. Only merge when doing so can
            // preserve the relative order of both branches, including additions.
            let retained = ids.filter { branch.values[$0] != nil }
            let appended = branch.ids.filter { values[$0] == nil }
            return retained + appended == branch.ids
        }
    }
}
