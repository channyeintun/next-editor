// Node streams over a file descriptor that is a pipe or a terminal: what
// `process.stdin/stdout/stderr` and child-process stdio are built from (the
// lead wires them; `tty` extends them). Reading goes through
// `runtime().fdStream.readStart/readStop`, writing through `fdStream.write`.
// A reading `FdReadable` keeps the process alive (one `runtime().ref()`) until
// it ends, pauses, is destroyed or is `unref()`'d; an `FdWritable` never does.
import type { ReadableOptions, WritableOptions } from "../stream";
import { toSystemErrorRecord } from "../../../errors";
import { Buffer } from "../buffer";
import { nextTick } from "../eventLoop";
import { errnoException } from "../net/errors";
import { Readable, Writable } from "../stream";
import { runtime } from "../../runtime";

const NOTHING = new Uint8Array(0);

/** Options for `FdReadable` / `FdWritable`. */
export interface FdStreamOptions {
  /** Closes the fd when the stream ends or is destroyed. Default: true, except fds 0-2 are never closed. */
  autoClose?: boolean;
}

function closeQuietly(fd: number): void {
  try {
    runtime().fdStream.close(fd);
  } catch {
    // Already closed, or no runtime: nothing to release.
  }
}

/**
 * The error of a failed write to a pipe or terminal as a Node stream reports
 * it (Node's ErrnoException): `write EPIPE`, with the system call's errno and
 * code, where the kernel words it as an fs call's (`EPIPE: broken pipe,
 * write`).
 */
export function streamWriteError(error: Error): Error {
  const record = toSystemErrorRecord(error);
  if (record === null) {
    return error;
  }
  return errnoException(record.code, "write");
}

/** A `Readable` fed by `fdStream.readStart(fd)`; `null` from the kernel ends it. */
export class FdReadable extends Readable {
  /** The file descriptor this stream reads. */
  readonly fd: number;
  #reading = false;
  #refed = true;
  #holdingRef = false;
  #autoClose: boolean;
  #closed = false;
  /** Whether `fd` is a pipe, asked of the kernel the first time a chunk overflows. */
  #pipe: boolean | null = null;

  constructor(fd: number, options: ReadableOptions & FdStreamOptions = {}) {
    const { autoClose, ...readable } = options;
    super(readable as ReadableOptions);
    this.fd = fd;
    this.#autoClose = (autoClose ?? true) && fd > 2;
    // As Node does for stdin: a paused, non-flowing stream stops reading so it
    // no longer keeps the process alive; `_read` restarts it on resume.
    this.on("pause", () => {
      nextTick(() => {
        if (this.#reading && !this.readableFlowing) {
          this.#stopReading();
          this.#forgetRead();
        }
      });
    });
  }

  /** Lets the next `read()` or `resume()` call `_read` again, to restart the reading it stopped. */
  #forgetRead(): void {
    (this as unknown as { _readableState: { reading: boolean } })._readableState.reading = false;
  }

  /**
   * Stops this stream reading a pipe whose fd is being given to a child as
   * its stdio, as Node stops a socket it hands to a child (`readStop` on the
   * handle, then `pause`): the child reads the pipe from here on. What the
   * stream already holds stays its own. What the kernel had sent for it and
   * it was not handed goes back to the pipe, in order with the spawn that
   * follows, so the child finds it there.
   */
  handOver(): void {
    this.#stopReading();
    runtime().fdStream.unread(this.fd, NOTHING);
    this.pause();
    this.#forgetRead();
  }

  override _read(): void {
    if (this.#reading || this.destroyed) {
      return;
    }
    this.#reading = true;
    this.#updateRef();
    runtime().fdStream.readStart(this.fd, (chunk) => this.#onChunk(chunk));
  }

  #onChunk(chunk: Uint8Array | null): void {
    if (!this.#reading) {
      return;
    }
    if (chunk === null) {
      this.#stopReading();
      this.push(null);
      return;
    }
    const room = this.readableHighWaterMark - this.readableLength;
    if (chunk.byteLength > room && !this.readableObjectMode && this.#isPipe()) {
      // As a socket reading a pipe in Node takes no more than its high water
      // mark: what fits is kept, the rest goes back to the pipe, where it
      // counts against what the pipe holds, for the next read.
      this.#reading = false;
      this.#updateRef();
      if (room > 0) {
        this.push(Buffer.from(chunk.buffer, chunk.byteOffset, room));
      }
      runtime().fdStream.unread(this.fd, chunk.subarray(Math.max(room, 0)));
      // Nothing pushed when the stream was full already (an unshift() while
      // it read): the next read() still starts reading again.
      this.#forgetRead();
      return;
    }
    if (!this.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
      this.#stopReading();
    }
  }

  #isPipe(): boolean {
    if (this.#pipe === null) {
      this.#pipe = runtime().fdStream.kind(this.fd) === "pipe";
    }
    return this.#pipe;
  }

  #stopReading(): void {
    if (!this.#reading) {
      return;
    }
    this.#reading = false;
    try {
      runtime().fdStream.readStop(this.fd);
    } catch {
      // The fd may already be gone (end of stream on a closed pipe).
    }
    this.#updateRef();
  }

  #updateRef(): void {
    const want = this.#reading && this.#refed;
    if (want === this.#holdingRef) {
      return;
    }
    this.#holdingRef = want;
    if (want) {
      runtime().ref();
    } else {
      runtime().unref();
    }
  }

  /** Lets this stream keep the process alive while it reads (the default). */
  ref(): this {
    this.#refed = true;
    this.#updateRef();
    return this;
  }

  /** Stops this stream from keeping the process alive. */
  unref(): this {
    this.#refed = false;
    this.#updateRef();
    return this;
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#stopReading();
    if (this.#autoClose && !this.#closed) {
      this.#closed = true;
      closeQuietly(this.fd);
    }
    callback(error);
  }
}

/** A `Writable` whose writes go to `fdStream.write(fd)`, in order. */
export class FdWritable extends Writable {
  /** The file descriptor this stream writes. */
  readonly fd: number;
  #autoClose: boolean;
  #closed = false;

  constructor(fd: number, options: WritableOptions & FdStreamOptions = {}) {
    const { autoClose, ...writable } = options;
    super(writable as WritableOptions);
    this.fd = fd;
    this.#autoClose = (autoClose ?? true) && fd > 2;
  }

  override _write(
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk, encoding)
        : chunk instanceof Uint8Array
          ? chunk
          : Buffer.from(chunk as ArrayLike<number>);
    runtime().fdStream.write(this.fd, bytes, (error) =>
      callback(error === null ? null : streamWriteError(error)),
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#close();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#close();
    callback(error);
  }

  #close(): void {
    if (this.#autoClose && !this.#closed) {
      this.#closed = true;
      closeQuietly(this.fd);
    }
  }
}
