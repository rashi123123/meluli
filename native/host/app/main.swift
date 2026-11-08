// Meluli 2.0 (D20): the native app. AppKit owns the process; the app's unchanged main-process code
// runs in JavaScriptCore on its own thread over the Node and Electron surfaces, and opens its
// windows as WKWebViews. Layout inside the bundle:
//   Contents/Resources/app/out/main/index.js       the main-process bundle (bundle-native-host.mjs)
//   Contents/Resources/app/out/preload/index.cjs   the preload, for the renderer side
//   Contents/Resources/app/out/renderer/           the React UI
//   Contents/Resources/{bin,icons,licenses}        as electron-builder lays them out
import AppKit

signal(SIGPIPE, SIG_IGN)
setvbuf(stderr, nil, _IOLBF, 0)

let application = NSApplication.shared
application.delegate = HostAppDelegate.shared

let resources = Bundle.main.resourcePath ?? FileManager.default.currentDirectoryPath
let appRoot = URL(fileURLWithPath: resources).appendingPathComponent("app/out", isDirectory: true)
let mainScript = appRoot.appendingPathComponent("main/index.js")
RendererConfig.root = appRoot.appendingPathComponent("renderer", isDirectory: true)
let preloadScript = appRoot.appendingPathComponent("preload/index.cjs")
do { RendererConfig.preloadSource = try String(contentsOf: preloadScript, encoding: .utf8) }
catch { hostLog("[startup] cannot read \(preloadScript.path); the page runs without its bridge: \(error.localizedDescription)") }

// A development identity names its own profile in Info.plist, so a test build launched from
// Finder never opens the person's real history. The shipped app has no such key.
if getenv("MELULI_USER_DATA") == nil, let profile = Bundle.main.object(forInfoDictionaryKey: HostNames.developmentProfileKey) as? String {
  setenv("MELULI_USER_DATA", (profile as NSString).expandingTildeInPath, 1)
}

// MELULI_NATIVE_DIAGNOSTICS=<folder>: page errors and window snapshots, in development builds only.
if HostNames.isDevelopmentBuild, let folder = ProcessInfo.processInfo.environment["MELULI_NATIVE_DIAGNOSTICS"] {
  try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
  RendererConfig.diagnostics = URL(fileURLWithPath: folder, isDirectory: true)
  let environment = ProcessInfo.processInfo.environment
  // MELULI_NATIVE_PAGE_SCRIPT=<file>: an async function body run in the main window (page-script.json).
  if let path = environment["MELULI_NATIVE_PAGE_SCRIPT"] {
    do { RendererConfig.pageScript = try String(contentsOfFile: path, encoding: .utf8) }
    catch { hostLog("[diagnostics] cannot read the page script \(path): \(error.localizedDescription)") }
  }
  // MELULI_NATIVE_OPEN_PATHS: what open dialogs return, "|" between dialogs and ":" between files.
  if let value = environment["MELULI_NATIVE_OPEN_PATHS"] {
    RendererConfig.scriptedOpenPaths = value.split(separator: "|", omittingEmptySubsequences: false).map { $0.split(separator: ":").map(String.init) }
  }
  // MELULI_NATIVE_SAVE_PATHS: what save dialogs return, "|" between dialogs.
  if let value = environment["MELULI_NATIVE_SAVE_PATHS"] {
    RendererConfig.scriptedSavePaths = value.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
  }
  // MELULI_NATIVE_MENU_CHOICES: which item pop-up menus choose, by index, "|" between menus.
  if let value = environment["MELULI_NATIVE_MENU_CHOICES"] {
    RendererConfig.scriptedMenuChoices = value.split(separator: "|").map { Int($0) ?? -1 }
  }
}

// MELULI_NATIVE_LOG sends stderr (the host's and the app's console) to a file, for runs from Finder.
if let logPath = ProcessInfo.processInfo.environment["MELULI_NATIVE_LOG"] {
  let fd = open(logPath, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0o600)
  if fd >= 0 { dup2(fd, STDERR_FILENO); close(fd) }
}
func hostLog(_ line: String) { FileHandle.standardError.write(Data((line + "\n").utf8)) }

let runtime = JSRuntime()
let bridge = UIBridge(runtime: runtime)
let fetcher = HostFetch(runtime: runtime)
runtime.onUncaught = { message in hostLog("[uncaught] \(message)") }
runtime.trimOnMemoryPressure()
runtime.performAndWait {
  runtime.installNodeHost(fetcher: fetcher)
  HostSafeStorage.install(in: runtime)
  bridge.install()
  runtime.define("resourcesPath", resources)
  runtime.define("isPackaged", true)
  runtime.define("isDevelopmentBuild", HostNames.isDevelopmentBuild)
}
WindowController.install(bridge)
TrayItem.install(bridge)
HostShortcuts.install(bridge)
HostAppDelegate.install(bridge)
HostUpdater.install(bridge)

guard let source = try? String(contentsOf: mainScript, encoding: .utf8) else {
  hostLog("[startup] cannot read \(mainScript.path)")
  exit(66)
}
runtime.perform { runtime.evaluate(source, url: mainScript) }
application.run()
