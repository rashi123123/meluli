// The app-level parts of the Electron surface (D20): lifecycle, paths, dock, login item, shell,
// clipboard, system preferences, power and theme events, screens, notifications, dialogs and
// safeStorage. Events go to JS as "app", "power", "screen", "theme" and "notification".
import AppKit
import AVFoundation
import CommonCrypto
import JavaScriptCore
import Security
import ServiceManagement
import UniformTypeIdentifiers
import UserNotifications

final class HostAppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  static let shared = HostAppDelegate()
  private var displays: [Int: [String: Any]] = [:]
  private var appearanceObservation: NSKeyValueObservation?

  func applicationWillFinishLaunching(_ notification: Notification) {
    installMainMenu()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    displays = HostAppDelegate.currentDisplays()
    let workspace = NSWorkspace.shared.notificationCenter
    workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { _ in UIBridge.shared.emit("power", "suspend") }
    workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in UIBridge.shared.emit("power", "resume") }
    workspace.addObserver(forName: NSWorkspace.willPowerOffNotification, object: nil, queue: .main) { [weak self] _ in
      self?.powerOffPending = true
      UIBridge.shared.emit("power", "shutdown")
    }
    workspace.addObserver(forName: NSWorkspace.sessionDidResignActiveNotification, object: nil, queue: .main) { _ in UIBridge.shared.emit("power", "lock-screen") }
    workspace.addObserver(forName: NSWorkspace.sessionDidBecomeActiveNotification, object: nil, queue: .main) { _ in UIBridge.shared.emit("power", "unlock-screen") }
    NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
      self?.screensChanged()
    }
    appearanceObservation = NSApp.observe(\.effectiveAppearance, options: [.new]) { _, _ in
      DispatchQueue.main.async { UIBridge.shared.emit("theme", HostAppDelegate.isDark()) }
    }
    if Bundle.main.bundleIdentifier != nil { UNUserNotificationCenter.current().delegate = self }
    UIBridge.shared.emit("app", ["type": "ready"])
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    // ⌘Q and the Dock go through app.quit(), whose before-quit the app may prevent (for example
    // to keep a dictation); it exits itself once it is done. A logout, restart or shutdown is not
    // cancelled: macOS waits while the app saves, with a deadline in case it never answers.
    if !powerOffPending && HostAppDelegate.systemIsEnding() {
      powerOffPending = true
      UIBridge.shared.emit("power", "shutdown")
    }
    UIBridge.shared.emit("app", ["type": "quit-request"])
    guard powerOffPending else { return .terminateCancel }
    if !terminationPending {
      terminationPending = true
      // JS exits by itself once its cleanup is done or its QUIT_CLEANUP_MS (10 s) has run out. This only
      // answers for a JS thread that is stuck, so it must not cut that cleanup short.
      DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in self?.answerTermination() }
    }
    return .terminateLater
  }

  private var terminationPending = false
  private var powerOffPending = false
  func answerTermination() {
    guard terminationPending else { return }
    terminationPending = false
    NSApp.reply(toApplicationShouldTerminate: true)
  }

  /// The quit Apple event says why it was sent: a logout, restart or shutdown, or a person's ⌘Q.
  private static func systemIsEnding() -> Bool {
    guard let event = NSAppleEventManager.shared().currentAppleEvent,
          let reason = event.attributeDescriptor(forKeyword: AEKeyword(kAEQuitReason))?.enumCodeValue else { return false }
    return [kAELogOut, kAEReallyLogOut, kAERestart, kAEShowRestartDialog, kAEShutDown, kAEShowShutdownDialog].map { OSType($0) }.contains(reason)
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    UIBridge.shared.emit("app", ["type": "activate", "hasVisibleWindows": flag])
    return false
  }

  func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
    UIBridge.shared.emit("notification", ["type": "click", "id": response.notification.request.identifier])
    done()
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                              withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    done([.banner, .list, .sound])
  }

  // MARK: Screens

  static func currentDisplays() -> [Int: [String: Any]] {
    Dictionary(NSScreen.screens.map { (ScreenSpace.displayId($0), ScreenSpace.display($0)) }, uniquingKeysWith: { first, _ in first })
  }

  private func screensChanged() {
    let now = HostAppDelegate.currentDisplays()
    for (id, display) in now where displays[id] == nil { UIBridge.shared.emit("screen", ["type": "display-added", "display": display]) }
    for (id, display) in displays where now[id] == nil { UIBridge.shared.emit("screen", ["type": "display-removed", "display": display]) }
    for (id, display) in now {
      guard let old = displays[id] else { continue }
      var changed: [String] = []
      if (old["bounds"] as? NSDictionary) != (display["bounds"] as? NSDictionary) { changed.append("bounds") }
      if (old["workArea"] as? NSDictionary) != (display["workArea"] as? NSDictionary) { changed.append("workArea") }
      if (old["scaleFactor"] as? Double) != (display["scaleFactor"] as? Double) { changed.append("scaleFactor") }
      if !changed.isEmpty { UIBridge.shared.emit("screen", ["type": "display-metrics-changed", "display": display, "changedMetrics": changed]) }
    }
    displays = now
  }

  static func isDark() -> Bool { NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua }

  // MARK: Main menu

  /// Electron's default menu without its developer items: the app menu, Edit (so ⌘C and ⌘V work
  /// in the page) and Window (⌘W closes through the window's close handler, ⌘M minimizes).
  private func installMainMenu() {
    let name = ProcessInfo.processInfo.processName
    let main = NSMenu()
    func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
      let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      let menu = NSMenu(title: title)
      items.forEach(menu.addItem)
      item.submenu = menu
      main.addItem(item)
      return menu
    }
    func item(_ title: String, _ action: Selector?, _ key: String, _ modifiers: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
      item.keyEquivalentModifierMask = modifiers
      return item
    }
    _ = submenu(name, [
      item("About \(name)", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""), .separator(),
      item("Hide \(name)", #selector(NSApplication.hide(_:)), "h"),
      item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("Show All", #selector(NSApplication.unhideAllApplications(_:)), ""), .separator(),
      item("Quit \(name)", #selector(NSApplication.terminate(_:)), "q")
    ])
    _ = submenu("Edit", [
      item("Undo", Selector(("undo:")), "z"), item("Redo", Selector(("redo:")), "z", [.command, .shift]), .separator(),
      item("Cut", #selector(NSText.cut(_:)), "x"), item("Copy", #selector(NSText.copy(_:)), "c"), item("Paste", #selector(NSText.paste(_:)), "v"),
      item("Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]),
      item("Delete", #selector(NSText.delete(_:)), ""), item("Select All", #selector(NSText.selectAll(_:)), "a")
    ])
    let window = submenu("Window", [
      item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"), item("Zoom", #selector(NSWindow.performZoom(_:)), ""), .separator(),
      item("Close", #selector(NSWindow.performClose(_:)), "w"), .separator(),
      item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:)), "")
    ])
    NSApp.mainMenu = main
    NSApp.windowsMenu = window
  }

  // MARK: Bridge operations

  static func install(_ bridge: UIBridge) {
    let fileManager = FileManager.default
    func directory(_ kind: FileManager.SearchPathDirectory) -> String {
      fileManager.urls(for: kind, in: .userDomainMask).first?.path ?? NSHomeDirectory()
    }
    bridge.op("appInfo") { _ in
      let info = Bundle.main.infoDictionary ?? [:]
      return [
        "name": info["CFBundleName"] as? String ?? ProcessInfo.processInfo.processName,
        "version": info["CFBundleShortVersionString"] as? String ?? "0.0.0",
        "exe": Bundle.main.executablePath ?? CommandLine.arguments[0],
        "home": NSHomeDirectory(),
        "appData": directory(.applicationSupportDirectory),
        "temp": NSTemporaryDirectory().hasSuffix("/") ? String(NSTemporaryDirectory().dropLast()) : NSTemporaryDirectory(),
        "desktop": directory(.desktopDirectory), "documents": directory(.documentDirectory), "downloads": directory(.downloadsDirectory),
        "music": directory(.musicDirectory), "pictures": directory(.picturesDirectory), "videos": directory(.moviesDirectory),
        "logs": directory(.libraryDirectory) + "/Logs",
        "isInApplicationsFolder": Bundle.main.bundlePath.hasPrefix("/Applications/") || Bundle.main.bundlePath.hasPrefix(NSHomeDirectory() + "/Applications/")
      ]
    }
    bridge.op("appSetActivationPolicy") { args in
      let policies: [String: NSApplication.ActivationPolicy] = ["regular": .regular, "accessory": .accessory, "prohibited": .prohibited]
      NSApp.setActivationPolicy(policies[args.string(0) ?? "regular"] ?? .regular)
      return nil
    }
    bridge.op("appFocus") { _ in NSApp.activateHost(); return nil }
    bridge.op("appHide") { _ in NSApp.hide(nil); return nil }
    bridge.op("dockIsVisible") { _ in NSApp.activationPolicy() == .regular }
    bridge.op("dockSetIcon") { args in NSApp.applicationIconImage = HostImages.image(args.dict(0)); return nil }
    bridge.op("dockSetBadge") { args in NSApp.dockTile.badgeLabel = args.string(0).flatMap { $0.isEmpty ? nil : $0 }; return nil }
    bridge.op("dockBounce") { args in NSApp.requestUserAttention(args.string(0) == "critical" ? .criticalRequest : .informationalRequest) }

    // The single-instance lock belongs to the profile, as Electron's does: a lock file in userData.
    // A second launch tells the first through a distributed notification named after the profile.
    bridge.op("appSingleInstanceLock") { args in
      let profile = args.string(0) ?? NSHomeDirectory()
      try? fileManager.createDirectory(atPath: profile, withIntermediateDirectories: true)
      let fd = open(profile + "/SingletonLock.native", O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
      // A stable name: Swift's hashValue changes with every launch.
      var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
      let bytes = Array(profile.utf8)
      CC_SHA256(bytes, CC_LONG(bytes.count), &digest)
      let name = NSNotification.Name("meluli.second-instance." + digest.prefix(12).map { String(format: "%02x", $0) }.joined())
      guard fd >= 0, flock(fd, LOCK_EX | LOCK_NB) == 0 else {
        if fd >= 0 { close(fd) }
        DistributedNotificationCenter.default().postNotificationName(name, object: nil, userInfo: nil, deliverImmediately: true)
        return false
      }
      singletonDescriptor = fd
      DistributedNotificationCenter.default().addObserver(forName: name, object: nil, queue: .main) { _ in
        UIBridge.shared.emit("app", ["type": "second-instance"])
      }
      return true
    }

    bridge.op("loginItemGet") { _ in
      let status = SMAppService.mainApp.status
      return ["openAtLogin": status == .enabled, "openAsHidden": false, "wasOpenedAtLogin": false, "wasOpenedAsHidden": false,
              "restoreState": false, "status": status == .enabled ? "enabled" : status == .requiresApproval ? "requires-approval" : "not-registered"]
    }
    bridge.op("loginItemSet") { args in
      let open = args.dict(0).bool("openAtLogin") == true
      do {
        if open && SMAppService.mainApp.status != .enabled { try SMAppService.mainApp.register() }
        if !open && SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
      } catch { NSLog("[login-item] %@", "\(error)") }
      return nil
    }

    bridge.op("shellOpenExternal") { args in
      guard let text = args.string(0), let url = URL(string: text) else { return false }
      return NSWorkspace.shared.open(url)
    }
    bridge.op("shellOpenPath") { args in
      let path = args.string(0) ?? ""
      guard fileManager.fileExists(atPath: path) else { return "Failed to open path" }
      return NSWorkspace.shared.open(URL(fileURLWithPath: path)) ? "" : "Failed to open path"
    }
    bridge.op("shellShowItemInFolder") { args in
      NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: args.string(0) ?? NSHomeDirectory())])
      return nil
    }
    bridge.op("shellBeep") { _ in NSSound.beep(); return nil }

    bridge.op("clipboardWriteText") { args in
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(args.string(0) ?? "", forType: .string)
      return nil
    }
    bridge.op("clipboardReadText") { _ in NSPasteboard.general.string(forType: .string) ?? "" }

    bridge.op("accessibilityTrusted") { args in
      let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: args.bool(0) ?? false] as CFDictionary
      return AXIsProcessTrustedWithOptions(options)
    }
    bridge.op("animationSettings") { _ in
      ["shouldRenderRichAnimation": !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion,
       "scrollAnimationsEnabledBySystem": true,
       "prefersReducedMotion": NSWorkspace.shared.accessibilityDisplayShouldReduceMotion]
    }
    bridge.op("mediaAccessStatus") { args in
      let type: AVMediaType = args.string(0) == "camera" ? .video : .audio
      switch AVCaptureDevice.authorizationStatus(for: type) {
      case .authorized: return "granted"
      case .denied: return "denied"
      case .restricted: return "restricted"
      case .notDetermined: return "not-determined"
      @unknown default: return "unknown"
      }
    }
    bridge.asyncOp("askForMediaAccess") { args, reply in
      let type: AVMediaType = args.string(0) == "camera" ? .video : .audio
      if AVCaptureDevice.authorizationStatus(for: type) == .authorized { return reply(true) }
      AVCaptureDevice.requestAccess(for: type) { granted in reply(granted) }
    }
    bridge.op("thermalState") { _ in
      switch ProcessInfo.processInfo.thermalState {
      case .nominal: return "nominal"
      case .fair: return "fair"
      case .serious: return "serious"
      case .critical: return "critical"
      @unknown default: return "unknown"
      }
    }
    bridge.op("idleTime") { _ in
      CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
    }

    bridge.op("themeSet") { args in
      switch args.string(0) {
      case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
      case "light": NSApp.appearance = NSAppearance(named: .aqua)
      default: NSApp.appearance = nil
      }
      return nil
    }
    bridge.op("themeIsDark") { _ in isDark() }

    bridge.op("screenDisplays") { _ in NSScreen.screens.map(ScreenSpace.display) }
    bridge.op("screenCursor") { _ in ScreenSpace.point(NSEvent.mouseLocation) }

    bridge.op("notificationShow") { args in
      let options = args.dict(0)
      let id = args.string(1) ?? UUID().uuidString
      let center = UNUserNotificationCenter.current()
      let content = UNMutableNotificationContent()
      content.title = options.string("title") ?? ""
      if let subtitle = options.string("subtitle") { content.subtitle = subtitle }
      content.body = options.string("body") ?? ""
      if options.bool("silent") != true { content.sound = .default }
      center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
        guard granted else { UIBridge.shared.emit("notification", ["type": "failed", "id": id, "error": "Notifications are not allowed"]); return }
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
          UIBridge.shared.emit("notification", error.map { ["type": "failed", "id": id, "error": $0.localizedDescription] } ?? ["type": "show", "id": id])
        }
      }
      return nil
    }
    bridge.op("notificationClose") { args in
      if let id = args.string(0) { UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [id]) }
      return nil
    }

    bridge.op("messageBoxSync") { args in runAlert(args.dict(0), windowId: args.int(1)) }
    bridge.asyncOp("messageBox") { args, reply in reply(["response": runAlert(args.dict(0), windowId: args.int(1)), "checkboxChecked": false]) }
    bridge.asyncOp("openDialog") { args, reply in
      if RendererConfig.diagnostics != nil, !RendererConfig.scriptedOpenPaths.isEmpty {
        let paths = RendererConfig.scriptedOpenPaths.removeFirst()
        return reply(["canceled": paths.isEmpty, "filePaths": paths])
      }
      let options = args.dict(0)
      let panel = NSOpenPanel()
      let properties = (options["properties"] as? [String]) ?? ["openFile"]
      panel.canChooseFiles = properties.contains("openFile")
      panel.canChooseDirectories = properties.contains("openDirectory")
      panel.allowsMultipleSelection = properties.contains("multiSelections")
      panel.canCreateDirectories = properties.contains("createDirectory")
      panel.showsHiddenFiles = properties.contains("showHiddenFiles")
      apply(options, to: panel)
      present(panel, windowId: args.int(1)) { ok in
        reply(["canceled": !ok, "filePaths": ok ? panel.urls.map(\.path) : []])
      }
    }
    bridge.asyncOp("saveDialog") { args, reply in
      if RendererConfig.diagnostics != nil, !RendererConfig.scriptedSavePaths.isEmpty {
        let path = RendererConfig.scriptedSavePaths.removeFirst()
        return reply(["canceled": path.isEmpty, "filePath": path])
      }
      let options = args.dict(0)
      let panel = NSSavePanel()
      panel.canCreateDirectories = true
      apply(options, to: panel)
      if let path = options.string("defaultPath") {
        let url = URL(fileURLWithPath: path)
        var isDirectory: ObjCBool = false
        if fileManager.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue { panel.directoryURL = url }
        else { panel.directoryURL = url.deletingLastPathComponent(); panel.nameFieldStringValue = url.lastPathComponent }
      }
      present(panel, windowId: args.int(1)) { ok in
        reply(ok ? ["canceled": false, "filePath": panel.url?.path ?? ""] : ["canceled": true, "filePath": ""])
      }
    }
  }

  private static var singletonDescriptor: Int32 = -1

  private static func apply(_ options: [String: Any], to panel: NSSavePanel) {
    if let title = options.string("title") { panel.title = title }
    if let message = options.string("message") { panel.message = message }
    if let label = options.string("buttonLabel") { panel.prompt = label }
    if let path = options.string("defaultPath"), panel is NSOpenPanel { panel.directoryURL = URL(fileURLWithPath: path) }
    let extensions = ((options["filters"] as? [[String: Any]]) ?? []).flatMap { ($0["extensions"] as? [String]) ?? [] }.filter { $0 != "*" }
    if !extensions.isEmpty {
      panel.allowedContentTypes = extensions.compactMap { UTType(filenameExtension: $0) }
    }
  }

  private static func present(_ panel: NSSavePanel, windowId: Int?, done: @escaping (Bool) -> Void) {
    if let windowId, let window = WindowController.live[windowId]?.window, window.isVisible {
      panel.beginSheetModal(for: window) { done($0 == .OK) }
    } else {
      NSApp.activateHost()
      panel.begin { done($0 == .OK) }
    }
  }

  private static func runAlert(_ options: [String: Any], windowId: Int?) -> Int {
    let alert = NSAlert()
    alert.messageText = options.string("message") ?? ""
    alert.informativeText = options.string("detail") ?? ""
    switch options.string("type") {
    case "warning", "error": alert.alertStyle = options.string("type") == "error" ? .critical : .warning
    default: alert.alertStyle = .informational
    }
    let buttons = (options["buttons"] as? [String]) ?? ["OK"]
    for title in buttons { alert.addButton(withTitle: title) }
    let defaultId = Int(options.number("defaultId") ?? 0)
    let cancelId = options.number("cancelId").map(Int.init)
    for (index, button) in alert.buttons.enumerated() {
      button.keyEquivalent = index == defaultId ? "\r" : index == cancelId ? "\u{1b}" : ""
    }
    NSApp.activateHost()
    let response = alert.runModal()
    let index = response.rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
    return (0..<buttons.count).contains(index) ? index : (cancelId ?? 0)
  }
}

