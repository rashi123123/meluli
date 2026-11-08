import Foundation
import JavaScriptCore

// MARK: Argument helpers

extension Array where Element == Any {
  func string(_ index: Int) -> String? { index < count ? self[index] as? String : nil }
  func number(_ index: Int) -> Double? { index < count ? (self[index] as? NSNumber)?.doubleValue : nil }
  func int(_ index: Int) -> Int? { index < count ? (self[index] as? NSNumber)?.intValue : nil }
  func bool(_ index: Int) -> Bool? { index < count ? (self[index] as? NSNumber)?.boolValue : nil }
  func dict(_ index: Int) -> [String: Any] { index < count ? (self[index] as? [String: Any]) ?? [:] : [:] }
  func list(_ index: Int) -> [Any] { index < count ? (self[index] as? [Any]) ?? [] : [] }
}

extension Dictionary where Key == String, Value == Any {
  func string(_ key: String) -> String? { self[key] as? String }
  func number(_ key: String) -> Double? { (self[key] as? NSNumber)?.doubleValue }
  func bool(_ key: String) -> Bool? { (self[key] as? NSNumber)?.boolValue }
  func dict(_ key: String) -> [String: Any]? { self[key] as? [String: Any] }
}

extension JSRuntime {
  /// Foundation to JS: dictionaries, arrays, strings, numbers, booleans, null, dates, and Data as Uint8Array.
  static func value(_ object: Any?, in context: JSContext) -> JSValue {
    guard let object else { return JSValue(undefinedIn: context) }
    switch object {
    case is NSNull: return JSValue(nullIn: context)
    case let data as Data: return bytes(data, in: context)
    case let number as NSNumber:
      if CFGetTypeID(number) == CFBooleanGetTypeID() { return JSValue(bool: number.boolValue, in: context) }
      return JSValue(double: number.doubleValue, in: context)
    case let text as String: return JSValue(object: text, in: context)
    case let date as Date: return JSValue(object: date, in: context)
    case let list as [Any]:
      let array = JSValue(newArrayIn: context)!
      for (index, item) in list.enumerated() { array.setValue(value(item, in: context), at: index) }
      return array
    case let map as [String: Any]:
      let result = JSValue(newObjectIn: context)!
      for (key, item) in map { result.setValue(value(item, in: context), forProperty: key) }
      return result
    case let value as JSValue: return value
    default: return JSValue(object: object, in: context)
    }
  }
}
