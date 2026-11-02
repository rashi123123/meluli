#!/usr/bin/env bash
# Builds, signs and notarizes the release archives, then writes the feed and checksums.
# Usage: package-release.sh <tag>, with the credentials from docs/RELEASE.md in the environment.
# There is no unsigned path through this script: a missing credential stops it before the build.
set -euo pipefail
cd "$(dirname "$0")/.."

tag="${1:?Usage: package-release.sh <tag>}"
version="$(node -p 'require("./package.json").version')"
[[ "$tag" == "v$version" ]] || { echo "Tag $tag does not match package.json version $version." >&2; exit 1; }

for name in CSC_LINK CSC_KEY_PASSWORD APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_TEAM_ID APPLE_SIGNING_IDENTITY; do
  [[ -n "${!name:-}" ]] || { echo "$name is not set. Refusing to build an unsigned release." >&2; exit 1; }
done
[[ -f "$APPLE_API_KEY" ]] || { echo "APPLE_API_KEY must be the path of the .p8 file." >&2; exit 1; }
[[ "$APPLE_SIGNING_IDENTITY" == *"($APPLE_TEAM_ID)" ]] || { echo "APPLE_SIGNING_IDENTITY must end in ($APPLE_TEAM_ID)." >&2; exit 1; }
[[ "$APPLE_SIGNING_IDENTITY" != "Developer ID Application:"* ]] || { echo "Leave \"Developer ID Application:\" out of APPLE_SIGNING_IDENTITY." >&2; exit 1; }

rm -rf release
MELULI_OFFICIAL_BUILD=1 pnpm run build:app

# Squirrel compares the feed with CFBundleVersion, so a build number here would offer the same update forever.
pnpm exec electron-builder --mac dmg zip --arm64 --publish never \
  "--config.mac.identity=$APPLE_SIGNING_IDENTITY" \
  --config.mac.notarize=true \
  --config.mac.entitlements=build/entitlements.release.plist \
  --config.mac.entitlementsInherit=build/entitlements.release.plist \
  --config.dmg.sign=true \
  "--config.buildVersion=$version"

dmg="release/Meluli-$version-arm64.dmg"
zip="release/Meluli-$version-arm64.zip"

# electron-builder notarizes and staples the app inside both archives. The disk image is a separate ticket.
xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait --timeout 30m
xcrun stapler staple "$dmg"

node scripts/write-update-feed.mjs "https://github.com/rashi123123/meluli/releases/download/$tag/Meluli-$version-arm64.zip"

# Last, so nothing changes after the checksums are taken.
cd release
shasum -a 256 "$(basename "$dmg")" "$(basename "$zip")" releases.json > SHA256SUMS.txt
