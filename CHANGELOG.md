# Changelog

## 0.1.0-preview.2 — unreleased

- Remove deleted transcripts from the database, its search index and its log, and remove their TXT copies. Delete-all also removes migration backups. This is not secure erasure.
- Write subtitle exports readable by their owner only.
- Close link import routes to local hosts, and bound its processes and the time and size of audio conversion.
- Bound history search and stop stray characters from failing it.
- Keep the paste target and the clipboard intact through a paste that may not have landed, bound clipboard text, and say when a clipboard could not be preserved.
- Respect a cancel, a later press or a closed window around a recording start, stop or paste retry.
- Flag a recording whose final audio never arrived.
- End call capture when its helper misses a deadline, force out a helper that ignores its stop signal, and keep a microphone fault from ending a call at its start.
- Save a call transcript only once, date a crashed call by the audio it left, and let delete-all and shutdown wait for call work already running.
- Keep transcripts with equal timestamps whole across pages.
- Let long transcription jobs run while the worker reports progress.
- Ignore development and diagnostic flags in packaged builds, and trust only the renderer entry the app loads.
- Pin the Electron framework digest and pnpm by hash, and fail the build and release check on a weakened production state.
- Publish the Phase 4 latency experiments in `docs/BENCHMARKS.md`.
- Remove unused code, and run tests with Electron's asar handling off.

## 0.1.0-preview.1 — 2026-11-01

- Harden packaged builds: hardened runtime on, and Electron's run-as-Node, `NODE_OPTIONS` and inspector paths fused off.
- Make link import an optional helper, shown only when built. It now runs site scripts in a pinned Deno with no permissions.
- Keep call suggestions off until they are turned on, and strengthen the consent reminders.
- Keep pasted text on this Mac, out of Universal Clipboard.
- Use `io.github.rashi123123.meluli` as the bundle identifier. History stays, and macOS asks for its permissions again.
- Render the interface icons from SF Symbols at build time, and keep the PNGs out of the repository.
- Update Electron to 45.2.1 and yt-dlp to 2026.10.26.
- Link to the source code from About, and state that the name and artwork are outside the MIT license.
- Suggest transcribing Zoom, Google Meet and Teams calls on macOS 14.2 and later: nothing records without a click, both sides are captured separately, and the transcript stays on this computer with timestamps and "אני" and "משתתפים" labels.
- Write out the About page and Terms of Use, add a Privacy page, and link to the third-party licenses from About.
- Show a small microphone with an orbiting ring while a screen loads, and matching marks on empty screens.
- Redraw the menu bar from the app icon: moving sound waves during transcription, no red while recording, and a shorter menu with the dictionary.
- Let Settings and the dictionary fill a default-sized window, and hold that width on larger ones.
- Move the dictionary out of Settings to its own screen in the sidebar.
- Put the sidebar icons in square tiles, center the search and drop the page title from the toolbar.
- Download new versions in the background and install them on restart, when a release feed is configured.
- Turn dictated punctuation into the mark itself, such as "סימן שאלה" and "שורה חדשה". Imported files keep the words.
- Remove more spoken fillers and repeated phrases, and keep "כאילו" and "נגיד" where they carry meaning.
- Replace the app icon with a smiling microphone, with Liquid Glass and dark and tinted versions on macOS 26 and later.
- Add a theme picker with ten themes, light and dark, plus following the system, across the main and floating windows.
- Refuse to paste when focus moved, the field changed or the target is secure, and offer a deliberate paste; never retry a paste that may have landed.
- Stay silent after a paste, and speak up only when one failed or may not have landed safely.
- Start and stop recording from the floating-window shortcut, and add a setting for where that window appears.
- Fix Copy on Home, which the clipboard permission blocked in the renderer.
- Transcribe links from the sites the bundled yt-dlp knows, not only YouTube, and refuse local addresses and pages it does not recognise.
- Accept audio files dropped on the file cell.
- Transcribe mono AAC files, which the engine used to refuse after conversion.
- Replace the blue focus ring with one in the app's own tones.
- Choose the floating window's position on a small picture of the screen.
- Stack notices instead of replacing them, keep the YouTube field on Home, and run the onboarding microphone check on arrival.
- Keep audio through cancel, engine failure, microphone loss and sleep; add Esc, Command-Z and shortcut recovery that work from the keyboard.
- Open the microphone with the shortcut rather than after the target check, and say when a slow microphone cost the recording.
- Warn before quitting with a dictation at risk.
- Add optional local stage timing with engine and thermal detail.
- Release the floating panel keyboard focus before paste, then show its feedback without activating the panel again. This handles macOS panels that can be key while another app remains frontmost.
- Adopt Meluli / מלולי while retaining the existing `IvritMenuBar` storage identity.
- Stabilize floating-recorder opening, focus, pause/resume, readiness and position handling.
- Reserve recording ownership and keep cancellation busy until work and cleanup settle.
- Batch and transfer microphone PCM buffers; flush partial audio on stop.
- Release the transcription worker after five idle minutes and dispose owned resources on shutdown.
- Preserve database results when paste or the TXT mirror fails; restore rich clipboard formats using a native helper.
- Back up legacy SQLite history before transactional schema updates.
- Isolate automated test profiles; distinguish simulated tests from real model checks.
- Add MIT licensing, contribution and security guidance, and Hebrew/English documentation.

- Select Hebrew Whisper Turbo Q8 with a pinned, statically linked whisper.cpp 1.9.5 runtime.
- Enforce the agreed +5 percentage-point WER threshold across 44 short speech clips, including noise; record the comparison and its limitations in `docs/BENCHMARKS.md`.
- Update Electron, SQLite and validation dependencies; pin and verify runtime/model downloads.
- Compile the AudioWorklet as JavaScript, close capture/visualization/cue contexts, and add explicit discard controls.
- Bundle a minimal standalone YouTube helper and complete native/font/model/library notices.

Distributable acceptance is still in progress. Real ASR and UI simulation evidence remain separate; see `docs/TESTING.md`.

- Use the physical Command-V key code for paste across keyboard input sources; distinguish an automation timeout from an unavailable target.

- Preserve decimal points, thousands separators, numeric identifiers and times during transcript formatting; keep raw ASR text unchanged. Six focused regression tests and a real packaged numeric-transcript check pass.

- Wait for bounded clipboard-helper cleanup after startup timeout or broken input before settling an insertion; fault-injection regressions cover both cases. Native paste endurance remains unresolved.

- The earlier intermittent paste failure was not reproduced in later packaged runs. Its cause is unknown and it is not claimed fixed; see `docs/KNOWN-LIMITATIONS.md`.

- Never offer a repeat paste after an AppleScript failure whose outcome is unknown, and honor a cancel that arrives before pasting starts.
- Remove crash-orphaned temporary audio at launch, and write TXT mirrors readable by the owner only.
- Check for a secure field before reading a target field's text.
- Ignore test doubles in packaged builds, restrict `revealPath` to the storage folder, and remove localhost from the production CSP.
- Export source archives from a commit, and remove the retired CT2, NeMo and Python workers. Their stored `backend` values stay readable.
