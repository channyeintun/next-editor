// App-facing wrapper around the Go (zstd + go-diff) WASM codec.
//
// WebAssembly calls are synchronous, so once the module is instantiated the
// codec methods are plain sync calls — only `loadGoCodec()` is async (it fetches
// and instantiates once, then caches). All data crosses through linear memory
// using the module's alloc/pack ABI (see src/core/wasm-go/README.md).
import { createWasiShim } from "./wasiShim";

interface GoExports {
  memory: WebAssembly.Memory;
  alloc(size: number): number;
  free(ptr: number): void;
  zstdCompress(ptr: number, len: number): bigint;
  zstdDecompress(ptr: number, len: number): bigint;
  diffDelta(aPtr: number, aLen: number, bPtr: number, bLen: number): bigint;
  applyDelta(aPtr: number, aLen: number, dPtr: number, dLen: number): bigint;
}

export interface GoCodec {
  /** zstd-compress bytes (SpeedDefault). */
  zstdCompress(input: Uint8Array): Uint8Array;
  /** Inverse of {@link zstdCompress}. Throws on corrupt input. */
  zstdDecompress(input: Uint8Array): Uint8Array;
  /** go-diff delta that transforms `a` into `b`; opaque, consumed by {@link applyDelta}. */
  diffDelta(a: Uint8Array, b: Uint8Array): Uint8Array;
  /** Reconstruct `b` from `a` and a delta produced by {@link diffDelta}. Throws on bad delta. */
  applyDelta(a: Uint8Array, delta: Uint8Array): Uint8Array;
}

function bind(exports: GoExports): GoCodec {
  const u8 = () => new Uint8Array(exports.memory.buffer);

  const write = (input: Uint8Array): number => {
    const ptr = exports.alloc(input.length || 1);
    u8().set(input, ptr);
    return ptr;
  };

  // The module returns an all-ones sentinel for failure; a packed (ptr=0,len=0)
  // is a valid *empty* result (e.g. decompressing an empty-payload frame).
  const ERROR = 0xffffffffffffffffn;
  const read = (packed: bigint, label: string): Uint8Array => {
    const value = BigInt.asUintN(64, packed);
    if (value === ERROR) throw new Error(`Go codec: ${label} failed (corrupt input?)`);
    const ptr = Number(value >> 32n);
    const len = Number(value & 0xffffffffn);
    if (ptr === 0) return new Uint8Array(0);
    const out = u8().slice(ptr, ptr + len);
    exports.free(ptr);
    return out;
  };

  return {
    zstdCompress(input) {
      const ptr = write(input);
      try {
        return read(exports.zstdCompress(ptr, input.length), "zstdCompress");
      } finally {
        exports.free(ptr);
      }
    },
    zstdDecompress(input) {
      const ptr = write(input);
      try {
        return read(exports.zstdDecompress(ptr, input.length), "zstdDecompress");
      } finally {
        exports.free(ptr);
      }
    },
    diffDelta(a, b) {
      const aPtr = write(a);
      const bPtr = write(b);
      try {
        return read(exports.diffDelta(aPtr, a.length, bPtr, b.length), "diffDelta");
      } finally {
        exports.free(aPtr);
        exports.free(bPtr);
      }
    },
    applyDelta(a, delta) {
      const aPtr = write(a);
      const dPtr = write(delta);
      try {
        return read(exports.applyDelta(aPtr, a.length, dPtr, delta.length), "applyDelta");
      } finally {
        exports.free(aPtr);
        exports.free(dPtr);
      }
    },
  };
}

/** Instantiate the codec from raw module bytes (no fetch). Used by tests. */
export async function instantiateGoCodec(wasmBytes: BufferSource): Promise<GoCodec> {
  const wasi = createWasiShim();
  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  wasi.initialize(instance);
  return bind(instance.exports as unknown as GoExports);
}

// The recording codec is required (no fflate/affix fallback), so it is held as a
// module singleton accessed synchronously by the encode/decode/replay paths.
// `loadGoCodec()` populates it once; `installGoCodec()` lets tests inject a
// codec built from local bytes.
let current: GoCodec | undefined;
let cached: Promise<GoCodec> | undefined;

/**
 * Synchronous accessor for the loaded codec. Throws if it hasn't been loaded yet
 * — callers on async boundaries (worker, recording load) must `await loadGoCodec()`
 * first; by the time replay reconstructs frames the codec is guaranteed present.
 */
export function getGoCodec(): GoCodec {
  if (!current) {
    throw new Error("Go codec not loaded — await loadGoCodec() before encode/decode/replay");
  }
  return current;
}

export function isGoCodecLoaded(): boolean {
  return current !== undefined;
}

/** Inject an already-instantiated codec as the singleton (tests, custom hosts). */
export function installGoCodec(codec: GoCodec): void {
  current = codec;
}

/**
 * Load and cache the codec from a URL (defaults to the public artifact), then
 * install it as the singleton. A no-op once a codec is present, so it's safe to
 * call repeatedly and won't attempt a fetch when one was installed directly.
 * Run `bun run build:wasm-go` to produce the artifact.
 */
export function loadGoCodec(wasmUrl: string | URL = "/next-editor-go.wasm"): Promise<GoCodec> {
  if (current) return Promise.resolve(current);
  cached ??= (async () => {
    const response = await fetch(wasmUrl);
    if (!response.ok) {
      throw new Error(`Go codec: failed to fetch ${String(wasmUrl)} (${response.status})`);
    }
    const codec = await instantiateGoCodec(await response.arrayBuffer());
    current = codec;
    return codec;
  })();
  return cached;
}
