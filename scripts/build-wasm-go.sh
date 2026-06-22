#!/usr/bin/env bash
# Builds the Go (zstd + go-diff) codec module to public/next-editor-go.wasm.
#
# TinyGo (-target=wasip1 -buildmode=c-shared) produces a WASI "reactor" module
# whose //go:wasmexport functions the JS host calls after wasi.initialize().
# We use TinyGo over the native Go toolchain because its runtime is tiny: the
# same sources build to ~0.71 MB (vs ~4.5 MB native) with byte-identical zstd
# output, so existing recordings stay readable. Requires TinyGo >= 0.36 (for
# //go:wasmexport + wasm c-shared); TinyGo bundles the binaryen wasm-opt it runs.
#
# Native Go fallback (no TinyGo in CI; produces the larger ~4.5 MB artifact):
#   ( cd "$SRC" && GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared \
#       -ldflags="-s -w" -o "$OUT" . )
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src/core/wasm-go"
OUT="$ROOT/public/next-editor-go.wasm"

if ! command -v tinygo >/dev/null 2>&1; then
  echo "error: tinygo not found on PATH." >&2
  echo "  install: brew tap tinygo-org/tools && brew install tinygo" >&2
  echo "  or build with native Go using the fallback command in this script." >&2
  exit 1
fi

echo "› building $OUT (tinygo $(tinygo version | awk '{print $3}'))"
# -opt=z optimizes for size; -no-debug strips DWARF. The release export is named
# freeBuf, not free, because TinyGo's runtime exports its own C `free`.
( cd "$SRC" && tinygo build -target=wasip1 -buildmode=c-shared -opt=z -no-debug -o "$OUT" . )

raw=$(wc -c < "$OUT")
gz=$(gzip -9 -c "$OUT" | wc -c)
printf "› done: %.2f MB raw, %.0f KB gzipped\n" "$(echo "$raw/1048576" | bc -l)" "$(echo "$gz/1024" | bc -l)"
