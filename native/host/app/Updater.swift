// Automatic updates for the native app, in the place of Squirrel.Mac (autoUpdater in
// native-host/electron/system.ts; the bridge operations are in Electron/ElectronUpdater.swift).
// UpdateService reads the feed and refuses downgrades and foreign archives first; this side downloads
// the archive it names, and accepts the app inside only if its code signature satisfies the running
// app's own designated requirement (same signing team and bundle identifier, as Squirrel requires),
// with the bundle identifier and version it expects. The swap happens after the app quits, in a
// small detached shell that keeps the old bundle until the new one is in place.
import Foundation
import Security

struct UpdateError: Error { let message: String }

enum HostUpdater {
  private static let hosts: Set<String> = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]
  private static let maxArchiveBytes: Int64 = 1 << 30

  /// Nil when this copy can update itself; otherwise why not. Electron refuses a feed in an app it
  /// cannot verify, and UpdateService reports updates as off when setFeedURL throws.
  static func unavailableReason() -> String? {
    if HostNames.isDevelopmentBuild { return "Development builds do not update themselves" }
    guard ownRequirement() != nil else { return "This copy is not signed, so an update could not be verified" }
    guard teamIdentifier() != nil else { return "This copy has no signing team, so an update could not be verified" }
    return nil
  }

  // MARK: Signature

  /// The running app's own code on disk.
  private static func ownStaticCode() -> SecStaticCode? {
    var me: SecCode?
    guard SecCodeCopySelf([], &me) == errSecSuccess, let me else { return nil }
    var staticMe: SecStaticCode?
    guard SecCodeCopyStaticCode(me, [], &staticMe) == errSecSuccess else { return nil }
    return staticMe
  }

  static func ownRequirement() -> SecRequirement? {
    guard let staticMe = ownStaticCode() else { return nil }
    var requirement: SecRequirement?
    guard SecCodeCopyDesignatedRequirement(staticMe, [], &requirement) == errSecSuccess else { return nil }
    return requirement
  }

  private static func teamIdentifier() -> String? {
    guard let staticMe = ownStaticCode() else { return nil }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(staticMe, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let values = info as? [String: Any] else { return nil }
    return values[kSecCodeInfoTeamIdentifier as String] as? String
  }

  /// The app at `url` is signed to the running app's designated requirement, whole and unmodified,
  /// and carries this app's bundle identifier and the expected version.
  static func verify(_ url: URL, version: String) throws {
    try verify(url, version: version, requirement: ownRequirement(), bundleIdentifier: Bundle.main.bundleIdentifier)
  }

  static func verify(_ url: URL, version: String, requirement: SecRequirement?, bundleIdentifier: String?) throws {
    guard let requirement else { throw UpdateError(message: "This copy is not signed") }
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code else { throw UpdateError(message: "The update is not an app") }
    let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate | kSecCSCheckNestedCode)
    var failure: Unmanaged<CFError>?
    let status = SecStaticCodeCheckValidityWithErrors(code, flags, requirement, &failure)
    guard status == errSecSuccess else {
      let reason = failure?.takeRetainedValue().localizedDescription ?? "status \(status)"
      throw UpdateError(message: "The update's signature does not match this app: \(reason)")
    }
    guard let bundle = Bundle(url: url), bundle.bundleIdentifier == bundleIdentifier else {
      throw UpdateError(message: "The update is a different app")
    }
    guard bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String == version else {
      throw UpdateError(message: "The update is not version \(version)")
    }
  }

  // MARK: Download

  private final class Redirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
      completionHandler(HostUpdater.allowed(request.url) ? request : nil)
    }
  }

  static func allowed(_ url: URL?) -> Bool {
    guard let url, url.scheme == "https", let host = url.host, hosts.contains(host), url.user == nil, url.password == nil else { return false }
    return url.port == nil || url.port == 443
  }

  static var updatesFolder: URL {
    let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    return caches.appendingPathComponent(Bundle.main.bundleIdentifier ?? "Meluli").appendingPathComponent("updates")
  }

  static func download(_ url: URL, version: String, done: @escaping (Result<URL, UpdateError>) -> Void) {
    guard allowed(url) else { return done(.failure(UpdateError(message: "Untrusted update host"))) }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 60
    configuration.timeoutIntervalForResource = 30 * 60
    let session = URLSession(configuration: configuration, delegate: Redirects(), delegateQueue: nil)
    session.downloadTask(with: url) { file, response, error in
      session.finishTasksAndInvalidate()
      do {
        if let error { throw UpdateError(message: "The update could not be downloaded: \(error.localizedDescription)") }
        guard let file, let http = response as? HTTPURLResponse, http.statusCode == 200, allowed(http.url) else {
          throw UpdateError(message: "The update could not be downloaded")
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int64) ?? 0
        guard size > 0, size <= maxArchiveBytes else { throw UpdateError(message: "The update archive has an unexpected size") }
        done(.success(try unpack(file, check: { try verify($0, version: version) })))
      } catch let error as UpdateError {
        done(.failure(error))
      } catch {
        done(.failure(UpdateError(message: "\(error)")))
      }
    }.resume()
  }

  static func unpack(_ archive: URL, into root: URL = updatesFolder,
                     check: (URL) throws -> Void = { _ in }) throws -> URL {
    let fileManager = FileManager.default
    // One update at a time: anything older in the folder is a previous attempt.
    try? fileManager.removeItem(at: root)
    let folder = root.appendingPathComponent(UUID().uuidString)
    try fileManager.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let zip = folder.appendingPathComponent("update.zip")
    try fileManager.moveItem(at: archive, to: zip)
    let unpacked = folder.appendingPathComponent("unpacked")
    // ditto keeps the bundle's symlinks, permissions and extended attributes, as Squirrel does.
    let ditto = Process()
    ditto.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
    ditto.arguments = ["-x", "-k", zip.path, unpacked.path]
    try ditto.run()
    ditto.waitUntilExit()
    try? fileManager.removeItem(at: zip)
    guard ditto.terminationStatus == 0 else { throw UpdateError(message: "The update archive could not be opened") }
    let apps = (try fileManager.contentsOfDirectory(at: unpacked, includingPropertiesForKeys: nil)).filter { $0.pathExtension == "app" }
    guard apps.count == 1, let app = apps.first else { throw UpdateError(message: "The update archive does not hold one app") }
    try check(app)
    return app
  }

  // MARK: Install

  /// Checks the downloaded app again, then starts the swap, which waits for this process to exit.
  static func installAfterQuit(_ update: URL, version: String) throws {
    guard update.path.hasPrefix(updatesFolder.path + "/") else { throw UpdateError(message: "The update is not one this app downloaded") }
    try verify(update, version: version)
    // The staged copy sits in a folder this user's other programs can write to until the swap runs, so the
    // swap checks the moved copy against this requirement again before it opens it.
    var text: CFString?
    guard let requirement = ownRequirement(), SecRequirementCopyString(requirement, [], &text) == errSecSuccess, let text else {
      throw UpdateError(message: "This copy is not signed")
    }
    try startSwap(current: Bundle.main.bundleURL, update: update, waitingFor: ProcessInfo.processInfo.processIdentifier, relaunch: true,
                  requirement: text as String)
  }

  /// Replaces `current` with `update` once `pid` has exited, keeping the old bundle until the new one
  /// is in place and putting it back if the move fails. Returns the started shell.
  @discardableResult
  static func startSwap(current: URL, update: URL, waitingFor pid: Int32, relaunch: Bool, requirement: String? = nil) throws -> Process {
    let parent = current.deletingLastPathComponent()
    guard FileManager.default.isWritableFile(atPath: parent.path) else {
      throw UpdateError(message: "Meluli cannot replace itself in \(parent.path)")
    }
    let backup = parent.appendingPathComponent(".\(current.lastPathComponent).previous-\(pid)")
    // Positional arguments, so no path is ever parsed by the shell. Nothing signals the script when
    // the app exits, so it outlives it.
    let script = """
    pid="$1"; app="$2"; update="$3"; backup="$4"; folder="$5"; relaunch="$6"; requirement="$7"
    for i in $(seq 1 120); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$pid" 2>/dev/null && exit 1
    mv "$app" "$backup" || exit 1
    status=0
    if mv "$update" "$app"; then
      # A copy changed after the app checked it goes back out, and the old app comes back.
      if [ -n "$requirement" ] && ! /usr/bin/codesign --verify --strict --deep --test-requirement="=$requirement" "$app" 2>/dev/null; then
        rm -rf "$app" && mv "$backup" "$app"
        status=2
      else
        rm -rf "$backup"
      fi
      rm -rf "$folder"
    else
      mv "$backup" "$app"
    fi
    [ "$relaunch" = 1 ] && /usr/bin/open "$app"
    exit $status
    """
    let shell = Process()
    shell.executableURL = URL(fileURLWithPath: "/bin/sh")
    shell.arguments = ["-c", script, "meluli-update", String(pid), current.path, update.path, backup.path,
                       update.deletingLastPathComponent().deletingLastPathComponent().path, relaunch ? "1" : "0", requirement ?? ""]
    shell.standardInput = FileHandle.nullDevice
    shell.standardOutput = FileHandle.nullDevice
    shell.standardError = FileHandle.nullDevice
    try shell.run()
    return shell
  }
}
