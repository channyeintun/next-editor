# dmp — diff-match-patch codec (Rust)

A WebAssembly module compiled from **Rust** (`no_std`, `wasm32-unknown-unknown`)
that exposes the recording codec's content-delta primitive to the browser/worker
host:

- **`diffDelta(a, b)`** — a [diff-match-patch](https://github.com/google/diff-match-patch)
  (Myers middle-snake) delta that transforms `a` into `b`. It generalizes the old
  prefix/suffix (`affix`) `ContentDelta`, which bloated to near-keyframe size on
  scattered, non-contiguous edits ([`frameDelta.ts`](../../utils/frameDelta.ts)).
- **`applyDelta(a, delta)`** — reconstructs `b` from `a` and the delta.

Compression is handled separately by **fflate** (zlib), not this module.

This replaces the previous AssemblyScript implementation (see
[`../docs/codec-history.md`](../docs/codec-history.md)). The port is faithful:
the delta byte format is **identical**, so deltas stored by older
(AssemblyScript-built) recordings still decode here unchanged. The move to Rust
buys the LLVM backend's faster Myers inner loops (notably scattered edits, the
case this codec exists for) at the same artifact size, while keeping the
zero-import property below.

## Why this can use Vite's `.wasm` import

This module is intentionally **import-free** — `WebAssembly.Module.imports()` is
`[]`. That is exactly the shape Vite's WASM-ESM integration requires: with no
imports to satisfy, the host loads it with a bare `import("…wasm")` and uses its
exports directly (see [`dmpCodec.ts`](../../storage/dmpCodec/dmpCodec.ts)) — no
fetch, no `WebAssembly.instantiate` boilerplate, no import object.

Three things keep it import-free:

1. **`#![no_std]` + panic handler that traps** via the `unreachable` instruction
   instead of importing `env.abort`.
2. **A self-contained allocator** that works entirely in `memory.grow`-acquired
   pages — it imports nothing and needs no `__heap_base` wiring.
3. **`wasm32-unknown-unknown`** (not `-wasi`) links no WASI runtime.

> A Go/TinyGo module can **never** load import-free: its runtime always imports
> `wasi_snapshot_preview1` (or the `gojs` glue), which no import-object-free
> loader can satisfy. Rust on the `-unknown` target can, which is why this and
> the AssemblyScript module before it could — and the previous Go codec
> (~0.72 MB) could not.

> **Toolchain note.** `vite-plus` (rolldown) doesn't ship the bare-`.wasm`
> integration natively yet — without help a bare import routes to
> `builtin:vite-wasm-fallback` and fails. So it's enabled by
> [`vite-plugin-wasm`](https://github.com/Menci/vite-plugin-wasm) in
> `vite.config.ts`, which also requires `worker.format: "es"` (the plugin emits a
> top-level `await` only an ES-module worker tolerates).

## Build

```sh
bun run build:wasm        # -> src/core/dmp/build/next-editor-dmp.wasm
```

Runs [`scripts/build-dmp-wasm.mjs`](../../../scripts/build-dmp-wasm.mjs):
`cargo build --release --target wasm32-unknown-unknown` (opt-level=3 + LTO) then
`wasm-opt -all -O3` (Binaryen) to shrink. Requires the Rust toolchain plus:

```sh
rustup target add wasm32-unknown-unknown
brew install binaryen          # provides wasm-opt
```

The `.wasm` is committed (~6.5 KB) so tests and Vercel need **no** Rust
toolchain; only regenerating the artifact does. The Cargo `target/` dir is
gitignored.

## Benchmark

```sh
bun run benchmark:dmp-codec
```

Compares the diff-match-patch delta **size** against the old affix model on
recording-shaped payloads and asserts every delta round-trips. See
[`benchmark-dmp-codec.mjs`](../../../scripts/benchmark-dmp-codec.mjs).

For the **speed** comparison against the previous AssemblyScript module (diff
~1.1× faster on contiguous edits, ~2.7× on scattered edits, at the same artifact
size), see the Phase 4 benchmark table in
[`../docs/codec-history.md`](../docs/codec-history.md).

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
