# Privacy and local data

Meluli is designed to perform speech recognition locally. It has no intended cloud ASR or cloud text-processing fallback, analytics account or telemetry collector.

The Hebrew privacy page in the app (`privacyPageSections` in `src/shared/locale.ts`) states the same facts for users. Change them together.

## Network use

- Development dependency installation and model/tool downloads contact their upstream package hosts.
- Initial model setup downloads public model assets from an immutable revision. Every required file is checked against its expected size and SHA-256 before it is accepted. On later runs, the first model use verifies the files again; metadata changes invalidate the in-process verification cache.
- Link imports, available when the optional helper is built, contact the site you paste and its media endpoints through that helper. The URL and ordinary request metadata are visible to those services. Audio is downloaded, then transcribed locally.
- Automatic updates, when on, periodically fetch a small version file and any new app archive from the release host, which sees ordinary request metadata such as the IP address. No audio, transcript or dictionary data is sent. They can be turned off in Settings.
- Opening a documentation link uses the user's external browser.

Offline transcription and packaged runtime independence are release acceptance checks. Their completion must be recorded in the release report rather than inferred from UI tests.

## What remains on disk

The legacy `IvritMenuBar` application-support folder holds the SQLite database, text mirrors, model assets and migration backups. History can contain transcript text, source titles and URLs, model identity and timed segments. These files are not encrypted by Meluli; device encryption and account access are managed by macOS.

TXT mirrors are readable by the owner only. Temporary recording and conversion WAV files are removed after work settles. After a failed transcription the audio stays in memory for ten minutes so it can be sent again, and after a cancelled recording for six seconds so it can be restored; neither is written to disk. App crashes or power loss may leave a temporary file; a later launch removes it once it is six hours old, so it can stay on disk until then. Imported originals are not deleted. Deleting a transcript overwrites it in the database and its search index, so neither keeps a copy on disk, though text deleted by older versions can stay in unused database space. It also removes its TXT mirror, and deleting all transcripts or resetting also removes every TXT mirror and migration backup. This is not secure erasure: file system snapshots and backups can keep the data, and exported files stay where they were saved.

Setting `MELULI_DICTATION_TIMING=1` writes `dictation-timing.jsonl` to the application-support folder. It holds stage names, durations and thermal state, with no audio or transcript text. It is off by default, and a shipped build ignores it.

## Call transcription

Meluli watches which applications have the microphone and the speakers in use, by bundle identifier, to suggest transcribing a call. This needs no permission, reads no audio and is kept in memory only. Suggestions stay off until they are turned on in Settings.

Nothing is recorded until the person clicks. Meluli does not join the call and does not tell the other participants. The suggestion tells the person to inform participants and obtain consent where the law requires it, and that responsibility is theirs. Laws on recording conversations differ by place.

While a call is recorded, the microphone and the call application's audio are written to two WAV files in `calls/<id>/` inside the application-support folder. The microphone keeps recording while the call application is muted, and the reminder says so. For a browser call the capture covers the whole browser, so sound from its other tabs is recorded too.

Transcription runs on this computer and Meluli sends no audio or text to any server. Backup, sync or a shared clipboard you enabled may copy data off it. The files are deleted once the transcript is saved. If transcription fails they stay until the person retries or discards them, and the partial result stays in `call.json` beside them. Deleting all data removes this folder. The transcript itself is stored like any other, with timestamps and a speaker label on each segment.

## Permissions and clipboard

Microphone access is used for recording. System audio recording access is requested the first time the person records a call, and is used only to capture the call application's audio. Input Monitoring is used only for hold-to-talk: a small helper listens for changes to modifier keys, reports whether the chosen key is down, and never receives keystrokes. Accessibility access is used to activate the captured application, send the paste keystroke and confirm the result.

To paste safely, the native helper reads the focused field's text when a recording starts, when the idle floating window loses focus, and again around the paste. Secure fields such as passwords are checked first and never read. The text stays in the helper's memory until that target is used or replaced. A SHA-256 hash of it is passed to the main process and also stays in memory. In packaged builds, neither is written to disk or logged.
 The native helper snapshots clipboard formats in memory, temporarily puts the result on the clipboard, and restores the old contents only when its clipboard change count still matches. A newer user copy takes priority. The snapshot is not written to a file. Clipboard restoration can be affected by an OS crash or forced termination.

Do not attach private audio, transcript databases, clipboard contents or unredacted diagnostics to public issues. See [security reporting](../SECURITY.md).
