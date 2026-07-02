// next-editor-dmp — diff-match-patch (Myers) diff/patch in Rust (no_std).
//
// This is the recording codec's content-delta primitive: `diffDelta(a, b)`
// produces an opaque, compact delta that `applyDelta(a, delta)` turns back into
// `b`. The diff core is a faithful diff-match-patch port; the delta wire format
// extends the original op stream with a mandatory leading CHECK op (base hash),
// so every apply verifies it is running against the base it was diffed from.
// Pre-CHECK deltas are not accepted (no legacy decoding).
//
// It is intentionally a pure-compute module with **zero host imports** — the
// panic handler traps via the `unreachable` instruction instead of importing
// `env.abort`, the allocator works entirely in `memory.grow`-acquired pages, and
// `wasm32-unknown-unknown` links no WASI runtime. So `WebAssembly.Module.imports()`
// is `[]`, which is what lets the host load it with a bare `import("…wasm")` (no
// import object). A Go/TinyGo module can never do this — its runtime always
// imports `wasi_snapshot_preview1`/`gojs` glue. Rust on the `-unknown` target can.
//
// ABI: all data crosses through linear `memory`. The host writes inputs into
// buffers from `alloc`, calls a codec function, reads the packed `u64` result
// `(ptr << 32) | len`, then releases buffers with `freeBuf`. A result of `0`
// means empty; `ERR` (all ones) means a corrupt/truncated delta; `ERR_BASE`
// (all ones minus one) means the delta is well-formed but the base does not
// match its CHECK hash (a replay desync — the actionable error).
//
// SIZE BOUND: offsets and op lengths are u32 and the serialized op tag is
// `(len << 2) | type`, so each buffer and each single op must stay under ~2^30
// bytes. The varint reader matches this (it stops at `shift > 28`). Comfortable
// for editor-sized documents; callers must not feed it gigabyte inputs.

#![no_std]
#![allow(non_snake_case)] // diffDelta / applyDelta / freeBuf are the JS-facing ABI names.

extern crate alloc;

use alloc::vec;
use alloc::vec::Vec;
use core::alloc::{GlobalAlloc, Layout};
use core::cell::UnsafeCell;

// Trap instead of importing `env.abort` (mirrors AssemblyScript's `abort=`).
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// ---------------------------------------------------------------------------
// Allocator.
//
// A best-fit free-list allocator (no splitting, no coalescing) living entirely
// in pages acquired with `memory.grow` — above whatever the linker laid out for
// data + stack, so it never collides with them and needs no `__heap_base`. Each
// block is prefixed with an 8-byte header holding its payload capacity; freed
// blocks store the next-free pointer in their (now unused) payload. The
// allocation pattern here is a handful of short-lived buffers per call, all
// freed afterwards, so reuse is near-total and fragmentation is bounded by the
// working set rather than growing over a session. Best-fit (rather than first-
// fit) matters because the mix of small + large requests per call would
// otherwise let a small request claim a large freed block, forcing the next
// large request to grow memory every call. Backs both `#[global_allocator]` (for
// the diff's temporary `Vec`s) and the host-facing `alloc`/`freeBuf` ABI.
// ---------------------------------------------------------------------------
const PAGE: usize = 65536;
const ALIGN: usize = 8;
const HEADER: usize = 8; // keeps payloads 8-aligned; stores payload capacity.

#[inline]
fn align_up(n: usize, a: usize) -> usize {
    (n + a - 1) & !(a - 1)
}

struct HeapState {
    inited: bool,
    bump: usize,
    end: usize,
    free_head: usize, // header address of the first free block, or 0.
}

struct Heap {
    state: UnsafeCell<HeapState>,
}

// Sound because wasm here is single-threaded (no atomics / no shared memory).
unsafe impl Sync for Heap {}

#[global_allocator]
static HEAP: Heap = Heap {
    state: UnsafeCell::new(HeapState {
        inited: false,
        bump: 0,
        end: 0,
        free_head: 0,
    }),
};

