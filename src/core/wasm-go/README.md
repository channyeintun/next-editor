# wasm-go — Go codec module (zstd + go-diff)

A WebAssembly module compiled from **native Go** that exposes two recording-codec
primitives to the browser/worker host, as an experiment alongside the
AssemblyScript affix module in [`../assembly`](../assembly):

- **zstd** compress/decompress ([`klauspost/compress`](https://github.com/klauspost/compress)) —
  a drop-in alternative to the fflate DEFLATE used by the SCR3 segment codec
  ([`streamingRecordingCodec/format.ts`](../../storage/streamingRecordingCodec/format.ts)).
- **diff/patch** ([`sergi/go-diff`](https://github.com/sergi/go-diff)) — a
  multi-region Myers delta, generalizing the prefix/suffix `ContentDelta` in
  [`frameDelta.ts`](../src/utils/frameDelta.ts).

## Build

```sh
bun run build:wasm-go      # -> public/next-editor-go.wasm
```

Requires Go ≥ 1.24 (for `//go:wasmexport`). The build uses
`GOOS=wasip1 GOARCH=wasm -buildmode=c-shared`, which yields a WASI **reactor**
module: the host instantiates it with a WASI import object, calls
`wasi.initialize(instance)`, then calls the exports.

## Benchmark

```sh
bun run benchmark:go-codec
```

Compares zstd vs fflate and go-diff vs the affix model on recording-shaped
payloads, asserting every codec round-trips. See [`../../../scripts/benchmark-go-codec.mjs`](../../../scripts/benchmark-go-codec.mjs).

## ABI

All data crosses through linear `memory` (wasm32 offsets). A `u64` result packs
`(ptr << 32) | len`; `0` means empty (or, for decode/apply, an error). The host
reads `len` bytes at `ptr`, then calls `free(ptr)`.

| export                                | signature    | notes                             |
| ------------------------------------- | ------------ | --------------------------------- |
| `alloc(size u32)`                     | `-> ptr u32` | pinned host-writable buffer       |
| `free(ptr u32)`                       |              | release a pinned buffer           |
| `zstdCompress(ptr,len u32)`           | `-> u64`     | SpeedDefault                      |
| `zstdDecompress(ptr,len u32)`         | `-> u64`     |                                   |
| `diffDelta(aPtr,aLen,bPtr,bLen u32)`  | `-> u64`     | `DiffToDelta(a -> b)`             |
| `applyDelta(aPtr,aLen,dPtr,dLen u32)` | `-> u64`     | reconstructs `b` from `a` + delta |

The diff delta is opaque to JS — `applyDelta` consumes exactly what `diffDelta`
produces, so the format never needs a JS-side interpreter.
[`../../../scripts/wasm-go-loader.mjs`](../../../scripts/wasm-go-loader.mjs) is a
reference host (Node `node:wasi`); the same shape works in a browser worker with
a WASI shim.

## ⚠️ The size tradeoff (read before adopting)

Native Go bundles its runtime + GC, so this module is **~4.5 MB raw / ~1.27 MB
gzipped** — versus **357 bytes** for the AssemblyScript affix module. It is only
viable **lazy-loaded inside the recording worker**, never on the main bundle
path. The win it buys (measured): zstd ≈ half the size of fflate on code
keyframes at ~5× the speed, and go-diff stays compact on scattered edits where
the affix delta degenerates to near-keyframe size. TinyGo would cut the binary
dramatically and is the obvious size follow-up — at the cost of stdlib/library
compatibility checks for `klauspost/compress`.
