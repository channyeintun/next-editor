// Byte chunks of any TypedArray or DataView, as Node's streams take them.
// readable-stream takes a Buffer or a Uint8Array and refuses every other view
// (ERR_INVALID_ARG_TYPE); Node turns any ArrayBufferView into a Buffer over
// the same memory. A byte stream's `write`, `end`, `push` and `unshift` do
// that here before the library sees the chunk; an object-mode stream keeps the
// view as it is, as Node's does.
import { Buffer } from "../buffer";
import type { StreamModule } from "./types";

type Method = (this: unknown, chunk?: unknown, ...rest: unknown[]) => unknown;
type State = { objectMode: boolean } | undefined;

/** `chunk` as the Buffer over its memory when it is a view other than a Uint8Array. */
function asBuffer(chunk: unknown): unknown {
  return ArrayBuffer.isView(chunk) && !(chunk instanceof Uint8Array)
    ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    : chunk;
}

/**
 * `method` with a view chunk made a Buffer, unless the side `state` reads is
 * in object mode. It keeps the method's arity, as Node's methods have it.
 */
function takingViews(method: Method, state: (stream: unknown) => State): Method {
  const wrapped = function (this: unknown, chunk?: unknown, ...rest: unknown[]) {
    return method.call(this, state(this)?.objectMode ? chunk : asBuffer(chunk), ...rest);
  };
  Object.defineProperty(wrapped, "length", { value: method.length });
  return wrapped;
}

const writable = (stream: unknown) => (stream as { _writableState: State })._writableState;
const readable = (stream: unknown) => (stream as { _readableState: State })._readableState;

/**
 * Lets every byte stream take any view as a chunk. A Duplex has its own
 * copies of the Writable methods, which Transform and PassThrough inherit;
 * `push` and `unshift` are the Readable's, which a Duplex inherits.
 */
export function installViewChunks(stream: StreamModule): void {
  for (const prototype of [stream.Writable.prototype, stream.Duplex.prototype]) {
    const methods = prototype as unknown as { write: Method; end: Method };
    methods.write = takingViews(methods.write, writable);
    methods.end = takingViews(methods.end, writable);
  }
  const methods = stream.Readable.prototype as unknown as { push: Method; unshift: Method };
  methods.push = takingViews(methods.push, readable);
  methods.unshift = takingViews(methods.unshift, readable);
}
