// next-editor-dmp — diff-match-patch (Myers) diff/patch in AssemblyScript.
//
// This is the recording codec's content-delta primitive: `diffDelta(a, b)`
// produces an opaque, compact delta that `applyDelta(a, delta)` turns back into
// `b`. It replaces the prefix/suffix ("affix") model, which bloated to
// near-keyframe size whenever an edit touched both ends of the document; the
// Myers middle-snake diff stays compact across scattered, non-contiguous edits.
//
// It is intentionally a pure-compute module with **zero host imports** (see
// `asconfig.json`: `use: ["abort="]` traps instead of importing `env.abort`) —
// `WebAssembly.Module.imports()` is `[]`. That is what lets it load with no
// import object: today via Vite's `?init` import, and via the bare WASM-ESM
// integration (`import { diffDelta } from "...wasm"`) once the build toolchain
// wires it up. A TinyGo/WASI module can never do either — its runtime always
// needs host imports.
//
// ABI: all data crosses through linear `memory`. The host writes inputs into
// buffers from `alloc`, calls a codec function, reads the packed `u64` result
// `(ptr << 32) | len`, then releases buffers with `freeBuf`. A result of `0`
// means empty; `ERR` (all ones) means failure (corrupt/mismatched delta). This
// mirrors the prior Go codec ABI so the JS host's reader is unchanged.
//
// SIZE BOUND: offsets and op lengths are i32/u32 and the serialized op tag is
// `(len << 2) | type`, so each buffer and each single op must stay under ~2^30
// bytes, and linear-memory addresses under 2^31 (INSERT stores its source as a
// signed-i32 address). The varint reader matches this — it stops at `shift > 28`,
// i.e. a 32-bit value. Comfortable for editor-sized documents; past ~1 GB these
// would overflow *silently* rather than trap, so callers must not feed it
// gigabyte inputs.

const ERR: u64 = 0xffffffffffffffff;

// Op tags (also the low 2 bits of each serialized op):
//   EQUAL  — copy `len` bytes from the source at the apply cursor
//   DELETE — skip `len` bytes of source
//   INSERT — copy `len` literal bytes that follow in the delta
const EQUAL: i32 = 0;
const DELETE: i32 = 1;
const INSERT: i32 = 2;

function pack(ptr: usize, len: i32): u64 {
  return ((<u64>ptr) << 32) | <u64>(<u32>len);
}

// ---------------------------------------------------------------------------
// Host I/O buffers (unmanaged: the host owns their lifetime via alloc/freeBuf).
// ---------------------------------------------------------------------------
export function alloc(size: i32): usize {
  return heap.alloc(size <= 0 ? 1 : <usize>size);
}

export function freeBuf(ptr: usize): void {
  heap.free(ptr);
}

// ---------------------------------------------------------------------------
// Op accumulator — diffs are streamed here in document order as parallel
// triples (type, off, len). For INSERT, `off` is the absolute linear-memory
// address of the literal bytes (in the `b` buffer, which stays live for the
// whole diff). Adjacent same-type ops are coalesced on push.
// ---------------------------------------------------------------------------
let opType: Array<i32> = [];
let opOff: Array<i32> = [];
let opLen: Array<i32> = [];

function resetOps(): void {
  opType = [];
  opOff = [];
  opLen = [];
}

function emit(type: i32, off: i32, len: i32): void {
  if (len <= 0) return;
  const n = opType.length;
  if (n > 0) {
    const last = n - 1;
    if (opType[last] == type) {
      if (type != INSERT) {
        opLen[last] += len;
        return;
      }
      // INSERT only merges when its source bytes are contiguous.
      if (opOff[last] + opLen[last] == off) {
        opLen[last] += len;
        return;
      }
    }
  }
  opType.push(type);
  opOff.push(off);
  opLen.push(len);
}

// ---------------------------------------------------------------------------
// Common affix lengths over raw byte ranges.
// ---------------------------------------------------------------------------
function commonPrefix(a: usize, aLen: i32, b: usize, bLen: i32): i32 {
  const n = aLen < bLen ? aLen : bLen;
  let i = 0;
  while (i < n && load<u8>(a + <usize>i) == load<u8>(b + <usize>i)) i++;
  return i;
}

function commonSuffix(a: usize, aLen: i32, b: usize, bLen: i32): i32 {
  const n = aLen < bLen ? aLen : bLen;
  let i = 0;
  while (i < n && load<u8>(a + <usize>(aLen - 1 - i)) == load<u8>(b + <usize>(bLen - 1 - i))) {
    i++;
  }
  return i;
}

