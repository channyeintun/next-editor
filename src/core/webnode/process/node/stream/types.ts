// The TypeScript shape of the `stream` builtin, written against Node 22's API.
// The engine has no @types/node (its only lib is DOM), so builtins that build
// on streams (zlib, net, http, fs, child_process) import these types.
/* eslint-disable typescript/no-explicit-any -- stream chunks are whatever the caller pushes */
import type { EventEmitter } from "../events";

/** A stream callback. */
export type StreamCallback = (error?: Error | null) => void;
/** Any chunk a stream carries. */
export type Chunk = any;

/** Options every stream takes. */
export interface StreamOptions<S> {
  emitClose?: boolean;
  highWaterMark?: number;
  objectMode?: boolean;
  signal?: AbortSignal;
  autoDestroy?: boolean;
  construct?(this: S, callback: StreamCallback): void;
  destroy?(this: S, error: Error | null, callback: StreamCallback): void;
}

/** `new Readable(options)`. */
export interface ReadableOptions<S = Readable> extends StreamOptions<S> {
  encoding?: string | null;
  read?(this: S, size: number): void;
}

/** `new Writable(options)`. */
export interface WritableOptions<S = Writable> extends StreamOptions<S> {
  decodeStrings?: boolean;
  defaultEncoding?: string;
  write?(this: S, chunk: Chunk, encoding: string, callback: StreamCallback): void;
  writev?(this: S, chunks: { chunk: Chunk; encoding: string }[], callback: StreamCallback): void;
  final?(this: S, callback: StreamCallback): void;
}

/** `new Duplex(options)`. */
export interface DuplexOptions<S = Duplex> extends ReadableOptions<S>, WritableOptions<S> {
  allowHalfOpen?: boolean;
  readableObjectMode?: boolean;
  writableObjectMode?: boolean;
  readableHighWaterMark?: number;
  writableHighWaterMark?: number;
}

/** `new Transform(options)`. */
export interface TransformOptions<S = Transform> extends DuplexOptions<S> {
  transform?(
    this: S,
    chunk: Chunk,
    encoding: string,
    callback: (error?: Error | null, data?: Chunk) => void,
  ): void;
  flush?(this: S, callback: (error?: Error | null, data?: Chunk) => void): void;
}

/** The legacy Stream: an EventEmitter with `pipe`. */
export interface Stream extends EventEmitter {
  pipe<T extends Writable>(destination: T, options?: { end?: boolean }): T;
}

/** A readable stream. */
export interface Readable extends Stream, AsyncIterable<Chunk> {
  readable: boolean;
  readonly readableAborted: boolean;
  readonly readableDidRead: boolean;
  readonly readableEncoding: string | null;
  readonly readableEnded: boolean;
  readonly readableFlowing: boolean | null;
  readonly readableHighWaterMark: number;
  readonly readableLength: number;
  readonly readableObjectMode: boolean;
  readonly closed: boolean;
  readonly errored: Error | null;
  destroyed: boolean;
  _readableState: any;
  _read(size: number): void;
  _destroy(error: Error | null, callback: StreamCallback): void;
  _construct?(callback: StreamCallback): void;
  read(size?: number): Chunk;
  push(chunk: Chunk, encoding?: string): boolean;
  unshift(chunk: Chunk, encoding?: string): void;
  setEncoding(encoding: string): this;
  pause(): this;
  resume(): this;
  isPaused(): boolean;
  unpipe(destination?: Writable): this;
  wrap(stream: Stream): this;
  destroy(error?: Error | null): this;
  iterator(options?: { destroyOnReturn?: boolean }): AsyncIterableIterator<Chunk>;
  map(fn: (data: Chunk, options?: { signal: AbortSignal }) => any, options?: object): Readable;
  filter(fn: (data: Chunk, options?: { signal: AbortSignal }) => any, options?: object): Readable;
  forEach(
    fn: (data: Chunk, options?: { signal: AbortSignal }) => any,
    options?: object,
  ): Promise<void>;
  toArray(options?: object): Promise<Chunk[]>;
  some(fn: (data: Chunk) => any, options?: object): Promise<boolean>;
  find(fn: (data: Chunk) => any, options?: object): Promise<Chunk>;
  every(fn: (data: Chunk) => any, options?: object): Promise<boolean>;
  flatMap(fn: (data: Chunk) => any, options?: object): Readable;
  drop(limit: number, options?: object): Readable;
  take(limit: number, options?: object): Readable;
  reduce(fn: (previous: any, data: Chunk) => any, initial?: any, options?: object): Promise<any>;
}

/** The writing half: what Writable and Duplex share. */
export interface WritableMembers {
  writable: boolean;
  readonly writableAborted: boolean;
  readonly writableEnded: boolean;
  readonly writableFinished: boolean;
  readonly writableHighWaterMark: number;
  readonly writableLength: number;
  readonly writableObjectMode: boolean;
  readonly writableCorked: number;
  readonly writableNeedDrain: boolean;
  _writableState: any;
  _write(chunk: Chunk, encoding: string, callback: StreamCallback): void;
  _writev?(chunks: { chunk: Chunk; encoding: string }[], callback: StreamCallback): void;
  _final(callback: StreamCallback): void;
  write(chunk: Chunk, callback?: StreamCallback): boolean;
  write(chunk: Chunk, encoding?: string, callback?: StreamCallback): boolean;
  end(callback?: () => void): this;
  end(chunk: Chunk, callback?: () => void): this;
  end(chunk: Chunk, encoding?: string, callback?: () => void): this;
  setDefaultEncoding(encoding: string): this;
  cork(): void;
  uncork(): void;
}

