# Local engine evaluation — 24 October 2026

## Decision

The Preview uses **whisper.cpp 1.9.5 + ivrit.ai Whisper large-v3 Turbo Q8**, with Hebrew decoding, beam size 1, two CPU threads, Metal, flash attention, segment timestamps and no VAD prefilter. The project kept a maximum **+5 percentage point WER** threshold and selected this Q8 candidate.

The primary gate uses all **44 short speech clips** (36 clean + 8 derived noisy clips), weighted by reference word count. CT2 baseline has **211/721 word errors (29.2649%)**; Whisper Q8 has **219/721 (30.3745%), +1.1096 pp**. Hebrew Parakeet has **248/721 (34.3967%), +5.1318 pp** and fails this gate. An earlier clean-only comparison incorrectly made Parakeet appear eligible (+4.9153 pp); that selection was corrected before release. No threshold was relaxed.

## Recorded results

These are observations on one busy M3 machine, **not clean speedup claims**. Latency columns cover 35 warm clean clips (first inference excluded), except the explicitly partial CT2 1.2.1 run. Nearest-rank p95 is `sorted[ceil(0.95*n)-1]`. Control count means nonempty text on three silent clips plus one noise-only clip.

| Engine / model variant | Short speech clips | WER % | Δ baseline pp | Warm p50 s | Warm p95 s | Controls with text / 4 |
|---|---:|---:|---:|---:|---:|---:|
| buzz-mlx-0.4.3 | 44 | 37.59 | +8.32 | 7.808 | 22.197 | 4 |
| ct2-1.1.1 | 44 | 29.26 | +0.00 | 13.668 | 44.755 | 0 |
| ct2-1.2.1 | 14 | 40.69 | partial | 30.834 | 136.912 | 0 |
| mlx-0.4.3 | 44 | 29.54 | +0.28 | 3.919 | 7.770 | 0 |
| mlx-q8-0.4.3 | 44 | 29.54 | +0.28 | 2.236 | 7.519 | 0 |
| parakeet-nemo-0.2.0 | 44 | 34.40 | +5.13 | 0.304 | 1.209 | 0 |
| whispercpp-1.9.5 | 44 | 30.10 | +0.83 | 3.771 | 8.994 | 0 |
| whispercpp-q8-1.9.5 | 44 | 30.37 | +1.11 | 2.640 | 5.454 | 0 |
| whisperkit-1.1.1-gpu | 44 | 29.68 | +0.42 | 9.201 | 15.525 | 0 |
| zipformer-beam4-sherpa-2.0.0 | 44 | 35.51 | +6.24 | 0.712 | 3.843 | 1 |
| zipformer-sherpa-2.0.0 | 44 | 34.95 | +5.69 | 0.289 | 0.631 | 0 |

CT2 1.2.1 stopped after 14 clips under severe contention; its partial WER must not be compared to full-corpus WER. Its first 14 outputs scored 94/231 errors, equal to the same baseline subset. Buzz's 48 completed cases exclude the long clip; its high error rate and four control outputs already failed eligibility. These results use the tested MLX conversion/settings, not every possible upstream Buzz configuration.

MLX Q8 had a lower first-run median (2.236 s) than whisper.cpp Q8 (2.640 s). A later alternating 48-run check, with both models resident, measured 5.519 s versus 5.285 s after each engine's first call: a difference under 10%, with changing host load. This does **not** establish a universally faster engine. The project selected the packageable native Q8 implementation; the runtime is statically linked with embedded Metal shaders. An MLX shipping bundle was not built, so no invented package-size comparison is presented.

WhisperKit CPU+ANE produced no first result within 887.9 seconds during first compilation and was stopped. Its GPU path completed the corpus. whisper.cpp's evaluated Metal paths completed without the earlier allocation failure; this is evidence for the tested machine/configuration only.

## Corpus, normalization and limits

- Google FLEURS `he_il`, test split, revision `168de341b3db6859a9bac1c50a2ef5e3b47647e0`, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); Conneau et al., Google, 2022. https://huggingface.co/datasets/google/fleurs
- 36 human read-speech clips, 8 deterministic additive Gaussian-noise derivatives at 15 dB SNR, silence of 2/5/15 seconds, 5 seconds of noise only, and one concatenation of all 36 speech clips with 0.5-second gaps. Total 49 cases / approximately 690.66 seconds.
- Seven references contain Latin tokens and eleven contain digits. That does not prove natural code switching or spoken English pronunciation. Synthetic noise is not a real noisy-room recording.
- Audio amplitude was preserved rather than normalized across the corpus. Some recordings are very quiet (for example `he-00` has peak amplitude about 0.00458). Browser microphone processing is outside these engine-only comparisons.
- One source (`he-02`) contains only three seconds of audio but a much longer official reference. Other references include unspoken parenthetical/acronym text. No sample was removed after viewing model outputs. These official-reference scores are not audited spontaneous-dictation accuracy.
- WER and CER use one common NFKC/lowercase normalization, remove combining marks and quote marks, turn other punctuation into spaces, and collapse whitespace. No digit-to-word or semantic number normalization. `benchmarks/score.py` preserves the exact algorithm; raw texts and scored records remain separate.
- The primary gate excludes silence and the derived long clip. Silence is assessed independently; the long clip repeats short-corpus content and is not an independent quality sample. Results do not establish natural multi-speaker or hour-long conversation performance.

