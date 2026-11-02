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

## Phase 4 latency experiments

Measured on 31 October 2026 on the same fanless MacBook Air. The goal was stop-to-text under 800 ms with no loss of accuracy or reliability. No tested option reaches it within the gates. The default model and production settings did not change.

**Gates.** Fixed before the runs, on 226 speech clips: pooled WER and CER at most +0.30 points, paired bootstrap 95% upper bound on WER at most +1.00, no group worse than +1.00, no new text on silence, no new invalid UTF-8, no more repeats or truncations. Baseline pooled WER is 22.40%. Any failure rejects the option whatever its speed. Latency is paced and interleaved on 20 clips of 2–5 s, n = 60 per arm, with nearest-rank p95.

The budget is about 700 ms of inference, not 460 ms. Text is visible about 45 ms after insertion starts; most of the 171 ms insertion stage is verification after that point.

| Option | Baseline p50 / p95 | Option p50 / p95 | Speedup | WER change | Result |
|---|---|---|---|---|---|
| Silence gate | 1156 / 1241 | 1167 / 1238; silence 15 ms | 0 on speech | 0.00, identical text | Pass, not shipped |
| Silero edge trim | Not measured | Not measured | None expected | −0.23 | Pass, no gain |
| Threads 1 / 4 | 1164 / 1222 | 1153 / 1237, 1144 / 1211 | Under 2% | 0.00, identical text | Pass, no gain |
| Greedy | 1164 / 1222 | 1141 / 1218 | 2% | −2.49; mixed +3.70 | Fail |
| No timestamps | 1164 / 1222 | 1145 / 1240 | 2% | −0.85; mixed +5.93, silence text | Fail |
| Window 1024 with gate | 1156 / 1241 | 774 / 864 | 33% | 0.00; technical +1.65, invalid UTF-8 on 2 clips | Fail |
| Window 768 with gate | 1156 / 1241 | 591 / 671 | 49% | −0.10 to −0.16; mixed +3.70, technical +3.31 | Fail |
| Window 512 with gate | 1156 / 1241 | 416 / 486, max 2511 | 64% | +1.11 to +1.41 without gate | Fail |
| Core ML on GPU | 1143 / 1212 | 1167 / 1233 | None | Not gated | No gain |
| Core ML requesting the Neural Engine | 1143 / 1212 | 1102 / 1170, 2.44 GB | 4% | Sweep stopped | Reject |
| Core ML on CPU | 1140 / 1249 | 1142 / 1547, 2.44 GB | None | −0.29; silence text on 3, invalid UTF-8 on 1 | Fail |
| Zipformer2 66M streaming | 1164 / 1222 | 19 / 37 after stop, 345 MB | 98% | +2.78; mixed +8.89, technical +4.13 | Fail |
| Full attention, no flash | Not measured | Not measured | Not measured | +0.23; CER, confidence bound, silence text and repeats fail | Fail |

Text cut at the last detected speech passes every gate at −0.20 points, so a speculative run at a pause could keep accuracy. In simulation from measured speech spans and a 1200 ms run, a 300 ms trigger saves 200 ms if the user stops 500 ms after speaking, 400 ms at 700 ms and 700 ms at 1000 ms. It saves nothing at 300 ms or less. This has not been built. How long people wait before stopping is not known, and the short clips understate wasted runs.

**Window sizes.** Flash attention pads cross-attention to a multiple of 256 without masking, so other sizes produce garbage. A short window also contaminates a later full window in the same state, so window runs used a separate state.

**Neural Engine.** The Core ML compute plan places all 2443 non-constant encoder operations on the CPU. A later run in that mode took about 72 s per clip with `ANECompilerService` active and machine memory under pressure from unrelated leftover processes. It was stopped, so that mode has no accuracy result. It remains rejected on the plan alone.

**Endurance.** Metal and Core ML CPU alternated in AB-BA blocks of 50 on the same clips, 200 dictations per arm per mode. No run failed and every clip kept one text per mode and arm.

| Arm and rhythm | p50 | p95 | Max | Heavy thermal pressure |
|---|---|---|---|---|
| Metal, 4 s gaps | 1140 | 1249 | 1417 | 0 of 200 |
| Metal, back to back | 1348 | 2590 | 4075 | 68 of 200 |
| Core ML CPU, 4 s gaps | 1142 | 1547 | 7434 | 0 of 200 |
| Core ML CPU, back to back | 1530 | 4598 | 10813 | 24 of 200 |

Moving the encoder to the CPU does not avoid sustained slowdown. Each block started after cooling to nominal pressure. The first back-to-back block of each arm was the slowest, at p50 1799 and 3398, and later blocks stayed near 1300; the cause was not established.

**Warm starts.** With the model in the page cache, loading took 330–800 ms and the first run matched later runs at 1135–1303 ms, so warming gives no measurable gain. Cold load after a reboot was not measured here.

**Long clips.** Clips joined from unrelated FLEURS speakers lost about 25% of words, and up to 76% on one clip. The same text spoken continuously kept 103% of words, and consecutive natural clips up to 47 s kept 101%. This points to speaker changes in the joined clips. It has not been tested on a long real dictation.

**Silence gate.** This was a development experiment and is not in this repository. It ran Silero on the finished audio and skipped the model when no speech was found, so audio with speech reached the model unchanged. On the real worker the text matched with the gate on, off and with a missing gate model. Silent clips returned in 11–366 ms. The baseline already gave empty text on these 9 silent clips, so the gain is one avoided model run.

**Limits.** Mixed and technical audio is synthetic. FLEURS and HebDB references are not audited, which inflates absolute WER. Greedy needs real recordings before any further decision. No test used a physical microphone. Kol-stream was not run because testing it means executing third-party Python code, so its published numbers are unverified.