impl Heap {
    unsafe fn raw_alloc(&self, size: usize) -> usize {
        let s = &mut *self.state.get();
        if !s.inited {
            // Start the heap at the current end of linear memory; everything
            // below (data + stack) is owned by the linker.
            let bytes = core::arch::wasm32::memory_size(0) * PAGE;
            s.bump = bytes;
            s.end = bytes;
            s.inited = true;
        }
        let need = align_up(if size < ALIGN { ALIGN } else { size }, ALIGN);

        // Best fit over the free list (capacity kept as-is; no splitting): pick
        // the smallest block that fits, so a small request doesn't consume a
        // large freed block. Exact fit short-circuits the scan.
        let mut best: usize = 0;
        let mut best_prev: usize = 0;
        let mut best_cap: usize = usize::MAX;
        let mut prev: usize = 0;
        let mut cur = s.free_head;
        while cur != 0 {
            let cap = *(cur as *const usize);
            if cap >= need && cap < best_cap {
                best = cur;
                best_prev = prev;
                best_cap = cap;
                if cap == need {
                    break;
                }
            }
            prev = cur;
            cur = *((cur + HEADER) as *const usize);
        }
        if best != 0 {
            let next = *((best + HEADER) as *const usize);
            if best_prev == 0 {
                s.free_head = next;
            } else {
                *((best_prev + HEADER) as *mut usize) = next;
            }
            return best + HEADER;
        }

        // Bump, growing linear memory if the block won't fit.
        let h = s.bump;
        let total = HEADER + need;
        if h + total > s.end {
            let extra = align_up(h + total - s.end, PAGE);
            let pages = extra / PAGE;
            if core::arch::wasm32::memory_grow(0, pages) == usize::MAX {
                core::arch::wasm32::unreachable();
            }
            s.end += pages * PAGE;
        }
        *(h as *mut usize) = need;
        s.bump = h + total;
        h + HEADER
    }

    unsafe fn raw_free(&self, ptr: usize) {
        if ptr == 0 {
            return;
        }
        let s = &mut *self.state.get();
        let h = ptr - HEADER;
        *((h + HEADER) as *mut usize) = s.free_head; // payload now holds next-free.
        s.free_head = h;
    }
}

unsafe impl GlobalAlloc for Heap {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // Blocks are 8-aligned; every type used here (u8/i32/usize) needs <= 8.
        // Guard the assumption so an align-16+ type added later fails loudly in
        // debug rather than handing back an under-aligned block (compiled out of
        // the release wasm).
        debug_assert!(layout.align() <= ALIGN);
        self.raw_alloc(layout.size()) as *mut u8
    }
    unsafe fn dealloc(&self, ptr: *mut u8, _layout: Layout) {
        self.raw_free(ptr as usize)
    }
}

// ---------------------------------------------------------------------------
// Constants and result packing.
// ---------------------------------------------------------------------------
// Two distinct failure sentinels so the host can attribute the error:
//   ERR      — structurally corrupt/truncated delta, or oversized input.
//   ERR_BASE — the delta is well-formed but was applied to the wrong base
//              (missing/failed CHECK op, or source-length mismatch).
// Both are impossible ptr/len packs: a real pack's ptr is a heap address well
// below 2^32 - 1.
const ERR: u64 = 0xffff_ffff_ffff_ffff;
const ERR_BASE: u64 = 0xffff_ffff_ffff_fffe;

// Buffers must stay under this so `(len << 2) | type` fits a u32 without silently
// truncating (see SIZE BOUND). An op's length never exceeds its buffer's, so
// bounding the buffers bounds every tag.
const MAX_BUF: usize = 1 << 30;

// Op tags (also the low 2 bits of each serialized op):
//   EQUAL  — copy `len` bytes from the source at the apply cursor
//   DELETE — skip `len` bytes of source
//   INSERT — copy `len` literal bytes that follow in the delta
//   CHECK  — `len` hash bytes follow (always 4: FNV-1a of the whole base).
//            Mandatory first op of every delta; applyDelta refuses a delta
//            whose base hash does not match (ERR_BASE), so applying against
//            the wrong base fails loudly instead of silently corrupting.
const EQUAL: u8 = 0;
const DELETE: u8 = 1;
const INSERT: u8 = 2;
const CHECK: u8 = 3;
const CHECK_HASH_LEN: usize = 4;

