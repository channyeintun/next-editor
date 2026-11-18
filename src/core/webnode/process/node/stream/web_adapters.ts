// The bridges between Node streams and WHATWG streams that readable-stream
// leaves unimplemented: `Readable.fromWeb/toWeb`, `Writable.fromWeb/toWeb`,
// `Duplex.fromWeb/toWeb`. Ported from Node 22's lib/internal/webstreams/adapters.js.
import { Buffer } from "../buffer";
import { normalizeEncoding } from "../buffer/encodings";
import { nextTick } from "../eventLoop";
import {
  AbortError,
  invalidArgType,
  invalidArgValue,
  makeNodeError,
  validateBoolean,
  validateObject,
} from "../internalErrors";
import type * as NodeStream from "./types";

type StreamModule = NodeStream.StreamModule;
type ErrorCallback = (error?: Error | null) => void;

interface AdapterOptions {
  highWaterMark?: number;
  encoding?: string;
  objectMode?: boolean;
  decodeStrings?: boolean;
  allowHalfOpen?: boolean;
  signal?: AbortSignal;
  strategy?: QueuingStrategy;
}

function isReadableStream(value: unknown): value is ReadableStream {
  return typeof ReadableStream !== "undefined" && value instanceof ReadableStream;
}

function isWritableStream(value: unknown): value is WritableStream {
  return typeof WritableStream !== "undefined" && value instanceof WritableStream;
}

