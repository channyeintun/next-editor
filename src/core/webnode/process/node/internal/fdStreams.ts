// Node streams over a file descriptor that is a pipe or a terminal: what
// `process.stdin/stdout/stderr` and child-process stdio are built from (the
// lead wires them; `tty` extends them). Reading goes through
// `runtime().fdStream.readStart/readStop`, writing through `fdStream.write`.
// A reading `FdReadable` keeps the process alive (one `runtime().ref()`) until
// it ends, pauses, is destroyed or is `unref()`'d; an `FdWritable` never does.
import type { ReadableOptions, WritableOptions } from "../stream";
import { Buffer } from "../buffer";
import { Readable, Writable } from "../stream";
import { runtime } from "../../runtime";

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

/** A `Readable` fed by `fdStream.readStart(fd)`; `null` from the kernel ends it. */
export class FdReadable extends Readable {
  /** The file descriptor this stream reads. */
  readonly fd: number;
  #reading = false;
  #refed = true;
  #holdingRef = false;
  #autoClose: boolean;
  #closed = false;

  constructor(fd: number, options: ReadableOptions & FdStreamOptions = {}) {
    const { autoClose, ...readable } = options;
    super(readable as ReadableOptions);
    this.fd = fd;
    this.#autoClose = (autoClose ?? true) && fd > 2;
    // As Node does for stdin: a paused, non-flowing stream stops reading so it
    // no longer keeps the process alive; `_read` restarts it on resume.
    this.on("pause", () => {
      queueMicrotask(() => {
        if (this.#reading && !this.readableFlowing) {
          this.#stopReading();
          (this as unknown as { _readableState: { reading: boolean } })._readableState.reading =
            false;
        }
      });
    });
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
    if (!this.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
      this.#stopReading();
    }
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
    runtime().fdStream.write(this.fd, bytes, (error) => callback(error));
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
