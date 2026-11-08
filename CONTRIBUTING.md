# Contributing to Meluli

Hebrew and English contributions are welcome. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Ask questions in [Discussions](https://github.com/rashi123123/meluli/discussions). Start with a focused issue or pull request explaining the problem and resulting behavior. For a large architectural or model change, discuss the tradeoff before implementing it.

## Development principles

- Keep transcription local and preserve existing histories in `IvritMenuBar`.
- Keep renderer access behind a typed, validated preload/IPC boundary.
- Do not log recordings, transcript text, clipboard contents or private file paths.
- Do not add cloud fallback, telemetry or analytics without an explicit product decision.
- Whisper is the default engine; the streaming engine ships as an opt-in experiment. A new engine or model needs measurements in [BENCHMARKS.md](docs/BENCHMARKS.md) before it ships, and experiments stay out of the shipped resources.
- `src/main` runs unchanged in two hosts: Electron for development and the native host for releases. Use only the Node and Electron APIs the native host provides (`src/native-host`), and run `node scripts/meluli2/native-host-conformance.mjs` after changing anything it covers.
- Do not change the `IvritMenuBar` folder, persisted settings keys or stored `backend` values without a migration plan. Older transcripts depend on them.
- Do not change the bundle identifier `io.github.rashi123123.meluli`. An installed copy refuses an update under a different identifier.
- Do not weaken the paste safeguards: one-time targets, no repeat of an attempted operation, and no retry when the outcome is unknown.
- Document measured quality and speed separately. Record hardware, model revision, settings, corpus and measurement conditions.

## Validation

Run the TypeScript check, lint, automated tests and app build before submitting. For interface changes, check every state in the Lab (`pnpm lab`), in light and dark and at the narrow width. The build renders the interface icons from the SF Symbols installed on your Mac (`pnpm run symbols`); the PNGs stay out of Git. See README for the current commands and toolchain. Native SQLite must be built for the runtime running the tests; do not mix the system Node ABI with Electron's ABI.

Use a temporary profile with `MELULI_USER_DATA` for app tests. Mock runs additionally require `IVRIT_E2E_MOCK=1`. Never point automated tests at personal history. Tests without an installed real model must report **skipped**, and mocked worker/UI success must not be presented as real ASR accuracy or end-to-end paste validation.

For UI changes, check Hebrew RTL, keyboard focus, reduced motion, contrast, and the floating recorder on supported macOS displays. Add regression tests for behavior changes where a test can catch a meaningful failure.

## Contributions and licensing

By submitting a contribution, you confirm you can provide it under this repository's MIT license. Do not submit code, text or media copied from another product unless its license allows it and you say so. Preserve third-party copyright and license notices; model weights, visual assets and bundled tools retain their own terms. Do not attach private or unlicensed audio to an issue or pull request.
