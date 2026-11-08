# Releasing Meluli

A trusted release comes only from [the release workflow](#signed-release), signed with a Developer ID and notarized. Everything built on a developer's machine is an ad hoc Preview, covered from [Install a local Preview](#install-a-local-preview) on. Read [known limitations](KNOWN-LIMITATIONS.md) first.

## Delivery contract

The deliverables are an Apple Silicon app in DMG and ZIP, SHA-256 checksums, an update feed, source code under MIT, third-party notices and Hebrew/English documentation. Users must not need a separately installed Python or Node runtime. Downloaded model weights are separate from the installer. The experimental streaming engine's worker ships in the bundle, and its model downloads only after it is chosen in Settings.

## Signed release

`.github/workflows/release.yml` runs in the public repository when a version tag is pushed. It has four stages, and each one needs the one before it:

1. **Validate.** The same checks as every push.
2. **Build**, in the `release-signing` environment. Stops if the tag is not on `main`, or if any signing input is missing. It never falls back to an unsigned build. Signs with the Developer ID, notarizes and staples the app and the DMG, and writes the feed and checksums.
3. **Verify**, on a separate machine with no secrets. `scripts/verify-release-artifacts.sh` checks both archives, proves they hold one build, runs every native helper and launches the app with an empty profile.
4. **Publish**, in the `release-publish` environment. Uploads a draft, downloads it again and compares checksums, and only then makes it public.

A tag with a suffix, such as `v0.1.0-preview.2`, publishes a prerelease. GitHub never counts a prerelease as `latest`, so the update feed cannot offer it. The app reads the feed from `releases/latest`, and a repository with no full release answers 404, which the app treats as nothing to do.

### What the Apple Developer account needs

Only someone with access to the account can do these. Nothing here can be done from the repository.

1. Join the Apple Developer Program. A free account cannot create a Developer ID certificate. An organization account needs a D-U-N-S number first.
2. As the Account Holder, create a **Developer ID Application** certificate under Certificates, IDs & Profiles. Use a certificate signing request from Keychain Access on a Mac you trust. An Apple Development certificate does not work.
3. In Keychain Access, export the certificate and its private key as a `.p12` with a strong password. Keep the `.p12` and its password in a password manager or other offline backup.
4. In App Store Connect, under Users and Access → Integrations → Team Keys, create a key with the Developer role. Download the `.p8`, which Apple offers only once, and note the Key ID and Issuer ID.
5. Note the Team ID from the Membership page, and the exact certificate name, for example `Example Name (ABCDE12345)`, from `security find-identity -v -p codesigning`.
6. Accept any pending agreement in the Apple Developer account. An unaccepted agreement makes notarization fail.

No App ID or provisioning profile is needed: Meluli uses no capability that requires one.

Developer ID certificates last five years. Renew under the same team. The designated requirement names the team, not the certificate, so a renewal keeps updates and macOS permissions working. Moving to another team does not.

### What the GitHub repository needs

Create two environments under Settings → Environments in the public repository. Restrict both to tags matching `v*`, and add yourself as a required reviewer on `release-publish`, so nothing goes public without a click. Add a reviewer on `release-signing` too if you want to approve each use of the certificate. Under Settings → General → Releases, turn on immutable releases, so a published version cannot be replaced.

Set these secrets on the `release-signing` environment. Run each command in its own terminal, so nothing lands in a shared history. `gh` reads the value from standard input:

```sh
base64 -i DeveloperID.p12 | gh secret set MAC_CERTIFICATE_P12_BASE64 --env release-signing --repo rashi123123/meluli
gh secret set MAC_CERTIFICATE_PASSWORD --env release-signing --repo rashi123123/meluli
base64 -i AuthKey_XXXXXXXXXX.p8 | gh secret set APPLE_API_KEY_P8_BASE64 --env release-signing --repo rashi123123/meluli
gh secret set APPLE_API_KEY_ID --env release-signing --repo rashi123123/meluli
gh secret set APPLE_API_ISSUER --env release-signing --repo rashi123123/meluli
```

Set these as repository variables, because the verify stage has no environment. Neither one is a secret; both appear in every signed app:

```sh
gh variable set APPLE_TEAM_ID --repo rashi123123/meluli --body "ABCDE12345"
gh variable set APPLE_SIGNING_IDENTITY --repo rashi123123/meluli --body "Example Name (ABCDE12345)"
```

`APPLE_SIGNING_IDENTITY` leaves out the `Developer ID Application:` prefix, because the packaging script adds it. Delete the local `.p12` and `.p8` from Downloads once they are stored.

### Cut a release

1. Set the version in `package.json`, update `CHANGELOG.md`, and merge to `main`.
2. Tag that commit and push the tag: `git tag v1.2.3 && git push origin v1.2.3`.
3. Watch the run. After Verify passes, approve `release-publish`.
4. Run the [clean Mac check](#clean-mac-check) on the published files before announcing the release.

If a stage fails, nothing is public. Fix the cause, delete the tag, and tag again. To stop offering a published release, mark it as a prerelease, which sends `latest` back to the previous one. Because updates only move forward, anyone who already took it stays on it until a higher version ships.

### Updates

The feed is `releases.json`, attached to each release. Only a build made with `MELULI_OFFICIAL_BUILD=1` carries the feed's address, so a build from source never looks for updates. `src/main/services/update-feed.ts` reads the feed first, over HTTPS and from GitHub's hosts only, and hands off to the native updater (`native/host/app/Updater.swift`) only when the feed names this repository's archive for a newer version. The updater then checks that the archive's app satisfies the running app's designated requirement and carries the same identifier and the named version, and keeps the old app until the new one is in place.

The first signed release cannot reach ad hoc copies. Those users install it by hand once, and macOS asks for microphone and Accessibility again, because the signature changed. History and settings stay, because the application support folder does not change. From then on, updates keep permissions.

Never change the bundle identifier, the application support folder name, the signing team, or the ZIP name in `scripts/meluli2/package-native-release.sh` and `src/main/services/update-feed.ts` without a migration.

### Clean Mac check

CI proves the signature, not the experience. Before announcing a release, use a Mac or a macOS virtual machine that has never had Xcode or the Command Line Tools. `xcode-select -p` must fail. A virtual machine can check everything here except the physical microphone.

Download the DMG, `SHA256SUMS.txt`, the ZIP, `releases.json` and `scripts/clean-mac-check.sh` with Safari, into one folder. Turn Wi-Fi off, then run:

```sh
sh clean-mac-check.sh 1.2.3
```

Then, by hand:

1. Open the DMG, drag Meluli to Applications, and open it. macOS may ask once whether to open a downloaded app. It must not say the developer cannot be verified.
2. Turn Wi-Fi on and go through setup: Welcome starts the download, then the microphone check and the paste step, which asks for Accessibility.
3. Press the record button on Home, say something, and confirm the transcript appears.
4. Focus a text field in another app, press Control+Shift+R, speak, and press it again. Confirm the text arrives exactly once.
5. Turn Wi-Fi off, quit, reopen, and confirm dictation still works.
6. In Settings, allow the hold key and turn on call suggestions, and confirm each asks for its own permission and that neither asked before this.
7. For a second release: install the older one and leave it running. It checks 30 seconds after launch and every six hours. When Settings offers the new version, install it there, and confirm that history, the permissions and paste all survive.

Record the macOS version, the Mac and the result in the release notes. Do not claim a macOS version that has not been through this.

## Install a local Preview

1. Verify the archives against the accompanying `SHA256SUMS.txt` with `shasum -a 256 -c SHA256SUMS.txt` from the delivery folder.
2. Open the DMG and drag Meluli to Applications, or extract the ZIP and move `Meluli.app` there.
3. This Preview is ad hoc signed and not notarized. If macOS blocks this app after a launch attempt, use System Settings → Privacy & Security → Open Anyway for this app. Do not disable Gatekeeper globally.
4. Allow the microphone when asked. Starting setup downloads the separately pinned model, approximately 874 MB; a network filter may require allowing Meluli. Pasting into other apps needs Accessibility, which Home and the floating window offer. The hold key, turned on in Settings, also needs Input Monitoring. Dictation and file imports then work locally. Link imports need the optional helper and network access.
5. Focus a text field, press Control+Shift+R, speak, and press it again to stop. Control+Shift+H opens the floating panel; Escape cancels without transcription, and a recording of three seconds or more can be restored for six seconds.
6. If paste fails, the saved result remains in history and the floating panel exposes recovery controls. Do not repeatedly retry without checking whether the target already contains the result.

Only the Apple M3/macOS configuration named in the known limitations has been exercised.

A signed release replaces steps 1 and 3: Gatekeeper accepts it, and step 1 stays as an optional check.

## Before packaging

- Default engine: Whisper Turbo Q8 via whisper.cpp 1.9.5; the primary 44-clip quality gate is recorded in [BENCHMARKS.md](BENCHMARKS.md). The experimental streaming engine (sherpa-onnx) has its own measurements there.
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
node scripts/meluli2/build-native-app.mjs --minify
```

This builds `.build/native-app/Meluli Native Test.app`, a development build with its own bundle identifier, profile folder and keychain item, so it never opens your real history, settings or saved keys. It renders the interface icons from the SF Symbols on the build machine, so a build needs macOS. `--release` builds the app under its real identity and is for the release workflow only: a release build opens the real profile. `pnpm build` still produces the Electron development package. The ASR build pins a source commit and SHA-256, statically links Whisper/GGML, embeds Metal shaders and verifies that dynamic dependencies are macOS frameworks only. The link-import helper is optional and left out of `pnpm build`; `pnpm run fetch:yt-dlp` builds it from hash-locked Python packages and project-local managed Python, with a pinned Deno. Do not include it in a public package without legal advice.

The bundle identifier is `io.github.rashi123123.meluli`. These commands sign ad hoc, not with a Developer ID, and the result is not notarized, so never publish it as a release. `scripts/meluli2/package-native-release.sh` is the only path to a trusted build, and it refuses to run without every signing input. A model download is required on first setup. Keep the model outside the installer to avoid duplicating it on each app update.

Copies signed ad hoc, and copies run from an external drive or anywhere outside Applications, never check for updates.

The worker hash in `resources/licenses/whispercpp/runtime.json` depends on the build path, so a rebuild elsewhere can change it. Do not commit that change on its own.

Export source from a commit, then check the result. The script refuses a ref that is not a commit, and the check reports unexpected files and local paths:

```sh
python3 scripts/export-source.py <commit> /absolute/path/to/Meluli-source.zip
python3 scripts/check-release-output.py /absolute/path/to/Meluli-source.zip
```

On a packaged `.app` the check also reads the built CSP and the entitlements, and, for an Electron build, the fuses. `check-release-output.py --release <version> <team id> /absolute/path/to/Meluli.app` adds what a trusted build must also prove: every Mach-O is arm64, signed by the team with a Developer ID, hardened and timestamped, links only system libraries, and the bundle passes Gatekeeper with a stapled ticket and carries the feed. The same check accepts a folder, but there it also flags third-party files: test keys in yt-dlp's dependencies, its CA bundle, and paths inside Electron and SQLite. Review those by hand; only the ZIP result is a pass or fail.

The cask lives in [rashi123123/homebrew-meluli](https://github.com/rashi123123/homebrew-meluli). A daily workflow there moves it to the newest Release with a DMG and takes the hash from `SHA256SUMS.txt`, so the tag needs no extra step.

## Pinned build inputs

Dependabot reaches npm and GitHub Actions only. Before a release, check uv, Deno and Python in `scripts/build-youtube-helper.sh` and `native/youtube-requirements.txt` against their upstream releases, and update any pin older than 90 days or with a published security fix.

## Before delivery

Install the finished DMG/ZIP into a clean temporary profile, launch and relaunch it, exercise recording and paste, test offline inference, verify data preservation and idle release, and record all remaining limitations. Generate checksums only after all bundle modifications are finished. Verify both archives contain the same app build. Do not advertise untested macOS versions or Intel support.

Preview installation may trigger Gatekeeper. Explain the macOS Privacy & Security “Open Anyway” flow for the specific delivered app. Do not instruct users to disable Gatekeeper globally. A Preview is not notarized and should not be described as signed or Apple-approved.

The final report must separate source/test readiness, package readiness, real performance evidence and unresolved acceptance items. Do not label the release complete while an installation, dictation, data-loss or privacy blocker remains.
