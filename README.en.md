# Meluli · מלולי

Hebrew dictation for the Mac: press a shortcut, speak, and the text is pasted where you are working. Transcription runs on your Mac, with no cloud.

[עברית](README.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/home-dark.png">
  <img src="docs/images/home-light.png" alt="Meluli's home screen: the recording card, file and link import, and recent transcripts">
</picture>

## Install

Meluli 2.0 (version 0.2.0) is a native macOS app, signed with a Developer ID and notarized by Apple. Download the DMG from [Releases](https://github.com/rashi123123/meluli/releases/latest), or install with Homebrew:

```bash
brew install --cask rashi123123/meluli/meluli
```

It needs an Apple Silicon Mac with macOS 13.3 or later. The Hebrew model downloads on first launch (about 874 MB); after that, transcription works offline. If you installed an earlier Preview, install 2.0 by hand once; your history and settings stay. Read the [known limitations](docs/KNOWN-LIMITATIONS.md) before installing.

## How it works

1. **Press the shortcut** (`Control + Shift + R`) or hold the dictation key, in any app.
2. **Speak.** A small floating window shows that it is recording, and lets you pause, resume or cancel.

   <picture>
     <source media="(prefers-color-scheme: dark)" srcset="docs/images/hud-dark.png">
     <img src="docs/images/hud-light.png" width="320" alt="The floating window while recording: time, voice bars, cancel, pause and stop">
   </picture>

3. **Stop.** A Hebrew Whisper model transcribes on your Mac, your dictionary and the writing rules tidy the text, and it is pasted into the field you were in. If the paste does not land, the text stays in Home and History, and it is never pasted twice.

Under the hood, a small Swift host runs the app's services in macOS's own JavaScriptCore, and the window opens in WebKit only when you need it. With the window closed, Meluli uses about 59 MB of memory. Details: [architecture](docs/ARCHITECTURE.md).

## Features

- Record with a shortcut or by holding a key, with a floating window to pause, resume, stop and cancel. `Esc` cancels, and a recording cancelled by mistake can be restored.
- Text written the way people write it: numbers in digits, question marks on questions, a full stop at a clear pause, email and web addresses and phone numbers in their usual form, and spoken corrections ("בשלוש, סליחה, בארבע").
- Hebrew and English on one line stay in order when pasted.
- A personal dictionary and built-in term packs (AI, development, work tools, product, design and marketing) that switch on and off.
- Actions: a chain of language-model steps that runs on a dictation before it is pasted, such as a polished email or an English prompt. Bring your own key (OpenAI, Anthropic, OpenRouter, Gemini, Groq or any OpenAI-compatible address) or run Ollama on your Mac.
- History with Hebrew search, playback from any sentence, editing, and export to Markdown, WebVTT and SRT.
- Recordings are kept for a week so they can be transcribed again, and a recording whose transcription failed is never lost.
- Import audio files (WAV, MP3, M4A, AIFF, CAF), and transcribe links you are allowed to download through an optional yt-dlp helper you build yourself.
- An offer to transcribe Zoom, Google Meet and Teams calls on macOS 14.2 and later, off until you turn it on. Nothing is recorded without a click.
- An experimental streaming engine, "מהיר וקל", that shows the text while you speak and has it ready the moment you stop. It is less accurate than Whisper, which stays the default. [Measurements](docs/BENCHMARKS.md#streaming-engine--7-november-2026).
- Ten themes, light and dark, or follow the system.

Microphone recordings are limited to 20 minutes. Imported files are not. Testing was done on an M3 with 24 GB on macOS 27.0.1.

## Privacy and data

Transcription is local only. There is no analytics and no telemetry. Text goes to a language model only through an action you set up, and only to an address you approved; an action with Ollama stays on your Mac. The network is also used to download the model, to check for updates (which you can turn off) and for link imports. Details: [privacy](docs/PRIVACY.md).

Data lives in:

```text
~/Library/Application Support/IvritMenuBar/
```

It holds the SQLite database, text copies, recordings and the model. Before a database schema upgrade, a backup is saved in `backups/`. Meluli does not encrypt its history itself. A transcription result is saved to the database even if pasting fails.

## Development

You need Node.js 22.12 or later, the pnpm version declared in `package.json`, the Xcode Command Line Tools and CMake.

```bash
pnpm install --frozen-lockfile
pnpm run prepare:runtime
pnpm run typecheck
pnpm run lint
pnpm test
```

`pnpm dev` runs the same code in an Electron-based development shell. `pnpm lab` opens every interface component and its states in the browser, with no model or permissions. `node scripts/meluli2/build-native-app.mjs` builds the native app for testing, with its own identifier, profile and keychain item, so it never touches your personal history. Signed builds come only from [the release workflow](docs/RELEASE.md).

## Layout and contributing

`native/host` is the Swift host; `src/native-host` implements on it the part of Node and Electron the services need; `src/main` holds the services and database; `src/preload` defines a limited, typed API; `src/renderer` holds the React interface; `src/shared` holds contracts and schemas. [Architecture](docs/ARCHITECTURE.md) · [Decisions](docs/DECISIONS.md) · [Testing](docs/TESTING.md) · [Benchmarks](docs/BENCHMARKS.md).

Questions and ideas go to [Discussions](https://github.com/rashi123123/meluli/discussions), bugs to [Issues](https://github.com/rashi123123/meluli/issues). Before contributing, read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

The application code is MIT licensed. Meluli's name, logo and icon are not part of that license, and a fork needs its own name and icon: see [TRADEMARKS.md](TRADEMARKS.md). Models, symbols and external tools keep their own terms; licenses and attributions are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Meluli is an independent project, with no affiliation, sponsorship or endorsement from Apple, Zoom, Google, Microsoft, OpenAI, Anthropic, ivrit.ai or any other company named here. Names belong to their owners and are used only to describe compatibility.
