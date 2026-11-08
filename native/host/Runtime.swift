// The JavaScriptCore runtime that runs the app's main-process TypeScript (D20). Everything in the
// context runs on one thread with its own run loop; work from other queues hops onto it through
// `perform`. The host functions the Node and Electron surfaces call live under `__native`.
import Foundation
import JavaScriptCore

final class JSRuntime {
  private(set) var context: JSContext!
  private(set) var native: JSValue!
  private var runLoop: RunLoop!
  private var cfRunLoop: CFRunLoop!
  private let started = DispatchSemaphore(value: 0)
  /// File and process work that may block runs here, never on the JS thread.
  let io = DispatchQueue(label: "meluli.io", qos: .userInitiated, attributes: .concurrent)
  private var timers: [Int: Timer] = [:]
  private var nextTimer = 1
  /// Uncaught errors are reported here (the console and the app's log).
  var onUncaught: ((String) -> Void)?

  init() {
    let thread = Thread { [unowned self] in
      self.runLoop = RunLoop.current
      self.cfRunLoop = CFRunLoopGetCurrent()
      // A port keeps the run loop alive while nothing else is scheduled; it never fires.
      RunLoop.current.add(Port(), forMode: .default)
      self.context = JSContext()
      self.context.name = "Meluli"
      self.context.exceptionHandler = { [weak self] _, exception in
        let message = exception.map { value -> String in
          let stack = value.forProperty("stack")?.toString() ?? ""
          return "\(value.toString() ?? "error")\n\(stack)"
        } ?? "unknown error"
        self?.onUncaught?(message)
      }
      self.native = JSValue(newObjectIn: self.context)
      self.context.setObject(self.native, forKeyedSubscript: "__native" as NSString)
      self.installCore()
      self.started.signal()
      while true { autoreleasepool { _ = RunLoop.current.run(mode: .default, before: .distantFuture) } }
    }
    thread.name = "meluli.js"
    thread.qualityOfService = .userInitiated
    thread.stackSize = 16 << 20
    thread.start()
    started.wait()
    JSRuntime.shared = self
  }

  /// The app's one runtime, for the windows that hand memory back when they close.
  private(set) static weak var shared: JSRuntime?

  /// Runs `block` on the JS thread. Safe to call from any thread, including the JS thread itself
  /// (the block then runs on the next turn, never re-entrantly).
  func perform(_ block: @escaping () -> Void) {
    CFRunLoopPerformBlock(cfRunLoop, CFRunLoopMode.defaultMode.rawValue) { autoreleasepool { block() } }
    CFRunLoopWakeUp(cfRunLoop)
  }

  /// Runs `block` on the JS thread and waits. Never call from the JS thread.
  func performAndWait<T>(_ block: @escaping () -> T) -> T {
    precondition(Thread.current.name != "meluli.js", "performAndWait from the JS thread")
    var result: T?
    let done = DispatchSemaphore(value: 0)
    perform { result = block(); done.signal() }
    done.wait()
    return result!
  }

  /// Registers a host function under `__native.<name>`.
  func define(_ name: String, _ function: Any) {
    native.setObject(function, forKeyedSubscript: name as NSString)
  }

  /// Runs a bundle. Its import.meta.url is __meluliMainUrl (bundle-native-host.mjs), so the first
  /// bundle evaluated names it and the bundle's relative paths resolve beside it.
  func evaluate(_ source: String, url: URL) {
    if context.objectForKeyedSubscript(HostNames.mainURLGlobal).isUndefined {
      context.setObject(url.absoluteString, forKeyedSubscript: HostNames.mainURLGlobal as NSString)
    }
    context.evaluateScript(source, withSourceURL: url)
  }

  // MARK: Memory

  private var trimTimer: Timer?
  private var pressureSource: DispatchSourceMemoryPressure?

  /// Hands memory back once the app has gone quiet, as Chromium does for a hidden renderer: a hint to
  /// collect the JS heap, then the system allocators' empty pages. Called when a window is destroyed
  /// and on memory pressure. Calls within the delay run it once, and nothing repeats afterwards, so an
  /// idle app gets no timer from it.
  func trimWhenIdle(after seconds: TimeInterval = 5) {
    perform { [self] in
      trimTimer?.invalidate()
      let timer = Timer(timeInterval: seconds, repeats: false) { [unowned self] _ in
        trimTimer = nil
        JSGarbageCollect(context.jsGlobalContextRef)
        io.async { malloc_zone_pressure_relief(nil, 0) }
      }
      timer.tolerance = 1
      RunLoop.current.add(timer, forMode: .default)
      trimTimer = timer
    }
  }

