# Recording codec evolution: AssemblyScript → TinyGo → AssemblyScript → Rust

A decision record for the recording codec's two primitives — **content diff**
(turn frame _N-1_'s text into frame _N_'s) and **payload compression** (shrink
the msgpack'd SCR3 segments). They have changed implementation language three
times. This doc explains what each phase did, why it changed, and the lesson
that settled it, so the loop isn't accidentally re-run.

## TL;DR

| Phase                         | Diff model               | Compression   | WASM                  | Size        | Loadable without host imports? |
| ----------------------------- | ------------------------ | ------------- | --------------------- | ----------- | ------------------------------ |
| **1. AssemblyScript (affix)** | prefix/suffix "affix"    | fflate (zlib) | AS affix helpers      | **357 B**   | yes (zero imports)             |
| **2. Go / TinyGo**            | go-diff (Myers)          | zstd          | TinyGo wasip1 reactor | **0.72 MB** | **no** (needs WASI)            |
| **3. AssemblyScript (dmp)**   | diff-match-patch (Myers) | fflate (zlib) | AS dmp module         | **6.6 KB**  | yes (zero imports)             |
| **4. Rust (dmp)**             | diff-match-patch (Myers) | fflate (zlib) | Rust `no_std` module  | **6.7 KB**  | yes (zero imports)             |

**The lesson:** the recording-size win was always the **diff algorithm** (Myers
vs affix), never the **language**. Phase 2 conflated the two — it adopted a heavy
runtime to get a better diff that AssemblyScript could have produced all along.
Phase 3 keeps the better diff and drops the runtime. Phase 4 keeps the format
byte-identical and swaps only the source language, for the LLVM backend's faster
Myers loops at the same size and the same zero-import property.

---

## Phase 1 — AssemblyScript (affix model)

Introduced in `b2f17f8` _"perf: enhance encoding and decoding using wasm with
AssemblyScript"_. Compression had moved pako → fflate by then (`4042ce9` add
pako, `02cf636` replace pako/jszip with fflate).

- **Diff:** `ContentDelta = { prefixLen, suffixLen, insert }`. Two AssemblyScript
  helpers, `findCommonPrefix` / `findCommonSuffix`, compared bytes 8 at a time in
  linear memory; the host (`wasm.ts`) spliced the middle.
- **Compression:** fflate `zlibSync` / `unzlibSync`.
- **WASM:** `public/next-editor.wasm`, **357 bytes, zero imports** (exports only
  `memory` and the two diff functions).

**Why it was abandoned:** the affix model is the real flaw. A delta only stores
one contiguous middle region, so **any edit touching both ends of the document**
(or several scattered edits) forces `prefixLen`/`suffixLen` toward zero and
`insert` toward the whole document — the delta degenerates to near-keyframe size.
This is the delta-bloat that motivated Phase 2.

---

## Phase 2 — Go / TinyGo (zstd + go-diff)

`b447c44` _"Replace recording codec with Go WASM (zstd + go-diff)"_ (2026-06-23),
then `48deedc` _"Build Go codec WASM with TinyGo (4.5MB → 0.72MB)"_. The demo was
transcoded to the new format in `133527f` _"Migrate demo"_.

