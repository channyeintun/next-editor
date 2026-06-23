# assembly — diff-match-patch codec (AssemblyScript)

A WebAssembly module compiled from **AssemblyScript** that exposes the recording
codec's content-delta primitive to the browser/worker host:

- **`diffDelta(a, b)`** — a [diff-match-patch](https://github.com/google/diff-match-patch)
  (Myers middle-snake) delta that transforms `a` into `b`. It generalizes the old
  prefix/suffix (`affix`) `ContentDelta`, which bloated to near-keyframe size on
  scattered, non-contiguous edits ([`frameDelta.ts`](../src/utils/frameDelta.ts)).
- **`applyDelta(a, delta)`** — reconstructs `b` from `a` and the delta.

Compression is handled separately by **fflate** (zlib), not this module.

## Why AssemblyScript (and why it can use Vite's `.wasm` import)

This module is intentionally **import-free** — `WebAssembly.Module.imports()` is
`[]`. That is exactly the shape Vite 8.1's WASM-ESM integration requires: with no
imports to satisfy, the host can load it with no import object and use its exports
directly (see [`dmpCodec.ts`](../../storage/dmpCodec/dmpCodec.ts)) — no fetch, no
`WebAssembly.instantiate` boilerplate.

> **Toolchain note.** The project builds with `vite-plus` (rolldown), which does
> not yet implement the bare `import { diffDelta } from "…wasm"` ESM integration
> — a bare import routes to `builtin:vite-wasm-fallback` and fails. So the loader
> uses Vite's `?init` import, the supported mechanism here. Because the module is
> import-free, moving to the bare ESM form once vite-plus supports it is a
> one-line change in `dmpCodec.ts`.

A Go/TinyGo module can **never** load import-free: its runtime always imports
`wasi_snapshot_preview1` (or the `gojs` glue), which no import-object-free loader
can satisfy. The previous Go codec (~0.72 MB) was replaced by this module (~7 KB)
for that reason — the diff win was always an _algorithm_ choice (Myers vs affix),
not a _language_ one.

To stay import-free the build uses `use: ["abort="]` (see
[`asconfig.json`](../../../asconfig.json)), which traps via the WebAssembly
`unreachable` instruction instead of importing `env.abort`.

## Build

```sh
bun run build:wasm        # -> src/core/assembly/build/next-editor-dmp.wasm
```

Uses `asc` (the `assemblyscript` dev dependency) with `--runtime incremental` so
the diff's temporary arrays are garbage-collected inside the module. The `.wasm`
is committed (~7 KB) so tests and Vercel need no build step; the `.wat` debug
disassembly is gitignored.

## Benchmark

```sh
bun run benchmark:dmp-codec
```

Compares the diff-match-patch delta against the old affix model on
recording-shaped payloads and asserts every delta round-trips. See
[`benchmark-dmp-codec.mjs`](../../../scripts/benchmark-dmp-codec.mjs).

## ABI

All data crosses through linear `memory` (wasm32 offsets). A `u64` result packs
`(ptr << 32) | len`; `0` means empty, and an all-ones sentinel means failure
(corrupt/mismatched delta). The host reads `len` bytes at `ptr`, then calls
`freeBuf(ptr)`.

| export                                | signature    | notes                              |
| ------------------------------------- | ------------ | ---------------------------------- |
| `alloc(size u32)`                     | `-> ptr u32` | host-writable input buffer         |
| `freeBuf(ptr u32)`                    |              | release a buffer (input or result) |
| `diffDelta(aPtr,aLen,bPtr,bLen u32)`  | `-> u64`     | `a -> b` delta                     |
| `applyDelta(aPtr,aLen,dPtr,dLen u32)` | `-> u64`     | reconstructs `b` from `a` + delta  |

The delta is opaque to JS: each op is a LEB128 varint `(len << 2) | type`
(`0` EQUAL copy-from-source, `1` DELETE skip-source, `2` INSERT literal bytes
that follow). `applyDelta` consumes exactly what `diffDelta` produces, so the
format never needs a JS-side interpreter.