  /// Trims as soon as the system reports memory pressure.
  func trimOnMemoryPressure() {
    let source = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical], queue: io)
    source.setEventHandler { [weak self] in self?.trimWhenIdle(after: 0) }
    source.resume()
    pressureSource = source
  }

  // MARK: Errors and binary data

  /// Throws a JS Error with a Node-style `code` (for example "ENOENT") from inside a host function.
  static func throwError(_ message: String, code: String? = nil, errno: Int32? = nil, syscall: String? = nil, path: String? = nil) {
    guard let context = JSContext.current() else { return }
    context.exception = errorValue(HostError(message: message, code: code, errno: errno, syscall: syscall, path: path), in: context)
  }

  static func errorValue(_ error: HostError, in context: JSContext) -> JSValue {
    let value = JSValue(newErrorFromMessage: error.message, in: context)!
    if let code = error.code { value.setValue(code, forProperty: "code") }
    if let errno = error.errno { value.setValue(-Int(errno), forProperty: "errno") }
    if let syscall = error.syscall { value.setValue(syscall, forProperty: "syscall") }
    if let path = error.path { value.setValue(path, forProperty: "path") }
    return value
  }

  /// A Uint8Array that owns a copy of `data`.
  static func bytes(_ data: Data, in context: JSContext) -> JSValue {
    let count = data.count
    let pointer = malloc(max(count, 1))!
    data.withUnsafeBytes { raw in if count > 0 { memcpy(pointer, raw.baseAddress!, count) } }
    var exception: JSValueRef?
    let object = JSObjectMakeTypedArrayWithBytesNoCopy(context.jsGlobalContextRef, kJSTypedArrayTypeUint8Array, pointer, count,
                                                       { bytes, _ in free(bytes) }, nil, &exception)
    return JSValue(jsValueRef: object, in: context)
  }

  /// The bytes of a typed array, DataView-free ArrayBuffer, or a string (as UTF-8). Nil otherwise.
  static func data(of value: JSValue?) -> Data? {
    guard let value, !value.isUndefined, !value.isNull else { return nil }
    if value.isString { return value.toString().data(using: .utf8) }
    let context = value.context.jsGlobalContextRef
    let ref = value.jsValueRef
    let type = JSValueGetTypedArrayType(context, ref, nil)
    guard type != kJSTypedArrayTypeNone, let object = JSValueToObject(context, ref, nil) else { return nil }
    if type == kJSTypedArrayTypeArrayBuffer {
      let length = JSObjectGetArrayBufferByteLength(context, object, nil)
      guard length > 0, let pointer = JSObjectGetArrayBufferBytesPtr(context, object, nil) else { return Data() }
      return Data(bytes: pointer, count: length)
    }
    let length = JSObjectGetTypedArrayByteLength(context, object, nil)
    guard length > 0, let pointer = JSObjectGetTypedArrayBytesPtr(context, object, nil) else { return Data() }
    // The pointer is to the start of the underlying buffer; the view's own offset is added here.
    let offset = JSObjectGetTypedArrayByteOffset(context, object, nil)
    return Data(bytes: pointer.advanced(by: offset), count: length)
  }

  // MARK: Core host functions

  private func installCore() {
    let log: @convention(block) (String, String) -> Void = { level, message in
      FileHandle.standardError.write("[js:\(level)] \(message)\n".data(using: .utf8)!)
    }
    define("log", log)
    // Timers: tolerance lets macOS coalesce wakeups, which matters for idle CPU (priority 2).
    let setTimer: @convention(block) (Double, Bool, JSValue) -> Int = { [unowned self] ms, repeats, callback in
      let id = self.nextTimer; self.nextTimer += 1
      let interval = max(ms, 0) / 1000
      let timer = Timer(timeInterval: interval, repeats: repeats) { [weak self] _ in
        guard let self else { return }
        if !repeats { self.timers.removeValue(forKey: id) }
        callback.call(withArguments: [])
      }
      timer.tolerance = interval >= 1 ? interval * 0.1 : min(interval * 0.1, 0.01)
      self.timers[id] = timer
      self.runLoop.add(timer, forMode: .default)
      return id
    }
    define("setTimer", setTimer)
    let clearTimer: @convention(block) (Int) -> Void = { [unowned self] id in self.timers.removeValue(forKey: id)?.invalidate() }
    define("clearTimer", clearTimer)
    let utf8Encode: @convention(block) (String) -> JSValue = { text in JSRuntime.bytes(Data(text.utf8), in: JSContext.current()) }
    define("utf8Encode", utf8Encode)
    let utf8Decode: @convention(block) (JSValue) -> String = { value in
      let data = JSRuntime.data(of: value) ?? Data()
      return String(decoding: data, as: UTF8.self)
    }
    define("utf8Decode", utf8Decode)
    let base64Encode: @convention(block) (JSValue) -> String = { value in (JSRuntime.data(of: value) ?? Data()).base64EncodedString() }
    define("base64Encode", base64Encode)
    let base64Decode: @convention(block) (String) -> JSValue = { text in
      var normalized = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        .filter { !$0.isWhitespace }
      normalized = normalized.trimmingCharacters(in: CharacterSet(charactersIn: "="))
      while normalized.count % 4 != 0 { normalized += "=" }
      return JSRuntime.bytes(Data(base64Encoded: normalized) ?? Data(), in: JSContext.current())
    }
    define("base64Decode", base64Decode)
    let hrtime: @convention(block) () -> Double = { Double(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) }
    define("hrtime", hrtime)
    let now: @convention(block) () -> Double = { Date().timeIntervalSince1970 * 1000 }
    define("now", now)
    let environment: @convention(block) () -> [String: String] = { ProcessInfo.processInfo.environment }
    define("environment", environment)
    let cwd: @convention(block) () -> String = { FileManager.default.currentDirectoryPath }
    define("cwd", cwd)
    define("pid", Int(getpid()))
    define("arguments", CommandLine.arguments)
    let osVersion = ProcessInfo.processInfo.operatingSystemVersion
    define("systemVersion", "\(osVersion.majorVersion).\(osVersion.minorVersion).\(osVersion.patchVersion)")
    let kill: @convention(block) (Int, Int) -> Bool = { pid, signal in
      if Darwin.kill(pid_t(pid), Int32(signal)) == 0 { return true }
      JSRuntime.throwError(String(cString: strerror(errno)), code: errnoCode(errno), errno: errno, syscall: "kill")
      return false
    }
    define("kill", kill)
    let cpuUsage: @convention(block) () -> [String: Double] = {
      var usage = rusage(); getrusage(RUSAGE_SELF, &usage)
      return ["user": Double(usage.ru_utime.tv_sec) * 1e6 + Double(usage.ru_utime.tv_usec),
              "system": Double(usage.ru_stime.tv_sec) * 1e6 + Double(usage.ru_stime.tv_usec)]
    }
    define("cpuUsage", cpuUsage)
    let exit: @convention(block) (Int) -> Void = { code in Foundation.exit(Int32(code)) }
    define("exit", exit)
    let parseUrl: @convention(block) (String, JSValue) -> Any = { input, base in
      JSRuntime.parseURL(input, base: base.isString ? base.toString() : nil) ?? NSNull()
    }
    define("parseUrl", parseUrl)
  }

  /// WHATWG-shaped parts of an absolute URL ("https:", "?q", "#h"), resolving against `base`.
  /// Foundation parses (RFC 3986, percent-encoding what it does not accept); nil when invalid.
  static func parseURL(_ input: String, base: String?) -> [String: String]? {
    let resolved: URL?
    if let base {
      guard let baseURL = URL(string: base), baseURL.scheme != nil else { return nil }
      resolved = URL(string: input, relativeTo: baseURL)?.absoluteURL
    } else {
      resolved = URL(string: input)
    }
    guard let url = resolved, let scheme = url.scheme?.lowercased(),
          let parts = URLComponents(url: url, resolvingAgainstBaseURL: true) else { return nil }
    if let port = parts.port, port < 0 || port > 65535 { return nil }
    let special = ["http", "https", "ws", "wss", "ftp", "file"].contains(scheme)
    if special && scheme != "file" && (parts.percentEncodedHost ?? "").isEmpty { return nil }
    var path = parts.percentEncodedPath
    if special && path.isEmpty { path = "/" }
    if special { path = normalizeDots(path) }
    return [
      "protocol": "\(scheme):",
      "username": parts.percentEncodedUser ?? "",
      "password": parts.percentEncodedPassword ?? "",
      "hostname": special ? (parts.percentEncodedHost ?? "").lowercased() : (parts.percentEncodedHost ?? ""),
      "port": parts.port.map(String.init) ?? "",
      "pathname": path,
      "search": parts.percentEncodedQuery.map { "?\($0)" } ?? "",
      "hash": parts.percentEncodedFragment.map { "#\($0)" } ?? ""
    ]
  }

  /// Removes "." and ".." segments the way WHATWG does for special schemes.
  private static func normalizeDots(_ path: String) -> String {
    guard path.contains("/.") else { return path }
    var out: [Substring] = []
    let segments = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
    for (index, segment) in segments.enumerated() {
      let last = index == segments.count - 1
      if segment == "." || segment.lowercased() == "%2e" { if last { out.append("") }; continue }
      if segment == ".." || segment.lowercased() == ".%2e" || segment.lowercased() == "%2e." || segment.lowercased() == "%2e%2e" {
        if !out.isEmpty { out.removeLast() }
        if last { out.append("") }
        continue
      }
      out.append(segment)
    }
    return "/" + out.joined(separator: "/")
  }
}

