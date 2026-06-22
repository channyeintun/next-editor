#!/usr/bin/env bash
# Builds the Go (zstd + go-diff) codec module to public/next-editor-go.wasm.
#
# Native Go (GOOS=wasip1, -buildmode=c-shared) produces a WASI "reactor" module
# whose //go:wasmexport functions the JS host calls after wasi.initialize().
# Requires Go >= 1.24 for //go:wasmexport. No other toolchain needed — the only
# dependency is the Go compiler.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src/core/wasm-go"
OUT="$ROOT/public/next-editor-go.wasm"

echo "› building $OUT"
# -s -w strips the symbol table and DWARF (the Go runtime is the bulk of the
# size). A wasm-opt -Oz pass shaved only ~9 KB off the gzipped artifact, not
# worth keeping a binaryen dependency for.
( cd "$SRC" && GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -ldflags="-s -w" -o "$OUT" . )

raw=$(wc -c < "$OUT")
gz=$(gzip -9 -c "$OUT" | wc -c)
printf "› done: %.1f MB raw, %.0f KB gzipped\n" "$(echo "$raw/1048576" | bc -l)" "$(echo "$gz/1024" | bc -l)"
