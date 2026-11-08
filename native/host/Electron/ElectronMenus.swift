// Tray, Menu and nativeImage for the Electron surface (D20). Menus arrive as templates whose items
// carry ids; a chosen item is reported back as a "menu-click" event and JS runs its handler.
import AppKit

enum HostImages {
  private static var cache: [String: NSImage] = [:]

  /// { kind: "path", path, template } | { kind: "symbol", name } | { kind: "empty" }. A path also
  /// loads its "@2x" sibling, as Electron does, so the menu bar icon is sharp on Retina displays.
  static func image(_ descriptor: [String: Any]?) -> NSImage? {
    guard let descriptor, let kind = descriptor.string("kind") else { return nil }
    switch kind {
    case "symbol":
      guard let name = descriptor.string("name") else { return nil }
      return NSImage(systemSymbolName: name, accessibilityDescription: nil)
    case "path":
      guard let path = descriptor.string("path") else { return nil }
      let template = descriptor.bool("template") == true
      let key = "\(path)|\(template)"
      if let cached = cache[key] { return cached }
      guard let base = NSImageRep(contentsOfFile: path) else { return nil }
      let image = NSImage(size: NSSize(width: base.pixelsWide, height: base.pixelsHigh))
      image.addRepresentation(base)
      let url = URL(fileURLWithPath: path)
      let retina = url.deletingPathExtension().path + "@2x." + url.pathExtension
      if let rep = NSImageRep(contentsOfFile: retina) {
        rep.size = image.size
        image.addRepresentation(rep)
      }
      image.isTemplate = template
      cache[key] = image
      return image
    default:
      return nil
    }
  }

  static func isEmpty(_ path: String) -> Bool { NSImageRep(contentsOfFile: path) == nil }
}

final class MenuTarget: NSObject {
  static let shared = MenuTarget()
  @objc func choose(_ item: NSMenuItem) {
    guard let ids = item.representedObject as? [Int] else { return }
    UIBridge.shared.emit("menu-click", ["menu": ids[0], "item": ids[1]])
  }
}

enum HostMenus {
  static func build(_ menuId: Int, _ template: [Any]) -> NSMenu {
    let menu = NSMenu()
    menu.autoenablesItems = false
    for case let entry as [String: Any] in template {
      if entry.bool("visible") == false { continue }
      let type = entry.string("type") ?? "normal"
      if type == "separator" { menu.addItem(.separator()); continue }
      let item = NSMenuItem(title: entry.string("label") ?? "", action: #selector(MenuTarget.choose(_:)), keyEquivalent: "")
      item.target = MenuTarget.shared
      item.representedObject = [menuId, Int(entry.number("id") ?? 0)]
      item.isEnabled = entry.bool("enabled") ?? true
      if type == "checkbox" || type == "radio" { item.state = entry.bool("checked") == true ? .on : .off }
      if let image = HostImages.image(entry.dict("icon")) { item.image = image }
      if let toolTip = entry.string("toolTip") { item.toolTip = toolTip }
      if type == "submenu", let children = entry["submenu"] as? [Any] {
        item.submenu = build(menuId, children)
        item.action = nil
      }
      menu.addItem(item)
    }
    return menu
  }
}

final class TrayItem {
  static var live: [Int: TrayItem] = [:]
  let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

  init(image: [String: Any]?) {
    item.button?.image = HostImages.image(image)
    item.button?.imagePosition = .imageLeft
  }

  func setTitle(_ title: String, monospacedDigits: Bool) {
    guard let button = item.button else { return }
    if title.isEmpty { button.title = ""; button.imagePosition = .imageOnly; return }
    button.imagePosition = .imageLeft
    let size = NSFont.systemFontSize(for: .regular)
    let font = monospacedDigits ? NSFont.monospacedDigitSystemFont(ofSize: size, weight: .regular) : NSFont.menuBarFont(ofSize: 0)
    button.attributedTitle = NSAttributedString(string: " " + title, attributes: [.font: font, .baselineOffset: 0])
  }

  static func install(_ bridge: UIBridge) {
    func tray(_ args: [Any]) throws -> TrayItem {
      guard let id = args.int(0), let tray = live[id] else { throw UIError(message: "The tray has been destroyed") }
      return tray
    }
    bridge.op("trayCreate") { args in
      guard let id = args.int(0) else { throw UIError(message: "trayCreate needs an id") }
      live[id] = TrayItem(image: args.dict(1))
      return nil
    }
    bridge.op("traySetImage") { args in try tray(args).item.button?.image = HostImages.image(args.dict(1)); return nil }
    bridge.op("traySetTitle") { args in try tray(args).setTitle(args.string(1) ?? "", monospacedDigits: args.bool(2) ?? false); return nil }
    bridge.op("traySetToolTip") { args in try tray(args).item.button?.toolTip = args.string(1); return nil }
    bridge.op("traySetContextMenu") { args in
      let tray = try tray(args)
      tray.item.menu = args.count > 2 && args[2] is [Any] ? HostMenus.build(args.int(1) ?? 0, args.list(2)) : nil
      return nil
    }
    bridge.op("trayDestroy") { args in
      if let id = args.int(0), let tray = live.removeValue(forKey: id) { NSStatusBar.system.removeStatusItem(tray.item) }
      return nil
    }
    bridge.op("imageIsEmpty") { args in HostImages.isEmpty(args.string(0) ?? "") }
    bridge.op("imageSize") { args in
      guard let image = HostImages.image(args.dict(0)) else { return ["width": 0, "height": 0] }
      return ["width": Int(image.size.width), "height": Int(image.size.height)]
    }
    // menuPopup(menuId, template, windowId?, x?, y?) -> answers once the menu has closed, after any click.
    bridge.asyncOp("menuPopup") { args, reply in
      let menu = HostMenus.build(args.int(0) ?? 0, args.list(1))
      if RendererConfig.diagnostics != nil, !RendererConfig.scriptedMenuChoices.isEmpty {
        let index = RendererConfig.scriptedMenuChoices.removeFirst()
        if menu.items.indices.contains(index) { menu.performActionForItem(at: index) }
        return DispatchQueue.main.async { reply(nil) }
      }
      if let windowId = args.int(2), let controller = WindowController.live[windowId], let view = controller.window.contentView {
        var point = NSEvent.mouseLocation
        if let x = args.number(3), let y = args.number(4) {
          point = NSPoint(x: x, y: view.isFlipped ? y : view.bounds.height - y)
          menu.popUp(positioning: nil, at: point, in: view)
        } else {
          let local = controller.window.convertPoint(fromScreen: point)
          menu.popUp(positioning: nil, at: view.convert(local, from: nil), in: view)
        }
      } else {
        menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
      }
      // A chosen item's action was queued by the menu as it closed; answering after it keeps that order.
      DispatchQueue.main.async { reply(nil) }
    }
  }
}
