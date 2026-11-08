# native — Swift and C++ outside JavaScript

| Where | What |
|---|---|
| `host/` | The Swift app (D20): `Runtime.swift` runs the bundled main process in JavaScriptCore; `Host*.swift` give it files, processes, SQLite, crypto and fetch; `Electron/` gives it windows, menus, shortcuts and updates; `app/main.swift` is the app entry; `cli/main.swift` is `meluli-js`, used by the conformance checks. |
| `CallAudio.swift` | Helper: which apps use audio; records mic + one app as two tracks. |
| `ClipboardBridge.swift` | Helper: clipboard snapshot, write and restore for paste. |
| `HoldKey.swift` | Helper: watches one modifier key for hold-to-talk. |
| `NativeInsertion.swift` | Helper: verified paste, one Cmd-V, no retry. |
| `whisper-worker.cpp`, `CMakeLists.txt` | The ASR worker over whisper.cpp. |
| `youtube-entry.py`, `youtube-requirements.*` | The YouTube download helper. |
| `tests/` | Worker guard and latency probes. |

The helpers speak line protocols over stdin/stdout; their TypeScript clients are in
`src/main/services` (`insertion/clipboard-bridge.service.ts`, `hold-key.service.ts`,
`insertion/native-insertion-client.ts`, `calls/call-audio.client.ts`). The protocols must stay byte-identical.
