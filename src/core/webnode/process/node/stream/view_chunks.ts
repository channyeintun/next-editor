// Byte chunks of any TypedArray or DataView, as Node's streams take them.
// readable-stream takes a string, a Buffer or a Uint8Array and refuses every
// other view (ERR_INVALID_ARG_TYPE); Node turns any ArrayBufferView into a
// Buffer over the same memory. The library's byte `write`, `end`, `push` and
// `unshift` ask `Stream._isUint8Array` about a chunk that is neither a string
// nor its Buffer, and make it a Buffer with `Stream._uint8ArrayToBuffer`;
// those two take every view here. The methods stay the library's own, and a
// string or a Buffer chunk never reaches them. An object-mode stream never
// asks, so it keeps the view as it is, as Node's does.
import { Buffer } from "../buffer";
import type { StreamModule } from "./types";

/** Whether a byte stream takes `value` as a chunk of bytes. */
function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value);
}

/** `chunk` as webnode's Buffer over the same memory. */
function _uint8ArrayToBuffer(chunk: ArrayBufferView): Uint8Array {
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

/** Lets every byte stream take any view as a chunk. */
export function installViewChunks(stream: StreamModule): void {
  for (const [name, value] of [
    ["_isUint8Array", isUint8Array],
    ["_uint8ArrayToBuffer", _uint8ArrayToBuffer],
  ] as const) {
    Object.defineProperty(stream, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
}
