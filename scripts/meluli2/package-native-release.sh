#!/usr/bin/env bash
# Builds, signs and notarizes the native app's release archives (Meluli 2.0, D20), then writes the feed
# and checksums: the same outputs, names and checks as scripts/package-release.sh gives the Electron app,
# so the release workflow, verify-release-artifacts.sh and the update feed stay as they are.
# Usage: package-native-release.sh <tag>, with the credentials from docs/RELEASE.md in the environment.
# There is no unsigned path through this script: a missing credential stops it before the build.
# Never launch the result on a development Mac: a release build opens the real profile.
set -euo pipefail
cd "$(dirname "$0")/../.."

tag="${1:?Usage: package-native-release.sh <tag>}"
version="$(node -p 'require("./package.json").version')"
[[ "$tag" == "v$version" ]] || { echo "Tag $tag does not match package.json version $version." >&2; exit 1; }

for name in CSC_LINK CSC_KEY_PASSWORD APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_TEAM_ID APPLE_SIGNING_IDENTITY; do
  [[ -n "${!name:-}" ]] || { echo "$name is not set. Refusing to build an unsigned release." >&2; exit 1; }
done
[[ -f "$APPLE_API_KEY" ]] || { echo "APPLE_API_KEY must be the path of the .p8 file." >&2; exit 1; }
[[ "$APPLE_SIGNING_IDENTITY" == *"($APPLE_TEAM_ID)" ]] || { echo "APPLE_SIGNING_IDENTITY must end in ($APPLE_TEAM_ID)." >&2; exit 1; }
[[ "$APPLE_SIGNING_IDENTITY" != "Developer ID Application:"* ]] || { echo "Leave \"Developer ID Application:\" out of APPLE_SIGNING_IDENTITY." >&2; exit 1; }

# The certificate goes into a keychain of this run's own, removed on exit, as electron-builder does.
work="$(mktemp -d)"
keychain="$work/signing.keychain-db"
keychain_password="$(uuidgen)"
original_keychains=()
while IFS= read -r line; do original_keychains+=("$(echo "$line" | sed -e 's/^ *"//' -e 's/"$//')"); done < <(security list-keychains -d user)
cleanup() {
  security list-keychains -d user -s "${original_keychains[@]}" >/dev/null 2>&1 || true
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
(umask 077 && printf '%s' "$CSC_LINK" | base64 --decode > "$work/certificate.p12")
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work/certificate.p12" -k "$keychain" -P "$CSC_KEY_PASSWORD" -T /usr/bin/codesign >/dev/null
rm -f "$work/certificate.p12"
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" "${original_keychains[@]}"

notarize() {
  xcrun notarytool submit "$1" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait --timeout 2h
}

rm -rf release
mkdir release
MELULI_OFFICIAL_BUILD=1 node scripts/meluli2/build-native-app.mjs --release --out "$work/build"
app="$work/build/Meluli.app"

# Squirrel compared the feed with CFBundleShortVersionString; the native updater does the same.
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")" == "$version" ]]
python3 scripts/check-release-output.py "$app"

# The app is notarized through a ZIP of itself, then stapled, so both archives carry the ticket.
ditto -c -k --sequesterRsrc --keepParent "$app" "$work/notarize.zip"
notarize "$work/notarize.zip"
xcrun stapler staple "$app"

zip="release/Meluli-$version-arm64.zip"
dmg="release/Meluli-$version-arm64.dmg"
ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"

mkdir "$work/image"
ditto "$app" "$work/image/Meluli.app"
ln -s /Applications "$work/image/Applications"
hdiutil create -volname "Meluli $version" -srcfolder "$work/image" -fs HFS+ -format UDZO -quiet "$dmg"
codesign --force --sign "Developer ID Application: $APPLE_SIGNING_IDENTITY" --timestamp "$dmg"
notarize "$dmg"
xcrun stapler staple "$dmg"

node scripts/write-update-feed.mjs "https://github.com/rashi123123/meluli/releases/download/$tag/Meluli-$version-arm64.zip"

# Last, so nothing changes after the checksums are taken.
cd release
shasum -a 256 "$(basename "$dmg")" "$(basename "$zip")" releases.json > SHA256SUMS.txt
