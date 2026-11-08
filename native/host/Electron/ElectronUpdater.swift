// The bridge operations for automatic updates (HostUpdater in native/host/app/Updater.swift), used by
// autoUpdater in native-host/electron/system.ts.
import Foundation

extension HostUpdater {
  static func install(_ bridge: UIBridge) {
    bridge.op("updaterUnavailableReason") { _ in unavailableReason() }
    bridge.asyncOp("updaterDownload") { args, reply in
      guard let text = args.first as? String, let url = URL(string: text), let version = args.dropFirst().first as? String else {
        return reply(["error": "Malformed update request"])
      }
      download(url, version: version) { result in
        switch result {
        case .success(let app): reply(["path": app.path])
        case .failure(let error): reply(["error": error.message])
        }
      }
    }
    bridge.op("updaterInstall") { args in
      guard let path = args.first as? String, let version = args.dropFirst().first as? String else { throw UIError(message: "Malformed install request") }
      do { try installAfterQuit(URL(fileURLWithPath: path), version: version) } catch let error as UpdateError { throw UIError(message: error.message) }
      return nil
    }
  }
}
