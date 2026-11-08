// Plays a WAV file through one named output device (for the self-run microphone test, the Mac's
// built-in speakers), so the default output, which may be headphones, is left alone.
// Build: swiftc -O -o .build/mic-selftest/player native/tests/audio-player.swift
//   player <device name> <wav>
//   player --running <device name>   prints whether any process has the input device running
//   player --inputs                  prints every input device and whether it is running
import AVFoundation
import CoreAudio

let arguments = CommandLine.arguments
func audioDevice(named name: String, input: Bool) -> AudioDeviceID? {
  var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return nil }
  var devices = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &devices) == noErr else { return nil }
  for device in devices {
    var nameAddress = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var cfName: Unmanaged<CFString>?
    var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(device, &nameAddress, 0, nil, &nameSize, &cfName) == noErr,
          let deviceName = cfName?.takeRetainedValue() as String?, deviceName == name else { continue }
    var streams = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: input ? kAudioDevicePropertyScopeInput : kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
    var streamSize: UInt32 = 0
    if AudioObjectGetPropertyDataSize(device, &streams, 0, nil, &streamSize) == noErr, streamSize > 0 { return device }
  }
  return nil
}
func isRunning(_ device: AudioDeviceID) -> Bool {
  var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var running: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  AudioObjectGetPropertyData(device, &address, 0, nil, &size, &running)
  return running != 0
}
if arguments.count == 2, arguments[1] == "--inputs" {
  var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size)
  var devices = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &devices)
  var entries: [[String: Any]] = []
  for device in devices {
    var streams = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
    var streamSize: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(device, &streams, 0, nil, &streamSize) == noErr, streamSize > 0 else { continue }
    var nameAddress = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var name: Unmanaged<CFString>?
    var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    AudioObjectGetPropertyData(device, &nameAddress, 0, nil, &nameSize, &name)
    entries.append(["name": (name?.takeRetainedValue() as String?) ?? "", "running": isRunning(device)])
  }
  print(String(data: try! JSONSerialization.data(withJSONObject: entries), encoding: .utf8)!)
  exit(0)
}
if arguments.count == 3, arguments[1] == "--running" {
  guard let device = audioDevice(named: arguments[2], input: true) else { print("{\"error\":\"device_not_found\"}"); exit(2) }
  print("{\"running\":\(isRunning(device))}")
  exit(0)
}
guard arguments.count == 3, var device = audioDevice(named: arguments[1], input: false) else { print("{\"error\":\"device_not_found\"}"); exit(2) }
let file = try! AVAudioFile(forReading: URL(fileURLWithPath: arguments[2]))
let engine = AVAudioEngine()
let player = AVAudioPlayerNode()
guard AudioUnitSetProperty(engine.outputNode.audioUnit!, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr else { print("{\"error\":\"set_device\"}"); exit(3) }
engine.attach(player)
engine.connect(player, to: engine.mainMixerNode, format: file.processingFormat)
try! engine.start()
let done = DispatchSemaphore(value: 0)
let seconds = Double(file.length) / file.processingFormat.sampleRate
// Apple's voice processing in another app reconfigures the built-in devices, which stops this
// engine; it is restarted, and the wait is bounded either way.
var restarts = 0
let observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { _ in
  restarts += 1
  if !engine.isRunning { try? engine.start(); player.play() }
}
player.scheduleFile(file, at: nil, completionCallbackType: .dataPlayedBack) { _ in done.signal() }
player.play()
let finished = done.wait(timeout: .now() + seconds + 4) == .success
NotificationCenter.default.removeObserver(observer)
engine.stop()
print("{\"played\":\(seconds),\"finished\":\(finished),\"restarts\":\(restarts)}")
