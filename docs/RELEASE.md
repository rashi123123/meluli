# Building a Preview

No public Release exists yet. This guide covers building and installing locally. Read [known limitations](KNOWN-LIMITATIONS.md) first.

## Delivery contract

The target deliverables are an unsigned Apple Silicon app in DMG and ZIP, SHA-256 checksums, source code under MIT, third-party notices and Hebrew/English documentation. Users must not need a separately installed Python or Node runtime. Downloaded model weights are separate from the installer; experimental engines do not belong in the app bundle.

## Install the local Preview candidate

1. Verify the archives against the accompanying `SHA256SUMS.txt` with `shasum -a 256 -c SHA256SUMS.txt` from the delivery folder.
2. Open the DMG and drag Meluli to Applications, or extract the ZIP and move `Meluli.app` there.
3. This Preview is ad hoc signed and not notarized. If macOS blocks this app after a launch attempt, use System Settings → Privacy & Security → Open Anyway for this app. Do not disable Gatekeeper globally.
4. Allow microphone and Accessibility permissions when requested. Hold-to-talk also needs Input Monitoring. First setup downloads the separately pinned model, approximately 874 MB; a network filter may require allowing Meluli. Dictation and file imports then work locally. Link imports need the optional helper and network access.
5. Focus a text field, press Control+Shift+R, speak, and press it again to stop. Control+Shift+H opens the floating panel; Escape cancels without transcription, and a recording of three seconds or more can be restored for six seconds.
6. If paste fails, the saved result remains in history and the floating panel exposes recovery controls. Do not repeatedly retry without checking whether the target already contains the result.

There is no public download URL yet. Only the Apple M3/macOS configuration named in the known limitations has been exercised.

## Before packaging

- Selected engine: Whisper Turbo Q8 via whisper.cpp 1.9.5; the primary 44-clip quality gate is recorded in [BENCHMARKS.md](BENCHMARKS.md).
- Build the local worker and native clipboard helper for arm64.
- Include only required runtime binaries, icons and model metadata.
- Pin model and tool revisions; verify downloaded bytes before use.
- Run the commands in [TESTING.md](TESTING.md) and retain logs. A missing real-model prerequisite is a skipped test, not a pass.
- Inventory third-party licenses from the actual final bundle and include their notices.

## Local build commands

Install Xcode Command Line Tools, CMake, Node.js 22.12+ and the declared pnpm version. From the repository:

```sh
pnpm install --frozen-lockfile
pnpm run prepare:runtime
pnpm run build:app
pnpm exec electron-builder --mac dmg zip --arm64 --publish never
```

`pnpm run build:app` renders the interface icons from the SF Symbols on the build machine, so a build needs macOS. `pnpm build` performs all preparation and packaging in sequence. The ASR build pins a source commit and SHA-256, statically links Whisper/GGML, embeds Metal shaders and verifies that dynamic dependencies are macOS frameworks only. The link-import helper is optional and left out of `pnpm build`; `pnpm run fetch:yt-dlp` builds it from hash-locked Python packages and project-local managed Python, with a pinned Deno. Do not include it in a public package without legal advice.

The bundle identifier is `io.github.rashi123123.meluli`. Preview signing is ad hoc, not a Developer ID signature; the app is not notarized. A model download is required on first setup. Keep the model outside the installer to avoid duplicating it on each app update.

Automatic updates read a static `releases.json` from `UPDATE_FEED_URL` in `src/shared/constants.ts`. After packaging, upload the ZIP, then run `node scripts/write-update-feed.mjs <zip-url>` and upload the result. Every release must keep the same bundle identifier and signing certificate, or installed copies refuse it. Back up the certificate's private key: losing it means everyone reinstalls by hand. Copies signed ad hoc, and copies run from an external drive, are not supported targets for an update.

The worker hash in `resources/licenses/whispercpp/runtime.json` depends on the build path, so a rebuild elsewhere can change it. Do not commit that change on its own.

Export source from a commit, then check the result. The script refuses a ref that is not a commit, and the check reports unexpected files and local paths:

```sh
python3 scripts/export-source.py <commit> /absolute/path/to/Meluli-source.zip
python3 scripts/check-release-output.py /absolute/path/to/Meluli-source.zip
```

On a packaged `.app` the check also reads the fuses, the built CSP and the entitlements. The same check accepts a folder, but there it also flags third-party files: test keys in yt-dlp's dependencies, its CA bundle, and paths inside Electron and SQLite. Review those by hand; only the ZIP result is a pass or fail.

There is no Homebrew cask.

## Pinned build inputs

Dependabot reaches npm and GitHub Actions only. Before a release, check uv, Deno and Python in `scripts/build-youtube-helper.sh` and `native/youtube-requirements.txt` against their upstream releases, and update any pin older than 90 days or with a published security fix.

## Before delivery

Install the finished DMG/ZIP into a clean temporary profile, launch and relaunch it, exercise recording and paste, test offline inference, verify data preservation and idle release, and record all remaining limitations. Generate checksums only after all bundle modifications are finished. Verify both archives contain the same app build. Do not advertise untested macOS versions or Intel support.

Unsigned Preview installation may trigger Gatekeeper. Explain the macOS Privacy & Security “Open Anyway” flow for the specific delivered app. Do not instruct users to disable Gatekeeper globally. The release is not notarized and should not be described as signed or Apple-approved.

The final report must separate source/test readiness, package readiness, real performance evidence and unresolved acceptance items. Do not label the release complete while an installation, dictation, data-loss or privacy blocker remains.
