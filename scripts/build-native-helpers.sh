#!/usr/bin/env bash
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$TASK_ROOT/resources/bin" "$TASK_ROOT/.build/native-module-cache"
xcrun swiftc -O -target arm64-apple-macosx13.0 -module-cache-path "$TASK_ROOT/.build/native-module-cache" \
  "$TASK_ROOT/native/ClipboardBridge.swift" -o "$TASK_ROOT/resources/bin/meluli-clipboard"
"$TASK_ROOT/resources/bin/meluli-clipboard" --self-test
xcrun swiftc -O -target arm64-apple-macosx13.0 -module-cache-path "$TASK_ROOT/.build/native-module-cache" \
  "$TASK_ROOT/native/NativeInsertion.swift" -o "$TASK_ROOT/resources/bin/meluli-insertion"
printf '%s\n' '{"type":"ping","requestId":"build-check"}' '{"type":"quit"}' \
  | "$TASK_ROOT/resources/bin/meluli-insertion" | grep -q '"state":"ready"'
xcrun swiftc -O -target arm64-apple-macosx13.0 -module-cache-path "$TASK_ROOT/.build/native-module-cache" \
  "$TASK_ROOT/native/HoldKey.swift" -o "$TASK_ROOT/resources/bin/meluli-holdkey"
"$TASK_ROOT/resources/bin/meluli-holdkey" --self-test | grep -q '^ok$'
# Process taps need macOS 14.2. The app starts this helper only there and hides the feature elsewhere.
xcrun swiftc -O -target arm64-apple-macosx14.2 -module-cache-path "$TASK_ROOT/.build/native-module-cache" \
  "$TASK_ROOT/native/CallAudio.swift" -o "$TASK_ROOT/resources/bin/meluli-callaudio"
"$TASK_ROOT/resources/bin/meluli-callaudio" --self-test | grep -q '^ok$'