// ---------------------------------------------------------------------------
// diff-match-patch core (faithful port of diff_main / diff_compute /
// diff_bisect / diff_bisectSplit, operating on bytes instead of UTF-16 units).
// ---------------------------------------------------------------------------
function diffMain(a: usize, aLen: i32, b: usize, bLen: i32): void {
  if (aLen == 0 && bLen == 0) return;

  const p = commonPrefix(a, aLen, b, bLen);
  if (p > 0) emit(EQUAL, 0, p);

  const a0 = a + <usize>p;
  const b0 = b + <usize>p;
  const aL = aLen - p;
  const bL = bLen - p;

  const s = commonSuffix(a0, aL, b0, bL);
  const aM = aL - s;
  const bM = bL - s;

  diffCompute(a0, aM, b0, bM);

  if (s > 0) emit(EQUAL, 0, s);
}

function diffCompute(a: usize, aLen: i32, b: usize, bLen: i32): void {
  if (aLen == 0) {
    if (bLen > 0) emit(INSERT, <i32>b, bLen);
    return;
  }
  if (bLen == 0) {
    emit(DELETE, 0, aLen);
    return;
  }
  diffBisect(a, aLen, b, bLen);
}

function diffBisect(a: usize, aLen: i32, b: usize, bLen: i32): void {
  const maxD = (aLen + bLen + 1) / 2; // ceil((aLen + bLen) / 2)
  const vOffset = maxD;
  const vLength = 2 * maxD; // logical diagonal span used by the overlap guards
  // The reference (JS) diff_bisect relies on sparse arrays auto-growing past
  // vLength for the `vOffset ± 1` accesses (notably when maxD == 1, e.g. a
  // single byte vs a single byte). A fixed-size Int32Array does not grow, so
  // pad the physical buffers by 2 to keep every `± 1` index in bounds.
  const cap = vLength + 2;
  const v1 = new Int32Array(cap);
  const v2 = new Int32Array(cap);
  for (let i = 0; i < cap; i++) {
    v1[i] = -1;
    v2[i] = -1;
  }
  v1[vOffset + 1] = 0;
  v2[vOffset + 1] = 0;
  const delta = aLen - bLen;
  // Whether the total difference is odd: only then can a forward and reverse
  // path overlap on the forward pass.
  const front = (delta & 1) != 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;

  for (let d = 0; d < maxD; d++) {
    // Forward path.
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1Offset = vOffset + k1;
      let x1: i32;
      if (k1 == -d || (k1 != d && v1[k1Offset - 1] < v1[k1Offset + 1])) {
        x1 = v1[k1Offset + 1];
      } else {
        x1 = v1[k1Offset - 1] + 1;
      }
      let y1 = x1 - k1;
      while (x1 < aLen && y1 < bLen && load<u8>(a + <usize>x1) == load<u8>(b + <usize>y1)) {
        x1++;
        y1++;
      }
      v1[k1Offset] = x1;
      if (x1 > aLen) {
        k1end += 2; // ran off the right
      } else if (y1 > bLen) {
        k1start += 2; // ran off the bottom
      } else if (front) {
        const k2Offset = vOffset + delta - k1;
        if (k2Offset >= 0 && k2Offset < vLength && v2[k2Offset] != -1) {
          const x2 = aLen - v2[k2Offset];
          if (x1 >= x2) {
            bisectSplit(a, aLen, b, bLen, x1, y1);
            return;
          }
        }
      }
    }

    // Reverse path.
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2Offset = vOffset + k2;
      let x2: i32;
      if (k2 == -d || (k2 != d && v2[k2Offset - 1] < v2[k2Offset + 1])) {
        x2 = v2[k2Offset + 1];
      } else {
        x2 = v2[k2Offset - 1] + 1;
      }
      let y2 = x2 - k2;
      while (
        x2 < aLen &&
        y2 < bLen &&
        load<u8>(a + <usize>(aLen - x2 - 1)) == load<u8>(b + <usize>(bLen - y2 - 1))
      ) {
        x2++;
        y2++;
      }
      v2[k2Offset] = x2;
      if (x2 > aLen) {
        k2end += 2;
      } else if (y2 > bLen) {
        k2start += 2;
      } else if (!front) {
        const k1Offset = vOffset + delta - k2;
        if (k1Offset >= 0 && k1Offset < vLength && v1[k1Offset] != -1) {
          const x1 = v1[k1Offset];
          const y1 = vOffset + x1 - k1Offset;
          const x2b = aLen - x2;
          if (x1 >= x2b) {
            bisectSplit(a, aLen, b, bLen, x1, y1);
            return;
          }
        }
      }
    }
  }

  // No middle snake (only reachable if the inputs share no bytes): full replace.
  emit(DELETE, 0, aLen);
  emit(INSERT, <i32>b, bLen);
}

function bisectSplit(a: usize, aLen: i32, b: usize, bLen: i32, x: i32, y: i32): void {
  diffMain(a, x, b, y);
  diffMain(a + <usize>x, aLen - x, b + <usize>y, bLen - y);
}

