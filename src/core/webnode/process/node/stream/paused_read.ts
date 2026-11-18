// How a paused Readable is read, as Node 26 reads it. readable-stream 4.8 is
// Node 18's stream code, and Node has since changed two things a program sees:
//
//  - `read()` with no size, on a byte stream without an encoding, returns the
//    first buffered chunk. readable-stream does that only while the stream
//    flows; a paused one gets every buffered chunk joined. `readFirstChunk`
//    is the library's `read` for that one case, with the amount chosen as
//    Node 26 chooses it. Every other read is the library's.
//  - A stream that ends while nobody observes it (not flowing, no read
//    waiting, no 'readable' listener) queues no 'readable' event for the end.
//    A 'readable' listener added later is told then, if nothing is buffered;
//    with data buffered its own event is the only one. readable-stream always
//    queues the event, so a listener added right after the end gets two.
import destroyImpl from "readable-stream/lib/internal/streams/destroy.js";
import processShim from "../internal/processShim";
import type { Chunk, Readable, StreamModule } from "./types";

/** readable-stream's BufferList: the chunks a Readable holds. */
interface BufferList {
  /** How many chunks. */
  length: number;
  first(): { length: number };
  join(separator: string): string;
  concat(bytes: number): Chunk;
  consume(amount: number, hasStrings: boolean): Chunk;
  clear(): void;
}

/** The parts of readable-stream's ReadableState this module reads and writes. */
interface ReadableState {
  objectMode: boolean;
  decoder: unknown;
  flowing: boolean | null;
  /** Buffered bytes (characters with an encoding, objects in object mode). */
  length: number;
  highWaterMark: number;
  buffer: BufferList;
  ended: boolean;
  endEmitted: boolean;
  reading: boolean;
  sync: boolean;
  needReadable: boolean;
  emittedReadable: boolean;
  readableListening: boolean;
  destroyed: boolean;
  errored: unknown;
  constructed: boolean;
  errorEmitted: boolean;
  closeEmitted: boolean;
  dataEmitted: boolean;
  multiAwaitDrain: boolean;
  awaitDrainWriters: { clear(): void } | null;
}

type Read = (this: Readable, size?: number) => Chunk;
type Push = (this: Readable, chunk: Chunk, encoding?: string) => boolean;
type Unshift = (this: Readable, chunk: Chunk, encoding?: string) => void;
type On = (
  this: Readable,
  event: string | symbol,
  listener: (...args: never[]) => unknown,
) => Readable;

function stateOf(stream: Readable): ReadableState {
  return stream._readableState as ReadableState;
}

/** `read`'s argument as Node reads it: no size is NaN, and so is one that parses as no integer. */
function requestedSize(size: unknown): number {
  if (size === undefined) {
    return NaN;
  }
  return Number.isInteger(size) ? (size as number) : Number.parseInt(size as string, 10);
}

/** Node 26's `howMuchToRead` for a read with no size. */
function howMuchToRead(state: ReadableState): number {
  if (state.length === 0) {
    return 0;
  }
  if (!state.decoder || state.flowing) {
    return state.buffer.first().length;
  }
  return state.length;
}

/** The first `amount` bytes (or characters) of the buffer: readable-stream's `fromList`. */
function fromList(amount: number, state: ReadableState): Chunk {
  if (amount < state.length) {
    return state.buffer.consume(amount, Boolean(state.decoder));
  }
  const all = state.decoder
    ? state.buffer.join("")
    : state.buffer.length === 1
      ? state.buffer.first()
      : state.buffer.concat(state.length);
  state.buffer.clear();
  return all;
}

/** Streams whose end queued no 'readable' event because nobody observed them. */
const endedUnobserved = new WeakSet<Readable>();

/** The `process.nextTick` readable-stream defers with, so a tick queued here keeps its place among the library's. */
const nextTick = processShim.nextTick as (
  callback: (readable: Readable) => void,
  readable: Readable,
) => void;

