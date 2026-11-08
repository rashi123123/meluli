// globalShortcut for the Electron surface (D20): Carbon hot keys, which need no Accessibility
// grant and cost nothing while idle (the system matches the key, not this process).
import AppKit
import Carbon.HIToolbox

enum HostShortcuts {
  private static var registered: [String: (ref: EventHotKeyRef, id: UInt32)] = [:]
  private static var accelerators: [UInt32: String] = [:]
  private static var nextId: UInt32 = 1
  private static var handlerInstalled = false

  private static let keys: [String: Int] = {
    var map: [String: Int] = [
      "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F, "g": kVK_ANSI_G,
      "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N,
      "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U,
      "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y, "z": kVK_ANSI_Z,
      "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6,
      "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
      "space": kVK_Space, "escape": kVK_Escape, "esc": kVK_Escape, "tab": kVK_Tab, "enter": kVK_Return, "return": kVK_Return,
      "backspace": kVK_Delete, "delete": kVK_ForwardDelete, "insert": kVK_Help, "home": kVK_Home, "end": kVK_End,
      "pageup": kVK_PageUp, "pagedown": kVK_PageDown, "up": kVK_UpArrow, "down": kVK_DownArrow, "left": kVK_LeftArrow, "right": kVK_RightArrow,
      "-": kVK_ANSI_Minus, "=": kVK_ANSI_Equal, "plus": kVK_ANSI_Equal, "[": kVK_ANSI_LeftBracket, "]": kVK_ANSI_RightBracket,
      ";": kVK_ANSI_Semicolon, "'": kVK_ANSI_Quote, ",": kVK_ANSI_Comma, ".": kVK_ANSI_Period, "/": kVK_ANSI_Slash,
      "\\": kVK_ANSI_Backslash, "`": kVK_ANSI_Grave
    ]
    let functionKeys = [kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10, kVK_F11, kVK_F12,
                        kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20]
    for (index, code) in functionKeys.enumerated() { map["f\(index + 1)"] = code }
    return map
  }()

  /// Electron accelerator syntax: modifiers and one key joined by "+". Nil when it cannot be parsed.
  static func parse(_ accelerator: String) -> (code: UInt32, modifiers: UInt32)? {
    var parts = accelerator.split(separator: "+", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
    // "Plus" can also be written as a trailing empty part ("Ctrl++").
    if parts.count >= 2, parts[parts.count - 1].isEmpty, parts[parts.count - 2].isEmpty { parts.removeLast(2); parts.append("plus") }
    guard let key = parts.last, let code = keys[key] else { return nil }
    var modifiers: UInt32 = 0
    for part in parts.dropLast() {
      switch part {
      case "command", "cmd", "commandorcontrol", "cmdorctrl", "super", "meta": modifiers |= UInt32(cmdKey)
      case "control", "ctrl": modifiers |= UInt32(controlKey)
      case "alt", "option", "altgr": modifiers |= UInt32(optionKey)
      case "shift": modifiers |= UInt32(shiftKey)
      default: return nil
      }
    }
    return (UInt32(code), modifiers)
  }

  private static func installHandler() {
    guard !handlerInstalled else { return }
    handlerInstalled = true
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
      var hotKey = EventHotKeyID()
      GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                        MemoryLayout<EventHotKeyID>.size, nil, &hotKey)
      if let accelerator = HostShortcuts.accelerators[hotKey.id] { UIBridge.shared.emit("shortcut", accelerator) }
      return noErr
    }, 1, &spec, nil, nil)
  }

  static func install(_ bridge: UIBridge) {
    // register(accelerator) -> true, false when another app holds it; throws when it cannot be parsed.
    bridge.op("shortcutRegister") { args in
      let accelerator = args.string(0) ?? ""
      guard let (code, modifiers) = parse(accelerator) else { throw UIError(message: "Failed to parse accelerator \"\(accelerator)\"") }
      if registered[accelerator] != nil { return false }
      installHandler()
      let id = nextId
      nextId += 1
      var ref: EventHotKeyRef?
      let status = RegisterEventHotKey(code, modifiers, EventHotKeyID(signature: OSType(0x4d4c4c49), id: id), GetApplicationEventTarget(), 0, &ref)
      guard status == noErr, let ref else { return false }
      registered[accelerator] = (ref, id)
      accelerators[id] = accelerator
      return true
    }
    bridge.op("shortcutUnregister") { args in
      if let accelerator = args.string(0), let entry = registered.removeValue(forKey: accelerator) {
        UnregisterEventHotKey(entry.ref)
        accelerators.removeValue(forKey: entry.id)
      }
      return nil
    }
    bridge.op("shortcutUnregisterAll") { _ in
      for (_, entry) in registered { UnregisterEventHotKey(entry.ref) }
      registered.removeAll()
      accelerators.removeAll()
      return nil
    }
  }
}
