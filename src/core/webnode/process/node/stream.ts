// The `stream` builtin: readable-stream@4.8.0 (Node's own stream code,
// extracted) with the gaps against Node 22 filled: the web stream adapters
// (stream/web_adapters.ts), `duplexPair`, `_isArrayBufferView`, and Uint8Array
// chunks turned into webnode's Buffer. The default export is the legacy
// `Stream` constructor carrying everything, exactly as `require("stream")`.
import Stream from "readable-stream/lib/stream.js";
import { Buffer } from "./buffer";
import { createDuplexPair } from "./stream/duplex_pair";
import type { StreamModule } from "./stream/types";
import { installWebAdapters } from "./stream/web_adapters";

import type * as types from "./stream/types";

export type {
  Chunk,
  DuplexOptions,
  FinishedOptions,
  PipelineStream,
  ReadableOptions,
  StreamCallback,
  StreamModule,
  TransformOptions,
  WritableMembers,
  WritableOptions,
} from "./stream/types";
/** A Stream instance. */
export type Stream = types.Stream;
/** A Readable instance. */
export type Readable = types.Readable;
/** A Writable instance. */
export type Writable = types.Writable;
/** A Duplex instance. */
export type Duplex = types.Duplex;
/** A Transform instance. */
export type Transform = types.Transform;
/** A PassThrough instance. */
export type PassThrough = types.Transform;

const stream = Stream as unknown as StreamModule;

installWebAdapters(stream);
// Node 22 raised the default byte high water mark from 16 KiB to 64 KiB.
stream.setDefaultHighWaterMark(false, 64 * 1024);

function define(name: string, value: unknown): void {
  Object.defineProperty(stream, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

define("duplexPair", createDuplexPair(stream.Duplex));
define("_isArrayBufferView", (value: unknown) => ArrayBuffer.isView(value));
define("_uint8ArrayToBuffer", (chunk: Uint8Array) =>
  Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
);

/** `stream.Readable`. */
export const Readable = stream.Readable;
/** `stream.Writable`. */
export const Writable = stream.Writable;
/** `stream.Duplex`. */
export const Duplex = stream.Duplex;
/** `stream.Transform`. */
export const Transform = stream.Transform;
/** `stream.PassThrough`. */
export const PassThrough = stream.PassThrough;
/** `stream.pipeline`. */
export const pipeline = stream.pipeline;
/** `stream.finished`. */
export const finished = stream.finished;
/** `stream.compose`. */
export const compose = stream.compose;
/** `stream.addAbortSignal`. */
export const addAbortSignal = stream.addAbortSignal;
/** `stream.destroy`. */
export const destroy = stream.destroy;
/** `stream.duplexPair`. */
export const duplexPair = stream.duplexPair;

export default stream;
