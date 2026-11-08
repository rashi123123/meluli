// BrowserWindow for the Electron surface (D20): an NSWindow or NSPanel holding a WKWebView that
// shows the app's renderer from out/renderer over meluli://app/. Window state lives here, on the
// main thread; the JS BrowserWindow objects drive it through UIBridge operations and hear about
// what the person did (close, move, focus) through "window" events.
import AppKit
import WebKit

enum RendererConfig {
  /// out/renderer inside the bundle. Set once at startup.
  static var root = URL(fileURLWithPath: "/nonexistent")
  /// The preload bundle injected into every page before its own scripts.
  static var preloadSource = ""
  /// Renderer messages beyond this are refused. A 20-minute recording at 48 kHz is ~300 MB of base64.
  static let maxMessageBytes = 512 * 1_048_576
  /// Development builds only (main.swift): each page's errors and a snapshot of every window are
  /// written here after it loads and when it is shown, for checks that need no screen recording.
  static var diagnostics: URL?
  /// Development builds with diagnostics only: an async function body run once in the main window
  /// after it loads, its result written to page-script.json. Drives IPC flows the way the UI would.
  static var pageScript: String?
  /// Development builds with diagnostics only: what the next open dialogs return, in order, instead
  /// of showing a panel. Lets a page script import a disposable fixture file.
  static var scriptedOpenPaths: [[String]] = []
  /// The same for save dialogs: the path each one returns, "" for a cancel.
  static var scriptedSavePaths: [String] = []
  /// The same for pop-up menus: the index of the item each one chooses, -1 for none.
  static var scriptedMenuChoices: [Int] = []
}

/// Collects the page's errors and console warnings for the diagnostics folder.
private let diagnosticsScript = """
(() => {
  const log = [];
  Object.defineProperty(window, "__meluliDiagnostics", { value: log });
  const keep = (kind, text) => { if (log.length < 200) log.push(kind + ": " + text); };
  addEventListener("error", (event) => keep("error", `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`));
  addEventListener("unhandledrejection", (event) => keep("rejection", String(event.reason?.stack ?? event.reason)));
  for (const level of ["error", "warn"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => { keep(level, args.map((value) => value instanceof Error ? value.stack : typeof value === "object" ? JSON.stringify(value) : String(value)).join(" ")); original(...args); };
  }
})();
"""

/// Serves only files inside out/renderer, read-only, at meluli://app/<path>.
final class RendererFiles: NSObject, WKURLSchemeHandler {
  static let shared = RendererFiles()
  static let types = ["html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
                      "css": "text/css; charset=utf-8", "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                      "webp": "image/webp", "gif": "image/gif", "woff2": "font/woff2", "woff": "font/woff", "ttf": "font/ttf", "otf": "font/otf",
                      "json": "application/json", "wasm": "application/wasm", "mp3": "audio/mpeg", "wav": "audio/wav", "m4a": "audio/mp4",
                      "ogg": "audio/ogg", "ico": "image/x-icon", "txt": "text/plain; charset=utf-8", "map": "application/json"]

  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url, url.host == HostNames.pageHost else { return task.didFailWithError(URLError(.badURL)) }
    let root = RendererConfig.root.standardizedFileURL
    let relative = url.path.isEmpty || url.path == "/" ? "index.html" : String(url.path.dropFirst())
    let file = root.appendingPathComponent(relative).standardizedFileURL.resolvingSymlinksInPath()
    guard file.path.hasPrefix(root.resolvingSymlinksInPath().path + "/"), let data = FileManager.default.contents(atPath: file.path) else {
      let response = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": "0"])!
      task.didReceive(response); task.didFinish(); return
    }
    let type = RendererFiles.types[file.pathExtension.lowercased()] ?? "application/octet-stream"
    let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                   headerFields: ["Content-Type": type, "Content-Length": String(data.count), "Cache-Control": "no-store"])!
    task.didReceive(response); task.didReceive(data); task.didFinish()
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

/// The parts of a window AppKit asks about that depend on the Electron options.
protocol HostWindowBehavior: AnyObject {
  var focusable: Bool { get }
  func handleDrag(_ event: NSEvent) -> Bool
}

