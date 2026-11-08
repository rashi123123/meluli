import Foundation

/// Names the Swift host shares with the JS bundles and the build scripts. Each one's other side is
/// named beside it; neither side can import the other, so these are the one Swift copy.
enum HostNames {
  /// The main bundle's URL, a global in the JS context that `import.meta.url` reads
  /// (scripts/meluli2/bundle-native-host.mjs, src/native-host/electron/windows.ts).
  static let mainURLGlobal = "__meluliMainUrl"
  /// Pages load from meluli://app/<path> (PAGE_SCHEME and PAGE_HOST in src/native-host/electron/windows.ts).
  static let pageScheme = "meluli"
  static let pageHost = "app"
  /// Info.plist key only a development build carries: its own profile folder (scripts/meluli2/build-native-app.mjs;
  /// scripts/check-release-output.py refuses a release that has it).
  static let developmentProfileKey = "MeluliDefaultUserData"
  static var isDevelopmentBuild: Bool { Bundle.main.object(forInfoDictionaryKey: developmentProfileKey) != nil }

  // The page bridge (src/native-host/renderer/electron.ts, the PAGE_* constants at its top).
  /// The WKScriptMessageHandler a page posts to.
  static let pageMessageHandler = "meluliIpc"
  /// Page functions the host calls: an IPC message for the page, and files dropped on the window.
  static let pageReceive = "__meluliReceive"
  static let pageDragged = "__meluliDragged"
  /// The `kind` of a message a page posts.
  enum PageMessage: String { case invoke, send, regions }
}