// MARK: safeStorage

/// Electron's safeStorage format on macOS ("v10"), so keys an Electron build saved still open:
/// AES-128-CBC with a key from PBKDF2-SHA1 over the keychain password, salt "saltysalt", 1003 rounds,
/// and an IV of 16 spaces. The password is the generic keychain item the Info.plist names.
enum HostSafeStorage {
  private static var key: Data?
  private static let lock = NSLock()

  private static var service: String {
    Bundle.main.object(forInfoDictionaryKey: "MeluliSafeStorageService") as? String
      ?? "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "Meluli") Safe Storage"
  }
  private static var account: String {
    Bundle.main.object(forInfoDictionaryKey: "MeluliSafeStorageAccount") as? String
      ?? "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "Meluli") Key"
  }

  private static func password() -> Data? {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var result: AnyObject?
    if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data { return data }
    // None yet: a random password, stored the way Chromium stores its own.
    var random = Data(count: 16)
    guard random.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }) == errSecSuccess else { return nil }
    let generated = Data(random.base64EncodedString().utf8)
    let add: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                              kSecAttrAccount as String: account, kSecValueData as String: generated]
    return SecItemAdd(add as CFDictionary, nil) == errSecSuccess ? generated : nil
  }

  static func derivedKey() -> Data? {
    lock.lock(); defer { lock.unlock() }
    if let key { return key }
    guard let password = password() else { return nil }
    var derived = Data(count: kCCKeySizeAES128)
    let salt = Data("saltysalt".utf8)
    let status = derived.withUnsafeMutableBytes { out in
      password.withUnsafeBytes { pass in
        salt.withUnsafeBytes { saltBytes in
          CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), pass.baseAddress!.assumingMemoryBound(to: Int8.self), password.count,
                               saltBytes.baseAddress!.assumingMemoryBound(to: UInt8.self), salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1),
                               1003, out.baseAddress!.assumingMemoryBound(to: UInt8.self), kCCKeySizeAES128)
        }
      }
    }
    guard status == kCCSuccess else { return nil }
    key = derived
    return derived
  }

  static func crypt(_ operation: CCOperation, _ input: Data, key: Data) -> Data? {
    let iv = Data(repeating: 0x20, count: kCCBlockSizeAES128)
    var output = Data(count: input.count + kCCBlockSizeAES128)
    var written = 0
    let capacity = output.count
    let status = output.withUnsafeMutableBytes { out in
      input.withUnsafeBytes { inBytes in
        key.withUnsafeBytes { keyBytes in
          iv.withUnsafeBytes { ivBytes in
            CCCrypt(operation, CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding), keyBytes.baseAddress, key.count,
                    ivBytes.baseAddress, inBytes.baseAddress, input.count, out.baseAddress, capacity, &written)
          }
        }
      }
    }
    guard status == kCCSuccess else { return nil }
    return output.prefix(written)
  }

  static func install(in runtime: JSRuntime) {
    let available: @convention(block) () -> Bool = { derivedKey() != nil }
    runtime.define("safeStorageAvailable", available)
    let encrypt: @convention(block) (String) -> JSValue = { text in
      let context = JSContext.current()!
      guard let key = derivedKey(), let sealed = crypt(CCOperation(kCCEncrypt), Data(text.utf8), key: key) else {
        JSRuntime.throwError("Error while encrypting the text provided to safeStorage.encryptString. Encryption is not available.")
        return JSValue(undefinedIn: context)
      }
      return JSRuntime.bytes(Data("v10".utf8) + sealed, in: context)
    }
    runtime.define("safeStorageEncrypt", encrypt)
    let decrypt: @convention(block) (JSValue) -> JSValue = { value in
      let context = JSContext.current()!
      let data = JSRuntime.data(of: value) ?? Data()
      guard data.count > 3, data.prefix(3) == Data("v10".utf8) else {
        JSRuntime.throwError("Error while decrypting the ciphertext provided to safeStorage.decryptString. Ciphertext does not appear to be encrypted.")
        return JSValue(undefinedIn: context)
      }
      guard let key = derivedKey(), let plain = crypt(CCOperation(kCCDecrypt), data.dropFirst(3), key: key) else {
        JSRuntime.throwError("Error while decrypting the ciphertext provided to safeStorage.decryptString.")
        return JSValue(undefinedIn: context)
      }
      return JSValue(object: String(decoding: plain, as: UTF8.self), in: context)
    }
    runtime.define("safeStorageDecrypt", decrypt)
  }
}

extension NSApplication {
  /// Brings the app forward. macOS 14 replaced activate(ignoringOtherApps:); the app still runs on 13.3,
  /// the oldest system the Electron build supported, so an update never strands anyone.
  func activateHost() {
    if #available(macOS 14.0, *) { activate() } else { activate(ignoringOtherApps: true) }
  }
}
