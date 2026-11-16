// The `stream/web` builtin: the platform's WHATWG stream classes. Each member
// is read from `globalThis` when it is accessed, so whatever the worker's
// global scope holds (or a later polyfill installs) is what code gets.

const NAMES = [
  "ReadableStream",
  "ReadableStreamDefaultReader",
  "ReadableStreamBYOBReader",
  "ReadableStreamBYOBRequest",
  "ReadableByteStreamController",
  "ReadableStreamDefaultController",
  "TransformStream",
  "TransformStreamDefaultController",
  "WritableStream",
  "WritableStreamDefaultWriter",
  "WritableStreamDefaultController",
  "ByteLengthQueuingStrategy",
  "CountQueuingStrategy",
  "TextEncoderStream",
  "TextDecoderStream",
  "CompressionStream",
  "DecompressionStream",
] as const;

/** What `require("stream/web")` returns. */
export interface StreamWebModule {
  ReadableStream: typeof ReadableStream;
  ReadableStreamDefaultReader: typeof ReadableStreamDefaultReader;
  ReadableStreamBYOBReader: typeof ReadableStreamBYOBReader;
  ReadableStreamBYOBRequest: typeof ReadableStreamBYOBRequest;
  ReadableByteStreamController: typeof ReadableByteStreamController;
  ReadableStreamDefaultController: typeof ReadableStreamDefaultController;
  TransformStream: typeof TransformStream;
  TransformStreamDefaultController: typeof TransformStreamDefaultController;
  WritableStream: typeof WritableStream;
  WritableStreamDefaultWriter: typeof WritableStreamDefaultWriter;
  WritableStreamDefaultController: typeof WritableStreamDefaultController;
  ByteLengthQueuingStrategy: typeof ByteLengthQueuingStrategy;
  CountQueuingStrategy: typeof CountQueuingStrategy;
  TextEncoderStream: typeof TextEncoderStream;
  TextDecoderStream: typeof TextDecoderStream;
  CompressionStream: typeof CompressionStream;
  DecompressionStream: typeof DecompressionStream;
}

const streamWeb = {} as StreamWebModule;
for (const name of NAMES) {
  Object.defineProperty(streamWeb, name, {
    configurable: true,
    enumerable: true,
    get: () => (globalThis as unknown as Record<string, unknown>)[name],
  });
}

export default streamWeb;
