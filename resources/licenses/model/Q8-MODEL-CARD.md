---
license: apache-2.0
base_model: ivrit-ai/whisper-large-v3-turbo-ggml
base_model_relation: quantized
pipeline_tag: automatic-speech-recognition
library_name: whisper.cpp
tags:
  - ggml
  - gguf
  - whisper.cpp
  - automatic-speech-recognition
  - on-device
  - quantized
language:
  - he
---

# ivrit-whisper-large-v3-turbo-ggml

Quantizations of the authors' own whisper.cpp f16 conversion of **ivrit-ai/whisper-large-v3-turbo-ggml** (the f16 is mirrored unchanged).

**Source checkpoint:** [ivrit-ai/whisper-large-v3-turbo-ggml](https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml) by ivrit-ai · **License:** apache-2.0 (unchanged; this repo only re-packages the weights)
**Engine:** Load with [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`whisper-cli -m <file>`), or any app that embeds it.

## Files

| File | Quantization | Size | Note |
|---|---|---|---|
| `ggml-ivrit-whisper-large-v3-turbo-f16.bin` | f16 | 1625 MB |  |
| `ggml-ivrit-whisper-large-v3-turbo-q4_0.bin` | q4_0 | 474 MB |  |
| `ggml-ivrit-whisper-large-v3-turbo-q5_0.bin` | q5_0 | 574 MB |  |
| `ggml-ivrit-whisper-large-v3-turbo-q8_0.bin` | q8_0 | 874 MB |  |

`f16` is the lossless conversion; `q8_0` is nearly identical in accuracy at ~55 % of the size; `q5_0`/`q5_k` are the phone-friendly choice; `q4_*` is smallest with a small accuracy cost.

## How these were made

Converted from the upstream checkpoint with the engine's own converter, then quantized with the engine's quantizer. Each variant was checked by transcribing short Portuguese and English samples before upload.

## Attribution

Weights are derivative works of the upstream model and keep its license. Please cite the original authors (ivrit-ai). The conversion and hosting here are maintained by [JoaoZaokk](https://huggingface.co/JoaoZaokk) so that the download links used by the Odysseus / Open WebUI native apps stay stable. No warranty.