final class HostNSWindow: NSWindow {
  weak var behavior: HostWindowBehavior?
  override var canBecomeKey: Bool { behavior?.focusable ?? true }
  override var canBecomeMain: Bool { behavior?.focusable ?? true }
  override func sendEvent(_ event: NSEvent) {
    if event.type == .leftMouseDown, behavior?.handleDrag(event) == true { return }
    super.sendEvent(event)
  }
}

final class HostNSPanel: NSPanel {
  weak var behavior: HostWindowBehavior?
  override var canBecomeKey: Bool { behavior?.focusable ?? false }
  override var canBecomeMain: Bool { false }
  override func sendEvent(_ event: NSEvent) {
    if event.type == .leftMouseDown, behavior?.handleDrag(event) == true { return }
    super.sendEvent(event)
  }
}

final class HostWebView: WKWebView {
  var firstMouse = false
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { firstMouse || super.acceptsFirstMouse(for: event) }

  /// WebKit gives a page dropped files without their paths, and the import needs the path, as Electron's
  /// webUtils.getPathForFile gives it. When files are dragged over the app's own page, the page learns
  /// the path, name, size and modification time of each regular file in the drag, before the drop
  /// arrives; webUtils (native-host/renderer/electron.ts) matches the dropped File against that list.
  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
    shareDraggedFiles(sender)
    return super.draggingEntered(sender)
  }

  private func shareDraggedFiles(_ sender: NSDraggingInfo) {
    guard url?.scheme == HostNames.pageScheme, url?.host == HostNames.pageHost else { return }
    let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
    let files: [[String: Any]] = urls.prefix(64).compactMap { url in
      let keys: Set<URLResourceKey> = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]
      guard let values = try? url.resourceValues(forKeys: keys), values.isRegularFile == true else { return nil }
      return ["path": url.path, "name": url.lastPathComponent, "size": values.fileSize ?? 0,
              "lastModified": ((values.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000).rounded(.down)]
    }
    callAsyncJavaScript("window.\(HostNames.pageDragged)?.(files)", arguments: ["files": files], in: nil, in: .page, completionHandler: nil)
  }
}

final class WindowController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply, HostWindowBehavior {
  static var live: [Int: WindowController] = [:]
  private static var nextReply = 1
  private static var nextPermission = 1
  private static var permissions: [Int: (WKPermissionDecision) -> Void] = [:]
  /// One store for every window, as Electron's default session: localStorage is shared between
  /// the main window and the floating one, and persists under the app's own bundle identity.
  private static let dataStore = WKWebsiteDataStore.default()

  let id: Int
  let window: NSWindow
  private(set) var webView: HostWebView?
  let focusable: Bool
  private let isPanel: Bool
  private var trafficLights: NSPoint?
  private var movingProgrammatically = false
  private var shownOnce = false
  private var replies: [Int: (Any?, String?) -> Void] = [:]
  /// This window's microphone requests, so the ones still waiting are denied when it goes.
  private var permissionRequests = Set<Int>()
  private var dragRegions: [NSRect] = []
  private var noDragRegions: [NSRect] = []
  private var destroyed = false