function prematureClose(): Error {
  return makeNodeError("ERR_STREAM_PREMATURE_CLOSE", "Premature close", Error);
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Throws `error` from a tick, as Node does for what a stream callback threw
 * inside a promise reaction: there it would only reject that promise.
 */
function rethrowLater(error: unknown): void {
  nextTick(() => {
    throw error;
  });
}

function encodeChunk(chunk: unknown, encoding: string): unknown {
  if (normalizeEncoding(encoding) === "utf8") {
    return new TextEncoder().encode(chunk as string);
  }
  const buffer = Buffer.from(chunk as string, encoding);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function validateEncoding(encoding: unknown): void {
  if (encoding !== undefined && !Buffer.isEncoding(encoding as string)) {
    throw invalidArgValue("options.encoding", encoding);
  }
}

/** Installs the adapters as statics of `stream`'s classes. */
export function installWebAdapters(stream: StreamModule): void {
  const { Readable, Writable, Duplex, finished, destroy } = stream;
  const isDestroyed = (s: unknown) => stream.isDestroyed(s);
  const isReadable = (s: unknown) => stream.isReadable(s) === true;
  const isWritable = (s: unknown) => stream.isWritable(s) === true;

  function readableFromWeb(
    readableStream: unknown,
    options: AdapterOptions = {},
  ): NodeStream.Readable {
    if (!isReadableStream(readableStream)) {
      throw invalidArgType("readableStream", "ReadableStream", readableStream);
    }
    validateObject(options, "options");
    const { highWaterMark, encoding, objectMode = false, signal } = options;
    validateEncoding(encoding);
    validateBoolean(objectMode, "options.objectMode");
    const reader = readableStream.getReader();
    let closed = false;
    const readable: NodeStream.Readable = new Readable({
      objectMode,
      highWaterMark,
      encoding,
      signal,
      read() {
        reader.read().then(
          (chunk) => {
            if (chunk.done) {
              readable.push(null);
            } else {
              readable.push(chunk.value);
            }
          },
          (error: Error) => destroy(readable, error),
        );
      },
      destroy(error: Error | null, callback: ErrorCallback) {
        const done = () => {
          try {
            callback(error);
          } catch (thrown) {
            rethrowLater(thrown);
          }
        };
        if (!closed) {
          reader.cancel(error).then(done, done);
          return;
        }
        done();
      },
    });
    reader.closed.then(
      () => {
        closed = true;
      },
      (error: Error) => {
        closed = true;
        destroy(readable, error);
      },
    );
    return readable;
  }

  function readableToWeb(
    streamReadable: NodeStream.Readable,
    options: AdapterOptions = {},
  ): ReadableStream {
    if (
      typeof (streamReadable as { _readableState?: unknown } | null)?._readableState !== "object"
    ) {
      throw invalidArgType("streamReadable", "stream.Readable", streamReadable);
    }
    if (isDestroyed(streamReadable) || !isReadable(streamReadable)) {
      const readable = new ReadableStream();
      void readable.cancel();
      return readable;
    }
    const objectMode = streamReadable.readableObjectMode;
    const highWaterMark = streamReadable.readableHighWaterMark;
    const strategy: QueuingStrategy =
      options?.strategy ??
      (objectMode
        ? new CountQueuingStrategy({ highWaterMark })
        : new ByteLengthQueuingStrategy({ highWaterMark }));
    let controller: ReadableStreamDefaultController;
    const onData = (chunk: unknown) => {
      // Copy a Buffer so the web stream owns its bytes.
      if (chunk instanceof Uint8Array && !objectMode) {
        chunk = new Uint8Array(chunk);
      }
      controller.enqueue(chunk);
      if ((controller.desiredSize ?? 0) <= 0) {
        streamReadable.pause();
      }
    };
    const onFinished = (error?: Error | null) => {
      streamReadable.removeListener("data", onData);
      if ((error as { code?: string } | null | undefined)?.code === "ERR_STREAM_PREMATURE_CLOSE") {
        error = new AbortError(undefined, { cause: error });
      }
      if (error) {
        controller.error(error);
        return;
      }
      controller.close();
    };
    streamReadable.on("data", onData);
    finished(streamReadable, onFinished);
    return new ReadableStream(
      {
        start(c) {
          controller = c;
        },
        pull() {
          streamReadable.resume();
        },
        cancel(reason) {
          destroy(streamReadable, reason);
        },
      },
      strategy,
    );
  }

  /** The `write`/`final` halves shared by `Writable.fromWeb` and `Duplex.fromWeb`. */
  function webWriterMethods(
    writer: WritableStreamDefaultWriter,
    getStream: () => NodeStream.Writable,
    decodeStrings: boolean,
    objectMode: boolean,
    isClosed: () => boolean,
  ) {
    return {
      write(chunk: unknown, encoding: string, callback: ErrorCallback) {
        if (typeof chunk === "string" && decodeStrings && !objectMode) {
          chunk = encodeChunk(chunk, encoding);
        }
        const done = (error?: Error | null) => {
          try {
            callback(error);
          } catch (thrown) {
            destroy(getStream(), thrown as Error);
          }
        };
        writer.ready.then(() => writer.write(chunk).then(() => done(), done), done);
      },
      final(callback: ErrorCallback) {
        const done = (error?: Error | null) => {
          try {
            callback(error);
          } catch (thrown) {
            nextTick(() => destroy(getStream(), thrown as Error));
          }
        };
        if (!isClosed()) {
          writer.close().then(() => done(), done);
        }
      },
    };
  }

  function writableFromWeb(
    writableStream: unknown,
    options: AdapterOptions = {},
  ): NodeStream.Writable {
    if (!isWritableStream(writableStream)) {
      throw invalidArgType("writableStream", "WritableStream", writableStream);
    }
    validateObject(options, "options");
    const { highWaterMark, decodeStrings = true, objectMode = false, signal } = options;
    validateBoolean(objectMode, "options.objectMode");
    validateBoolean(decodeStrings, "options.decodeStrings");
    const writer = writableStream.getWriter();
    let closed = false;
    const methods = webWriterMethods(
      writer,
      () => writable,
      decodeStrings,
      objectMode,
      () => closed,
    );
    const writable: NodeStream.Writable = new Writable({
      highWaterMark,
      objectMode,
      decodeStrings,
      signal,
      write: methods.write,
      final: methods.final,
      destroy(error: Error | null, callback: ErrorCallback) {
        const done = () => {
          try {
            callback(error);
          } catch (thrown) {
            rethrowLater(thrown);
          }
        };
        if (!closed) {
          if (error != null) {
            writer.abort(error).then(done, done);
          } else {
            writer.close().then(done, done);
          }
          return;
        }
        done();
      },
    });
    writer.closed.then(
      () => {
        closed = true;
        if (!writable.writableEnded) {
          destroy(writable, prematureClose());
        }
      },
      (error: Error) => {
        closed = true;
        destroy(writable, error);
      },
    );
    return writable;
  }

  function writableToWeb(streamWritable: NodeStream.Writable): WritableStream {
    if (
      typeof (streamWritable as { _writableState?: unknown } | null)?._writableState !== "object"
    ) {
      throw invalidArgType("streamWritable", "stream.Writable", streamWritable);
    }
    if (isDestroyed(streamWritable) || !isWritable(streamWritable)) {
      const writable = new WritableStream();
      void writable.close();
      return writable;
    }
    const highWaterMark = streamWritable.writableHighWaterMark;
    const strategy: QueuingStrategy = streamWritable.writableObjectMode
      ? new CountQueuingStrategy({ highWaterMark })
      : { highWaterMark };
    let controller: WritableStreamDefaultController | undefined;
    let backpressure: ReturnType<typeof deferred<void>> | undefined;
    let closed: ReturnType<typeof deferred<void>> | undefined;
    const onDrain = () => backpressure?.resolve();
    const cleanup = finished(streamWritable, (error?: Error | null) => {
      if ((error as { code?: string } | null | undefined)?.code === "ERR_STREAM_PREMATURE_CLOSE") {
        error = new AbortError(undefined, { cause: error });
      }
      cleanup();
      // Legacy streams may emit 'error' again after finishing.
      streamWritable.on("error", () => {});
      if (error != null) {
        backpressure?.reject(error);
        if (closed !== undefined) {
          closed.reject(error);
          closed = undefined;
        }
        controller?.error(error);
        controller = undefined;
        return;
      }
      if (closed !== undefined) {
        closed.resolve();
        closed = undefined;
        return;
      }
      controller?.error(new AbortError());
      controller = undefined;
    });
    streamWritable.on("drain", onDrain);
    return new WritableStream(
      {
        start(c) {
          controller = c;
        },
        write(chunk) {
          if (streamWritable.writableNeedDrain || !streamWritable.write(chunk)) {
            backpressure = deferred();
            return backpressure.promise.finally(() => {
              backpressure = undefined;
            });
          }
          return undefined;
        },
        abort(reason) {
          destroy(streamWritable, reason);
        },
        close() {
          if (closed === undefined && !streamWritable.writableEnded) {
            closed = deferred();
            streamWritable.end();
            return closed.promise;
          }
          controller = undefined;
          return Promise.resolve();
        },
      },
      strategy,
    );
  }

  function duplexFromWeb(pair: unknown, options: AdapterOptions = {}): NodeStream.Duplex {
    validateObject(pair, "pair");
    const { readable: readableStream, writable: writableStream } = pair as {
      readable?: unknown;
      writable?: unknown;
    };
    if (!isReadableStream(readableStream)) {
      throw invalidArgType("pair.readable", "ReadableStream", readableStream);
    }
    if (!isWritableStream(writableStream)) {
      throw invalidArgType("pair.writable", "WritableStream", writableStream);
    }
    validateObject(options, "options");
    const {
      allowHalfOpen = false,
      objectMode = false,
      encoding,
      decodeStrings = true,
      highWaterMark,
      signal,
    } = options;
    validateBoolean(objectMode, "options.objectMode");
    validateEncoding(encoding);
    const writer = writableStream.getWriter();
    const reader = readableStream.getReader();
    let writableClosed = false;
    let readableClosed = false;
    const methods = webWriterMethods(
      writer,
      () => duplex,
      decodeStrings,
      objectMode,
      () => writableClosed,
    );
    const duplex: NodeStream.Duplex = new Duplex({
      allowHalfOpen,
      highWaterMark,
      objectMode,
      encoding,
      decodeStrings,
      signal,
      write: methods.write,
      final: methods.final,
      read() {
        reader.read().then(
          (chunk) => {
            if (chunk.done) {
              duplex.push(null);
            } else {
              duplex.push(chunk.value);
            }
          },
          (error: Error) => destroy(duplex, error),
        );
      },
      destroy(error: Error | null, callback: ErrorCallback) {
        const done = () => {
          try {
            callback(error);
          } catch (thrown) {
            rethrowLater(thrown);
          }
        };
        const closeWriter = async () => {
          if (!writableClosed) {
            await writer.abort(error);
          }
        };
        const closeReader = async () => {
          if (!readableClosed) {
            await reader.cancel(error);
          }
        };
        if (!writableClosed || !readableClosed) {
          Promise.all([closeWriter(), closeReader()]).then(done, done);
          return;
        }
        done();
      },
    });
    writer.closed.then(
      () => {
        writableClosed = true;
        if (!duplex.writableEnded) {
          destroy(duplex, prematureClose());
        }
      },
      (error: Error) => {
        writableClosed = true;
        readableClosed = true;
        destroy(duplex, error);
      },
    );
    reader.closed.then(
      () => {
        readableClosed = true;
      },
      (error: Error) => {
        writableClosed = true;
        readableClosed = true;
        destroy(duplex, error);
      },
    );
    return duplex;
  }

  function duplexToWeb(duplex: NodeStream.Duplex): {
    readable: ReadableStream;
    writable: WritableStream;
  } {
    const candidate = duplex as { _readableState?: unknown; _writableState?: unknown } | null;
    if (
      typeof candidate?._writableState !== "object" ||
      typeof candidate?._readableState !== "object"
    ) {
      throw invalidArgType("duplex", "stream.Duplex", duplex);
    }
    if (isDestroyed(duplex)) {
      const writable = new WritableStream();
      const readable = new ReadableStream();
      void writable.close();
      void readable.cancel();
      return { readable, writable };
    }
    let writable: WritableStream;
    if (isWritable(duplex)) {
      writable = writableToWeb(duplex);
    } else {
      writable = new WritableStream();
      void writable.close();
    }
    let readable: ReadableStream;
    if (isReadable(duplex)) {
      readable = readableToWeb(duplex);
    } else {
      readable = new ReadableStream();
      void readable.cancel();
    }
    return { writable, readable };
  }

  const statics = (target: object, values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(target, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
  };
  statics(Readable, { fromWeb: readableFromWeb, toWeb: readableToWeb });
  statics(Writable, { fromWeb: writableFromWeb, toWeb: writableToWeb });
  statics(Duplex, { fromWeb: duplexFromWeb, toWeb: duplexToWeb });
}
