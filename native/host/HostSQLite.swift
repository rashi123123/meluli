// macOS's own SQLite behind the part of better-sqlite3's API the app uses (D11): prepare, run, get,
// all, exec, pragma, transaction and close, with positional or named parameters. Integers come back
// as numbers, blobs as Uint8Array, as better-sqlite3 does without safeIntegers.
import Foundation
import JavaScriptCore
import SQLite3

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

enum HostSQLite {
  private static var databases: [Int: OpaquePointer] = [:]
  private static var statements: [Int: (db: Int, stmt: OpaquePointer)] = [:]
  private static var nextId = 1

  /// Throws SQLite's last error for `db` into JS, with Node's `SQLITE_*` code name.
  private static func fail(_ db: OpaquePointer?) -> JSValue {
    let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "SQLite error"
    return thrown(message, code: codeName(db.map { sqlite3_extended_errcode($0) } ?? SQLITE_ERROR))
  }

  private static func thrown(_ message: String, code: String? = nil) -> JSValue {
    JSRuntime.throwError(message, code: code)
    return JSValue(undefinedIn: JSContext.current())
  }

  private static func codeName(_ code: Int32) -> String {
    switch code & 0xff {
    case SQLITE_CONSTRAINT:
      switch code {
      case 2067: return "SQLITE_CONSTRAINT_UNIQUE"
      case 1555: return "SQLITE_CONSTRAINT_PRIMARYKEY"
      case 787: return "SQLITE_CONSTRAINT_FOREIGNKEY"
      case 1299: return "SQLITE_CONSTRAINT_NOTNULL"
      case 275: return "SQLITE_CONSTRAINT_CHECK"
      default: return "SQLITE_CONSTRAINT"
      }
    case SQLITE_BUSY: return "SQLITE_BUSY"
    case SQLITE_LOCKED: return "SQLITE_LOCKED"
    case SQLITE_READONLY: return "SQLITE_READONLY"
    case SQLITE_CORRUPT: return "SQLITE_CORRUPT"
    case SQLITE_FULL: return "SQLITE_FULL"
    case SQLITE_CANTOPEN: return "SQLITE_CANTOPEN"
    case SQLITE_NOTADB: return "SQLITE_NOTADB"
    case SQLITE_IOERR: return "SQLITE_IOERR"
    case SQLITE_MISUSE: return "SQLITE_MISUSE"
    case SQLITE_RANGE: return "SQLITE_RANGE"
    default: return "SQLITE_ERROR"
    }
  }

