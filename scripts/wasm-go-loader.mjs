// Loader + ABI helpers for the Go (wasip1 reactor) codec module.
//
// The module is a WASI reactor: instantiate it with a WASI import object, call
// `wasi.initialize(instance)` to run Go's runtime init, then call the exported
// functions. All data crosses the boundary through linear memory:
//
//   const ptr = api.write(bytes);        // alloc + copy into wasm memory
//   const out = api.unpack(api.zstdCompress(ptr, bytes.length));
//   api.free(ptr);                       // release the input buffer
//
// `unpack` reads the (ptr<<32)|len result, copies it out, and frees it.
import { readFile } from "node:fs/promises";
import { WASI } from "node:wasi";

export async function loadGoCodec(wasmUrl) {
  const wasi = new WASI({ version: "preview1", args: [], env: {} });
  const bytes = await readFile(wasmUrl);
  const { instance } = await WebAssembly.instantiate(bytes, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  // Reactor modules expose `_initialize` rather than `_start`.
  wasi.initialize(instance);

  const e = instance.exports;
  // memory.buffer detaches whenever wasm grows it, so always re-view fresh.
  const u8 = () => new Uint8Array(e.memory.buffer);

  function write(input) {
    const ptr = e.alloc(input.length);
    u8().set(input, ptr);
    return ptr;
  }

  function unpack(packed) {
    const value = BigInt.asUintN(64, BigInt(packed));
    if (value === 0xffffffffffffffffn) throw new Error("Go codec call failed");
    const ptr = Number(value >> 32n);
    const len = Number(value & 0xffffffffn);
    if (ptr === 0) return new Uint8Array(0);
    const out = u8().slice(ptr, ptr + len);
    e.free(ptr);
    return out;
  }

  const free = (ptr) => e.free(ptr);

  return {
    instance,
    exports: e,
    write,
    unpack,
    free,
    // Convenience one-shots that manage the input pointer for you.
    zstdCompress(input) {
      const ptr = write(input);
      try {
        return unpack(e.zstdCompress(ptr, input.length));
      } finally {
        free(ptr);
      }
    },
    zstdDecompress(input) {
      const ptr = write(input);
      try {
        return unpack(e.zstdDecompress(ptr, input.length));
      } finally {
        free(ptr);
      }
    },
    diffDelta(a, b) {
      const aPtr = write(a);
      const bPtr = write(b);
      try {
        return unpack(e.diffDelta(aPtr, a.length, bPtr, b.length));
      } finally {
        free(aPtr);
        free(bPtr);
      }
    },
    applyDelta(a, delta) {
      const aPtr = write(a);
      const dPtr = write(delta);
      try {
        return unpack(e.applyDelta(aPtr, a.length, dPtr, delta.length));
      } finally {
        free(aPtr);
        free(dPtr);
      }
    },
  };
}