## Long input, memory and cold loading

The concatenated long case took 281.986 s for baseline CT2, 45.250 s for CPP Q8, 54.760 s for MLX Q8, 259.954 s for WhisperKit GPU and 11.679 s for Parakeet. Corresponding long-case WER was 47.627%, 48.814%, 46.949%, 48.814% and 39.322%. Do not extrapolate a per-hour throughput claim from one concatenated clip.

Peak process RSS for CPP Q8 was about **1.09 GB** and its model is **874,188,075 bytes**. MLX Q8 process RSS was about 554 MB, while MLX separately reported roughly 874 MB active / 1.645 GB peak allocator memory. On unified-memory systems these counters overlap and cannot simply be added or compared as equivalent total memory. Native Parakeet process RSS was about 809 MB; this does not override its quality gate failure.

CPP Q8 initial model load measured 2.167 s from SSD in the benchmark. Other runs used different storage and Python environments, including an external drive after benchmark-owned assets were relocated to recover disk space. Cold loads are not a controlled engine comparison. App startup/model verification, microphone capture, WAV encoding and clipboard restoration are outside engine-only timings and are checked separately.

## Host and reproducibility

Apple M3, 8 CPU cores, 24 GB unified memory, macOS 27.0.1 arm64. User applications remained open during subsequent comparisons, with substantial memory pressure and swap observed. Project builds were not run concurrently with inference measurements. Ambient user-app load was not controlled; timings are exploratory.

The public audio source row IDs, exact references, durations and SHA-256 hashes are in `benchmarks/corpus.json`; audio and model weights are not shipped. `benchmarks/results/` retains measured outputs/settings (with local filesystem paths removed), and `summary.json` contains the aggregate gate. Re-score with `python3 benchmarks/score.py`. Engine settings and revisions must match before attempting a reproduction; rebuilding the app does not re-run this research corpus.

The release model revision/hash is the shared manifest. Runtime build source/hash is pinned in `scripts/build-cpp-worker.mjs`. No remote API is used for transcription.

## Phase 3 latency split

Measured on 30 and 31 October 2026 on a fanless MacBook Air (M3, 24 GB) on AC, with Claude, Helium, Figma and Stats running. The engine spends about 90% of its time in the encoder, which always processes a full 30-second window, so a short clip takes as long as a medium one.

**Cause.** Sustained GPU work raises macOS thermal pressure, and the GPU drops from its top state to its lowest. 120 clips run back to back, in a fresh process without Meluli:

| Time into the run | GPU state | Thermal pressure | Inference, one clip |
|---|---|---|---|
| Start | P12.7 | 0 nominal | 1.16 s |
| About 26 s | P8.5 | 2 heavy | 1.35–1.4 s |
| After 70–110 s | P1.7 | 2 heavy | 2.8–3.1 s, 22 s in one transition spike |

Load stopping brought it back from 2.2 s to 1.2 s within about 15 s. Clips 20 s apart stayed at 1.17–1.27 s for 20 runs at nominal pressure. Idle gaps, thread QoS, the encoder pass and memory residency showed no effect. CPU load alone caused no slowdown in 12 runs, though thermal pressure reached heavy.

Thermal pressure comes from the `com.apple.system.thermalpressurelevel` notification and GPU residency from IOReport, neither of which needs root. `pmset -g therm` does not show this. The reported split of 1.7 s and 4.2 s matches fast and throttled inference plus about 0.5 s of pipeline, but how those 40 recordings were spaced is not known.

Also seen and not fully explained: encoder runs of 5.2–5.8 s, about five times normal, once for 45 seconds and again while Safari launched, with only moderate pressure. Later dictations returned to 1.1 s and Safari in front did not reproduce it.

**Phase 2 against Phase 3.** Packaged builds, isolated profile, real engine, 2.5 s Hebrew clip swapped in for the fake microphone, 11-second gaps, 1.5 s between presses. n = 22 each, in milliseconds. Phase 2's blocks ran just before Phase 3's rather than alternating with this final tree.

| Measure | Phase 2 median | Phase 2 p95 | Phase 3 median | Phase 3 p95 |
|---|---|---|---|---|
| Shortcut to window | 119 | 133 | 110 | 116 |
| Shortcut to first audio | 148 | 169 | 136 | 150 |
| Stop to text in the field | 1490 | 2064 | 1452 | 1777 |
| Press to text, including the 1.5 s | 3187 | 3771 | 3152 | 3469 |

These are fake-device figures: a real microphone opens more slowly. Timing the shortcut includes about 100 ms of test tooling. Typical stop-to-text stages were 8 ms capture, 60 ms WAV, 1200 ms inference, 10 ms formatting and database, and 280 ms paste and verification.

With `MELULI_DICTATION_TIMING=1` and the profile on an external disk, a synchronous trace write added about 300 ms to a quarter of shortcut presses, so compare latency with it off.
