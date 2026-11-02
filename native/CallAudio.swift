// Reports which listed apps use audio, and records the microphone and one app's audio as two tracks.
// stdout is a closed list of events without audio data. Audio goes only to the folder the app names.
import AVFoundation
import CoreAudio
import Darwin
import Foundation

let systemObject = AudioObjectID(kAudioObjectSystemObject)
let stallSeconds = 2.5
/// Starting a stream can itself report a change, so each stream restarts at most this often.
let restartSeconds = 5.0
/// Quieter than this is the digital silence of a tap that has nothing to hear.
let audibleSample: Int32 = 64

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func emit(_ fields: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: fields, options: .sortedKeys),
          let text = String(data: data, encoding: .utf8) else { return }
    print(text)
    fflush(stdout)
}

func emitError(_ reason: String, id: Int? = nil) {
    var fields: [String: Any] = ["type": "error", "reason": reason]
    if let id { fields["id"] = id }
    emit(fields)
}

func audioProcesses() -> [AudioObjectID] {
    var property = address(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(systemObject, &property, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(systemObject, &property, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

func flag(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> Bool {
    var property = address(selector)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(object, &property, 0, nil, &size, &value) == noErr && value != 0
}

func bundleId(_ object: AudioObjectID) -> String {
    var property = address(kAudioProcessPropertyBundleID)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(object, &property, 0, nil, &size, &value) == noErr, let value else { return "" }
    return value.takeRetainedValue() as String
}

func matching(_ prefixes: [String]) -> [AudioObjectID] {
    audioProcesses().filter { process in
        let bundle = bundleId(process)
        return prefixes.contains { bundle.hasPrefix($0) }
    }
}

func defaultOutputUID() -> String? {
    var property = address(kAudioHardwarePropertyDefaultOutputDevice)
    var device: AudioObjectID = 0
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(systemObject, &property, 0, nil, &size, &device) == noErr else { return nil }
    var uidProperty = address(kAudioDevicePropertyDeviceUID)
    var uid: Unmanaged<CFString>?
    size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(device, &uidProperty, 0, nil, &size, &uid) == noErr, let uid else { return nil }
    return uid.takeRetainedValue() as String
}

/// 16 kHz mono PCM, the format the transcription worker reads. The header is refreshed as the file
/// grows, so a crash leaves a file that still opens.
final class WavFile {
    private let file: UnsafeMutablePointer<FILE>
    private var bytes: UInt32 = 0
    private var bytesAtLastHeader: UInt32 = 0

    init?(path: String) {
        guard let file = fopen(path, "wb") else { return nil }
        self.file = file
        writeHeader()
    }

    private func writeHeader() {
        var header = Data()
        func text(_ value: String) { header.append(value.data(using: .ascii)!) }
        func u32(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { header.append(contentsOf: $0) } }
        func u16(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { header.append(contentsOf: $0) } }
        text("RIFF"); u32(36 + bytes); text("WAVE"); text("fmt "); u32(16); u16(1); u16(1)
        u32(16_000); u32(32_000); u16(2); u16(16); text("data"); u32(bytes)
        let position = ftell(file)
        fseek(file, 0, SEEK_SET)
        header.withUnsafeBytes { _ = fwrite($0.baseAddress, 1, header.count, file) }
        fseek(file, max(position, 44), SEEK_SET)
        fflush(file)
        bytesAtLastHeader = bytes
    }

    func append(_ samples: UnsafePointer<Int16>, count: Int) {
        fwrite(samples, MemoryLayout<Int16>.size, count, file)
        bytes += UInt32(count * MemoryLayout<Int16>.size)
        if bytes - bytesAtLastHeader >= 320_000 { writeHeader() }
    }

    func close() {
        writeHeader()
        fclose(file)
    }
}

final class Track {
    private let wav: WavFile
    private let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
    private var converter: AVAudioConverter?
    private var frames: Int64 = 0
    private(set) var firstHostTime: UInt64 = 0
    private(set) var lastAudio = Date()
    private(set) var heard = false

    init?(path: String) {
        guard let wav = WavFile(path: path) else { return nil }
        self.wav = wav
    }

    func append(_ buffer: AVAudioPCMBuffer, hostTime: UInt64) {
        if firstHostTime == 0 { firstHostTime = hostTime }
        lastAudio = Date()
        fillGap(until: hostTime)
        if converter == nil || converter?.inputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: output)
            converter?.downmix = true
        }
        guard let converter else { return }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 16_000 / buffer.format.sampleRate) + 64
        guard let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return }
        var served = false
        var failure: NSError?
        converter.convert(to: converted, error: &failure) { _, status in
            if served {
                status.pointee = .noDataNow
                return nil
            }
            served = true
            status.pointee = .haveData
            return buffer
        }
        guard failure == nil, let samples = converted.int16ChannelData?[0] else { return }
        let count = Int(converted.frameLength)
        wav.append(samples, count: count)
        frames += Int64(count)
        if !heard { heard = (0..<count).contains { abs(Int32(samples[$0])) > audibleSample } }
    }

    /// A device change stops the stream for a moment. Silence keeps later speech at its real time.
    private func fillGap(until hostTime: UInt64) {
        let elapsed = AVAudioTime.seconds(forHostTime: hostTime) - AVAudioTime.seconds(forHostTime: firstHostTime)
        let missing = Int64(elapsed * 16_000) - frames
        guard missing > 1_600 else { return }
        let silence = [Int16](repeating: 0, count: 1_600)
        var remaining = missing
        while remaining > 0 {
            let count = Int(min(remaining, 1_600))
            silence.withUnsafeBufferPointer { wav.append($0.baseAddress!, count: count) }
            remaining -= Int64(count)
        }
        frames += missing
    }

    func close() { wav.close() }
}

final class Recording {
    private let engine = AVAudioEngine()
    private let queue = DispatchQueue(label: "meluli.call.tap")
    private let mic: Track
    private let system: Track
    private let prefixes: [String]
    private var description: CATapDescription?
    private var targets: [AudioObjectID] = []
    private var tap: AudioObjectID = 0
    private var aggregate: AudioObjectID = 0
    private var ioProc: AudioDeviceIOProcID?
    private var lastMicrophoneRestart = Date.distantPast
    private var lastTapRestart = Date.distantPast

    init?(directory: String, prefixes: [String]) {
        guard let mic = Track(path: "\(directory)/mic.wav"), let system = Track(path: "\(directory)/system.wav") else { return nil }
        self.mic = mic
        self.system = system
        self.prefixes = prefixes
        NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            self?.restartMicrophone()
        }
        if !startMicrophone() { emitError("microphone") }
        if !startTap() { emitError("tap") }
    }

    private func startMicrophone() -> Bool {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else { return false }
        input.installTap(onBus: 0, bufferSize: 4_096, format: format) { [weak self] buffer, time in
            self?.mic.append(buffer, hostTime: time.hostTime)
        }
        return (try? engine.start()) != nil
    }

    private func restartMicrophone() {
        guard Date().timeIntervalSince(lastMicrophoneRestart) > restartSeconds else { return }
        lastMicrophoneRestart = Date()
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        engine.reset()
        _ = startMicrophone()
    }

    private func startTap() -> Bool {
        targets = matching(prefixes)
        let description = CATapDescription(monoMixdownOfProcesses: targets)
        description.name = "Meluli call"
        description.isPrivate = true
        description.muteBehavior = CATapMuteBehavior.unmuted
        self.description = description
        guard AudioHardwareCreateProcessTap(description, &tap) == noErr, let output = defaultOutputUID() else { return false }

        let aggregateDescription: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Meluli call",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: output,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: output]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: description.uuid.uuidString
            ]]
        ]
        guard AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregate) == noErr else { return false }

        // The tap reports its own rate, but buffers arrive at the device's. Trusting the tap shifts the pitch.
        var formatProperty = address(kAudioTapPropertyFormat)
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        guard AudioObjectGetPropertyData(tap, &formatProperty, 0, nil, &size, &asbd) == noErr else { return false }
        var rateProperty = address(kAudioDevicePropertyNominalSampleRate)
        var deviceRate: Float64 = 0
        size = UInt32(MemoryLayout<Float64>.size)
        if AudioObjectGetPropertyData(aggregate, &rateProperty, 0, nil, &size, &deviceRate) == noErr, deviceRate > 0 {
            asbd.mSampleRate = deviceRate
        }
        guard let format = AVAudioFormat(streamDescription: &asbd) else { return false }

        let status = AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggregate, queue) { [weak self] _, input, inputTime, _, _ in
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: input) else { return }
            self?.system.append(buffer, hostTime: inputTime.pointee.mHostTime)
        }
        guard status == noErr, let ioProc else { return false }
        return AudioDeviceStart(aggregate, ioProc) == noErr
    }

    private func stopTap() {
        if let ioProc {
            AudioDeviceStop(aggregate, ioProc)
            AudioDeviceDestroyIOProcID(aggregate, ioProc)
        }
        ioProc = nil
        if aggregate != 0 { AudioHardwareDestroyAggregateDevice(aggregate) }
        aggregate = 0
        if tap != 0 { AudioHardwareDestroyProcessTap(tap) }
        tap = 0
        queue.sync {}
    }

    /// A call app can start a new audio process mid-call, and a stream can end with no notification.
    func check() {
        let now = Date()
        if now.timeIntervalSince(mic.lastAudio) > stallSeconds { restartMicrophone() }
        if now.timeIntervalSince(system.lastAudio) > stallSeconds {
            guard now.timeIntervalSince(lastTapRestart) > restartSeconds else { return }
            lastTapRestart = now
            stopTap()
            if !startTap() { emitError("tap") }
            return
        }
        let current = matching(prefixes)
        guard Set(current) != Set(targets), tap != 0, let description else { return }
        description.processes = current
        var property = address(kAudioTapPropertyDescription)
        var reference = Unmanaged.passUnretained(description)
        let status = AudioObjectSetPropertyData(tap, &property, 0, nil, UInt32(MemoryLayout<Unmanaged<CATapDescription>>.size), &reference)
        if status == noErr { targets = current }
    }

    func stop(id: Int = 0) {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        stopTap()
        mic.close()
        system.close()
        let starts = [mic.firstHostTime, system.firstHostTime].filter { $0 != 0 }
        let earliest = starts.min() ?? 0
        func offset(_ track: Track) -> Double {
            guard track.firstHostTime != 0 else { return 0 }
            return (AVAudioTime.seconds(forHostTime: track.firstHostTime) - AVAudioTime.seconds(forHostTime: earliest)) * 1_000
        }
        emit(["type": "stopped", "id": id, "micOffsetMs": offset(mic), "systemOffsetMs": offset(system), "systemHeard": system.heard])
    }
}

