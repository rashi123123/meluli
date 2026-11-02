// Verified native paste: one Cmd-V pair, AX logical-range acknowledgement, no retry.
import AppKit
import ApplicationServices
import Foundation
import Carbon
import Darwin
import CryptoKit

struct Target {
    let app: NSRunningApplication
    let element: AXUIElement?
    let window: AXUIElement?
    let text: String
    let selection: CFRange
    let token: String
    let launch: Date?
    let method: String
    let blockedReason: String?
    /// Adaptive targets may refuse, retry and paste without a readable field. Research targets stay strict.
    let insertability: String?
}
var captured: Target?
var dispatched = Set<String>()
func now() -> UInt64 { DispatchTime.now().uptimeNanoseconds }
func ms(_ start: UInt64) -> Double { Double(now() - start) / 1_000_000 }
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) else { return }
    // Valid unescaped JSON, yet readline-style consumers end a line at these two.
    print(text.replacingOccurrences(of: "\u{2028}", with: "\\u2028").replacingOccurrences(of: "\u{2029}", with: "\\u2029")); fflush(stdout)
}
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func focused(_ app: AXUIElement) -> AXUIElement? {
    guard let value = attr(app, kAXFocusedUIElementAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
}
func selection(_ field: AXUIElement) -> CFRange? {
    guard let value = attr(field, kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var range = CFRange()
    return AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cfRange, &range) ? range : nil
}
func editable(_ field: AXUIElement) -> Bool {
    var settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(field, kAXSelectedTextAttribute as CFString, &settable) == .success && settable.boolValue
}
func logicalText(_ field: AXUIElement) -> String? {
    guard let count = attr(field, kAXNumberOfCharactersAttribute) as? NSNumber,
          count.intValue >= 0, count.intValue <= 4_000_000 else { return nil }
    var range = CFRange(location: 0, length: count.intValue)
    guard let argument = AXValueCreate(.cfRange, &range) else { return nil }
    var value: CFTypeRef?
    guard AXUIElementCopyParameterizedAttributeValue(field, kAXStringForRangeParameterizedAttribute as CFString, argument, &value) == .success else { return nil }
    return value as? String
}
/// The field's own state, read so that a secure value is never touched.
func inspect(_ element: AXUIElement?) -> (insertability: String, role: String, text: String, range: CFRange) {
    guard let field = element else { return ("blind", "unknown", "", CFRange()) }
    AXUIElementSetMessagingTimeout(field, 0.3)
    let role = attr(field, kAXRoleAttribute) as? String ?? "unknown"
    if attr(field, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole { return ("secure", role, "", CFRange()) }
    guard [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(role),
          let text = logicalText(field), let range = selection(field), range.location >= 0, range.length >= 0,
          range.location <= (text as NSString).length, range.length <= (text as NSString).length - range.location else { return ("blind", role, "", CFRange()) }
    return ("verified", role, text, range)
}
/// Bounded evidence that one paste landed where a target rewrote the text: the surrounding
/// text is untouched and the new span is about one transcript long, so never two.
func landed(_ observed: String, _ before: String, _ range: CFRange, _ text: String) -> Bool {
    let old = before as NSString, new = observed as NSString
    let prefix = old.substring(to: range.location), suffix = old.substring(from: range.location + range.length)
    let span = new.length - (prefix as NSString).length - (suffix as NSString).length, inserted = (text as NSString).length
    return observed.utf16.starts(with: prefix.utf16) && observed.utf16.reversed().starts(with: suffix.utf16.reversed())
        && span * 10 >= inserted * 9 && span * 10 <= inserted * 12
}
func tick() { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.02)) }
func sha(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }
func electronFrameworkVersion(_ app: NSRunningApplication) -> String? {
    guard let bundle = app.bundleURL,
          let data = try? Data(contentsOf: bundle.appendingPathComponent("Contents/Frameworks/Electron Framework.framework/Resources/Info.plist")),
          let info = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any],
          info["CFBundleIdentifier"] as? String == "com.github.Electron.framework" else { return nil }
    return info["CFBundleVersion"] as? String
}
func blockKnownUnsupportedAX(_ method: String, _ version: String?) -> Bool {
    // Only the locally reproduced version is blocked by this evidence. Other
    // versions remain unvalidated; this is not a universal compatibility claim.
    return method == "ax_selected_text" && version == "45.0.0"
}
func cpu() -> Double {
    var usage = rusage(); getrusage(RUSAGE_SELF, &usage)
    return Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1_000_000
}
func handle(_ request: [String: Any]) -> [String: Any] {
    let start = now(), cpuStart = cpu()
    let id = request["requestId"] as? String ?? "invalid"
    var timings: [String: Double] = [:]
    func result(_ state: String, _ reason: String, _ extra: [String: Any] = [:]) -> [String: Any] {
        var value: [String: Any] = ["requestId": id, "state": state, "reason": reason,
            "totalMs": ms(start), "cpuMs": (cpu()-cpuStart)*1000, "stagesMs": timings,
            "clockNs": String(now())]
        value.merge(extra) { _, new in new }; return value
    }
    guard let type = request["type"] as? String else { return result("not_dispatched", "invalid_request") }
    if type == "ping" { return result("ready", "persistent_insertion_v2") }
    let adaptive = request["adaptive"] as? Bool ?? false
    // Naming the frontmost app needs no permission, and the user is told which app could not be reached.
    guard AXIsProcessTrusted() || (type == "capture" && adaptive) else { return result("not_dispatched", "accessibility_permission") }
    if type == "capture" {
        let method = request["method"] as? String ?? "ax_selected_text"
        guard ["ax_selected_text", "unicode_events", "native_paste"].contains(method) else { return result("not_dispatched", "unsupported_method") }
        // Meluli's own windows are not a new target, so they must not spend the one already held.
        if let excluded = request["excludePid"] as? Int32, NSWorkspace.shared.frontmostApplication?.processIdentifier == excluded { return result("not_dispatched", "own_application") }
        captured = nil
        guard let app = NSWorkspace.shared.frontmostApplication, let bundle = app.bundleIdentifier ?? (adaptive ? "" : nil) else { return result("not_dispatched", "target_unavailable") }
        if adaptive {
            let ax = AXUIElementCreateApplication(app.processIdentifier); AXUIElementSetMessagingTimeout(ax, 0.3)
            let stamp = now()
            let field = AXIsProcessTrusted() ? focused(ax) : nil
            var window: AXUIElement?
            if let value = attr(ax, kAXFocusedWindowAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() { window = unsafeBitCast(value, to: AXUIElement.self) }
            let state = inspect(field)
            // A readable but protected input can hide behind any role; the system flags it.
            let insertability = state.insertability == "blind" && IsSecureEventInputEnabled() ? "secure" : state.insertability
            timings["capture_ax"] = ms(stamp)
            let token = UUID().uuidString
            captured = Target(app: app, element: field, window: window, text: state.text, selection: state.range, token: token,
                launch: app.launchDate, method: method, blockedReason: nil, insertability: insertability)
            return result("captured", insertability, ["targetToken": token, "target": ["pid": app.processIdentifier, "bundleId": bundle,
                "name": app.localizedName ?? bundle, "role": state.role, "method": method, "insertability": insertability]])
        }
        let ax = AXUIElementCreateApplication(app.processIdentifier); AXUIElementSetMessagingTimeout(ax, 0.75)
        let stamp = now()
        guard let field = focused(ax) else { return result("not_dispatched", "unsupported_control", ["targetPid": app.processIdentifier]) }
        let role = attr(field, kAXRoleAttribute) as? String ?? "unknown"
        let subrole = attr(field, kAXSubroleAttribute) as? String ?? ""
        // Checked before any value read, so the text of a secure field is never touched.
        guard [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(role), subrole != kAXSecureTextFieldSubrole else { return result("not_dispatched", "unsupported_or_secure_control") }
        guard let text = (method == "native_paste" ? logicalText(field) : attr(field, kAXValueAttribute) as? String),
              let range = selection(field), method != "ax_selected_text" || editable(field) else { return result("not_dispatched", "unsupported_control", ["targetPid": app.processIdentifier]) }
        guard text.utf8.count <= 4_000_000, range.location >= 0, range.length >= 0,
              range.location <= (text as NSString).length, range.length <= (text as NSString).length - range.location else { return result("not_dispatched", "invalid_or_oversized_snapshot") }
        AXUIElementSetMessagingTimeout(field, 0.75)
        timings["capture_ax"] = ms(stamp)
        let token = UUID().uuidString
        let version = electronFrameworkVersion(app)
        let block = blockKnownUnsupportedAX(method, version) ? "unsupported_electron45_ax_selected_text" : nil
        captured = Target(app: app, element: field, window: nil, text: text, selection: range, token: token, launch: app.launchDate, method: method, blockedReason: block, insertability: nil)
        return result("captured", "editable_selected_text", ["targetToken": token,
            "target": ["pid": app.processIdentifier, "bundleId": bundle, "name": app.localizedName ?? bundle,
                "role": role, "method": method, "textSha256": sha(text), "selectionStart": range.location, "selectionLength": range.length,
                "capability": block == nil ? "unvalidated" : "blocked_known_incompatibility", "frameworkVersion": version ?? "not_detected"]])
    }
    guard type == "insert", let operation = request["operationId"] as? String,
          let token = request["targetToken"] as? String, let text = request["text"] as? String,
          !text.isEmpty, text.utf8.count <= 1_000_000, !operation.isEmpty, operation.utf8.count <= 256 else { return result("not_dispatched", "invalid_insert") }
    guard !dispatched.contains(operation) else { return result("duplicate_blocked", "operation_already_dispatched") }
    guard dispatched.count < 10000 else { return result("not_dispatched", "session_capacity") }
    guard let target = captured, token == target.token else { return result("not_dispatched", "stale_target") }
    if target.app.isTerminated || target.launch != target.app.launchDate { return result("not_dispatched", target.insertability == nil ? "stale_target" : "target_closed") }
    if let insertability = target.insertability {
        return insertAdaptive(target, insertability, operation, text, explicit: request["explicit"] as? Bool ?? false, result) { timings[$0] = $1 }
    }
    if let reason = target.blockedReason {
        captured = nil
        return result("not_dispatched", reason, ["mutations": 0])
    }
    let activation = now()
    target.app.activate(options: [])
    let activationDeadline = Date(timeIntervalSinceNow: 0.75)
    while NSWorkspace.shared.frontmostApplication?.processIdentifier != target.app.processIdentifier && Date() < activationDeadline { tick() }
    timings["activation"] = ms(activation)
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.app.processIdentifier else { return result("not_dispatched", "target_not_active") }
    let ax = AXUIElementCreateApplication(target.app.processIdentifier); AXUIElementSetMessagingTimeout(ax, 0.75)
    let preflight = now()
    guard let field = focused(ax),
          let targetElement = target.element, CFEqual(field, targetElement),
          let before = (target.method == "native_paste" ? logicalText(field) : attr(field, kAXValueAttribute) as? String), before == target.text,
          let range = selection(field), range.location == target.selection.location, range.length == target.selection.length,
          range.location >= 0, range.length >= 0, range.location <= (before as NSString).length, range.length <= (before as NSString).length - range.location,
          target.method != "ax_selected_text" || editable(field) else { return result("not_dispatched", "field_text_or_selection_changed") }
    timings["preflight"] = ms(preflight)
    let expected = (before as NSString).replacingCharacters(in: NSRange(location: range.location, length: range.length), with: text)
    // An unchanged value is not evidence that this operation actually executed.
    guard expected != before else { return result("not_dispatched", "unobservable_noop") }
    // Unicode events remain a bounded explicit experiment; control characters can
    // activate editor commands and are rejected before the mutation boundary.
    if target.method == "unicode_events" && (text.utf16.count > 20 || text.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 || $0.value == 0x2028 || $0.value == 0x2029 })) {
        return result("not_dispatched", "unicode_payload_not_supported")
    }
    var down: CGEvent?, up: CGEvent?
    if target.method == "native_paste" {
        guard CGPreflightPostEventAccess() else { return result("not_dispatched", "event_permission") }
        guard NSPasteboard.general.string(forType: .string) == text else { return result("not_dispatched", "clipboard_changed") }
        let source = CGEventSource(stateID: .privateState)
        down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true)
        up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false)
        guard down != nil, up != nil else { return result("not_dispatched", "event_construction_failed") }
        down!.flags = .maskCommand; up!.flags = .maskCommand
    }
    if target.method == "unicode_events" {
        guard CGPreflightPostEventAccess() else { return result("not_dispatched", "event_permission") }
        let source = CGEventSource(stateID: .privateState)
        down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
        up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
        guard down != nil, up != nil else { return result("not_dispatched", "event_construction_failed") }
        let units = Array(text.utf16)
        units.withUnsafeBufferPointer { pointer in
            down!.keyboardSetUnicodeString(stringLength: units.count, unicodeString: pointer.baseAddress!)
            up!.keyboardSetUnicodeString(stringLength: units.count, unicodeString: pointer.baseAddress!)
        }
        down!.flags = []; up!.flags = []
    }
    // One dispatch only. Native-paste callers hold the clipboard lease through
    // acknowledgment; an unknown outcome is quarantined and never resent.
    dispatched.insert(operation); captured = nil
    let mutation = now()
    let error: AXError
    if target.method == "unicode_events" || target.method == "native_paste" {
        // Target-PID posting cannot spill into an unrelated foreground process.
        // It is not an atomic edit transaction; post-dispatch focus races remain.
        down!.postToPid(target.app.processIdentifier); up!.postToPid(target.app.processIdentifier)
        error = .success
    } else {
        error = AXUIElementSetAttributeValue(field, kAXSelectedTextAttribute as CFString, text as CFString)
    }
    timings["mutation"] = ms(mutation)
    let verification = now(), deadline = Date(timeIntervalSinceNow: 1.0)
    var firstObserved: UInt64?
    let expectedCursor = range.location + (text as NSString).length
    repeat {
        let sameFocus = focused(ax).map { CFEqual($0, field) } ?? false
        let observed = target.method == "native_paste" ? logicalText(field) : attr(field, kAXValueAttribute) as? String
        if observed == expected, let endRange = selection(field),
           endRange.location == expectedCursor, endRange.length == 0, sameFocus {
            if firstObserved == nil { firstObserved = now(); timings["first_expected_observation"] = ms(verification) }
            // Allows a renderer turn to expose immediate controlled-state rollback.
            // This bounded observation is not proof of arbitrary future stability.
            if Double(now() - firstObserved!) / 1_000_000 >= 100 {
                timings["verification"] = ms(verification)
                return result("confirmed", "exact_value_and_cursor_stable", ["mutations": 1, "axError": error.rawValue, "method": target.method])
            }
        } else {
            firstObserved = nil
        }
        tick()
    } while Date() < deadline && !target.app.isTerminated
    timings["verification"] = ms(verification)
    return result("unresolved", "mutation_not_confirmed", ["mutations": 1, "axError": error.rawValue])
}
/// Pastes only when this is still the place the user was working. A refusal keeps the target,
/// so the transcript can be offered again; an explicit request moves focus back and starts over.
func insertAdaptive(_ target: Target, _ insertability: String, _ operation: String, _ text: String, explicit: Bool,
                    _ result: (String, String, [String: Any]) -> [String: Any], _ mark: (String, Double) -> Void) -> [String: Any] {
    let pid = target.app.processIdentifier
    if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
        guard explicit else { return result("not_dispatched", "target_not_active", ["mutations": 0]) }
        let activation = now()
        target.app.activate(options: [])
        let activationDeadline = Date(timeIntervalSinceNow: 0.75)
        while NSWorkspace.shared.frontmostApplication?.processIdentifier != pid && Date() < activationDeadline { tick() }
        mark("activation", ms(activation))
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return result("not_dispatched", "target_not_active", ["mutations": 0]) }
    }
    guard explicit || insertability != "secure" else { return result("not_dispatched", "secure_field", ["mutations": 0]) }
    let preflight = now()
    let ax = AXUIElementCreateApplication(pid); AXUIElementSetMessagingTimeout(ax, 0.3)
    let current = focused(ax)
    var currentWindow: AXUIElement?
    if let value = attr(ax, kAXFocusedWindowAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() { currentWindow = unsafeBitCast(value, to: AXUIElement.self) }
    if !explicit {
        // Text and selection may have moved on inside the same field; another field is another destination.
        if let element = target.element { guard let current, CFEqual(current, element) else { return result("not_dispatched", "focus_moved", ["mutations": 0]) } }
        else if let window = target.window { guard let currentWindow, CFEqual(currentWindow, window) else { return result("not_dispatched", "focus_moved", ["mutations": 0]) } }
    }
    let state = inspect(current)
    mark("preflight", ms(preflight))
    guard state.insertability != "secure" else { return result("not_dispatched", "secure_field", ["mutations": 0]) }
    if !explicit && insertability == "verified" {
        guard state.insertability == "verified" else { return result("not_dispatched", "field_unreadable", ["mutations": 0]) }
        // Pasting over text selected after the press would erase something the user never offered.
        guard state.range.length == 0 || (state.range.location == target.selection.location && state.range.length == target.selection.length && state.text == target.text)
        else { return result("not_dispatched", "selection_changed", ["mutations": 0]) }
    }
    let verified = state.insertability == "verified"
    guard verified || !IsSecureEventInputEnabled() else { return result("not_dispatched", "secure_field", ["mutations": 0]) }
    guard CGPreflightPostEventAccess() else { return result("not_dispatched", "event_permission", ["mutations": 0]) }
    guard NSPasteboard.general.string(forType: .string) == text else { return result("not_dispatched", "clipboard_changed", ["mutations": 0]) }
    let source = CGEventSource(stateID: .privateState)
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false) else { return result("not_dispatched", "event_construction_failed", ["mutations": 0]) }
    down.flags = .maskCommand; up.flags = .maskCommand
    dispatched.insert(operation); captured = nil
    let mutation = now()
    down.postToPid(pid); up.postToPid(pid)
    mark("mutation", ms(mutation))
    // Nothing in this target can be read back, so the honest answer is that it was sent.
    guard verified, let field = current else { return result("unverified", "target_not_readable", ["mutations": 1, "method": target.method]) }
    let expected = (state.text as NSString).replacingCharacters(in: NSRange(location: state.range.location, length: state.range.length), with: text)
    let expectedCursor = state.range.location + (text as NSString).length
    let verification = now(), deadline = Date(timeIntervalSinceNow: 1.2)
    var firstObserved: UInt64?, exact = false
    repeat {
        let sameFocus = focused(ax).map { CFEqual($0, field) } ?? false
        let observed = logicalText(field), cursor = selection(field)
        exact = sameFocus && observed == expected && cursor?.location == expectedCursor && cursor?.length == 0
        if exact || (sameFocus && cursor?.length == 0 && observed.map { landed($0, state.text, state.range, text) } == true) {
            if firstObserved == nil { firstObserved = now(); mark("first_expected_observation", ms(verification)) }
            if Double(now() - firstObserved!) / 1_000_000 >= 100 {
                mark("verification", ms(verification))
                return result("confirmed", exact ? "exact_value_and_cursor_stable" : "normalized_by_target", ["mutations": 1, "method": target.method])
            }
        } else { firstObserved = nil }
        tick()
    } while Date() < deadline && !target.app.isTerminated
    mark("verification", ms(verification))
    return result("unresolved", "mutation_not_confirmed", ["mutations": 1])
}
NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
    if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication { emit(["type": "frontmost", "pid": app.processIdentifier]) }
}
emit(["type":"ready", "protocol":3, "method":"explicit_strategy", "pid":ProcessInfo.processInfo.processIdentifier])
DispatchQueue.global(qos: .userInitiated).async {
while let line = readLine() {
    guard line.utf8.count <= 1_100_000, let data = line.data(using: .utf8),
          let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        emit(["requestId":"invalid", "state":"not_dispatched", "reason":"invalid_json"]); continue
    }
    if request["type"] as? String == "quit" { DispatchQueue.main.async { exit(0) }; return }
    DispatchQueue.main.async { autoreleasepool { emit(handle(request)) } }
}
DispatchQueue.main.async { exit(0) }
}
RunLoop.main.run()
