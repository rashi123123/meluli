// Checks HostUpdater (native/host/app/Updater.swift) on small signed bundles that updater-check.mjs makes:
//   updater-check <folder>
// The folder holds Current.app (1.0.0) and the candidates; each candidate must pass or fail as named.
import Foundation
import Security

@main
struct UpdaterCheck {
  static func main() throws {
    let folder = URL(fileURLWithPath: CommandLine.arguments[1])
    let current = folder.appendingPathComponent("Current.app")
    var code: SecStaticCode?
    SecStaticCodeCreateWithPath(current as CFURL, [], &code)
    var requirement: SecRequirement?
    SecCodeCopyDesignatedRequirement(code!, [], &requirement)
    let identifier = Bundle(url: current)?.bundleIdentifier
    var requirementText: CFString?
    SecRequirementCopyString(requirement!, [], &requirementText)
    var results: [String: Any] = [:]
    func attempt(_ name: String, _ version: String) -> String {
      do { try HostUpdater.verify(folder.appendingPathComponent("\(name).app"), version: version, requirement: requirement, bundleIdentifier: identifier); return "accepted" }
      catch let error as UpdateError { return "refused: \(error.message)" } catch { return "refused: \(error)" }
    }
    results["good"] = attempt("Good", "1.0.1")
    results["wrongVersion"] = attempt("Good", "1.0.2")
    results["tampered"] = attempt("Tampered", "1.0.1")
    results["adHoc"] = attempt("AdHoc", "1.0.1")
    results["otherIdentifier"] = attempt("Other", "1.0.1")
    results["unsigned"] = attempt("Unsigned", "1.0.1")
    // The archive path: one app in, checked, kept; two apps refused.
    let unpackRoot = folder.appendingPathComponent("unpack")
    let check: (URL) throws -> Void = { try HostUpdater.verify($0, version: "1.0.1", requirement: requirement, bundleIdentifier: identifier) }
    do {
      let app = try HostUpdater.unpack(folder.appendingPathComponent("good.zip"), into: unpackRoot, check: check)
      results["unpackGood"] = app.lastPathComponent
      // The swap waits for a process to exit, then replaces the installed copy.
      let installed = folder.appendingPathComponent("Installed/Current.app")
      let waiter = Process()
      waiter.executableURL = URL(fileURLWithPath: "/bin/sleep")
      waiter.arguments = ["1"]
      try waiter.run()
      let started = Date()
      let shell = try HostUpdater.startSwap(current: installed, update: app, waitingFor: waiter.processIdentifier, relaunch: false,
                                            requirement: requirementText as String?)
      let versionDuring = Bundle(url: installed)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
      waiter.waitUntilExit()
      shell.waitUntilExit()
      // Bundle caches its Info.plist per path, so read the file itself.
      let plist = NSDictionary(contentsOf: installed.appendingPathComponent("Contents/Info.plist"))
      let leftovers = try FileManager.default.contentsOfDirectory(atPath: installed.deletingLastPathComponent().path)
      results["swap"] = ["versionWhileWaiting": versionDuring ?? "", "versionAfter": plist?["CFBundleShortVersionString"] ?? "", "exit": shell.terminationStatus,
                         "seconds": Date().timeIntervalSince(started), "folderAfter": leftovers.sorted(),
                         "updateFolderRemoved": !FileManager.default.fileExists(atPath: app.deletingLastPathComponent().deletingLastPathComponent().path)]
    } catch let error as UpdateError { results["unpackGood"] = "refused: \(error.message)" }
    // A staged copy changed while the swap waits is put back out, and the installed app stays.
    do {
      let installed = folder.appendingPathComponent("Installed2/Current.app")
      let staged = folder.appendingPathComponent("stage2/1.0.1/Good.app")
      try FileManager.default.createDirectory(at: staged.deletingLastPathComponent(), withIntermediateDirectories: true)
      try FileManager.default.copyItem(at: folder.appendingPathComponent("Good.app"), to: staged)
      let waiter = Process()
      waiter.executableURL = URL(fileURLWithPath: "/bin/sleep")
      waiter.arguments = ["1"]
      try waiter.run()
      let shell = try HostUpdater.startSwap(current: installed, update: staged, waitingFor: waiter.processIdentifier, relaunch: false,
                                            requirement: requirementText as String?)
      let binary = try FileHandle(forWritingTo: staged.appendingPathComponent("Contents/MacOS/hello"))
      try binary.seekToEnd()
      try binary.write(contentsOf: Data([0]))
      try binary.close()
      waiter.waitUntilExit()
      shell.waitUntilExit()
      let plist = NSDictionary(contentsOf: installed.appendingPathComponent("Contents/Info.plist"))
      let leftovers = try FileManager.default.contentsOfDirectory(atPath: installed.deletingLastPathComponent().path)
      results["swapTampered"] = ["versionAfter": plist?["CFBundleShortVersionString"] ?? "", "exit": shell.terminationStatus, "folderAfter": leftovers.sorted()]
    } catch { results["swapTampered"] = "error: \(error)" }
    do { _ = try HostUpdater.unpack(folder.appendingPathComponent("two.zip"), into: unpackRoot, check: check); results["unpackTwo"] = "accepted" }
    catch let error as UpdateError { results["unpackTwo"] = "refused: \(error.message)" }
    do { _ = try HostUpdater.unpack(folder.appendingPathComponent("tampered.zip"), into: unpackRoot, check: check); results["unpackTampered"] = "accepted" }
    catch let error as UpdateError { results["unpackTampered"] = "refused: \(error.message)" }
    results["hosts"] = ["https://github.com/a": HostUpdater.allowed(URL(string: "https://github.com/a")),
                        "http://github.com/a": HostUpdater.allowed(URL(string: "http://github.com/a")),
                        "https://evil.example/a": HostUpdater.allowed(URL(string: "https://evil.example/a")),
                        "https://u:p@github.com/a": HostUpdater.allowed(URL(string: "https://u:p@github.com/a")),
                        "https://github.com:8443/a": HostUpdater.allowed(URL(string: "https://github.com:8443/a"))]
    print(String(data: try JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!)
  }
}