  /// Reads only the keys JS forwards (WINDOW_OPTION_KEYS in src/native-host/electron/windows.ts); a new key goes in both.
  init(id: Int, options: [String: Any]) {
    self.id = id
    let frameless = options.bool("frame") == false
    isPanel = options.string("type") == "panel"
    focusable = options.bool("focusable") ?? true
    let width = options.number("width") ?? 800, height = options.number("height") ?? 600
    var style: NSWindow.StyleMask = frameless ? [.borderless] : [.titled, .closable]
    if !frameless {
      if options.bool("minimizable") ?? true { style.insert(.miniaturizable) }
      if options.bool("resizable") ?? true { style.insert(.resizable) }
      if options.string("titleBarStyle").map({ $0 != "default" }) ?? false { style.insert(.fullSizeContentView) }
    } else if options.bool("resizable") ?? false { style.insert(.resizable) }
    if isPanel { style.insert(.nonactivatingPanel) }
    let rect = NSRect(x: 0, y: 0, width: width, height: height)
    if isPanel {
      let panel = HostNSPanel(contentRect: rect, styleMask: style, backing: .buffered, defer: true)
      panel.hidesOnDeactivate = false
      panel.becomesKeyOnlyIfNeeded = false
      panel.isFloatingPanel = false
      window = panel
    } else {
      window = HostNSWindow(contentRect: rect, styleMask: style, backing: .buffered, defer: true)
    }
    super.init()
    (window as? HostNSWindow)?.behavior = self
    (window as? HostNSPanel)?.behavior = self
    window.isReleasedWhenClosed = false
    window.isRestorable = false
    window.delegate = self
    window.title = options.string("title") ?? ProcessInfo.processInfo.processName
    if let style = options.string("titleBarStyle"), style != "default", !frameless {
      window.titlebarAppearsTransparent = true
      window.titleVisibility = .hidden
    }
    if let position = options.dict("trafficLightPosition") {
      trafficLights = NSPoint(x: position.number("x") ?? 0, y: position.number("y") ?? 0)
    }
    if options.bool("maximizable") == false { window.standardWindowButton(.zoomButton)?.isEnabled = false }
    if options.bool("fullscreenable") == false { window.collectionBehavior.insert(.fullScreenNone) }
    if options.bool("movable") == false { window.isMovable = false }
    window.hasShadow = options.bool("hasShadow") ?? true
    if options.bool("hiddenInMissionControl") == true { window.collectionBehavior.formUnion([.transient, .ignoresCycle]) }
    if options.bool("skipTaskbar") == true { window.isExcludedFromWindowsMenu = true }
    if let min = options.number("minWidth"), let minHeight = options.number("minHeight") { window.contentMinSize = NSSize(width: min, height: minHeight) }
    let transparent = options.bool("transparent") == true
    if transparent { window.isOpaque = false; window.backgroundColor = .clear }
    else if let color = NSColor.electron(options.string("backgroundColor")) { window.backgroundColor = color }

    let configuration = WKWebViewConfiguration()
    configuration.setURLSchemeHandler(RendererFiles.shared, forURLScheme: HostNames.pageScheme)
    configuration.websiteDataStore = WindowController.dataStore
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    configuration.preferences.isElementFullscreenEnabled = false
    // Electron's autoplayPolicy "no-user-gesture-required": a shortcut starts dictation with sounds.
    configuration.mediaTypesRequiringUserActionForPlayback = []
    if RendererConfig.diagnostics != nil {
      configuration.userContentController.addUserScript(WKUserScript(source: diagnosticsScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    configuration.userContentController.addUserScript(WKUserScript(source: RendererConfig.preloadSource, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let web = HostWebView(frame: rect, configuration: configuration)
    web.firstMouse = options.bool("acceptFirstMouse") == true
    web.navigationDelegate = self
    web.uiDelegate = self
    web.allowsMagnification = false
    web.allowsBackForwardNavigationGestures = false
    if transparent || options.string("backgroundColor") != nil { web.setValue(false, forKey: "drawsBackground") }
    web.autoresizingMask = [.width, .height]
    // WebKit treats a page in a window that other windows cover as hidden, and holds its microphone
    // request until it shows (MEASURED: getUserMedia waited past 20 s with the window behind others).
    // Chromium does not, so dictation started from a covered window would stall here and not in
    // Electron. Hiding or closing a window still hides its page.
    if web.responds(to: NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")) {
      web.setValue(false, forKey: "windowOcclusionDetectionEnabled")
    }
    #if DEBUG
    web.isInspectable = true
    #endif
    configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: HostNames.pageMessageHandler)
    window.contentView = web
    webView = web

    if let x = options.number("x"), let y = options.number("y") {
      window.setFrame(ScreenSpace.frame(x: x, y: y, width: width, height: height), display: false)
    } else {
      // Centred on the screen the pointer is on, so a window never opens unseen on another display.
      let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main
      if let visible = screen?.visibleFrame {
        window.setFrameOrigin(NSPoint(x: (visible.midX - window.frame.width / 2).rounded(), y: (visible.midY - window.frame.height / 2).rounded()))
      }
    }
    layoutTrafficLights()
    WindowController.live[id] = self
  }

  private func emit(_ type: String, _ extra: [String: Any] = [:]) {
    var payload = extra
    payload["id"] = id
    payload["type"] = type
    UIBridge.shared.emit("window", payload)
  }

  // MARK: Operations

  func load(_ path: String, query: String) {
    var components = URLComponents()
    components.scheme = HostNames.pageScheme
    components.host = HostNames.pageHost
    components.path = "/" + path
    components.percentEncodedQuery = query.isEmpty ? nil : query
    guard let url = components.url else { return }
    webView?.load(URLRequest(url: url))
  }

  private var diagnosticsCount = 0
  /// Writes window-<id>-<n>.png and .json (URL, title, visible text, page errors) to the diagnostics folder.
  func writeDiagnostics(after delay: Double, reason: String) {
    guard let folder = RendererConfig.diagnostics else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self, let webView = self.webView else { return }
      self.diagnosticsCount += 1
      let base = folder.appendingPathComponent("window-\(self.id)-\(self.diagnosticsCount)")
      let script = "JSON.stringify({ url: location.href, title: document.title, dir: document.documentElement.dir, text: (document.body?.innerText ?? '').slice(0, 4000), errors: window.__meluliDiagnostics ?? [] })"
      webView.evaluateJavaScript(script) { result, error in
        let info: [String: Any] = ["reason": reason, "visible": self.window.isVisible, "frame": ScreenSpace.rect(self.window.frame),
                                   "page": (result as? String) ?? "", "error": error.map { "\($0)" } ?? ""]
        if let data = try? JSONSerialization.data(withJSONObject: info, options: [.prettyPrinted, .sortedKeys]) {
          try? data.write(to: base.appendingPathExtension("json"))
        }
      }
      webView.takeSnapshot(with: nil) { image, _ in
        guard let image, let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else { return }
        try? png.write(to: base.appendingPathExtension("png"))
      }
    }
  }

  private func runPageScript(in webView: WKWebView) {
    guard let folder = RendererConfig.diagnostics, let body = RendererConfig.pageScript,
          webView.url?.query?.contains("window=main") == true else { return }
    RendererConfig.pageScript = nil
    let started = Date()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
      guard let self else { return }
      webView.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { result in
        var info: [String: Any] = ["seconds": Date().timeIntervalSince(started)]
        switch result {
        case .success(let value): info["result"] = value
        case .failure(let error): info["error"] = "\(error)"
        }
        let data = (try? JSONSerialization.data(withJSONObject: info, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed]))
          ?? Data("{\"error\":\"result is not JSON\"}".utf8)
        try? data.write(to: folder.appendingPathComponent("page-script.json"))
        // A script that returns { closeWindow: true } closes the window as its close button would.
        if case .success(let value) = result, (value as? [String: Any])?["closeWindow"] as? Bool == true { self.window.performClose(nil) }
      }
    }
  }

  func show(activate: Bool) {
    writeDiagnostics(after: 1.2, reason: activate ? "show" : "showInactive")
    if window.isMiniaturized { window.deminiaturize(nil) }
    if activate { focus() } else { window.orderFrontRegardless() }
  }

  /// Panels take key focus without activating the app, so the app the user is typing in stays frontmost.
  func focus() {
    if !isPanel { NSApp.activateHost() }
    window.makeKeyAndOrderFront(nil)
  }

  func send(_ channel: String, _ json: String) {
    webView?.callAsyncJavaScript("window.\(HostNames.pageReceive)?.(channel, payload)", arguments: ["channel": channel, "payload": json], in: nil, in: .page) { _ in }
  }

  func reply(_ replyId: Int, ok: Bool, value: String) {
    guard let reply = replies.removeValue(forKey: replyId) else { return }
    if ok { reply(value, nil) } else { reply(nil, value) }
  }

  func setBounds(_ frame: NSRect, animate: Bool) {
    movingProgrammatically = true
    window.setFrame(frame, display: true, animate: animate)
    movingProgrammatically = false
  }

  func destroy() {
    guard !destroyed else { return }
    destroyed = true
    for (_, reply) in replies { reply(nil, "Object has been destroyed") }
    replies.removeAll()
    for request in permissionRequests { WindowController.answerPermission(request, allowed: false) }
    permissionRequests.removeAll()
    if let webView {
      webView.stopLoading()
      webView.configuration.userContentController.removeAllScriptMessageHandlers()
      webView.configuration.userContentController.removeAllUserScripts()
      webView.navigationDelegate = nil
      webView.uiDelegate = nil
      webView.removeFromSuperview()
    }
    webView = nil
    window.delegate = nil
    window.orderOut(nil)
    window.contentView = nil
    window.close()
    WindowController.live.removeValue(forKey: id)
    // The JS heap and the allocators keep what the page's IPC used until asked to give it back.
    hostLog("[window] \(id) destroyed, \(WindowController.live.count) left")
    JSRuntime.shared?.trimWhenIdle()
  }

  // MARK: Traffic lights (titleBarStyle with trafficLightPosition)

  /// Places the window buttons `trafficLights` from the top-left, as Electron does: the title bar
  /// container grows to fit the offset and the buttons keep their own spacing.
  private func layoutTrafficLights() {
    guard let position = trafficLights, let close = window.standardWindowButton(.closeButton),
          let mini = window.standardWindowButton(.miniaturizeButton), let zoom = window.standardWindowButton(.zoomButton),
          let container = close.superview?.superview else { return }
    let buttonHeight = close.frame.height
    let barHeight = buttonHeight + position.y * 2
    var frame = container.frame
    frame.size.height = barHeight
    frame.origin.y = window.frame.height - barHeight
    container.frame = frame
    let spacing = mini.frame.minX - close.frame.maxX
    for (index, button) in [close, mini, zoom].enumerated() {
      button.setFrameOrigin(NSPoint(x: position.x + CGFloat(index) * (button.frame.width + spacing), y: (barHeight - buttonHeight) / 2))
    }
  }

  // MARK: Drag regions (the renderer's -webkit-app-region, reported by the preload)

  func setRegions(drag: [Any], noDrag: [Any]) {
    func rects(_ list: [Any]) -> [NSRect] {
      list.compactMap { item in
        guard let values = item as? [NSNumber], values.count == 4 else { return nil }
        return NSRect(x: values[0].doubleValue, y: values[1].doubleValue, width: values[2].doubleValue, height: values[3].doubleValue)
      }
    }
    dragRegions = rects(drag)
    noDragRegions = rects(noDrag)
  }

  func handleDrag(_ event: NSEvent) -> Bool {
    guard !dragRegions.isEmpty, window.isMovable, let webView, event.clickCount == 1 else { return false }
    let local = webView.convert(event.locationInWindow, from: nil)
    // Page coordinates run from the top-left.
    let point = NSPoint(x: local.x, y: webView.isFlipped ? local.y : webView.bounds.height - local.y)
    guard dragRegions.contains(where: { $0.contains(point) }), !noDragRegions.contains(where: { $0.contains(point) }) else { return false }
    window.performDrag(with: event)
    return true
  }

  // MARK: NSWindowDelegate

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    // The JS side decides, as Electron's "close" event does; it destroys the window if nothing prevents it.
    emit("close-request")
    return false
  }

