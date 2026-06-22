# wasm-go — Go codec module (zstd + go-diff)

A WebAssembly module compiled from Go (via **TinyGo**) that exposes two
recording-codec primitives to the browser/worker host:

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

Requires TinyGo ≥ 0.36 (`brew tap tinygo-org/tools && brew install tinygo`). The
build uses `tinygo build -target=wasip1 -buildmode=c-shared -opt=z -no-debug`,
which yields a WASI **reactor** module: the host instantiates it with a WASI
import object, calls `wasi.initialize(instance)`, then calls the exports. If
TinyGo is unavailable, [`build-wasm-go.sh`](../../../scripts/build-wasm-go.sh)
documents a native-Go fallback (same sources, ~4.5 MB instead of ~0.72 MB).

## Benchmark

```sh
bun run benchmark:go-codec
```

Compares zstd vs fflate and go-diff vs the affix model on recording-shaped
payloads, asserting every codec round-trips. See [`../../../scripts/benchmark-go-codec.mjs`](../../../scripts/benchmark-go-codec.mjs).

## ABI

All data crosses through linear `memory` (wasm32 offsets). A `u64` result packs
`(ptr << 32) | len`; `0` means empty (or, for decode/apply, an error). The host
reads `len` bytes at `ptr`, then calls `freeBuf(ptr)`.

| export                                | signature    | notes                             |
| ------------------------------------- | ------------ | --------------------------------- |
| `alloc(size u32)`                     | `-> ptr u32` | pinned host-writable buffer       |
| `freeBuf(ptr u32)`                    |              | release a pinned buffer¹          |
| `zstdCompress(ptr,len u32)`           | `-> u64`     | SpeedDefault                      |
| `zstdDecompress(ptr,len u32)`         | `-> u64`     |                                   |
| `diffDelta(aPtr,aLen,bPtr,bLen u32)`  | `-> u64`     | `DiffToDelta(a -> b)`             |
| `applyDelta(aPtr,aLen,dPtr,dLen u32)` | `-> u64`     | reconstructs `b` from `a` + delta |

¹ Named `freeBuf`, not `free`, because TinyGo's runtime already exports a C
`free`; the two can't share an export name. `freeBuf` releases buffers from the
module's `keep` map and is unrelated to the C allocator.

The diff delta is opaque to JS — `applyDelta` consumes exactly what `diffDelta`
produces, so the format never needs a JS-side interpreter.
[`../../../scripts/wasm-go-loader.mjs`](../../../scripts/wasm-go-loader.mjs) is a
reference host (Node `node:wasi`); the same shape works in a browser worker with
a WASI shim.

## ⚠️ The size tradeoff (read before adopting)

Even via TinyGo the runtime + GC dominate, so this module is **~0.72 MB raw /
~283 KB gzipped** — large for a WASM helper. It is only viable **lazy-loaded
inside the recording worker**, never on the main bundle path. The win it buys (measured): zstd ≈ half the size of fflate on code
keyframes, and go-diff stays compact on scattered edits where the affix delta
degenerates to near-keyframe size.

TinyGo over native Go (which would be ~4.5 MB) is a 6.3× size win with
byte-identical zstd output, so recordings made by either build interop. The cost
is throughput: TinyGo's conservative GC + asyncify make zstd ~4× slower than
native (still sub-millisecond on recording-shaped payloads). The CI build needs
TinyGo on `PATH`; the native-Go fallback in the build script stays as an escape
hatch.
