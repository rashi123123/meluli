// Watches one modifier key for hold-to-talk. The tap listens to flagsChanged only, so no keystroke
// ever reaches this process, and stdout is a closed list of states that carries no key data.
import CoreGraphics
import Darwin
import Foundation

struct WatchedKey {
    let code: Int64
    /// The device-dependent bit that tells the right key from the left one.
    let deviceMask: UInt64
    let otherModifiers: UInt64
}

let sideIndependent = CGEventFlags.maskShift.rawValue | CGEventFlags.maskControl.rawValue
let keys = [
    "right_option": WatchedKey(code: 0x3D, deviceMask: 0x40, otherModifiers: sideIndependent | CGEventFlags.maskCommand.rawValue | 0x20),
    "right_command": WatchedKey(code: 0x36, deviceMask: 0x10, otherModifiers: sideIndependent | CGEventFlags.maskAlternate.rawValue | 0x08)
]
let armingDelay = 0.15
let hardwareState = Int64(CGEventSourceStateID.hidSystemState.rawValue)

func emit(_ type: String, reason: String? = nil) {
    print(reason.map { "{\"reason\":\"\($0)\",\"type\":\"\(type)\"}" } ?? "{\"type\":\"\(type)\"}")
    fflush(stdout)
}

var watched: WatchedKey?
var tap: CFMachPort?
var isDown = false
var chorded = false
var reported = false
var isPhysical = false
var pressedAt = DispatchTime.now()
var arming: DispatchWorkItem?

func secondsSincePress() -> Double {
    Double(DispatchTime.now().uptimeNanoseconds - pressedAt.uptimeNanoseconds) / 1_000_000_000
}

/** Checked once the delay ends, so Option+key and Option+drag never read as a hold. */
func anythingElseHappened() -> Bool {
    let held = secondsSincePress()
    return [CGEventType.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown].contains {
        CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) < held
    }
}

func release() {
    arming?.cancel()
    arming = nil
    isDown = false
    if reported {
        reported = false
        emit("up")
    }
}

func arm() {
    guard isDown, !chorded, !reported, !anythingElseHappened() else { return }
    reported = true
    emit("down")
}

func handleFlags(_ event: CGEvent) {
    guard let key = watched else { return }
    let code = event.getIntegerValueField(.keyboardEventKeycode)
    guard code == key.code else {
        if isDown && !reported { chorded = true }
        return
    }

    let flags = event.flags.rawValue
    let pressed = flags & key.deviceMask != 0
    if pressed == isDown { return }
    guard pressed else {
        release()
        return
    }

    isDown = true
    chorded = flags & key.otherModifiers != 0
    isPhysical = event.getIntegerValueField(.eventSourceStateID) == hardwareState
    pressedAt = DispatchTime.now()
    let work = DispatchWorkItem(block: arm)
    arming = work
    DispatchQueue.main.asyncAfter(deadline: .now() + armingDelay, execute: work)
}

/** A lost key-up must not leave the microphone open. A posted event has no physical key to check. */
func reconcile() {
    guard let key = watched, isDown, isPhysical else { return }
    if !CGEventSource.keyState(.hidSystemState, key: CGKeyCode(key.code)) { release() }
}

let callback: CGEventTapCallBack = { _, type, event, _ in
    switch type {
    case .flagsChanged:
        handleFlags(event)
    case .tapDisabledByTimeout, .tapDisabledByUserInput:
        if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
        reconcile()
    default:
        break
    }
    return Unmanaged.passUnretained(event)
}

func fail(_ reason: String) -> Never {
    release()
    emit("error", reason: reason)
    exit(3)
}

func startTap() {
    guard tap == nil else { return }
    guard CGPreflightListenEventAccess() else { fail("permission") }
    guard let created = CGEvent.tapCreate(
        tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
        eventsOfInterest: CGEventMask(1) << CGEventType.flagsChanged.rawValue, callback: callback, userInfo: nil
    ) else { fail("tap") }
    tap = created
    CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, created, 0), .commonModes)
    CGEvent.tapEnable(tap: created, enable: true)
    emit("ready")
}

func handleLine(_ line: String) {
    guard let data = line.data(using: .utf8),
          let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          message["type"] as? String == "watch",
          let name = message["key"] as? String, let key = keys[name] else {
        fail("input")
    }
    release()
    watched = key
    startTap()
}

switch CommandLine.arguments.dropFirst().first {
case "--check":
    print(CGPreflightListenEventAccess() ? "granted" : "denied")
    exit(0)
case "--request":
    print(CGRequestListenEventAccess() ? "granted" : "denied")
    exit(0)
case "--self-test":
    guard keys.count == 2, keys.values.allSatisfy({ $0.otherModifiers & $0.deviceMask == 0 }) else { exit(1) }
    print("ok")
    exit(0)
default:
    break
}

let checks = DispatchSource.makeTimerSource(queue: .main)
checks.schedule(deadline: .now() + 0.25, repeating: 0.25)
var ticks = 0
checks.setEventHandler {
    reconcile()
    ticks += 1
    if ticks % 20 == 0, tap != nil, !CGPreflightListenEventAccess() { fail("permission") }
}
checks.resume()

DispatchQueue.global(qos: .utility).async {
    while let line = readLine() {
        DispatchQueue.main.async { handleLine(line) }
    }
    exit(0)
}
CFRunLoopRun()