// FNV-1a (32-bit) over the base bytes — tiny, allocation-free, and plenty to
// catch a desynced replay base (this is integrity checking, not cryptography).
fn fnv1a32(bytes: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for &byte in bytes {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

#[inline]
fn pack(ptr: usize, len: usize) -> u64 {
    ((ptr as u64) << 32) | (len as u32 as u64)
}

// ---------------------------------------------------------------------------
// Op accumulator — diffs are streamed here in document order as parallel
// triples (kind, off, len). For INSERT, `off` is the absolute linear-memory
// address of the literal bytes (in the `b` buffer, which stays live for the
// whole diff). Adjacent same-kind ops are coalesced on push.
// ---------------------------------------------------------------------------
struct Ops {
    kind: Vec<u8>,
    off: Vec<usize>,
    len: Vec<usize>,
}

impl Ops {
    fn new() -> Ops {
        Ops {
            kind: Vec::new(),
            off: Vec::new(),
            len: Vec::new(),
        }
    }

    fn emit(&mut self, kind: u8, off: usize, len: usize) {
        if len == 0 {
            return;
        }
        let n = self.kind.len();
        if n > 0 {
            let last = n - 1;
            if self.kind[last] == kind {
                if kind != INSERT {
                    self.len[last] += len;
                    return;
                }
                // INSERT only merges when its source bytes are contiguous.
                if self.off[last] + self.len[last] == off {
                    self.len[last] += len;
                    return;
                }
            }
        }
        self.kind.push(kind);
        self.off.push(off);
        self.len.push(len);
    }
}

// ---------------------------------------------------------------------------
// Common affix lengths over raw byte ranges.
//
// For this codec's workload — content-deltas between consecutive editor states,
// usually a single edit inside an otherwise unchanged document — these affix
// scans, not the bisect, dominate: their cost is linear in document size while
// the changed middle handed to diff_bisect is tiny. So they compare 8 bytes at a
// time (wasm permits unaligned i64 loads) and fall back to a byte loop only for
// the final partial word and to pinpoint the mismatch. Equality is the only test,
// so the computed length is identical to a byte-by-byte scan and the emitted
// delta stays byte-for-byte unchanged.
// ---------------------------------------------------------------------------
const WORD: usize = 8;

fn common_prefix(a: &[u8], b: &[u8]) -> usize {
    let n = a.len().min(b.len());
    let mut i = 0;
    while i + WORD <= n {
        let x = unsafe { (a.as_ptr().add(i) as *const u64).read_unaligned() };
        let y = unsafe { (b.as_ptr().add(i) as *const u64).read_unaligned() };
        if x != y {
            break;
        }
        i += WORD;
    }
    while i < n && a[i] == b[i] {
        i += 1;
    }
    i
}

fn common_suffix(a: &[u8], b: &[u8]) -> usize {
    let (alen, blen) = (a.len(), b.len());
    let n = alen.min(blen);
    let mut i = 0;
    while i + WORD <= n {
        // The word ending `i` bytes from the end of each slice.
        let x = unsafe { (a.as_ptr().add(alen - i - WORD) as *const u64).read_unaligned() };
        let y = unsafe { (b.as_ptr().add(blen - i - WORD) as *const u64).read_unaligned() };
        if x != y {
            break;
        }
        i += WORD;
    }
    while i < n && a[alen - 1 - i] == b[blen - 1 - i] {
        i += 1;
    }
    i
}

// ---------------------------------------------------------------------------
// diff-match-patch core (faithful port of diff_main / diff_compute /
// diff_bisect / diff_bisectSplit, operating on bytes instead of UTF-16 units).
// ---------------------------------------------------------------------------
fn diff_main(ops: &mut Ops, a: &[u8], b: &[u8]) {
    if a.is_empty() && b.is_empty() {
        return;
    }

    let p = common_prefix(a, b);
    if p > 0 {
        ops.emit(EQUAL, 0, p);
    }
    let a0 = &a[p..];
    let b0 = &b[p..];

    let s = common_suffix(a0, b0);
    let a_mid = &a0[..a0.len() - s];
    let b_mid = &b0[..b0.len() - s];

    diff_compute(ops, a_mid, b_mid);

    if s > 0 {
        ops.emit(EQUAL, 0, s);
    }
}

fn diff_compute(ops: &mut Ops, a: &[u8], b: &[u8]) {
    if a.is_empty() {
        if !b.is_empty() {
            ops.emit(INSERT, b.as_ptr() as usize, b.len());
        }
        return;
    }
    if b.is_empty() {
        ops.emit(DELETE, 0, a.len());
        return;
    }
    diff_bisect(ops, a, b);
}

fn diff_bisect(ops: &mut Ops, a: &[u8], b: &[u8]) {
    let a_len = a.len() as i32;
    let b_len = b.len() as i32;
    let max_d = (a_len + b_len + 1) / 2; // ceil((a_len + b_len) / 2)
    let v_offset = max_d;
    let v_length = 2 * max_d; // logical diagonal span used by the overlap guards
    // The reference diff_bisect relies on sparse arrays auto-growing past
    // v_length for the `v_offset ± 1` accesses (notably when max_d == 1). Fixed
    // buffers don't grow, so pad by 2 to keep every `± 1` index in bounds.
    let cap = (v_length + 2) as usize;
    let mut v1 = vec![-1i32; cap];
    let mut v2 = vec![-1i32; cap];
    v1[(v_offset + 1) as usize] = 0;
    v2[(v_offset + 1) as usize] = 0;
    let delta = a_len - b_len;
    // Whether the total difference is odd: only then can a forward and reverse
    // path overlap on the forward pass.
    let front = (delta & 1) != 0;
    let mut k1start = 0;
    let mut k1end = 0;
    let mut k2start = 0;
    let mut k2end = 0;

    let mut d = 0;
    while d < max_d {
        // Forward path.
        let mut k1 = -d + k1start;
        while k1 <= d - k1end {
            let k1_offset = v_offset + k1;
            let mut x1: i32;
            if k1 == -d
                || (k1 != d && v1[(k1_offset - 1) as usize] < v1[(k1_offset + 1) as usize])
            {
                x1 = v1[(k1_offset + 1) as usize];
            } else {
                x1 = v1[(k1_offset - 1) as usize] + 1;
            }
            let mut y1 = x1 - k1;
            while x1 < a_len && y1 < b_len && a[x1 as usize] == b[y1 as usize] {
                x1 += 1;
                y1 += 1;
            }
            v1[k1_offset as usize] = x1;
            if x1 > a_len {
                k1end += 2; // ran off the right
            } else if y1 > b_len {
                k1start += 2; // ran off the bottom
            } else if front {
                let k2_offset = v_offset + delta - k1;
                if k2_offset >= 0 && k2_offset < v_length && v2[k2_offset as usize] != -1 {
                    let x2 = a_len - v2[k2_offset as usize];
                    if x1 >= x2 {
                        bisect_split(ops, a, b, x1, y1);
                        return;
                    }
                }
            }
            k1 += 2;
        }

        // Reverse path.
        let mut k2 = -d + k2start;
        while k2 <= d - k2end {
            let k2_offset = v_offset + k2;
            let mut x2: i32;
            if k2 == -d
                || (k2 != d && v2[(k2_offset - 1) as usize] < v2[(k2_offset + 1) as usize])
            {
                x2 = v2[(k2_offset + 1) as usize];
            } else {
                x2 = v2[(k2_offset - 1) as usize] + 1;
            }
            let mut y2 = x2 - k2;
            while x2 < a_len
                && y2 < b_len
                && a[(a_len - x2 - 1) as usize] == b[(b_len - y2 - 1) as usize]
            {
                x2 += 1;
                y2 += 1;
            }
            v2[k2_offset as usize] = x2;
            if x2 > a_len {
                k2end += 2;
            } else if y2 > b_len {
                k2start += 2;
            } else if !front {
                let k1_offset = v_offset + delta - k2;
                if k1_offset >= 0 && k1_offset < v_length && v1[k1_offset as usize] != -1 {
                    let x1 = v1[k1_offset as usize];
                    let y1 = v_offset + x1 - k1_offset;
                    let x2b = a_len - x2;
                    if x1 >= x2b {
                        bisect_split(ops, a, b, x1, y1);
                        return;
                    }
                }
            }
            k2 += 2;
        }
        d += 1;
    }

    // Fallthrough: emit a full replace (a correct, if suboptimal, diff). In the
    // reference this is the deadline branch; with no deadline here the middle
    // snake is always found within max_d, so this is effectively unreachable.
    ops.emit(DELETE, 0, a.len());
    ops.emit(INSERT, b.as_ptr() as usize, b.len());
}

fn bisect_split(ops: &mut Ops, a: &[u8], b: &[u8], x: i32, y: i32) {
    let x = x as usize;
    let y = y as usize;
    diff_main(ops, &a[..x], &b[..y]);
    diff_main(ops, &a[x..], &b[y..]);
}

// ---------------------------------------------------------------------------
// LEB128 varints. Each op is a varint `(len << 2) | type`; INSERT is followed
// by `len` literal bytes.
// ---------------------------------------------------------------------------
fn varint_size(mut v: u32) -> usize {
    let mut n = 1;
    while v >= 0x80 {
        v >>= 7;
        n += 1;
    }
    n
}

unsafe fn write_varint(mut ptr: usize, mut v: u32) -> usize {
    while v >= 0x80 {
        *(ptr as *mut u8) = ((v & 0x7f) | 0x80) as u8;
        ptr += 1;
        v >>= 7;
    }
    *(ptr as *mut u8) = v as u8;
    ptr + 1
}

// Returns (value, ok, next_ptr). `ok` is false on a truncated/overlong varint.
unsafe fn read_varint(mut ptr: usize, end: usize) -> (u32, bool, usize) {
    let mut result: u32 = 0;
    let mut shift: u32 = 0;
    loop {
        if ptr >= end || shift > 28 {
            return (0, false, ptr);
        }
        let byte = *(ptr as *const u8);
        ptr += 1;
        result |= ((byte & 0x7f) as u32) << shift;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
    }
    (result, true, ptr)
}

// ---------------------------------------------------------------------------
// Host I/O buffers (unmanaged: the host owns their lifetime via alloc/freeBuf).
// ---------------------------------------------------------------------------
#[no_mangle]
pub extern "C" fn alloc(size: u32) -> u32 {
    unsafe { HEAP.raw_alloc(if size == 0 { 1 } else { size as usize }) as u32 }
}

#[no_mangle]
pub extern "C" fn freeBuf(ptr: u32) {
    unsafe { HEAP.raw_free(ptr as usize) }
}

// ---------------------------------------------------------------------------
// Exports.
// ---------------------------------------------------------------------------
#[no_mangle]
pub extern "C" fn diffDelta(a_ptr: u32, a_len: u32, b_ptr: u32, b_len: u32) -> u64 {
    if a_len as usize >= MAX_BUF || b_len as usize >= MAX_BUF {
        return ERR;
    }
    let a = unsafe { core::slice::from_raw_parts(a_ptr as *const u8, a_len as usize) };
    let b = unsafe { core::slice::from_raw_parts(b_ptr as *const u8, b_len as usize) };

    let mut ops = Ops::new();
    diff_main(&mut ops, a, b);

    // Every delta starts with a mandatory CHECK op carrying the base hash, so a
    // delta is never empty — even for identical or empty inputs.
    let check_tag = ((CHECK_HASH_LEN as u32) << 2) | CHECK as u32;
    let mut size = varint_size(check_tag) + CHECK_HASH_LEN;
    for i in 0..ops.kind.len() {
        let tag = ((ops.len[i] as u32) << 2) | ops.kind[i] as u32;
        size += varint_size(tag);
        if ops.kind[i] == INSERT {
            size += ops.len[i];
        }
    }

    let out = unsafe { HEAP.raw_alloc(size) };
    let mut o = unsafe { write_varint(out, check_tag) };
    let base_hash = fnv1a32(a);
    unsafe {
        core::ptr::copy_nonoverlapping(base_hash.to_le_bytes().as_ptr(), o as *mut u8, CHECK_HASH_LEN);
    }
    o += CHECK_HASH_LEN;
    for i in 0..ops.kind.len() {
        let tag = ((ops.len[i] as u32) << 2) | ops.kind[i] as u32;
        o = unsafe { write_varint(o, tag) };
        if ops.kind[i] == INSERT {
            unsafe {
                core::ptr::copy_nonoverlapping(ops.off[i] as *const u8, o as *mut u8, ops.len[i]);
            }
            o += ops.len[i];
        }
    }
    pack(out, size)
}

#[no_mangle]
pub extern "C" fn applyDelta(a_ptr: u32, a_len: u32, d_ptr: u32, d_len: u32) -> u64 {
    let a_len = a_len as usize;
    let a_base = a_ptr as usize;
    let d_ptr = d_ptr as usize;
    let d_end = d_ptr + d_len as usize;

    // Pass 1: validate and size the output. The first op MUST be the CHECK op —
    // verify the base hash before trusting any EQUAL copy out of the source.
    let mut r = d_ptr;
    let mut out_len = 0usize;
    let mut src = 0usize;
    {
        let (tag, ok, next) = unsafe { read_varint(r, d_end) };
        if !ok {
            return ERR;
        }
        let kind = (tag & 3) as u8;
        let len = (tag >> 2) as usize;
        if kind != CHECK || len != CHECK_HASH_LEN || next + CHECK_HASH_LEN > d_end {
            return ERR_BASE; // pre-check-op (legacy) or garbled delta head
        }
        let a = unsafe { core::slice::from_raw_parts(a_base as *const u8, a_len) };
        let mut stored = [0u8; CHECK_HASH_LEN];
        unsafe {
            core::ptr::copy_nonoverlapping(next as *const u8, stored.as_mut_ptr(), CHECK_HASH_LEN);
        }
        if u32::from_le_bytes(stored) != fnv1a32(a) {
            return ERR_BASE;
        }
        r = next + CHECK_HASH_LEN;
    }
    while r < d_end {
        let (tag, ok, next) = unsafe { read_varint(r, d_end) };
        if !ok {
            return ERR;
        }
        r = next;
        let kind = (tag & 3) as u8;
        let len = (tag >> 2) as usize;
        if kind == EQUAL {
            if src + len > a_len {
                return ERR;
            }
            src += len;
            out_len += len;
        } else if kind == DELETE {
            if src + len > a_len {
                return ERR;
            }
            src += len;
        } else if kind == INSERT {
            if r + len > d_end {
                return ERR;
            }
            r += len;
            out_len += len;
        } else {
            // A CHECK op is only valid as the delta's first op.
            return ERR;
        }
    }
    // A well-formed delta consumes exactly the whole source. Combined with the
    // hash check above, a wrong base of any length now fails loudly.
    if src != a_len {
        return ERR_BASE;
    }
    if out_len == 0 {
        return 0;
    }

    let out = unsafe { HEAP.raw_alloc(out_len) };

    // Pass 2: materialize (skipping the already-verified CHECK head).
    let mut r = d_ptr;
    {
        let (_tag, _ok, next) = unsafe { read_varint(r, d_end) };
        r = next + CHECK_HASH_LEN;
    }
    let mut o = out;
    let mut src = 0usize;
    while r < d_end {
        // Pass 1 already validated structure, so reads here cannot fail.
        let (tag, _ok, next) = unsafe { read_varint(r, d_end) };
        r = next;
        let kind = (tag & 3) as u8;
        let len = (tag >> 2) as usize;
        if kind == EQUAL {
            unsafe {
                core::ptr::copy_nonoverlapping((a_base + src) as *const u8, o as *mut u8, len);
            }
            o += len;
            src += len;
        } else if kind == DELETE {
            src += len;
        } else {
            unsafe {
                core::ptr::copy_nonoverlapping(r as *const u8, o as *mut u8, len);
            }
            r += len;
            o += len;
        }
    }
    pack(out, out_len)
}
