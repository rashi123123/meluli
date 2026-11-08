# Decisions behind Meluli 2.0

Meluli 2.0 replaced the Electron shell of 0.1 with a native host. These are the decisions that shaped it, kept under the numbers the code cites (`D20` and so on). Entries about prototypes and measurements that no longer apply are left out, so the numbers have gaps. Figures were measured on an Apple M3 with 24 GB on macOS 27.0.1 with the person's usual apps open; see [benchmarks](BENCHMARKS.md).

## D11. The native host opens the same database with macOS's own SQLite

The app's migrations and `TranscriptRepository` (better-sqlite3) and a Swift client linked to the system SQLite (FTS5 compiled in) were run against the same file. The 16 search strings the repository sends to `MATCH` return the same rows in the same order, writes from either side go through the app's triggers, and FTS5's integrity check passes on both. The database needs no format change to move between hosts, and history from 0.1 opens unchanged. FTS5's secure-delete option stays off.

`native/host/HostSQLite.swift` puts macOS's SQLite behind the part of better-sqlite3's API the app uses.

## D14. A native host instead of Electron

An idle Electron build held 118.9 MiB in five processes with its window closed. A native host that loads the UI only while a window is open measured 12–14 MiB in one process before and after dictations, and the text pipeline and database carried over unchanged (D11). The work went ahead on that evidence, gated on real paste, a real shortcut, calls and the full UI in WKWebView.

## D19. Microphone input is the raw device, without Apple's voice processing

Apple's voice processing (echo cancellation and noise suppression) ducks other apps' sound and, on the same audio, got 10 of 14 words where the raw input got 13. The app records the raw input, as Chromium did in 0.1.

## D20. `src/main` runs in JavaScriptCore inside the native host

The main-process TypeScript runs unchanged in one JavaScriptCore context on its own thread, over a Node and Electron surface written for exactly what `src/main` imports. The HUD and capture stay in the app.

- One copy of the logic. The journal, flows, kept audio, text rules and the test suite stay the authority. A Swift port would keep two copies, and drift in the journal is what costs a double paste.
- JavaScriptCore is part of macOS, so the app ships no JavaScript engine.
- Rejected: porting the services to Swift (two copies), and embedding Node (a second runtime of about 90 MB on disk, with its own idle cost).
- `scripts/meluli2/native-host-conformance.mjs` runs the same checks in Node and in the host and requires identical results. One difference is accepted by design: `process.nextTick` runs in the microtask queue, not before it.

Idle with the window closed, as a release ships: 59.0 MiB in two processes (the app and the hold-key helper), 0% CPU, about one wakeup a second.

## D21. Dictation captures through the window's web audio

The first native release records through the React overlay and `getUserMedia` in WKWebView, the code the test suite covers. A fully native capture and HUD would save about 43 MiB more and remain a later step behind the same recording handlers.

- WebKit treats a window covered by others as hidden and holds `getUserMedia` until it is shown, so the host turns WebKit's occlusion detection off for its pages.
- The page always gets the raw input (D19).
- The window's record button passes unattended through a loopback device (`scripts/meluli2/native-app-record-e2e.mjs`). The runner kills the app if any other input opens, so a fallback to the default input never records the room.

## D22. Release packaging keeps the same names, checks and minimum system

`scripts/meluli2/package-native-release.sh` produces what the Electron packaging did: `Meluli-<version>-arm64.{zip,dmg}`, `releases.json` and `SHA256SUMS.txt`, signed with Developer ID and a secure timestamp, notarized and stapled. `verify-release-artifacts.sh` is unchanged, and `check-release-output.py` recognizes the native bundle.

- The bundle identifier, the application support folder (`IvritMenuBar`), the keychain item and its "v10" format, the archive name and the designated requirement stay the same. An Electron copy's history, saved keys and permissions carry over, and its updater can install the native app.
- The minimum system stays macOS 13.3, so an update never installs an app that cannot launch on the Mac that took it. The JavaScript is lowered to Safari 16.4. No macOS 13 Mac has been tested.
- A release leaves out the link-import helper, as 0.1 did, and ships no source maps.
- The native updater (`native/host/app/Updater.swift`) keeps Squirrel's rules: GitHub hosts only, the archive's app must satisfy the running app's designated requirement, the same identifier and the named version. The swap keeps the old app until the new one is in place.

## D24. The streaming engine is an opt-in choice; Whisper stays the default

The streaming zipformer (`ivrit-ai/zipformer2-66m-streaming-he`) was measured against production Whisper on identical audio (270 clips, 36 minutes). It is 3.08 percentage points worse on word error rate (confidence upper bound 4.49, and 8.15 worse on mixed Hebrew and English), so it does not replace Whisper. It stops in 32 ms against 1497 ms at the median, shows live text, uses 287 MiB against 1010 MiB, and is 12.5 points better on long recordings.

Settings → Transcription offers "מדויק" (Whisper, the default) or "מהיר וקל (ניסיוני)". Release packages ship the streaming worker and its licenses; its model downloads only after the choice. `MELULI_ASR_ENGINE` overrides the choice only in development runs.
