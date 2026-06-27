// App-facing wrapper around the Rust diff-match-patch WASM module.
//
// The module is a pure-compute, **zero-import** WASM (see src/core/dmp) — a
// Go/TinyGo/WASI module can never be, because its runtime always needs host
// imports; Rust on wasm32-unknown-unknown can. That zero-import shape lets us use
// the WASM-ESM integration directly: a plain
// `import("…wasm")` instantiates the module (no import object) and hands back its
// exports. `loadDmpCodec()` uses the *dynamic* form so the wasm code-splits into
// its own lazy chunk and doesn't pull top-level await into the main graph; the
// static `import { diffDelta } from "…wasm"` works too.
//
// The integration is provided by `vite-plugin-wasm` (vite.config.ts) — vite-plus
// (rolldown) doesn't yet ship the bare-`.wasm` integration natively, and that
// plugin is exactly what stock Vite 8.1 upstreamed it from. Vitest can't import
// `.wasm`, so tests instantiate from bytes via `instantiateDmpCodec` instead and
// never hit the dynamic import.
//
// WebAssembly calls are synchronous, so once the module is instantiated the
// codec methods are plain sync calls — only `loadDmpCodec()` is async. All data
// crosses through linear memory using the module's alloc/pack ABI (see
// src/core/dmp/README.md).

interface DmpExports {
  memory: WebAssembly.Memory;
  alloc(size: number): number;
  freeBuf(ptr: number): void;
  // i64 result packs (ptr << 32) | len; crosses to JS as a bigint.
  diffDelta(aPtr: number, aLen: number, bPtr: number, bLen: number): bigint;
  applyDelta(aPtr: number, aLen: number, dPtr: number, dLen: number): bigint;
}

export interface DmpCodec {
  /** Opaque diff-match-patch delta that transforms `a` into `b`; consumed by {@link applyDelta}. */
  diffDelta(a: Uint8Array, b: Uint8Array): Uint8Array;
  /** Reconstruct `b` from `a` and a delta produced by {@link diffDelta}. Throws on a bad/mismatched delta. */
  applyDelta(a: Uint8Array, delta: Uint8Array): Uint8Array;
}

function bind(exports: DmpExports): DmpCodec {
  const u8 = () => new Uint8Array(exports.memory.buffer);

  const write = (input: Uint8Array): number => {
    const ptr = exports.alloc(input.length || 1);
    u8().set(input, ptr);
    return ptr;
  };

  // The module returns an all-ones sentinel for failure; a packed (ptr=0,len=0)
  // is a valid *empty* result.
  const ERROR = 0xffffffffffffffffn;
  const read = (packed: bigint, label: string): Uint8Array => {
    const value = BigInt.asUintN(64, packed);
    if (value === ERROR) throw new Error(`dmp codec: ${label} failed (corrupt/mismatched input?)`);
    const ptr = Number(value >> 32n);
    const len = Number(value & 0xffffffffn);
    if (ptr === 0) return new Uint8Array(0);
    const out = u8().slice(ptr, ptr + len);
    exports.freeBuf(ptr);
    return out;
  };

  return {
    diffDelta(a, b) {
      const aPtr = write(a);
      const bPtr = write(b);
      try {
        return read(exports.diffDelta(aPtr, a.length, bPtr, b.length), "diffDelta");
      } finally {
        exports.freeBuf(aPtr);
        exports.freeBuf(bPtr);
      }
    },
    applyDelta(a, delta) {
      const aPtr = write(a);
      const dPtr = write(delta);
      try {
        return read(exports.applyDelta(aPtr, a.length, dPtr, delta.length), "applyDelta");
      } finally {
        exports.freeBuf(aPtr);
        exports.freeBuf(dPtr);
      }
    },
  };
}

/** Instantiate the codec from raw module bytes (no import). Used by tests/Node hosts. */
export async function instantiateDmpCodec(wasmBytes: BufferSource): Promise<DmpCodec> {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  return bind(instance.exports as unknown as DmpExports);
}

// The recording codec's content delta is required (no fallback), so it is held
// as a module singleton accessed synchronously by the encode/decode/replay
// paths. `loadDmpCodec()` populates it once; `installDmpCodec()` lets tests
// inject a codec built from local bytes.
let current: DmpCodec | undefined;
let cached: Promise<DmpCodec> | undefined;

/**
 * Synchronous accessor for the loaded codec. Throws if it hasn't been loaded yet
 * — callers on async boundaries (worker, recording load) must `await
 * loadDmpCodec()` first; by the time replay reconstructs frames the codec is
 * guaranteed present.
 */
export function getDmpCodec(): DmpCodec {
  if (!current) {
    throw new Error("dmp codec not loaded — await loadDmpCodec() before encode/decode/replay");
  }
  return current;
}

export function isDmpCodecLoaded(): boolean {
  return current !== undefined;
}

/** Inject an already-instantiated codec as the singleton (tests, custom hosts). */
export function installDmpCodec(codec: DmpCodec): void {
  current = codec;
}

/**
 * Load and cache the codec via the WASM-ESM integration, then install it as the
 * singleton. A no-op once a codec is present, so it's safe to call repeatedly and
 * won't instantiate again when one was installed directly.
 * Run `bun run build:wasm` to produce the artifact.
 */
export function loadDmpCodec(): Promise<DmpCodec> {
  if (current) return Promise.resolve(current);
  cached ??= (async () => {
    // Bare WASM-ESM import: Vite instantiates the (zero-import) module and the
    // returned namespace *is* its exports.
    const wasm = await import("../../core/dmp/build/next-editor-dmp.wasm");
    const codec = bind(wasm as unknown as DmpExports);
    current = codec;
    return codec;
  })();
  return cached;
}
