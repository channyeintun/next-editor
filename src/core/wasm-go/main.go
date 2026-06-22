//go:build wasip1

// Package main is a WASI "reactor" module (built with -buildmode=c-shared)
// that exposes two recording-codec primitives to the JS host:
//
//   - zstd compress/decompress (klauspost/compress) — a drop-in alternative to
//     the fflate DEFLATE used by the SCR3 segment codec.
//   - diff/patch (sergi/go-diff diff-match-patch) — a multi-region Myers delta,
//     a more general alternative to the prefix/suffix ContentDelta.
//
// ABI (all pointers/lengths are wasm32 offsets into the exported `memory`):
//
//	alloc(size u32)              -> ptr u32      // pinned host-writable buffer
//	free(ptr u32)                                // release a pinned buffer
//	zstdCompress(ptr,len u32)    -> packed u64   // (ptr<<32)|len of result
//	zstdDecompress(ptr,len u32)  -> packed u64
//	diffDelta(aPtr,aLen,bPtr,bLen u32) -> packed u64   // go-diff DiffToDelta(a->b)
//	applyDelta(aPtr,aLen,dPtr,dLen u32) -> packed u64  // reconstructs b from a+delta
//
// A packed result of 0 means empty (or, for decode/apply, an error). The host
// reads `len` bytes at `ptr`, then must call free(ptr).
package main

import (
	"unsafe"

	"github.com/klauspost/compress/zstd"
	"github.com/sergi/go-diff/diffmatchpatch"
)

// main is required for -buildmode=c-shared but never runs as a command; the
// host calls _initialize (WASI reactor) and then the exported functions.
func main() {}

// keep pins buffers handed across the host boundary so Go's GC won't reclaim
// them while JS still references them. Go's GC is non-moving, so the address
// returned to the host stays valid until free(ptr) deletes the entry.
var keep = make(map[uint32][]byte)

//go:wasmexport alloc
func alloc(size uint32) uint32 {
	if size == 0 {
		size = 1
	}
	buf := make([]byte, size)
	ptr := uint32(uintptr(unsafe.Pointer(&buf[0])))
	keep[ptr] = buf
	return ptr
}

//go:wasmexport free
func free(ptr uint32) {
	delete(keep, ptr)
}

// view aliases host-written linear memory without copying. Safe because the
// underlying array was alloc()'d above and is pinned in keep.
func view(ptr, length uint32) []byte {
	if length == 0 {
		return nil
	}
	return unsafe.Slice((*byte)(unsafe.Pointer(uintptr(ptr))), length)
}

// errResult is an out-of-band sentinel for failure, distinct from a packed
// (ptr=0,len=0) which is a *successful* empty result. A real pointer is never
// all-ones, so this can't collide with a valid result.
const errResult = ^uint64(0)

// pack copies out into a freshly pinned buffer and returns (ptr<<32)|len so the
// host can locate the result with a single i64 return value. An empty slice
// packs to 0 (a valid empty result), never the error sentinel.
func pack(out []byte) uint64 {
	if len(out) == 0 {
		return 0
	}
	buf := make([]byte, len(out))
	copy(buf, out)
	ptr := uint32(uintptr(unsafe.Pointer(&buf[0])))
	keep[ptr] = buf
	return (uint64(ptr) << 32) | uint64(uint32(len(buf)))
}

var (
	zEnc *zstd.Encoder
	zDec *zstd.Decoder
)

func init() {
	// Concurrency 1: wasm is single-threaded, and the default encoder spawns
	// worker goroutines we don't want under a cooperative wasm scheduler.
	zEnc, _ = zstd.NewWriter(nil,
		zstd.WithEncoderConcurrency(1),
		zstd.WithEncoderLevel(zstd.SpeedDefault),
	)
	zDec, _ = zstd.NewReader(nil, zstd.WithDecoderConcurrency(1))
}

//go:wasmexport zstdCompress
func zstdCompress(srcPtr, srcLen uint32) uint64 {
	return pack(zEnc.EncodeAll(view(srcPtr, srcLen), nil))
}

//go:wasmexport zstdDecompress
func zstdDecompress(srcPtr, srcLen uint32) uint64 {
	out, err := zDec.DecodeAll(view(srcPtr, srcLen), nil)
	if err != nil {
		return errResult
	}
	return pack(out)
}

var dmp = diffmatchpatch.New()

//go:wasmexport diffDelta
func diffDelta(aPtr, aLen, bPtr, bLen uint32) uint64 {
	a := string(view(aPtr, aLen))
	b := string(view(bPtr, bLen))
	diffs := dmp.DiffMain(a, b, true)
	diffs = dmp.DiffCleanupEfficiency(diffs)
	return pack([]byte(dmp.DiffToDelta(diffs)))
}

//go:wasmexport applyDelta
func applyDelta(aPtr, aLen, deltaPtr, deltaLen uint32) uint64 {
	a := string(view(aPtr, aLen))
	delta := string(view(deltaPtr, deltaLen))
	diffs, err := dmp.DiffFromDelta(a, delta)
	if err != nil {
		return errResult
	}
	return pack([]byte(dmp.DiffText2(diffs)))
}
