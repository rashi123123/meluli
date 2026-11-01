# Validation and evidence

Run `pnpm run typecheck`, `pnpm run lint`, `pnpm test`, `pnpm run build:app` and `pnpm run test:e2e`. Lint fails on unawaited promises and reports React hook findings as warnings. The test runner uses Electron's Node ABI; do not rebuild SQLite for system Node between these commands.

## Automated tests

Unit and renderer tests cover input validation, worker lifecycle, cancellation, persistence, search migrations, subtitle generation, audio batching, download integrity and floating-window state. SQLite migration tests use synthetic Hebrew fixtures and temporary directories, including committed WAL data and rollback after a failed index rebuild.

The floating recorder also has explicit discard tests: Escape and the cancel button must leave history unchanged and release recording ownership unless the user chooses undo.

E2E uses a fresh `MELULI_USER_DATA` profile and `IVRIT_E2E_MOCK=1`. The ordinary UI scenarios simulate recording, ASR and paste. A separate AudioWorklet test runs a real oscillator through the built worklet under the app CSP, including its final flush acknowledgement. These checks prove UI/IPC behavior, not microphone quality, engine accuracy, real external pasting or packaged offline behavior. Nothing in CI runs the native paste helper against a real text field.

The native clipboard helper's self-test uses a private named pasteboard. It does not change the general user clipboard. Test it with `resources/bin/meluli-clipboard --self-test` after `bash scripts/build-native-helpers.sh`.

## Packaged and real macOS tests

Keep these categories apart when reporting: unit, mock E2E, packaged with the real engine, and real macOS interaction. Only the last establishes real-world behaviour, and only for the apps it covered.

Run a package with an isolated `MELULI_USER_DATA` profile and disposable targets. A child of a trusted shell inherits its Accessibility grant, which says nothing about the installed app's grant. `--use-fake-device-for-media-stream` replaces the microphone with a tone; speech reaches the engine by swapping PCM in the `recording:send-audio` handler. That proves the path after capture, not physical capture.

Set `MELULI_DICTATION_TIMING=1` to record stage timing. Engine times, thermal state and clock time are in each line, so compare runs by state, not only by median.

Manual checks that automation cannot make, on a released build with its own permissions:

1. **Physical microphone.** Dictate one Hebrew sentence in TextEdit and check the words are right and start at the first word.
2. **Bluetooth.** Select a Bluetooth headset, press the shortcut and speak as soon as the window stops saying the microphone is opening. Then turn the headset off mid-recording: the recording must stop, say so and offer to send what was kept.
3. **Sleep and wake.** Close the lid mid-recording. After waking, the recording must be held with an offer to send it, and the shortcut must work.
4. **Permissions.** Turn off Accessibility for Meluli while it runs, then dictate: nothing pastes, the transcript stays and the window offers the permission. Do the same with the microphone.

Calls need a packaged build on macOS 14.2 or later, and real audio: `meluli-callaudio --self-test` proves only that the helper starts. Use a separate bundle identifier so the permission of the installed app is not touched. Check, in a real call on each platform: the suggestion, both tracks, the permission refusal notice, stopping on leaving and by hand, and that dictation during transcription stays fast.

## Real transcription and release acceptance

Keep test audio public or explicitly consented and record its license and reference transcript. Report cold load separately from warm inference and end-to-end stop-to-paste latency. Record hardware, OS, runtime versions, model revisions, decode settings, memory pressure and competing work. Do not compare cold loads from different storage/runtime locations as an engine effect.

The selection rule is the fastest stable, packageable local candidate within five percentage points of baseline WER. When measured speed differs by less than 10%, prefer lower memory use and a smaller bundle. This is a project acceptance threshold, not a published claim about model quality.

Required release checks include at least 30 human Hebrew clips, silence/noise and long-file cases; 50 consecutive real dictation cycles; five-minute idle release; cancellation and recovery; physical microphone and external-app paste; rich-clipboard preservation; legacy history compatibility; clean-profile installation and relaunch; offline inference after model setup; and valid TXT/SRT export. Keep mocked checks and real evidence in separate tables.

FLEURS read speech and concatenated samples are useful reproducible controls, but do not establish spontaneous dictation, natural long-conversation or noisy real-room performance. WER normalization and percentile calculation must be disclosed with results.
