#!/usr/bin/env bash
# Compiles the Icon Composer package into the catalog macOS 26 and later read for Liquid Glass.
# Needs Xcode 26 or later. The result is committed, so packaging itself does not need Xcode.
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ICONS="$TASK_ROOT/resources/icons"
OUTPUT="$(mktemp -d)"
trap 'rm -rf "$OUTPUT"' EXIT
xcrun actool "$ICONS/Meluli.icon" --compile "$OUTPUT" --output-format human-readable-text \
  --errors --warnings --output-partial-info-plist "$OUTPUT/partial.plist" --app-icon Meluli \
  --include-all-app-icons --enable-on-demand-resources NO --development-region en \
  --target-device mac --platform macosx --minimum-deployment-target 13.3
cp "$OUTPUT/Assets.car" "$ICONS/Assets.car"