- **Diff:** an opaque [`sergi/go-diff`](https://github.com/sergi/go-diff) delta
  (`ContentDelta = { delta: Uint8Array }`). go-diff is a Go port of Google's
  diff-match-patch — a real Myers diff, so it stays compact across scattered
  edits where affix degenerated.
- **Compression:** zstd ([`klauspost/compress`](https://github.com/klauspost/compress)),
  replacing fflate. ~half the size of fflate on code keyframes.
- **WASM:** a Go `wasip1` reactor (`//go:wasmexport`), built with TinyGo
  (`-target=wasip1 -buildmode=c-shared`). Native Go was ~4.5 MB; TinyGo cut it to
  **~0.72 MB / 283 KB gz**. Loaded with a hand-written WASI shim
  (`src/storage/goCodec/wasiShim.ts`).

**What it cost:**

- **0.72 MB** WASM (vs 357 B), lazy-loaded in the recording worker.
- A WASI shim, `tinygo` on CI's `PATH` (~1.2 GB), and a `freeBuf`-not-`free`
  export workaround (TinyGo's runtime already exports C `free`).
- zstd ~4× slower than native Go (still sub-ms on recording payloads).
- **Can never use Vite's `.wasm` import** — the Go runtime always imports
  `wasi_snapshot_preview1`, which no import-object-free loader can satisfy.

**The conflation:** two wins were bundled together. The **big** one (compact
deltas on scattered edits) came from the diff _algorithm_, which is
language-agnostic. The **small** one (zstd ≈ half fflate) is the only thing that
genuinely needed a richer toolchain — and it's what dragged in the 0.72 MB
runtime.

---

## Phase 3 — AssemblyScript (diff-match-patch) + fflate

`2966240` _"Replace Go WASM codec with AssemblyScript diff-match-patch + fflate"_
(2026-06-24); follow-ups `e2cbeb0` (docs) and `01cea67` (build script).

- **Diff:** a faithful **diff-match-patch (Myers middle-snake)** port in
  AssemblyScript (`src/core/assembly/index.ts`), operating on raw UTF-8 bytes in
  linear memory. Same `ContentDelta = { delta: Uint8Array }` shape; same delta
  quality as go-diff (it is the same algorithm). Host wrapper in
  `src/storage/dmpCodec/`.
- **Compression:** back to fflate `zlibSync` / `unzlibSync`.
- **WASM:** `src/core/assembly/build/next-editor-dmp.wasm`, **~6.6 KB, zero
  imports** (`WebAssembly.Module.imports()` is `[]`), committed to the repo. Built
  with `bun run build:wasm` (`asc`, `--runtime incremental`, `use: ["abort="]`).

**What it cost:** fflate is ~10–25% larger than zstd; the demo grew 1150 KB →
1277 KB (+11%). That is the deliberate price of dropping the 0.72 MB runtime —
the diff-quality win is fully preserved.

**What it bought:** WASM 0.72 MB → 6.6 KB, no WASI shim, no TinyGo on CI, and a
module that is **shaped for Vite's WASM-ESM import** because it has no host
imports (see "Loading", below).

---

## Phase 4 — Rust (diff-match-patch), same format

The diff-match-patch port moved from AssemblyScript to **Rust** (`no_std`,
`wasm32-unknown-unknown`) in `src/core/dmp`.

- **Diff:** the same Myers middle-snake algorithm, ported faithfully so the delta
  byte format is **identical** to Phase 3. `ContentDelta = { delta: Uint8Array }`
  is unchanged; the host wrapper in `src/storage/dmpCodec/` is unchanged.
- **Compression:** still fflate.
- **WASM:** `src/core/dmp/build/next-editor-dmp.wasm`, **~6.7 KB, zero imports**
  (`WebAssembly.Module.imports()` is `[]`), committed. Built with `bun run
build:wasm` → `cargo build` (opt-level=3 + LTO) then `wasm-opt -all -O3`. Stays
  import-free via `#![no_std]` + a panic handler that traps (`unreachable`), a
  self-contained `memory.grow` allocator, and the `-unknown` (non-WASI) target.

**Why:** the LLVM backend produces faster Myers inner loops, at effectively the
same artifact size and the same zero-import property. Rust is the first
non-AssemblyScript language in this history that _can_ stay import-free
(Go/TinyGo never could).

**Benchmark (Rust vs the AssemblyScript module it replaced).** Point-in-time, one
machine (Apple Silicon, Node 24), median of 3 × 2000 iterations through the same
host wrapper; ratio > 1 means Rust is faster. This was a one-off migration
measurement — the AS module is gone, so it isn't reproducible from the repo (the
committed `benchmark:dmp-codec` only compares delta _size_ vs the affix model).

| Operation                | AssemblyScript | Rust     | Rust speedup |
| ------------------------ | -------------- | -------- | ------------ |
| `diffDelta`, contiguous  | ~34.5 ms       | ~31.4 ms | **~1.1×**    |
| `diffDelta`, scattered   | ~87 ms         | ~32 ms   | **~2.7×**    |
| `applyDelta`, contiguous | ~4.7 ms        | ~6.6 ms  | ~0.7×        |
| `applyDelta`, scattered  | ~2.4 ms        | ~2.7 ms  | ~0.9×        |
| Artifact size            | 6633 B         | 6670 B   | ≈parity      |

The win is on `diffDelta` — which runs hot during recording, on every content
change — and is largest exactly on scattered, non-contiguous edits (the case this
codec exists for). `applyDelta` is a few hundred ns slower per call in the
microbench (copy-bound, and the JS-side `slice` out of linear memory dominates
equally for both); it runs only at replay and is single-µs in absolute terms, so
it is not a meaningful regression. Enabling the `bulk-memory` target feature did
**not** improve `applyDelta` and grew the binary ~530 B, so it is left off.

**What it cost:** a Rust toolchain (`rustup target add wasm32-unknown-unknown` +
`wasm-opt`) is now needed to **regenerate** the artifact. The `.wasm` is still
committed, so tests, Vercel, and contributors who don't touch the codec need no
Rust. Because the delta format is byte-identical, existing recordings decode
unchanged — no migration.

---

## Current state

- **Diff:** `getDmpCodec().diffDelta(a, b)` / `applyDelta(a, delta)`, wired into
  `createContentDelta` / `applyContentDelta` in `frameDelta.ts`. ABI and op
  format documented in [`../dmp/README.md`](../dmp/README.md).
- **Compression:** fflate, in `streamingRecordingCodec/format.ts` + `decode.ts`.
- **The JS prefix/suffix helpers survive** (`findCommonPrefixLength` /
  `findCommonSuffixLength` in `frameDelta.ts`, backed by pure-JS
  `stringAffix.ts`) but are **not** used for `ContentDelta` anymore — only to
  compute a minimal edit range when applying content to the live Monaco editor
  (`editorDiff.ts`). Don't mistake them for a missing WASM affix module.

### Loading (the Vite WASM import)

The codec is import-free, so `loadDmpCodec()` uses the **bare WASM-ESM import** —
`await import("…wasm")` returns the instantiated exports directly (no fetch, no
import object). The dynamic form is used so the wasm code-splits into its own lazy
chunk without pulling top-level await into the main module graph.

vite-plus (rolldown) doesn't ship that integration natively yet — a bare import
would otherwise route to `builtin:vite-wasm-fallback` and fail — so it's provided
by [`vite-plugin-wasm`](https://github.com/Menci/vite-plugin-wasm) (the plugin
stock Vite 8.1 upstreamed the feature from), registered in both `plugins` and
`worker.plugins` in `vite.config.ts`. Two consequences:

- **`worker.format: "es"`** is required: `vite-plugin-wasm` emits a top-level
  `await` in the generated wasm module, which only an ES-module worker tolerates.
  This is global, so Monaco's `?worker` workers also build as ES modules (fine —
  they're created as `type: "module"` already, but worth knowing).
- **Vitest can't import `.wasm`** (its bundled Vite errors), so tests instantiate
  from bytes via `instantiateDmpCodec` and never hit the dynamic import.

When vite-plus ships the integration natively, the plugin (and `worker.format`)
can be dropped with no code change.

### Format compatibility

Each phase changed the on-wire bytes (compression algo and delta encoding), and
**old recordings do not auto-upgrade** — there is no zstd decoder or go-diff
applier in the app anymore. Recordings written during the brief Phase-2 window
(zstd + go-diff) must be transcoded; `public/introduction.ne` was migrated back
to fflate + dmp via a throwaway worktree pinned at the Phase-2 commit (Go decode
→ fflate+dmp re-encode, verified frame-by-frame).

## If you're tempted to change this again

- **Want smaller recordings?** Improve the delta or bring back a _small_ WASM
  zstd (e.g. a freestanding C/Rust build that stays import-free) — do **not**
  reach for a runtime that needs WASI/`gojs`, or you re-lose the Vite import and
  re-add ~0.7 MB.
- **Want the bare `import { fn } from "…wasm"`?** That's a build-toolchain gap,
  not a codec gap. Track vite-plus's WASM-ESM support; the codec is already ready.
