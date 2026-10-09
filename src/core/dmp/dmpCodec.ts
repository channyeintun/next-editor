// Host binding for the Rust diff-match-patch WASM module built from this crate
// (build/next-editor-dmp.wasm); it lives beside the crate so core owns its codec.
//
// The module is a pure-compute, **zero-import** WASM (see README.md) — a
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
// README.md).
//
// `encodeAppendDelta` (end of this file) is the one place TypeScript writes the
// delta wire format itself, so it sits here beside the crate that defines it.

interface DmpExports {
  memory: WebAssembly.Memory;
  alloc(size: number): number;
  freeBuf(ptr: number): void;
  // i64 result packs (ptr << 32) | len; crosses to JS as a bigint.
  diffDelta(aPtr: number, aLen: number, bPtr: number, bLen: number): bigint;
  applyDelta(aPtr: number, aLen: number, dPtr: number, dLen: number): bigint;
}

export interface DmpCodec {
  /**
   * Opaque diff-match-patch delta that transforms `a` into `b`; consumed by
   * {@link applyDelta}. Always begins with a CHECK op carrying a hash of `a`.
   */
  diffDelta(a: Uint8Array, b: Uint8Array): Uint8Array;
  /**
   * Reconstruct `b` from `a` and a delta produced by {@link diffDelta}. Throws
   * {@link DmpBaseMismatchError} when `a` is not the base the delta was diffed
   * against (it fails the delta's CHECK hash), a plain Error on a structurally
   * corrupt, truncated or pre-CHECK delta, and a TypeError when either input
   * is not an ArrayBuffer view (e.g. a forged msgpack map).
   */
  applyDelta(a: Uint8Array, delta: Uint8Array): Uint8Array;
}

/** Thrown by `applyDelta` when the base content fails the delta's CHECK hash. */
export class DmpBaseMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DmpBaseMismatchError";
  }
}