  static func install(in runtime: JSRuntime) {
    let open: @convention(block) (String, Bool) -> JSValue = { path, readonly in
      var db: OpaquePointer?
      let flags = (readonly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE) | SQLITE_OPEN_FULLMUTEX
      guard sqlite3_open_v2(path, &db, flags, nil) == SQLITE_OK, let db else {
        let value = fail(db); sqlite3_close(db); return value
      }
      sqlite3_busy_timeout(db, 5000)
      sqlite3_extended_result_codes(db, 1)
      let id = nextId; nextId += 1
      databases[id] = db
      return JSValue(int32: Int32(id), in: JSContext.current())
    }
    runtime.define("sqliteOpen", open)
    let close: @convention(block) (Int) -> Void = { id in
      for (key, value) in statements where value.db == id { sqlite3_finalize(value.stmt); statements.removeValue(forKey: key) }
      if let db = databases.removeValue(forKey: id) { sqlite3_close_v2(db) }
    }
    runtime.define("sqliteClose", close)
    let exec: @convention(block) (Int, String) -> JSValue = { id, sql in
      guard let db = databases[id] else { return thrown("The database connection is not open", code: "SQLITE_MISUSE") }
      guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { return fail(db) }
      return JSValue(undefinedIn: JSContext.current())
    }
    runtime.define("sqliteExec", exec)
    // prepare -> { id, reader, readonly }
    let prepare: @convention(block) (Int, String) -> JSValue = { id, sql in
      let context = JSContext.current()!
      guard let db = databases[id] else { return thrown("The database connection is not open", code: "SQLITE_MISUSE") }
      var stmt: OpaquePointer?
      // The tail points into the C string, so it is read before that buffer goes away.
      var rest = ""
      let result = sql.withCString { text -> Int32 in
        var tail: UnsafePointer<CChar>?
        let code = sqlite3_prepare_v3(db, text, -1, 0, &stmt, &tail)
        if let tail, tail.pointee != 0 { rest = String(cString: tail) }
        return code
      }
      guard result == SQLITE_OK, let stmt else { return fail(db) }
      if !rest.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: ";"))).isEmpty {
        sqlite3_finalize(stmt)
        return thrown("The supplied SQL string contains more than one statement")
      }
      let statementId = nextId; nextId += 1
      statements[statementId] = (id, stmt)
      let reader = sqlite3_column_count(stmt) > 0
      return JSValue(object: ["id": statementId, "reader": reader, "readonly": sqlite3_stmt_readonly(stmt) != 0], in: context)
    }
    runtime.define("sqlitePrepare", prepare)
    let finalize: @convention(block) (Int) -> Void = { id in
      if let entry = statements.removeValue(forKey: id) { sqlite3_finalize(entry.stmt) }
    }
    runtime.define("sqliteFinalize", finalize)
    // step(statement, params, mode): mode "run" -> { changes, lastInsertRowid }; "get" -> row or
    // undefined; "all" -> rows; "pluck" -> first column of each row.
    let step: @convention(block) (Int, JSValue, String) -> JSValue = { id, params, mode in
      let context = JSContext.current()!
      guard let (dbId, stmt) = statements[id], let db = databases[dbId] else {
        return thrown("The statement has been finalized", code: "SQLITE_MISUSE")
      }
      sqlite3_reset(stmt)
      sqlite3_clear_bindings(stmt)
      defer { sqlite3_reset(stmt) }
      if let message = bind(stmt, params) {
        return thrown(message, code: "SQLITE_RANGE")
      }
      var rows: [JSValue] = []
      while true {
        let result = sqlite3_step(stmt)
        if result == SQLITE_DONE { break }
        guard result == SQLITE_ROW else { return fail(db) }
        if mode == "run" { continue }
        rows.append(mode == "pluck" ? column(stmt, 0, in: context) : row(stmt, in: context))
        if mode == "get" { break }
      }
      switch mode {
      case "run":
        return JSValue(object: ["changes": Int(sqlite3_changes64(db)), "lastInsertRowid": Int(sqlite3_last_insert_rowid(db))], in: context)
      case "get":
        return rows.first ?? JSValue(undefinedIn: context)
      default:
        let array = JSValue(newArrayIn: context)!
        for (index, value) in rows.enumerated() { array.setValue(value, at: index) }
        return array
      }
    }
    runtime.define("sqliteStep", step)
    let inTransaction: @convention(block) (Int) -> Bool = { id in
      guard let db = databases[id] else { return false }
      return sqlite3_get_autocommit(db) == 0
    }
    runtime.define("sqliteInTransaction", inTransaction)
  }

  private static func bindValue(_ stmt: OpaquePointer, _ index: Int32, _ value: JSValue) -> String? {
    if value.isUndefined || value.isNull { sqlite3_bind_null(stmt, index); return nil }
    if value.isBoolean { sqlite3_bind_int64(stmt, index, value.toBool() ? 1 : 0); return nil }
    if value.isNumber {
      let number = value.toDouble()
      if number.rounded() == number && abs(number) < 9.007199254740992e15 { sqlite3_bind_int64(stmt, index, Int64(number)) }
      else { sqlite3_bind_double(stmt, index, number) }
      return nil
    }
    if value.isString { sqlite3_bind_text(stmt, index, value.toString(), -1, SQLITE_TRANSIENT); return nil }
    if let data = JSRuntime.data(of: value) {
      _ = data.withUnsafeBytes { sqlite3_bind_blob(stmt, index, $0.baseAddress, Int32(data.count), SQLITE_TRANSIENT) }
      return nil
    }
    if let big = value.context.objectForKeyedSubscript("__isBigInt")?.call(withArguments: [value]), big.toBool() {
      sqlite3_bind_int64(stmt, index, Int64(value.toString()) ?? 0); return nil
    }
    return "SQLite3 can only bind numbers, strings, bigints, buffers, and null"
  }

  private static func bind(_ stmt: OpaquePointer, _ params: JSValue) -> String? {
    let count = sqlite3_bind_parameter_count(stmt)
    guard params.isArray else { return count == 0 ? nil : "Too few parameter values were provided" }
    let list = params.toArray() ?? []
    var positional: [JSValue] = []
    var named: JSValue?
    for index in 0..<list.count {
      let item = params.atIndex(index)!
      let isPlainObject = item.isObject && !item.isArray && JSRuntime.data(of: item) == nil && !item.isDate
      if isPlainObject && named == nil { named = item } else { positional.append(item) }
    }
    var next = 0
    for index in 1...max(count, 1) where count > 0 {
      let name = sqlite3_bind_parameter_name(stmt, Int32(index)).map { String(cString: $0) }
      if let name, !name.hasPrefix("?") {
        let key = String(name.dropFirst())
        guard let named, let value = named.forProperty(key), !value.isUndefined else { return "Missing named parameter \"\(key)\"" }
        if let error = bindValue(stmt, Int32(index), value) { return error }
      } else {
        guard next < positional.count else { return "Too few parameter values were provided" }
        if let error = bindValue(stmt, Int32(index), positional[next]) { return error }
        next += 1
      }
    }
    if next < positional.count { return "Too many parameter values were provided" }
    return nil
  }

  private static func column(_ stmt: OpaquePointer, _ index: Int32, in context: JSContext) -> JSValue {
    switch sqlite3_column_type(stmt, index) {
    case SQLITE_INTEGER: return JSValue(double: Double(sqlite3_column_int64(stmt, index)), in: context)
    case SQLITE_FLOAT: return JSValue(double: sqlite3_column_double(stmt, index), in: context)
    case SQLITE_TEXT:
      let text = sqlite3_column_text(stmt, index).map { String(cString: $0) } ?? ""
      return JSValue(object: text, in: context)
    case SQLITE_BLOB:
      let count = Int(sqlite3_column_bytes(stmt, index))
      let data = count > 0 ? Data(bytes: sqlite3_column_blob(stmt, index), count: count) : Data()
      return JSRuntime.bytes(data, in: context)
    default: return JSValue(nullIn: context)
    }
  }

  private static func row(_ stmt: OpaquePointer, in context: JSContext) -> JSValue {
    let object = JSValue(newObjectIn: context)!
    for index in 0..<sqlite3_column_count(stmt) {
      let name = String(cString: sqlite3_column_name(stmt, index))
      object.setValue(column(stmt, index, in: context), forProperty: name)
    }
    return object
  }
}