var watched: [String] = []
var reportedApps = ""
var recording: Recording?

/// Only apps on the list leave this process, so what else uses audio stays private.
func reportApps() {
    var apps: [String: (input: Bool, output: Bool)] = [:]
    for process in matching(watched) {
        let id = bundleId(process)
        let current = apps[id] ?? (false, false)
        apps[id] = (
            current.input || flag(process, kAudioProcessPropertyIsRunningInput),
            current.output || flag(process, kAudioProcessPropertyIsRunningOutput)
        )
    }
    let active = apps.filter { $0.value.input || $0.value.output }.sorted { $0.key < $1.key }
    let summary = active.map { "\($0.key):\($0.value.input):\($0.value.output)" }.joined(separator: ",")
    guard summary != reportedApps else { return }
    reportedApps = summary
    emit(["type": "apps", "apps": active.map { ["id": $0.key, "input": $0.value.input, "output": $0.value.output] }])
}

func stringList(_ value: Any?) -> [String] { (value as? [String]) ?? [] }

func handle(_ line: String) {
    guard let data = line.data(using: .utf8),
          let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let type = message["type"] as? String else {
        emitError("input")
        return
    }
    switch type {
    case "watch":
        watched = stringList(message["prefixes"]).filter { !$0.isEmpty }
        reportedApps = ""
        reportApps()
    case "start":
        guard let id = message["id"] as? Int else {
            emitError("input")
            return
        }
        // Every bundle id has the empty prefix, so one empty entry would record all audio on the Mac.
        let prefixes = stringList(message["prefixes"])
        guard recording == nil, let directory = message["directory"] as? String,
              !prefixes.isEmpty, !prefixes.contains(where: \.isEmpty) else {
            emitError("input", id: id)
            return
        }
        recording = Recording(directory: directory, prefixes: prefixes)
        if recording == nil { emitError("disk", id: id) } else { emit(["type": "started", "id": id]) }
    case "stop":
        recording?.stop(id: message["id"] as? Int ?? 0)
        recording = nil
    default:
        emitError("input")
    }
}

if CommandLine.arguments.contains("--self-test") {
    print(audioProcesses().isEmpty ? "failed" : "ok")
    exit(0)
}

signal(SIGPIPE, SIG_IGN)
DispatchQueue.global().async {
    while let line = readLine() {
        DispatchQueue.main.async { handle(line) }
    }
    DispatchQueue.main.async {
        recording?.stop()
        exit(0)
    }
}
Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
    reportApps()
    recording?.check()
}
emit(["type": "ready"])
RunLoop.main.run()
