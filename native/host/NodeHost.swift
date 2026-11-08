import Foundation

extension JSRuntime {
  /// The Node-shaped host every runtime gets, the command-line one and the app's: files, processes,
  /// SQLite, crypto and fetch. Runs on the JS thread.
  func installNodeHost(fetcher: HostFetch) {
    HostFS.install(in: self)
    HostProcess.install(in: self)
    HostSQLite.install(in: self)
    HostCrypto.install(in: self)
    fetcher.install()
  }
}
