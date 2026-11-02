#!/bin/sh
# Run on a Mac that has never had developer tools, from a folder holding the release assets.
# Usage: sh clean-mac-check.sh <version>
# Uses only what macOS ships, because xcrun, stapler, lipo and python3 are stubs until the tools are installed.
# Turn Wi-Fi off first: Gatekeeper must then accept the stapled tickets without asking Apple.
set -eu
version="${1:?Usage: sh clean-mac-check.sh <version>}"
dmg="Meluli-$version-arm64.dmg"
mount="$(mktemp -d)"
trap '/usr/bin/hdiutil detach "$mount" -quiet -force 2>/dev/null || true; rmdir "$mount" 2>/dev/null || true' EXIT

if /usr/bin/xcode-select -p >/dev/null 2>&1; then
  echo "FAIL: developer tools are installed, so this is not a clean Mac." >&2
  exit 1
fi
[ "$(/usr/bin/uname -m)" = arm64 ] || { echo "FAIL: Meluli needs Apple Silicon." >&2; exit 1; }

/usr/bin/shasum -a 256 -c SHA256SUMS.txt
/usr/sbin/spctl -a -t open --context context:primary-signature -v "$dmg"
/usr/bin/hdiutil attach "$dmg" -readonly -nobrowse -noautoopen -mountpoint "$mount" -quiet
/usr/bin/codesign --verify --deep --strict "$mount/Meluli.app"
/usr/sbin/spctl -a -vv -t exec "$mount/Meluli.app" 2>&1 | /usr/bin/tee /dev/stderr | /usr/bin/grep -q 'source=Notarized Developer ID'

echo "PASS: the archives are intact and Gatekeeper accepts them. Now follow the manual steps in docs/RELEASE.md."
