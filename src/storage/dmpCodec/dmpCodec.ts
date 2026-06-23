// App-facing wrapper around the AssemblyScript diff-match-patch WASM module.
//
// The module is a pure-compute, **zero-import** WASM (see src/core/assembly) — a
// TinyGo/WASI module can never be, because its runtime always needs host imports.
// That zero-import shape is precisely what Vite 8.1's WASM-ESM integration wants:
// the day the build toolchain supports it, this becomes
//   `import { diffDelta, applyDelta, alloc, freeBuf, memory } from "…wasm";`
// with no fetch and no import object.
//
// Today the project builds with vite-plus (rolldown), which hasn't wired that
// bare-`.wasm` ESM integration yet — a bare import routes to the wasm fallback
// plugin and fails. So we use Vite's `?init` import, which is the supported
// mechanism in this toolchain: it hands back an init function that instantiates
// the (import-free) module on demand. Switching to the bare ESM import later is
// a one-line change here.
//
// WebAssembly calls are synchronous, so once the module is instantiated the
// codec methods are plain sync calls — only `loadDmpCodec()` is async. All data
// crosses through linear memory using the module's alloc/pack ABI (see
// src/core/assembly/README.md).
import initDmpWasm from "../../core/assembly/build/next-editor-dmp.wasm?init";

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
 * Load and cache the codec via Vite's `?init` WASM import, then install it as the
 * singleton. A no-op once a codec is present, so it's safe to call repeatedly and
 * won't instantiate again when one was installed directly.
 * Run `bun run build:wasm` to produce the artifact.
 */
export function loadDmpCodec(): Promise<DmpCodec> {
  if (current) return Promise.resolve(current);
  cached ??= (async () => {
    // The module imports nothing, so it needs no import object.
    const instance = await initDmpWasm();
    const codec = bind(instance.exports as unknown as DmpExports);
    current = codec;
    return codec;
  })();
  return cached;
}
