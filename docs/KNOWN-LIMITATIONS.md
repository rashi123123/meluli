# Known limitations

Meluli is a Preview. This page lists what is known not to work, or has not been verified.

## Pasting

- **Unexplained paste failure.** One endurance run saved a transcript without pasting it on cycle 38; the recovery controls appeared. The cause was not established. Later runs of 80 paste-only and 50 full cycles did not reproduce it, which does not show it is fixed.
- **Dictating into Meluli.** With Meluli in front there is nothing to paste into, so the text stays in Meluli and the floating window offers Copy.
- **Fields Meluli cannot read.** Chrome and other apps that hide their fields from Accessibility cannot be checked after the paste. Meluli sends it once and shows nothing, so a paste that did not land only shows in the app itself; the text stays in Home and History. In tests the page received it exactly once. Inside such an app, a move between fields of the same window is not detected, and text goes to the field that has focus.
- **Helper unavailable.** If the native helper cannot run, Meluli falls back to AppleScript, which cannot confirm the text arrived, and it says so instead of reporting success.
- **Unknown outcome.** If a paste may have been sent but its result is unknown, Meluli does not offer a retry, because the text may already be in the field. It says so and offers Copy.
- **Cancellation.** Cancelling after pasting has started does not undo the paste.

## Platform

- Only an Apple M3 with 24 GB on macOS 27.0.1 has been exercised. Intel Macs are not supported. Older macOS releases, Bluetooth microphones, real sleep and wake, and sustained physical dictation are unverified. Packaged tests used Chromium's fake microphone with recorded speech swapped in afterwards, so physical capture on a released build still needs the manual check in [testing](TESTING.md).
- No signed release exists yet. The release workflow needs an Apple Developer ID, and it has never run with one. Until then builds are ad hoc signed and not notarized, so Gatekeeper may block them. Hardened runtime and the Electron fuses that block run-as-Node, `NODE_OPTIONS` and the inspector are on. An ad hoc signature still needs library validation off; a Developer ID build keeps it on.
- Automatic updates work only on a signed build from the release workflow, installed in Applications. Ad hoc copies never check. The first signed version has to be installed by hand once, and macOS asks for its permissions again.
- No installation has been tested on a Mac without developer tools. The steps are in [the release guide](RELEASE.md#clean-mac-check).

## Data

- Meluli does not encrypt its history.
- A recording's file is deleted when processing ends. If the engine fails, the audio stays in memory for ten minutes so it can be sent again, and quitting Meluli loses it.
- A cancelled recording or transcription can be restored from the floating window for six seconds, provided the recording lasted at least three seconds. After that the audio is gone.
- A crash can leave a temporary audio file behind. It is removed on the first launch after it is six hours old, and it stays on disk until then.
- A link import downloads audio only to transcribe it. Meluli does not save the audio as a file. Sites can block the download, and private or sign-in content does not work.
- Link import checks the pasted address, not where a site's extractor goes next. Extractors that follow any host are blocked, and that list must be checked whenever the yt-dlp pin moves.
- Deleting a transcript does not guarantee removal from migration backups, TXT mirrors or exported files, and SQLite may keep deleted bytes until they are overwritten.

## Microphone

- Opening the microphone is the system's work, and speech before it opens is not recorded. The floating window shows that it is still opening. Stopping before it opens, or with less than half a second captured, records nothing and says so.

## Calls

- Call transcription needs macOS 14.2 or later, and is hidden below that. The rest of the app still runs on macOS 13.3.
- Detection and capture were tested on real Google Meet calls in a Chromium browser. Zoom and Teams were not tested on real calls, so their application identifiers and behaviour are unconfirmed.
- Meluli cannot tell a Meet call from any other site that uses the microphone in a browser, so the suggestion can appear for those too. It says it looks like a browser call.
- A browser call records the sound of every tab in that browser, and a tab still playing sound keeps the call open after the person leaves.
- Joining muted can delay the suggestion if the call application keeps the microphone closed until it is unmuted.
- The microphone track uses the system's default input device, not the device chosen in Settings.
- The microphone keeps recording while the call application is muted.
- Speakers are told apart only as "אני" and "משתתפים": all other participants share one label. Speech heard through laptop speakers can reach the microphone; a line repeated on both tracks is kept once, as the call side.
- A recording stops after 4 hours, or when less than 200 MB of disk remains, and starting needs 1 GB free.
- A call is transcribed after it ends, at about a fifth of its length on the test machine, and silence is skipped. Dictation takes priority between and during pieces, so a piece that gives way starts again, and a dictation that interrupts a piece can wait up to about 1.5 s.
- With ad hoc signing, macOS asks for system audio access again after each rebuild.

## Performance

- A long run of back-to-back dictations can make the Mac slow its GPU. On the fanless M3 test machine each short transcription went from about 1.2 s to about 3 s after a minute or two of continuous work, and recovered within seconds of stopping. Dictations 20 s apart stayed fast. See [Phase 3 latency](BENCHMARKS.md#phase-3-latency-split).
- The first dictation after five idle minutes reloads the model. Stop to text was 5.5 s in testing, with the model on an external disk.
- Other GPU work can also delay a dictation. Short episodes of about 6 s were seen while another app launched; one 45-second episode was not explained.
- Imported audio is held in memory while it is transcribed, at about 230 MB per hour of audio.
- The selected model has a higher word error rate than the baseline on the evaluation corpus, by 1.11 percentage points. See [benchmarks](BENCHMARKS.md).