function bind(exports: DmpExports): DmpCodec {
  const u8 = () => new Uint8Array(exports.memory.buffer);

  const write = (input: Uint8Array): number => {
    // Deltas come out of untrusted .ne files via msgpack, where a map such as
    // `{ length: -8 }` decodes to a plain object; its length must never reach
    // alloc as a raw size. ArrayBuffer.isView rather than `instanceof`, which
    // also rejects genuine byte arrays from another realm (a same-origin frame,
    // or jsdom's globals under Vitest, where TextEncoder output fails it).
    if (!ArrayBuffer.isView(input)) {
      throw new TypeError("dmp codec: input must be a Uint8Array");
    }
    const ptr = exports.alloc(input.length || 1);
    u8().set(input, ptr);
    return ptr;
  };

  // Failure sentinels (impossible ptr/len packs); a packed (ptr=0,len=0) is a
  // valid *empty* result. ERR_BASE is the actionable one: the delta was applied
  // against a base whose bytes don't match its CHECK hash (replay desync).
  const ERR_CORRUPT = 0xffffffffffffffffn;
  const ERR_BASE = 0xfffffffffffffffen;
  const read = (packed: bigint, label: string): Uint8Array => {
    const value = BigInt.asUintN(64, packed);
    if (value === ERR_BASE) {
      throw new DmpBaseMismatchError(
        `dmp codec: ${label} base mismatch — delta applied against the wrong base content`,
      );
    }
    if (value === ERR_CORRUPT) throw new Error(`dmp codec: ${label} failed (corrupt delta?)`);
    const ptr = Number(value >> 32n);
    const len = Number(value & 0xffffffffn);
    if (ptr === 0) return new Uint8Array(0);
    const out = u8().slice(ptr, ptr + len);
    exports.freeBuf(ptr);
    return out;
  };

  // Both writes sit inside the try so a throwing second write (bad input, or
  // an alloc trap) still frees the first buffer.
  return {
    diffDelta(a, b) {
      let aPtr: number | null = null;
      let bPtr: number | null = null;
      try {
        aPtr = write(a);
        bPtr = write(b);
        return read(exports.diffDelta(aPtr, a.length, bPtr, b.length), "diffDelta");
      } finally {
        if (aPtr !== null) exports.freeBuf(aPtr);
        if (bPtr !== null) exports.freeBuf(bPtr);
      }
    },
    applyDelta(a, delta) {
      let aPtr: number | null = null;
      let dPtr: number | null = null;
      try {
        aPtr = write(a);
        dPtr = write(delta);
        return read(exports.applyDelta(aPtr, a.length, dPtr, delta.length), "applyDelta");
      } finally {
        if (aPtr !== null) exports.freeBuf(aPtr);
        if (dPtr !== null) exports.freeBuf(dPtr);
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
 * won't instantiate again when one was installed directly. A failed load is not
 * cached; the next call tries again.
 * Run `bun run build:wasm` to produce the artifact.
 */
export function loadDmpCodec(): Promise<DmpCodec> {
  if (current) return Promise.resolve(current);
  cached ??= (async () => {
    // Bare WASM-ESM import: Vite instantiates the (zero-import) module and the
    // returned namespace *is* its exports.
    const wasm = await import("./build/next-editor-dmp.wasm");
    const codec = bind(wasm as unknown as DmpExports);
    current = codec;
    return codec;
  })().catch((error: unknown) => {
    // A transient chunk failure (offline, a stale tab after a deploy) must not
    // disable decoding for the rest of the page's life.
    cached = undefined;
    throw error;
  });
  return cached;
}

// ---------------------------------------------------------------------------
// Append-only fast path. The constants and helpers below mirror the delta
// wire format in src/lib.rs (op kinds, `op_tag`, `varint_size`, `write_varint`,
// `fnv1a32`); a change there must be made here too. A test in dmpCodec.test.ts
// applies this encoder's output with the real module.
// ---------------------------------------------------------------------------

// Op kinds, the low 2 bits of a serialized op tag (EQUAL, INSERT and CHECK in
// lib.rs). The append encoder never writes DELETE.
const EQUAL_KIND = 0;
const INSERT_KIND = 2;
const CHECK_KIND = 3;
/** The CHECK op's payload: a little-endian FNV-1a hash of the whole base. */
const CHECK_HASH_LEN = 4;
/** One under lib.rs MAX_BUF (2^30): the longest op whose `(len << 2) | kind` tag fits a u32. */
const MAX_OP_BYTES = 0x3fffffff;
const FNV1A32_OFFSET_BASIS = 0x811c9dc5;
const FNV1A32_PRIME = 0x01000193;

/**
 * lib.rs `op_tag`, `(len << 2) | kind`, computed arithmetically so a length
 * near MAX_OP_BYTES does not wrap to a negative int32.
 */
function opTag(kind: number, len: number): number {
  return len * 4 + kind;
}

function fnv1a32(bytes: Uint8Array): number {
  let hash = FNV1A32_OFFSET_BASIS;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, FNV1A32_PRIME);
  }
  return hash >>> 0;
}

/** Byte length of `value` as an LEB128 varint. */
function varintSize(value: number): number {
  let remaining = value >>> 0;
  let byteLength = 1;
  while (remaining >= 0x80) {
    remaining >>>= 7;
    byteLength += 1;
  }
  return byteLength;
}

/** Writes `value` as an LEB128 varint at `offset`; returns the offset after it. */
function writeVarint(target: Uint8Array, offset: number, value: number): number {
  let remaining = value >>> 0;
  while (remaining >= 0x80) {
    target[offset] = (remaining & 0x7f) | 0x80;
    offset += 1;
    remaining >>>= 7;
  }
  target[offset] = remaining;
  return offset + 1;
}

/**
 * Encodes the delta that appends `appendedBytes` to `baseBytes` without
 * running the Myers diff: the mandatory CHECK head over the base, one EQUAL op
 * over the whole base (omitted when it is empty) and one INSERT op carrying
 * only the appended bytes. Pure TypeScript, so it needs no loaded module;
 * {@link DmpCodec.applyDelta} accepts the result like any diffDelta output.
 * Throws when either side is longer than one op can describe.
 */
export function encodeAppendDelta(baseBytes: Uint8Array, appendedBytes: Uint8Array): Uint8Array {
  if (baseBytes.byteLength > MAX_OP_BYTES || appendedBytes.byteLength > MAX_OP_BYTES) {
    throw new Error("append-only content delta exceeds the codec operation limit");
  }

  const checkTag = opTag(CHECK_KIND, CHECK_HASH_LEN);
  const equalTag = opTag(EQUAL_KIND, baseBytes.byteLength);
  const insertTag = opTag(INSERT_KIND, appendedBytes.byteLength);
  const byteLength =
    varintSize(checkTag) +
    CHECK_HASH_LEN +
    (baseBytes.byteLength > 0 ? varintSize(equalTag) : 0) +
    varintSize(insertTag) +
    appendedBytes.byteLength;
  const delta = new Uint8Array(byteLength);

  let offset = writeVarint(delta, 0, checkTag);
  new DataView(delta.buffer).setUint32(offset, fnv1a32(baseBytes), true);
  offset += CHECK_HASH_LEN;
  if (baseBytes.byteLength > 0) {
    offset = writeVarint(delta, offset, equalTag);
  }
  offset = writeVarint(delta, offset, insertTag);
  delta.set(appendedBytes, offset);

  return delta;
}
