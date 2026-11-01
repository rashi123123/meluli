# Architecture

Meluli keeps Electron's renderer isolated from filesystem, process and database access. Main-process IPC handlers validate the sending window and payload. The preload exposes a typed API; the historical `ivritMenuBar` API name remains internal for compatibility.

## Dictation lifecycle

1. A shortcut or record button requests recording ownership from the main process. Only one renderer owns capture.
2. The model prewarms while the renderer records. The AudioWorklet transfers batches of PCM samples; stop flushes the partial final batch before WAV encoding.
3. The main workflow converts audio and sends a request to one local worker. Admission remains closed until processing, persistence and any automatic paste settle.
4. The result, raw text, model identity and available timed segments are saved to SQLite. TXT mirrors are secondary to the database result.
5. The floating flow pastes only into the previously captured external application. The nonactivating panel releases key focus before a bounded activation of the captured PID and bundle identifier. A native clipboard lease restores prior formats if the user has not made a newer copy. Failed paste retains the transcript for recovery.
6. An idle timer releases the worker after five minutes. Recording and processing prevent idle release. App shutdown cancels work and closes resources before SQLite closes.

The floating-window shortcut starts recording and stops it again, the same as the recording shortcut; the tray opens the window idle. The window stays available across focus changes, preserves its dragged position within the session, and clamps to the available display area. Cancellation is explicit; blur does not hide an active recorder.

## Paste outcomes

A native helper records the frontmost app and, where it can read one, the focused text field. When pasting, it checks that the same app is in front, that a readable field still matches and that the field is not secure. It sends Command-V with the physical V key code so the current input source does not matter, then reads the field to confirm the text arrived. A field it cannot read still gets the paste, with no confirmation afterwards. Text goes nowhere on its own after a refusal: the floating window keeps it and a second paste takes a deliberate press. Research profiles keep the strict single-attempt client.

If the helper cannot run, production falls back to AppleScript. Each attempt ends in one of these states:

| Outcome | Meaning | Allowed next step |
|---|---|---|
| `confirmed` | The helper saw the text in the field | None; the window closes without a message |
| `dispatched_unverified` | Sent to a field that cannot be read | None; the window closes without a message, and the text stays in Home and History |
| `command_completed_unverified` | AppleScript finished, arrival unknown | None; the window closes without a message, and the text stays in Home and History |
| `not_dispatched` | Proven not to have been sent | Deliberate paste, unless the target is gone or secure |
| `unresolved` | May have been sent | Copy only |

See [known limitations](KNOWN-LIMITATIONS.md) for what these checks do not guarantee.

## Storage compatibility

Product name and storage identity are separate. `IvritMenuBar` and `ivrit-menu-bar.sqlite` remain stable. Schema updates execute in a transaction; an existing older database receives a consistent `VACUUM INTO` backup before migration. FTS5 indexes text and metadata for Hebrew history search. Old records without timed segments remain readable, but cannot provide meaningful SRT timing. The `backend` column keeps the values `ct2` and `nemo` for transcripts from retired engines; the app no longer runs those engines.

## Calls

`meluli-callaudio` is a Swift helper driven over JSON lines on stdio. It reports which allowlisted applications hold an input or output (no permission needed) and, on request, writes `mic.wav` and `system.wav`. The system track comes from a CoreAudio process tap that targets only the call application's processes, read through a private aggregate device. A one-second timer restarts a stalled source and retargets the tap as processes come and go.

`CallDetector` turns those reports into a suggestion after 3 s and an end after 30 s with neither input nor output. `CallService` owns the session, and a separate unfocusable window shows the suggestion and the running indicator. Nothing starts without `callAccept`.

After the call, `call-pieces` finds speech on each track and plans pieces of up to 4 minutes, and `transcribeCall` sends them through the worker one at a time, saving progress after each. `TranscriptionService.transcribeBackground` runs them at low priority: a recording or foreground job cancels the running piece, which is repeated once the model is free. `call-transcript` removes lines the microphone heard from the speakers, merges the tracks by time and formats turns. Audio is deleted only after the transcript is saved.

## Engine boundary

The selected Preview runtime is a statically linked arm64 whisper.cpp 1.9.5 worker with embedded Metal shaders and the pinned Hebrew Turbo Q8 model. It uses two CPU threads, beam size one and segment timestamps. It converts WAV in bounded chunks into one allocated PCM buffer; total PCM memory grows by approximately 230 MB per hour of imported audio. This does not claim constant-memory streaming. The production worker protocol covers ready/health, warmup, transcribe, cancellation and process release. Cancellation can terminate a worker that cannot interrupt inference safely. Only the selected runtime belongs in the distributed app. Development builds can opt into an isolated research profile through environment settings; packaged builds refuse it.

On macOS the native worker explicitly requests `IOPOL_STANDARD` for its disk reads: work initiated by the user while another editor may be in the foreground. The worker reports the applied policy in its readiness event. This does not raise CPU priority, hold the display awake or change idle model release. Earlier validation observed cold-load timeouts under extreme host load; a later successful run also had lower host load, so no controlled speedup is attributed to this policy alone.
