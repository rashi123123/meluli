# Third-party notices

Meluli application code is MIT licensed (see LICENSE). That license does not replace the licenses of models, fonts, runtimes or separately bundled tools. No endorsement by any upstream author is implied.

## Local speech model (downloaded separately)

Meluli downloads the speech model at runtime. The weights are not in this repository.

- `ggml-ivrit-whisper-large-v3-turbo-q8_0.bin` from `JoaoZaokk/ivrit-whisper-large-v3-turbo-ggml` (https://huggingface.co/JoaoZaokk/ivrit-whisper-large-v3-turbo-ggml), revision `7caf56da903afb6adf616b56ac4bbe59485e15aa`, 874,188,075 bytes, Apache License 2.0. Quantized by JoaoZaokk from `ivrit-ai/whisper-large-v3-turbo-ggml`.
- Upstream `ivrit-ai/whisper-large-v3-turbo`, Apache License 2.0, a fine-tune of `openai/whisper-large-v3-turbo`.
- OpenAI Whisper, MIT License, Copyright (c) 2022 OpenAI. See `resources/licenses/model/OPENAI-WHISPER-LICENSE.txt`.
- ivrit.ai trained its model on datasets under the ivrit.ai License. Meluli does not include or use those datasets.

ivrit.ai and OpenAI do not endorse Meluli.

## Native recognition runtime

**whisper.cpp v1.9.5** and its GGML subtree, MIT: https://github.com/ggml-org/whisper.cpp . Exact source commit `d1be6fde11ac6e0407606b4e42fe72d34add8037`; the source archive and nlohmann/json v3.11.3 header are pinned by SHA-256 in `scripts/build-cpp-worker.mjs`. Meluli adds an MIT JSON-lines adapter and statically links the runtime with embedded Metal shaders. Full Whisper/GGML and nlohmann/json MIT texts and binary provenance are in `resources/licenses/whispercpp/`.

## Streaming recognition engine (optional, "מהיר וקל")

Every package includes this engine's worker and licenses. It runs only when the person picks "מהיר וקל" under Settings → Transcription; Whisper stays the default. Its model is downloaded only after that choice.

- Model `ivrit-ai/zipformer2-66m-streaming-he` (https://huggingface.co/ivrit-ai/zipformer2-66m-streaming-he), revision `ee769a2a13b887f91572eec349458bfb0fe79e7a`, by ivrit.ai, Creative Commons Attribution 4.0 International (CC BY 4.0, https://creativecommons.org/licenses/by/4.0/). Meluli downloads the four INT8 files in `sherpa-onnx/` unchanged, each pinned by SHA-256 in `src/shared/zipformer-manifest.json`. ivrit.ai does not endorse Meluli.
- **sherpa-onnx v1.12.30**, Apache License 2.0, https://github.com/k2-fsa/sherpa-onnx . The macOS static archive is pinned by SHA-256 in `scripts/build-stream-worker.mjs`. Meluli adds an MIT JSON-lines adapter (`native/stream-worker.cpp`) and links the archive statically, CPU only.
- From that archive: ONNX Runtime 1.23.2 (MIT, with its own third-party notices), kaldi-native-fbank 1.22.3, kaldi-decoder 0.2.11, kaldifst 1.7.17, OpenFst (sherpa-onnx-2024-06-19) and simple-sentencepiece 0.7 (all Apache License 2.0), and KISS FFT (BSD 3-Clause). nlohmann/json v3.11.3 (MIT) is compiled into the adapter.
- Full texts and binary provenance: `resources/licenses/sherpa-onnx/`.

Experimental NeMo, MLX, Core ML and Python ASR engines are not included in the Preview package. Their benchmark results do not imply bundled support.

## Electron, Node and Chromium

Electron 45.2.3 is MIT licensed; its bundled Node, V8, Chromium and third-party libraries carry their respective notices. The standard Electron `LICENSE` and `LICENSES.chromium.html` must remain in the app distribution. https://github.com/electron/electron

## Application libraries

`resources/licenses/npm/inventory.json` records exact installed versions, declared licenses, repositories and notice hashes for the 21 runtime/renderer/CSS dependencies. Full notices accompany it, including React, Base UI, better-sqlite3, Zod and Tailwind. Build-only tooling is not shipped as application code. The interface uses fonts already installed on macOS; no font file is bundled.

## YouTube helper

This repository does not contain the link-import helper, and `pnpm run fetch:yt-dlp` builds it locally. It is a minimal standalone build of **yt-dlp 2026.10.26** and **yt-dlp-ejs 0.8.0** (Unlicense), **PyCryptodomeX 3.24.1** (BSD/Public Domain components), **certifi 2026.10.23** (MPL-2.0), embedded **CPython 3.14.8**, and **Deno 2.9.7** (MIT, see `resources/licenses/youtube/deno-LICENSE.md`). EJS retains the ISC/MIT notices of its bundled JavaScript dependencies. Python's component notices include its statically linked OpenSSL and other stdlib dependencies.

The executable is assembled with **PyInstaller 6.22.3**, whose bootloader distribution exception permits this combined executable. Its full license and exception, Python's upstream native-component license inventory, exact package versions, and individual license texts are preserved in `resources/licenses/youtube/`. The inventory also labels build-tool inputs. Python's notice set deliberately includes optional stdlib components to preserve upstream attributions.

The optional mutagen, curl_cffi and websockets packages are excluded. The upstream all-features yt-dlp executable is not shipped. JavaScript challenge handling uses Electron's bundled Node; no separate Node, Deno or Python installation is required. Source/build inputs are pinned in `native/youtube-requirements.txt` and `scripts/build-youtube-helper.sh`. See https://github.com/yt-dlp/yt-dlp#licensing .

## Benchmark data

Evaluation used selected Hebrew recordings and references from Google FLEURS (CC BY 4.0), https://huggingface.co/datasets/google/fleurs . Derived noise and concatenation fixtures are identified in the benchmark manifest. Evaluation audio is not included in the application installer.

## Assets outside the MIT license

The MIT license covers the code and documentation in this repository, except as stated here and in [TRADEMARKS.md](TRADEMARKS.md).

**Name and artwork.** See [TRADEMARKS.md](TRADEMARKS.md).

**SF Symbols.** The 47 interface icons are rendered from Apple's SF Symbols on the build machine by `scripts/export-sf-symbols.swift`. The PNGs are not in this repository, but a built app contains them. Apple's terms apply to them, and they are not offered under MIT. They may be used only in apps for Apple platforms, so a fork for another platform must replace them.