  func windowDidBecomeKey(_ notification: Notification) { emit("focus") }
  func windowDidResignKey(_ notification: Notification) { emit("blur") }
  func windowWillMove(_ notification: Notification) { if !movingProgrammatically { emit("will-move") } }
  func windowDidMove(_ notification: Notification) {
    if !movingProgrammatically { emit("move"); emit("moved") }
  }
  func windowDidResize(_ notification: Notification) {
    layoutTrafficLights()
    if !movingProgrammatically { emit("resize") }
  }
  func windowDidEndLiveResize(_ notification: Notification) { emit("resized") }
  func windowDidMiniaturize(_ notification: Notification) { emit("minimize") }
  func windowDidDeminiaturize(_ notification: Notification) { emit("restore") }
  func windowDidExitFullScreen(_ notification: Notification) { layoutTrafficLights() }

  // MARK: Navigation

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    // Only the app's own pages, in the main frame. Links never navigate the window.
    let url = action.request.url
    let allowed = url?.scheme == HostNames.pageScheme && url?.host == HostNames.pageHost && (action.targetFrame?.isMainFrame ?? false)
      && (action.navigationType == .other || action.navigationType == .reload)
    decisionHandler(allowed ? .allow : .cancel)
  }

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { emit("did-start-loading") }

  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    // A reload replaces the page, so calls the old one is waiting on would otherwise stay stored.
    for (_, reply) in replies { reply(nil, "The page was reloaded") }
    replies.removeAll()
    emit("did-navigate", ["url": webView.url?.absoluteString ?? ""])
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    emit("did-finish-load", ["url": webView.url?.absoluteString ?? ""])
    writeDiagnostics(after: 2, reason: "did-finish-load")
    runPageScript(in: webView)
    if !shownOnce {
      shownOnce = true
      // After the first frame is on screen, as Electron's ready-to-show.
      DispatchQueue.main.async { [weak self] in self?.emit("ready-to-show") }
    }
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    emit("did-fail-load", ["message": error.localizedDescription, "code": (error as NSError).code])
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    emit("did-fail-load", ["message": error.localizedDescription, "code": (error as NSError).code])
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    for (_, reply) in replies { reply(nil, "Render process gone") }
    replies.removeAll()
    emit("render-process-gone", ["reason": "crashed"])
    // WebKit also ends a page under memory pressure. A blank floating window helps no one, so the
    // page comes back; the app hears the loss first, as with Electron, and the page re-reads state.
    webView.reload()
  }

  // MARK: UI delegate

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
               windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

  /// The page's microphone, decided by the app's session permission handler (security.ts).
  func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
               type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    guard type == .microphone, origin.protocol == HostNames.pageScheme, origin.host == HostNames.pageHost else { return decisionHandler(.deny) }
    let request = WindowController.nextPermission
    WindowController.nextPermission += 1
    WindowController.permissions[request] = decisionHandler
    permissionRequests.insert(request)
    emit("permission-request", ["request": request, "permission": "media", "mediaTypes": ["audio"],
                                "requestingUrl": frame.request.url?.absoluteString ?? "", "mainFrame": frame.isMainFrame])
  }

  static func answerPermission(_ request: Int, allowed: Bool) {
    for controller in live.values { controller.permissionRequests.remove(request) }
    permissions.removeValue(forKey: request)?(allowed ? .grant : .deny)
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    completionHandler()
  }

  // MARK: Messages from the preload

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                             replyHandler: @escaping (Any?, String?) -> Void) {
    guard let body = message.body as? [String: Any], let name = body.string("kind") else { return replyHandler(nil, "Malformed message") }
    guard let kind = HostNames.PageMessage(rawValue: name) else { return replyHandler(nil, "Unknown message") }
    switch kind {
    case .invoke, .send:
      guard let channel = body.string("channel"), let payload = body.string("payload") else { return replyHandler(nil, "Malformed message") }
      guard payload.utf8.count <= RendererConfig.maxMessageBytes else { return replyHandler(nil, "Message too large") }
      var reply = 0
      if kind == .invoke {
        reply = WindowController.nextReply
        WindowController.nextReply += 1
        replies[reply] = replyHandler
      } else {
        replyHandler(nil, nil)
      }
      emit("ipc", ["channel": channel, "payload": payload, "reply": reply,
                   "frameUrl": message.frameInfo.request.url?.absoluteString ?? "", "mainFrame": message.frameInfo.isMainFrame])
    case .regions:
      setRegions(drag: (body["drag"] as? [Any]) ?? [], noDrag: (body["noDrag"] as? [Any]) ?? [])
      replyHandler(nil, nil)
    }
  }

  // MARK: Bridge operations

  static func install(_ bridge: UIBridge) {
    func controller(_ args: [Any]) throws -> WindowController {
      guard let id = args.int(0), let controller = live[id] else { throw UIError(message: "Object has been destroyed") }
      return controller
    }
    bridge.op("windowCreate") { args in
      guard let id = args.int(0) else { throw UIError(message: "windowCreate needs an id") }
      _ = WindowController(id: id, options: args.dict(1))
      return nil
    }
    bridge.op("windowLoad") { args in try controller(args).load(args.string(1) ?? "index.html", query: args.string(2) ?? ""); return nil }
    bridge.op("windowShow") { args in try controller(args).show(activate: true); return nil }
    bridge.op("windowShowInactive") { args in try controller(args).show(activate: false); return nil }
    bridge.op("windowFocus") { args in try controller(args).focus(); return nil }
    bridge.op("windowHide") { args in try controller(args).window.orderOut(nil); return nil }
    bridge.op("windowDestroy") { args in live[args.int(0) ?? -1]?.destroy(); return nil }
    bridge.op("windowIsVisible") { args in try controller(args).window.isVisible }
    bridge.op("windowIsMinimized") { args in try controller(args).window.isMiniaturized }
    bridge.op("windowIsFocused") { args in try controller(args).window.isKeyWindow }
    bridge.op("windowRestore") { args in try controller(args).window.deminiaturize(nil); return nil }
    bridge.op("windowMinimize") { args in try controller(args).window.miniaturize(nil); return nil }
    bridge.op("windowGetBounds") { args in ScreenSpace.rect(try controller(args).window.frame) }
    bridge.op("windowGetContentBounds") { args in
      let window = try controller(args).window
      return ScreenSpace.rect(window.contentRect(forFrameRect: window.frame))
    }
    bridge.op("windowSetBounds") { args in
      let window = try controller(args)
      window.setBounds(ScreenSpace.frame(args.dict(1), current: window.window.frame), animate: args.bool(2) ?? false)
      return nil
    }
    bridge.op("windowSetBackgroundColor") { args in
      let window = try controller(args)
      if let color = NSColor.electron(args.string(1)) {
        window.window.backgroundColor = color
        if color.alphaComponent < 1 { window.window.isOpaque = false }
      }
      return nil
    }
    bridge.op("windowSetVisibleOnAllWorkspaces") { args in
      let window = try controller(args).window
      if args.bool(1) == true {
        window.collectionBehavior.insert(.canJoinAllSpaces)
        if args.dict(2).bool("visibleOnFullScreen") == true { window.collectionBehavior.insert(.fullScreenAuxiliary) }
      } else {
        window.collectionBehavior.remove([.canJoinAllSpaces, .fullScreenAuxiliary])
      }
      return nil
    }
    bridge.op("windowSetAlwaysOnTop") { args in
      let window = try controller(args).window
      guard args.bool(1) == true else { window.level = .normal; return nil }
      let levels: [String: NSWindow.Level] = ["normal": .normal, "floating": .floating, "torn-off-menu": .tornOffMenu, "modal-panel": .modalPanel,
                                              "main-menu": .mainMenu, "status": .statusBar, "pop-up-menu": .popUpMenu, "screen-saver": .screenSaver]
      window.level = levels[args.string(2) ?? "floating"] ?? .floating
      return nil
    }
    bridge.op("windowSetFullScreenable") { args in
      let window = try controller(args).window
      if args.bool(1) == true { window.collectionBehavior.remove(.fullScreenNone) } else { window.collectionBehavior.insert(.fullScreenNone) }
      return nil
    }
    bridge.op("windowSetTitle") { args in try controller(args).window.title = args.string(1) ?? ""; return nil }
    bridge.op("windowSend") { args in try controller(args).send(args.string(1) ?? "", args.string(2) ?? "null"); return nil }
    bridge.op("ipcReply") { args in
      live[args.int(0) ?? -1]?.reply(args.int(1) ?? 0, ok: args.bool(2) ?? false, value: args.string(3) ?? "null")
      return nil
    }
    bridge.op("permissionReply") { args in answerPermission(args.int(0) ?? 0, allowed: args.bool(1) ?? false); return nil }
    bridge.op("focusedWindow") { _ in
      guard NSApp.isActive || NSApp.keyWindow is HostNSPanel, let key = NSApp.keyWindow else { return NSNull() }
      return live.first { $0.value.window === key }?.key ?? NSNull()
    }
  }
}