// ---------------------------------------------------------------------------
// LEB128 varints. Each op is a varint `(len << 2) | type`; INSERT is followed
// by `len` literal bytes.
// ---------------------------------------------------------------------------
function varintSize(v: u32): i32 {
  let n = 1;
  while (v >= 0x80) {
    v >>= 7;
    n++;
  }
  return n;
}

function writeVarint(ptr: usize, v: u32): usize {
  while (v >= 0x80) {
    store<u8>(ptr, <u8>((v & 0x7f) | 0x80));
    ptr++;
    v >>= 7;
  }
  store<u8>(ptr, <u8>v);
  return ptr + 1;
}

// Varint reader state, shared by apply's two passes (AS can't return tuples
// cheaply). `rOk` goes false on a truncated/overlong varint.
let rPtr: usize = 0;
let rOk: bool = true;

function readVarint(end: usize): u32 {
  let result: u32 = 0;
  let shift: u32 = 0;
  while (true) {
    if (rPtr >= end || shift > 28) {
      rOk = false;
      return 0;
    }
    const byte = load<u8>(rPtr);
    rPtr++;
    result |= (<u32>(byte & 0x7f)) << shift;
    if ((byte & 0x80) == 0) break;
    shift += 7;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Exports.
// ---------------------------------------------------------------------------
export function diffDelta(aPtr: usize, aLen: i32, bPtr: usize, bLen: i32): u64 {
  resetOps();
  diffMain(aPtr, aLen, bPtr, bLen);

  let size = 0;
  for (let i = 0, n = opType.length; i < n; i++) {
    const tag = ((<u32>opLen[i]) << 2) | <u32>opType[i];
    size += varintSize(tag);
    if (opType[i] == INSERT) size += opLen[i];
  }
  if (size == 0) {
    resetOps();
    // The `0` (empty-delta) result is reserved for empty OUTPUT: applyDelta reads
    // an empty delta as "produce nothing" and still requires the source to be
    // fully consumed, so it only round-trips when aLen == 0 too. Identical
    // *non-empty* inputs must NOT short-circuit to 0 — they fall through to the
    // compact EQUAL-only delta below (~1-5 bytes) so applyDelta can copy the
    // source back. (Callers skip identical content upstream; see createContentDelta.)
    return 0; // both inputs empty (or identical empty middle)
  }

  const out = heap.alloc(<usize>size);
  let o = out;
  for (let i = 0, n = opType.length; i < n; i++) {
    const tag = ((<u32>opLen[i]) << 2) | <u32>opType[i];
    o = writeVarint(o, tag);
    if (opType[i] == INSERT) {
      memory.copy(o, <usize>opOff[i], <usize>opLen[i]);
      o += <usize>opLen[i];
    }
  }
  resetOps();
  return pack(out, size);
}

export function applyDelta(aPtr: usize, aLen: i32, dPtr: usize, dLen: i32): u64 {
  const dEnd = dPtr + <usize>dLen;

  // Pass 1: validate and size the output.
  rPtr = dPtr;
  rOk = true;
  let outLen = 0;
  let srcCursor = 0;
  while (rPtr < dEnd) {
    const tag = readVarint(dEnd);
    if (!rOk) return ERR;
    const type = <i32>(tag & 3);
    const len = <i32>(tag >> 2);
    if (type == EQUAL) {
      if (srcCursor + len > aLen) return ERR;
      srcCursor += len;
      outLen += len;
    } else if (type == DELETE) {
      if (srcCursor + len > aLen) return ERR;
      srcCursor += len;
    } else {
      if (rPtr + <usize>len > dEnd) return ERR;
      rPtr += <usize>len;
      outLen += len;
    }
  }
  // A well-formed delta consumes exactly the whole source. This catches a
  // wrong-*length* base and structurally invalid deltas — but NOT a same-length
  // base whose bytes differ: EQUAL copies from the source cursor unconditionally,
  // so a same-length mismatch reconstructs silently-wrong output. Base-content
  // integrity is the caller's contract (see applyContentDelta), not checked here.
  if (srcCursor != aLen) return ERR;
  if (outLen == 0) return 0;

  const out = heap.alloc(<usize>outLen);

  // Pass 2: materialize.
  rPtr = dPtr;
  rOk = true;
  let o = out;
  srcCursor = 0;
  while (rPtr < dEnd) {
    const tag = readVarint(dEnd);
    if (!rOk) {
      heap.free(out);
      return ERR;
    }
    const type = <i32>(tag & 3);
    const len = <i32>(tag >> 2);
    if (type == EQUAL) {
      memory.copy(o, aPtr + <usize>srcCursor, <usize>len);
      o += <usize>len;
      srcCursor += len;
    } else if (type == DELETE) {
      srcCursor += len;
    } else {
      memory.copy(o, rPtr, <usize>len);
      rPtr += <usize>len;
      o += <usize>len;
    }
  }
  return pack(out, outLen);
}