/// An error a host operation reports to JS, with Node's fields.
struct HostError: Error {
  var message: String
  var code: String?
  var errno: Int32?
  var syscall: String?
  var path: String?

  static func posix(_ number: Int32 = Darwin.errno, _ syscall: String, _ path: String? = nil) -> HostError {
    let code = errnoCode(number)
    let base = "\(code): \(errnoMessage(number)), \(syscall)"
    return HostError(message: path.map { "\(base) '\($0)'" } ?? base, code: code, errno: number, syscall: syscall, path: path)
  }
}

/// libuv's wording for an errno (Node's messages), falling back to the system's in lower case.
func errnoMessage(_ number: Int32) -> String {
  switch number {
  case ENOENT: return "no such file or directory"
  case EEXIST: return "file already exists"
  case EACCES: return "permission denied"
  case EPERM: return "operation not permitted"
  case ENOTDIR: return "not a directory"
  case EISDIR: return "illegal operation on a directory"
  case ENOTEMPTY: return "directory not empty"
  case EBADF: return "bad file descriptor"
  case EINVAL: return "invalid argument"
  case EXDEV: return "cross-device link not permitted"
  case ENOSPC: return "no space left on device"
  case EMFILE: return "too many open files"
  case EBUSY: return "resource busy or locked"
  case ELOOP: return "too many symbolic links encountered"
  case ENAMETOOLONG: return "name too long"
  case EROFS: return "read-only file system"
  default:
    let text = String(cString: strerror(number))
    return text.prefix(1).lowercased() + text.dropFirst()
  }
}

/// Node's names for the errno values the app's code checks or might see.
func errnoCode(_ number: Int32) -> String {
  switch number {
  case ENOENT: return "ENOENT"
  case EEXIST: return "EEXIST"
  case EACCES: return "EACCES"
  case EPERM: return "EPERM"
  case ENOTDIR: return "ENOTDIR"
  case EISDIR: return "EISDIR"
  case ENOTEMPTY: return "ENOTEMPTY"
  case EBADF: return "EBADF"
  case EINVAL: return "EINVAL"
  case EXDEV: return "EXDEV"
  case ENOSPC: return "ENOSPC"
  case EMFILE: return "EMFILE"
  case EBUSY: return "EBUSY"
  case ESRCH: return "ESRCH"
  case EPIPE: return "EPIPE"
  case ELOOP: return "ELOOP"
  case ENAMETOOLONG: return "ENAMETOOLONG"
  case EROFS: return "EROFS"
  case EAGAIN: return "EAGAIN"
  case EINTR: return "EINTR"
  case EIO: return "EIO"
  case ECHILD: return "ECHILD"
  default: return "E\(number)"
  }
}