/** A writable stream. */
export interface Writable extends Stream, WritableMembers {
  readonly closed: boolean;
  readonly errored: Error | null;
  destroyed: boolean;
  _destroy(error: Error | null, callback: StreamCallback): void;
  _construct?(callback: StreamCallback): void;
  destroy(error?: Error | null): this;
}

/** A duplex stream: both readable and writable. */
export interface Duplex extends Readable, WritableMembers {
  allowHalfOpen: boolean;
}

/** A transform stream. */
export interface Transform extends Duplex {
  _transform(
    chunk: Chunk,
    encoding: string,
    callback: (error?: Error | null, data?: Chunk) => void,
  ): void;
  _flush(callback: (error?: Error | null, data?: Chunk) => void): void;
}

/** What `pipeline` and `compose` accept. */
export type PipelineStream =
  | Stream
  | AsyncIterable<Chunk>
  | Iterable<Chunk>
  | ReadableStream
  | WritableStream
  | ((source: any) => any);

/** `finished` options. */
export interface FinishedOptions {
  error?: boolean;
  readable?: boolean;
  writable?: boolean;
  signal?: AbortSignal;
  cleanup?: boolean;
}

/** `new Readable()` and its statics. */
export interface ReadableConstructor {
  new (options?: ReadableOptions): Readable;
  (this: unknown, options?: ReadableOptions): void;
  prototype: Readable;
  from(iterable: Iterable<Chunk> | AsyncIterable<Chunk>, options?: ReadableOptions): Readable;
  fromWeb(stream: ReadableStream, options?: ReadableOptions): Readable;
  toWeb(stream: Readable, options?: { strategy?: QueuingStrategy }): ReadableStream;
  isDisturbed(stream: unknown): boolean;
  wrap(stream: Stream, options?: ReadableOptions): Readable;
}

/** `new Writable()` and its statics. */
export interface WritableConstructor {
  new (options?: WritableOptions): Writable;
  (this: unknown, options?: WritableOptions): void;
  prototype: Writable;
  fromWeb(stream: WritableStream, options?: WritableOptions): Writable;
  toWeb(stream: Writable): WritableStream;
}

/** `new Duplex()` and its statics. */
export interface DuplexConstructor {
  new (options?: DuplexOptions): Duplex;
  (this: unknown, options?: DuplexOptions): void;
  prototype: Duplex;
  from(source: unknown): Duplex;
  fromWeb(
    pair: { readable: ReadableStream; writable: WritableStream },
    options?: DuplexOptions,
  ): Duplex;
  toWeb(stream: Duplex): { readable: ReadableStream; writable: WritableStream };
}

/** `new Transform()`. */
export interface TransformConstructor {
  new (options?: TransformOptions): Transform;
  (this: unknown, options?: TransformOptions): void;
  prototype: Transform;
}

/** `new PassThrough()`. */
export interface PassThroughConstructor {
  new (options?: TransformOptions): Transform;
  (this: unknown, options?: TransformOptions): void;
  prototype: Transform;
}

/** `stream.promises`. */
export interface StreamPromises {
  pipeline(...streams: any[]): Promise<any>;
  finished(stream: unknown, options?: FinishedOptions): Promise<void>;
}

/** What `require("stream")` returns: the legacy Stream constructor with Node 22's statics. */
export interface StreamModule {
  new (options?: object): Stream;
  (this: unknown, options?: object): void;
  prototype: Stream;
  Stream: StreamModule;
  Readable: ReadableConstructor;
  Writable: WritableConstructor;
  Duplex: DuplexConstructor;
  Transform: TransformConstructor;
  PassThrough: PassThroughConstructor;
  pipeline(...streams: any[]): any;
  finished(stream: unknown, callback: StreamCallback): () => void;
  finished(stream: unknown, options: FinishedOptions, callback: StreamCallback): () => void;
  compose(...streams: any[]): Duplex;
  addAbortSignal<T>(signal: AbortSignal, stream: T): T;
  destroy(stream: unknown, error?: Error | null): void;
  duplexPair(options?: DuplexOptions): [Duplex, Duplex];
  promises: StreamPromises;
  isReadable(stream: unknown): boolean | null;
  isWritable(stream: unknown): boolean | null;
  isErrored(stream: unknown): boolean;
  isDisturbed(stream: unknown): boolean;
  isDestroyed(stream: unknown): boolean;
  getDefaultHighWaterMark(objectMode: boolean): number;
  setDefaultHighWaterMark(objectMode: boolean, value: number): void;
  _isArrayBufferView(value: unknown): value is ArrayBufferView;
  _isUint8Array(value: unknown): value is Uint8Array;
  _uint8ArrayToBuffer(chunk: Uint8Array): Uint8Array;
}
