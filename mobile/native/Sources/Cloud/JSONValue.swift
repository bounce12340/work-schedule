import Foundation

typealias JSONObject = [String: JSONValue]

/// The Worker and browser exchange complete versioned snapshots. Values that the
/// native screens do not edit still need to survive a pull and push unchanged.
enum JSONValue: Codable, Equatable, Sendable {
    case object(JSONObject)
    case array([JSONValue])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    var object: JSONObject? {
        if case let .object(value) = self { return value }
        return nil
    }

    var array: [JSONValue]? {
        if case let .array(value) = self { return value }
        return nil
    }

    var string: String? {
        if case let .string(value) = self { return value }
        return nil
    }

    var number: Double? {
        if case let .number(value) = self { return value }
        return nil
    }

    var int: Int? {
        number.flatMap { Int(exactly: $0) }
    }

    var bool: Bool? {
        if case let .bool(value) = self { return value }
        return nil
    }

    subscript(_ key: String) -> JSONValue? { object?[key] }

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() {
            self = .null
        } else if let bool = try? value.decode(Bool.self) {
            self = .bool(bool)
        } else if let number = try? value.decode(Double.self) {
            self = .number(number)
        } else if let string = try? value.decode(String.self) {
            self = .string(string)
        } else if let array = try? value.decode([JSONValue].self) {
            self = .array(array)
        } else {
            self = .object(try value.decode(JSONObject.self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .object(let object): try value.encode(object)
        case .array(let array): try value.encode(array)
        case .string(let string): try value.encode(string)
        case .number(let number): try value.encode(number)
        case .bool(let bool): try value.encode(bool)
        case .null: try value.encodeNil()
        }
    }
}
