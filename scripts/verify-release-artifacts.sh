#!/usr/bin/env bash
# Verifies a finished release folder from the outside, with no signing credentials.
# Usage: verify-release-artifacts.sh <folder> <version> <team id>
# Holds both archives to the full bundle check, proves they carry one build, and runs what ships.
set -euo pipefail
scripts="$(cd "$(dirname "$0")" && pwd)"
folder="$(cd "${1:?Usage: verify-release-artifacts.sh <folder> <version> <team id>}" && pwd)"
version="${2:?Provide the version.}"
team="${3:?Provide the team identifier.}"
dmg="$folder/Meluli-$version-arm64.dmg"
zip="$folder/Meluli-$version-arm64.zip"

work="$(mktemp -d)"
mounted=""
smoke=""
cleanup() {
  [[ -z "$smoke" ]] || kill "$smoke" 2>/dev/null || true
  [[ -z "$mounted" ]] || hdiutil detach "$mounted" -quiet -force || true
  rm -rf "$work"
}
trap cleanup EXIT

(cd "$folder" && shasum -a 256 -c SHA256SUMS.txt)
grep -Eq "Meluli-$version-arm64\.dmg" "$folder/SHA256SUMS.txt"
grep -Eq "Meluli-$version-arm64\.zip" "$folder/SHA256SUMS.txt"
grep -Eq "releases\.json" "$folder/SHA256SUMS.txt"

node -e '
  const [path, version] = process.argv.slice(1);
  const feed = JSON.parse(require("node:fs").readFileSync(path, "utf8"));
  const url = `https://github.com/rashi123123/meluli/releases/download/v${version}/Meluli-${version}-arm64.zip`;
  const release = feed.releases.find(entry => entry.version === feed.currentRelease);
  if (feed.currentRelease !== version || release?.updateTo.url !== url) throw new Error("The feed does not name this release.");
' "$folder/releases.json" "$version"

codesign --verify --strict "$dmg"
codesign -dvv "$dmg" 2>&1 | grep -Fxq "TeamIdentifier=$team"
xcrun stapler validate "$dmg"
spctl -a -t open --context context:primary-signature -v "$dmg"

mounted="$work/image"
hdiutil attach "$dmg" -readonly -nobrowse -noautoopen -mountpoint "$mounted" -quiet
mkdir "$work/zip"
ditto -x -k "$zip" "$work/zip"

python3 "$scripts/check-release-output.py" --release "$version" "$team" "$mounted/Meluli.app"
python3 "$scripts/check-release-output.py" --release "$version" "$team" "$work/zip/Meluli.app"

cdhash() { codesign -dvvv "$1" 2>&1 | sed -n 's/^CDHash=//p'; }
[[ -n "$(cdhash "$work/zip/Meluli.app")" ]]
[[ "$(cdhash "$mounted/Meluli.app")" == "$(cdhash "$work/zip/Meluli.app")" ]] || { echo "The DMG and the ZIP hold different builds." >&2; exit 1; }

bin="$work/zip/Meluli.app/Contents/Resources/bin"
"$bin/meluli-clipboard" --self-test
# Captured, not piped to grep -q: an early exit would stop the helper and fail the pipeline.
[[ "$(printf '%s\n' '{"type":"ping","requestId":"release-check"}' '{"type":"quit"}' | "$bin/meluli-insertion")" == *'"type":"ready"'* ]]
[[ "$("$bin/meluli-holdkey" --self-test)" == ok ]]
[[ "$("$bin/meluli-callaudio" --self-test)" == ok ]]
node "$scripts/check-asr-protocol.mjs" "$bin/whispercpp/meluli-asr-worker"

# The app must load its frameworks and SQLite under library validation, from a profile of its own.
profile="$work/profile"
mkdir -m 700 "$profile"
MELULI_USER_DATA="$profile" "$work/zip/Meluli.app/Contents/MacOS/Meluli" > "$work/smoke.log" 2>&1 &
smoke=$!
for _ in $(seq 1 45); do
  kill -0 "$smoke" 2>/dev/null || { cat "$work/smoke.log" >&2; echo "The packaged app exited during launch." >&2; exit 1; }
  [[ -s "$profile/ivrit-menu-bar.sqlite" ]] && break
  sleep 1
done
[[ -s "$profile/ivrit-menu-bar.sqlite" ]] || { cat "$work/smoke.log" >&2; echo "The packaged app never opened its database." >&2; exit 1; }
sleep 5
kill -0 "$smoke" 2>/dev/null || { cat "$work/smoke.log" >&2; echo "The packaged app exited after opening its database." >&2; exit 1; }

echo "Release $version verified."
