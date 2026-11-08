// The bridge between the JS thread and AppKit for the Electron surface (D20). AppKit lives on the
// main thread, the app's main-process code on "meluli.js", and the rule between them is one-way:
//   - JS may wait on the main thread (`ui`, for getters and modal dialogs);
//   - the main thread never waits on JS. Everything it tells JS goes through `emit`, which only
//     queues a call on the JS run loop.
// Operations are registered by name; their arguments and results are plain Foundation values.
import AppKit
import JavaScriptCore

struct UIError: Error { let message: String }

final class UIBridge {
  static private(set) var shared: UIBridge!

  let runtime: JSRuntime
  private var handler: JSValue?
  private var ops: [String: ([Any]) throws -> Any?] = [:]
  private var asyncOps: [String: ([Any], @escaping (Any?) -> Void) -> Void] = [:]

  init(runtime: JSRuntime) {
    self.runtime = runtime
    UIBridge.shared = self
  }

  /// A synchronous operation, run on the main thread while the JS thread waits.
  func op(_ name: String, _ body: @escaping ([Any]) throws -> Any?) { ops[name] = body }
  /// An operation that answers later (a dialog, a permission prompt). `reply` may be called from any thread.
  func asyncOp(_ name: String, _ body: @escaping ([Any], @escaping (Any?) -> Void) -> Void) { asyncOps[name] = body }

  /// Tells JS about something that happened. Safe from any thread; never waits.
  func emit(_ event: String, _ payload: Any? = nil) {
    runtime.perform { [weak self] in
      guard let self, let handler = self.handler, let context = handler.context else { return }
      handler.call(withArguments: [event, JSRuntime.value(payload, in: context)])
    }
  }

  func install() {
    // ui(op, args) -> result. The arguments are converted here, on the JS thread, before the hop.
    let ui: @convention(block) (String, JSValue) -> JSValue = { [unowned self] name, args in
      let context = JSContext.current()!
      let values = (args.toArray() ?? []) as [Any]
      guard let body = self.ops[name] else {
        JSRuntime.throwError("The native host has no operation \(name)")
        return JSValue(undefinedIn: context)
      }
      var result: Any?
      var failure: String?
      let work = {
        do { result = try body(values) } catch let error as UIError { failure = error.message } catch { failure = "\(error)" }
      }
      if Thread.isMainThread { work() } else { DispatchQueue.main.sync(execute: work) }
      if let failure { JSRuntime.throwError(failure); return JSValue(undefinedIn: context) }
      return JSRuntime.value(result, in: context)
    }
    runtime.define("ui", ui)
    // uiPost(op, args): the same operations, without waiting for them. Order with `ui` is kept,
    // since both go through the main queue.
    let post: @convention(block) (String, JSValue) -> Void = { [unowned self] name, args in
      let values = (args.toArray() ?? []) as [Any]
      guard let body = self.ops[name] else { self.runtime.onUncaught?("The native host has no operation \(name)"); return }
      DispatchQueue.main.async {
        do { _ = try body(values) } catch { NSLog("[ui] %@ failed: %@", name, "\(error)") }
      }
    }
    runtime.define("uiPost", post)
    // uiAsync(op, args, callback): the callback runs on the JS thread with the result.
    let async: @convention(block) (String, JSValue, JSValue) -> Void = { [unowned self] name, args, callback in
      let values = (args.toArray() ?? []) as [Any]
      guard let body = self.asyncOps[name] else {
        JSRuntime.throwError("The native host has no async operation \(name)")
        return
      }
      let managed = JSManagedValue(value: callback, andOwner: self)
      self.runtime.context.virtualMachine.addManagedReference(managed, withOwner: self)
      DispatchQueue.main.async {
        body(values) { [weak self] result in
          self?.runtime.perform {
            guard let self, let callback = managed?.value else { return }
            self.runtime.context.virtualMachine.removeManagedReference(managed, withOwner: self)
            callback.call(withArguments: [JSRuntime.value(result, in: callback.context)])
          }
        }
      }
    }
    runtime.define("uiAsync", async)
    let events: @convention(block) (JSValue) -> Void = { [unowned self] handler in self.handler = handler }
    runtime.define("uiEvents", events)
  }
}

// MARK: Coordinates

/// Electron's screen space: the primary display's top-left is 0,0 and y grows down. AppKit's
/// origin is the primary display's bottom-left with y growing up.
enum ScreenSpace {
  static var primaryHeight: CGFloat { NSScreen.screens.first?.frame.height ?? 0 }

  static func rect(_ frame: NSRect) -> [String: Any] {
    ["x": Int(frame.minX.rounded()), "y": Int((primaryHeight - frame.maxY).rounded()),
     "width": Int(frame.width.rounded()), "height": Int(frame.height.rounded())]
  }

  static func frame(x: Double, y: Double, width: Double, height: Double) -> NSRect {
    NSRect(x: x, y: Double(primaryHeight) - y - height, width: width, height: height)
  }

  static func frame(_ bounds: [String: Any], current: NSRect) -> NSRect {
    let old = rect(current)
    let width = bounds.number("width") ?? Double(old["width"] as! Int)
    let height = bounds.number("height") ?? Double(old["height"] as! Int)
    return frame(x: bounds.number("x") ?? Double(old["x"] as! Int), y: bounds.number("y") ?? Double(old["y"] as! Int), width: width, height: height)
  }

  static func point(_ point: NSPoint) -> [String: Any] {
    ["x": Int(point.x.rounded()), "y": Int((primaryHeight - point.y).rounded())]
  }

  static func displayId(_ screen: NSScreen) -> Int {
    (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue ?? 0
  }

  static func display(_ screen: NSScreen) -> [String: Any] {
    let bounds = rect(screen.frame), work = rect(screen.visibleFrame)
    let id = displayId(screen)
    return ["id": id, "label": screen.localizedName, "bounds": bounds, "workArea": work,
            "size": ["width": bounds["width"]!, "height": bounds["height"]!],
            "workAreaSize": ["width": work["width"]!, "height": work["height"]!],
            "scaleFactor": Double(screen.backingScaleFactor), "rotation": 0,
            "internal": CGDisplayIsBuiltin(CGDirectDisplayID(id)) != 0, "monochrome": false,
            "accelerometerSupport": "unknown", "touchSupport": "unknown", "colorDepth": 24, "colorSpace": "", "depthPerComponent": 8,
            "displayFrequency": Double(screen.maximumFramesPerSecond), "detected": true]
  }
}

// MARK: Colors

extension NSColor {
  /// "#RGB", "#RRGGBB" or Electron's "#AARRGGBB".
  static func electron(_ text: String?) -> NSColor? {
    guard var hex = text?.trimmingCharacters(in: .whitespaces), hex.hasPrefix("#") else { return nil }
    hex.removeFirst()
    if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
    guard let value = UInt64(hex, radix: 16) else { return nil }
    let channel = { (shift: UInt64) in CGFloat((value >> shift) & 0xff) / 255 }
    switch hex.count {
    case 6: return NSColor(srgbRed: channel(16), green: channel(8), blue: channel(0), alpha: 1)
    case 8: return NSColor(srgbRed: channel(16), green: channel(8), blue: channel(0), alpha: channel(24))
    default: return nil
    }
  }
}
