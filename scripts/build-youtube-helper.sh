#!/usr/bin/env bash
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Bootstrap a verified build tool locally; never replace the user's uv/Python.
mkdir -p "$TASK_ROOT/.build/tools"
UV_ARCHIVE="$TASK_ROOT/.build/tools/uv-0.13.5.tar.gz"
UV_SHA="743f85035a1996ecb350659e01cd9faea9709829be09b1b4b03c73eaf3c9cd73"
if [[ ! -f "$UV_ARCHIVE" ]] || [[ "$(shasum -a 256 "$UV_ARCHIVE" | cut -d ' ' -f 1)" != "$UV_SHA" ]]; then
  curl --fail --location --retry 3 --proto '=https' --proto-redir '=https' \
    https://github.com/astral-sh/uv/releases/download/0.13.5/uv-aarch64-apple-darwin.tar.gz -o "$UV_ARCHIVE"
fi
[[ "$(shasum -a 256 "$UV_ARCHIVE" | cut -d ' ' -f 1)" == "$UV_SHA" ]] || { echo "uv checksum mismatch" >&2; exit 1; }
tar -xzf "$UV_ARCHIVE" -C "$TASK_ROOT/.build/tools"
UV_BIN="$TASK_ROOT/.build/tools/uv-aarch64-apple-darwin/uv"
export PYINSTALLER_CONFIG_DIR="$TASK_ROOT/.build/pyinstaller-cache"
export UV_CACHE_DIR="$TASK_ROOT/.build/uv-cache"
export UV_PYTHON_INSTALL_DIR="$TASK_ROOT/.build/python"
export UV_PYTHON_PREFERENCE=only-managed
"$UV_BIN" venv --allow-existing --python 3.14.8 "$TASK_ROOT/.build/youtube-venv"
"$UV_BIN" pip sync --python "$TASK_ROOT/.build/youtube-venv/bin/python" --require-hashes "$TASK_ROOT/native/youtube-requirements.txt"
"$TASK_ROOT/.build/youtube-venv/bin/python" -m PyInstaller --noconfirm --clean --onedir \
  --name yt-dlp --target-architecture arm64 \
  --distpath "$TASK_ROOT/.build/youtube-dist" --workpath "$TASK_ROOT/.build/youtube-build" --specpath "$TASK_ROOT/.build" \
  --collect-all yt_dlp --collect-all yt_dlp_ejs --collect-all certifi --collect-all Cryptodome \
  --exclude-module mutagen --exclude-module curl_cffi --exclude-module websockets \
  "$TASK_ROOT/native/youtube-entry.py"
mkdir -p "$TASK_ROOT/resources/bin/youtube"
cp -R "$TASK_ROOT/.build/youtube-dist/yt-dlp/." "$TASK_ROOT/resources/bin/youtube/"
"$TASK_ROOT/resources/bin/youtube/yt-dlp" --ignore-config --version
# yt-dlp runs site scripts in a JS runtime. Deno gives them no permissions, and Electron's own runtime is fused off.
DENO_ARCHIVE="$TASK_ROOT/.build/tools/deno-2.9.7.zip"
DENO_SHA="5cd46d6268f6f78f5d88bdc7159d20bd44cdaa4b3303474839f87ec6fe7ae25c"
if [[ ! -f "$DENO_ARCHIVE" ]] || [[ "$(shasum -a 256 "$DENO_ARCHIVE" | cut -d ' ' -f 1)" != "$DENO_SHA" ]]; then
  curl --fail --location --retry 3 --proto '=https' --proto-redir '=https' \
    https://github.com/denoland/deno/releases/download/v2.9.7/deno-aarch64-apple-darwin.zip -o "$DENO_ARCHIVE"
fi
[[ "$(shasum -a 256 "$DENO_ARCHIVE" | cut -d ' ' -f 1)" == "$DENO_SHA" ]] || { echo "deno checksum mismatch" >&2; exit 1; }
unzip -o -q "$DENO_ARCHIVE" deno -d "$TASK_ROOT/resources/bin/youtube"
"$TASK_ROOT/resources/bin/youtube/deno" --version

"$TASK_ROOT/.build/youtube-venv/bin/python" "$TASK_ROOT/scripts/collect-youtube-notices.py"
