// Child processes for the Node `child_process` surface: the ASR worker, the Swift helpers, afconvert,
// osascript and yt-dlp. Output arrives as chunks on the JS thread. As in Node, "exit" comes when the
// process ends and "close" once it has ended and both output pipes are drained, so a listener on
// "close" has seen everything the child wrote.
import Foundation
import JavaScriptCore

final class HostProcess {
  private let process = Process()
  private let input = Pipe(), output = Pipe(), errors = Pipe()
  private let writes = DispatchQueue(label: "meluli.process.stdin")
  private var openStreams = 2
  private var exited: (code: Int32?, signal: Int32?)?
  private var inputClosed = false
  private let runtime: JSRuntime
  private let onEvent: JSValue

  private static var live: [Int: HostProcess] = [:]
  private static var nextId = 1

  private init(runtime: JSRuntime, onEvent: JSValue) {
    self.runtime = runtime
    self.onEvent = onEvent
  }

  static func install(in runtime: JSRuntime) {
    // spawn(path, args, { cwd, env, stdin, stdout, stderr }, onEvent) -> { id, pid }, or throws.
    let spawn: @convention(block) (String, [String], JSValue, JSValue) -> JSValue = { [unowned runtime] path, args, options, onEvent in
      let context = JSContext.current()!
      let child = HostProcess(runtime: runtime, onEvent: onEvent)
      let id = nextId; nextId += 1
      do {
        try child.start(path: path, args: args, options: options)
      } catch let error as HostError {
        context.exception = JSRuntime.errorValue(error, in: context)
        return JSValue(undefinedIn: context)
      } catch {
        JSRuntime.throwError("\(error)", code: "ENOENT", syscall: "spawn \(path)", path: path)
        return JSValue(undefinedIn: context)
      }
      live[id] = child
      return JSValue(object: ["id": id, "pid": Int(child.process.processIdentifier)], in: context)
    }
    runtime.define("spawn", spawn)
    let write: @convention(block) (Int, JSValue) -> Bool = { id, data in
      guard let child = live[id], !child.inputClosed, let bytes = JSRuntime.data(of: data) else { return false }
      child.writes.async {
        do { try child.input.fileHandleForWriting.write(contentsOf: bytes) }
        catch { child.runtime.perform { child.emit("stdinError", [String(describing: error)]) } }
      }
      return true
    }
    runtime.define("processWrite", write)
    let end: @convention(block) (Int) -> Void = { id in
      guard let child = live[id], !child.inputClosed else { return }
      child.inputClosed = true
      child.writes.async { try? child.input.fileHandleForWriting.close() }
    }
    runtime.define("processEndInput", end)
    let kill: @convention(block) (Int, Int) -> Bool = { id, signal in
      guard let child = live[id], child.exited == nil, child.process.isRunning else { return false }
      return Darwin.kill(child.process.processIdentifier, Int32(signal)) == 0
    }
    runtime.define("processKill", kill)
  }

  private func start(path: String, args: [String], options: JSValue) throws {
    guard access(path, X_OK) == 0 else { throw HostError.posix(errno, "spawn \(path)", path) }
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = args
    if let cwd = options.forProperty("cwd"), cwd.isString { process.currentDirectoryURL = URL(fileURLWithPath: cwd.toString()) }
    if let env = options.forProperty("env"), env.isObject, let values = env.toDictionary() as? [String: Any] {
      process.environment = values.compactMapValues { $0 is NSNull ? nil : "\($0)" }
    }
    // "ignore" goes to /dev/null; everything else is a pipe, as the app's helpers expect.
    func ignored(_ name: String) -> Bool { options.forProperty(name)?.toString() == "ignore" }
    process.standardInput = ignored("stdin") ? FileHandle.nullDevice : input
    if ignored("stdin") { inputClosed = true }
    if ignored("stdout") { process.standardOutput = FileHandle.nullDevice; openStreams -= 1 } else { process.standardOutput = output }
    if ignored("stderr") { process.standardError = FileHandle.nullDevice; openStreams -= 1 } else { process.standardError = errors }
    if !ignored("stdout") { read(output.fileHandleForReading, as: "stdout") }
    if !ignored("stderr") { read(errors.fileHandleForReading, as: "stderr") }
    process.terminationHandler = { [weak self] process in
      guard let self else { return }
      let signal = process.terminationReason == .uncaughtSignal ? process.terminationStatus : nil
      let code = process.terminationReason == .exit ? process.terminationStatus : nil
      self.runtime.perform {
        self.exited = (code, signal)
        self.emit("exit", [code.map { Int($0) } ?? NSNull(), signal.map { Int($0) } ?? NSNull()])
        self.finishIfDone()
      }
    }
    do { try process.run() }
    catch { throw HostError(message: "spawn \(path) \(error.localizedDescription)", code: "ENOENT", errno: ENOENT, syscall: "spawn \(path)", path: path) }
    // The parent's copies of the child's ends are not needed once it runs.
    try? output.fileHandleForWriting.close()
    try? errors.fileHandleForWriting.close()
    try? input.fileHandleForReading.close()
  }

  private func read(_ handle: FileHandle, as stream: String) {
    handle.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard let self else { return }
      if data.isEmpty {
        handle.readabilityHandler = nil
        self.runtime.perform { self.openStreams -= 1; self.emit("end", [stream]); self.finishIfDone() }
      } else {
        self.runtime.perform { self.emit(stream, [JSRuntime.bytes(data, in: self.runtime.context)]) }
      }
    }
  }

  private func finishIfDone() {
    guard openStreams == 0, let exited else { return }
    emit("close", [exited.code.map { Int($0) } ?? NSNull(), exited.signal.map { Int($0) } ?? NSNull()])
    // A linear search for our own id; a handful of children live at once, so it is not worth storing the id.
    if let id = HostProcess.live.first(where: { $0.value === self })?.key { HostProcess.live.removeValue(forKey: id) }
    if !inputClosed { inputClosed = true; writes.async { [input] in try? input.fileHandleForWriting.close() } }
  }

  private func emit(_ event: String, _ arguments: [Any]) {
    onEvent.call(withArguments: [event] + arguments)
  }
}