/** Installs Node 26's paused-mode reading on `stream.Readable`. */
export function installPausedRead(stream: StreamModule): void {
  const prototype = stream.Readable.prototype as Readable & {
    push: Push;
    unshift: Unshift;
    on: On;
    addListener: On;
  };
  const nativeRead: Read = prototype.read;
  const nativePush: Push = prototype.push;
  const nativeUnshift: Unshift = prototype.unshift;
  const nativeOn: On = prototype.on;

  /**
   * A read with no size of a paused byte stream that has no encoding and has
   * not ended empty: `Readable.prototype.read` with the amount from
   * `howMuchToRead` above and Node's `nOrig` of NaN, so the high water mark is
   * never raised and a stream this read empties after its end ends.
   */
  function readFirstChunk(readable: Readable, state: ReadableState): Chunk {
    state.emittedReadable = false;
    let amount = howMuchToRead(state);

    let doRead = state.needReadable;
    if (state.length === 0 || state.length - amount < state.highWaterMark) {
      doRead = true;
    }
    if (state.ended || state.reading || state.destroyed || state.errored || !state.constructed) {
      doRead = false;
    } else if (doRead) {
      state.reading = true;
      state.sync = true;
      if (state.length === 0) {
        state.needReadable = true;
      }
      try {
        readable._read(state.highWaterMark);
      } catch (error) {
        destroyImpl.errorOrDestroy(readable, error);
      }
      state.sync = false;
      // _read pushed at once: what the buffer starts with may have changed.
      if (!state.reading) {
        amount = howMuchToRead(state);
      }
    }

    let chunk: Chunk = null;
    if (amount > 0) {
      chunk = fromList(amount, state);
      state.length -= amount;
      if (state.multiAwaitDrain) {
        state.awaitDrainWriters?.clear();
      } else {
        state.awaitDrainWriters = null;
      }
    }

    if (state.length === 0) {
      if (!state.ended) {
        state.needReadable = true;
      } else {
        // Emptied after its end: read(0) of such a stream only ends it.
        nativeRead.call(readable, 0);
      }
    }

    if (chunk !== null && !state.errorEmitted && !state.closeEmitted) {
      state.dataEmitted = true;
      readable.emit("data", chunk);
    }
    return chunk;
  }

  prototype.read = function read(this: Readable, size?: number): Chunk {
    const state = stateOf(this);
    const requested = requestedSize(size);
    if (requested !== 0 && state.ended) {
      endedUnobserved.delete(this);
    }
    if (
      !Number.isNaN(requested) ||
      state.objectMode ||
      state.decoder ||
      state.flowing ||
      (state.length === 0 && state.ended)
    ) {
      return nativeRead.call(this, size);
    }
    return readFirstChunk(this, state);
  };

  /**
   * The end of the stream (`push(null)`). When nobody observes the stream the
   * library's end must not queue its 'readable' event: it queues none while
   * one counts as emitted.
   */
  function pushEnd<R>(
    readable: Readable,
    native: (this: Readable, chunk: Chunk, encoding?: string) => R,
    encoding: string | undefined,
  ): R {
    const state = stateOf(readable);
    const unobserved =
      !state.ended &&
      state.sync &&
      state.flowing !== true &&
      !state.needReadable &&
      readable.listenerCount("readable") === 0;
    if (!unobserved) {
      return native.call(readable, null, encoding);
    }
    const emitted = state.emittedReadable;
    state.emittedReadable = true;
    try {
      return native.call(readable, null, encoding);
    } finally {
      state.emittedReadable = emitted;
      endedUnobserved.add(readable);
    }
  }

  prototype.push = function push(this: Readable, chunk: Chunk, encoding?: string): boolean {
    return chunk === null
      ? pushEnd(this, nativePush, encoding)
      : nativePush.call(this, chunk, encoding);
  };

  prototype.unshift = function unshift(this: Readable, chunk: Chunk, encoding?: string): void {
    if (chunk === null) {
      pushEnd(this, nativeUnshift, encoding);
    } else {
      nativeUnshift.call(this, chunk, encoding);
    }
  };

  /** The 'readable' event an unobserved end did not queue: the library's `emitReadable_`. */
  function emitReadableForEnd(readable: Readable): void {
    const state = stateOf(readable);
    if (!state.destroyed && !state.errored && (state.length > 0 || state.ended)) {
      readable.emit("readable");
      state.emittedReadable = false;
    }
    state.needReadable = !state.flowing && !state.ended && state.length <= state.highWaterMark;
    while (state.flowing && readable.read() !== null);
  }

  const on: On = function on(this: Readable, event, listener) {
    const state = stateOf(this);
    // The first 'readable' listener of a stream that ended unobserved with
    // nothing buffered: it is told of the end, before the library's own
    // read(0), which it queues as the listener is added.
    const tellOfEnd =
      event === "readable" &&
      typeof listener === "function" &&
      state.length === 0 &&
      !state.endEmitted &&
      !state.readableListening &&
      endedUnobserved.delete(this);
    if (tellOfEnd) {
      nextTick(emitReadableForEnd, this);
    }
    const result = nativeOn.call(this, event, listener);
    if (tellOfEnd) {
      state.needReadable = false;
      state.emittedReadable = true;
    }
    return result;
  };
  prototype.on = on;
  prototype.addListener = on;
}
