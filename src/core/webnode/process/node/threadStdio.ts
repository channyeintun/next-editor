// The standard streams a Worker keeps for itself (`stdin: true`,
// `stdout: true`, `stderr: true`). As in Node they travel as messages on the
// thread's port: what the thread writes to `process.stdout` arrives in the
// parent's `worker.stdout`, in order with everything else the thread posts
// and before its exit; what the parent writes to `worker.stdin` arrives in
// the thread's `process.stdin`. An output stream the Worker did not keep
// stays the process's own (the thread writes its file descriptor itself), so
// the parent's stream for it only ends when the thread exits. A stdin the
// Worker did not keep is at its end from the start, as in Node.
//
// A write is handed over as it is made, so none is lost however the thread
// ends. Its callback waits, as Node's does, for the parent's stream to ask
// for more: it comes with a message, not from `process.nextTick`, which a
// program's fake timers may have replaced. The writer is not held to its
// reader's pace: `write` does not return false past the reader's high water
// mark, as Node's does.
import { runtime } from "../runtime";
import { Buffer } from "./buffer";
import { addMacrotaskListener } from "./eventLoop";
import { Readable, Writable, type Chunk, type StreamCallback } from "./stream";

/** What a thread posts for a chunk written to a stream its Worker kept; a null chunk ends it. */
const THREAD_OUTPUT_MESSAGE = "__webnode_thread_output__";
/** What a thread posts first when its Worker kept a stream: the port the parent answers through. */
const THREAD_STDIO_PORT_MESSAGE = "__webnode_thread_stdio_port__";

// The platform's own, captured now: a program's test spy may replace them on
// the prototype, and a port's `close` here must not speak the close protocol
// program ports use (worker_threads.ts).
const PlatformMessageChannel = MessageChannel;
const nativePostMessage = MessagePort.prototype.postMessage as (
  this: MessagePort,
  message: unknown,
  transfer?: Transferable[],
) => void;
const nativeStart = MessagePort.prototype.start;
const nativeClose = MessagePort.prototype.close;

/** Which of a thread's standard streams its Worker keeps. */
export interface KeptStdio {
  stdin: boolean;
  stdout: boolean;
  stderr: boolean;
}

type OutputName = "stdout" | "stderr";

interface OutputMessage {
  type: typeof THREAD_OUTPUT_MESSAGE;
  stream: OutputName;
  chunk: Uint8Array | null;
}

interface PortMessage {
  type: typeof THREAD_STDIO_PORT_MESSAGE;
  port: MessagePort;
}

/**
 * What the parent sends the thread: a chunk for its stdin (null ends it), or
 * that the parent's stream wants more, having `received` so many chunks.
 */
type ParentMessage = { stdin: Uint8Array | null } | { wants: OutputName; received: number };

function hasType(value: unknown, type: string): boolean {
  return value !== null && typeof value === "object" && (value as { type?: unknown }).type === type;
}

function isOutputMessage(value: unknown): value is OutputMessage {
  return hasType(value, THREAD_OUTPUT_MESSAGE);
}

function isPortMessage(value: unknown): value is PortMessage {
  return hasType(value, THREAD_STDIO_PORT_MESSAGE);
}

/**
 * Posts `message(bytes)` on `port` for a copy of `chunk` in a buffer of its
 * own, which goes with the message: the writer keeps its buffer, and no more
 * than the chunk's bytes travel.
 */
function postChunk(
  port: MessagePort,
  chunk: Uint8Array,
  message: (bytes: Uint8Array) => unknown,
): void {
  const bytes = new Uint8Array(chunk);
  nativePostMessage.call(port, message(bytes), [bytes.buffer]);
}

// ---------------------------------------------------------------------------
// The parent's side
// ---------------------------------------------------------------------------

/** A Worker's `stdin`, `stdout` and `stderr`, and what feeds them. */
export interface WorkerStdio {
  /** A Writable when the Worker kept the thread's stdin; null otherwise, as in Node. */
  stdin: Writable | null;
  stdout: Readable;
  stderr: Readable;
  /** Takes `message` if the thread posted it for these streams. */
  receive(message: unknown): boolean;
  /** The thread is gone: its output streams end. */
  end(): void;
}

/** The streams of a Worker constructed with `kept`. */
export function createWorkerStdio(kept: KeptStdio): WorkerStdio {
  // The thread's end of the way back, once it has arrived, and what waits for it.
  let back: MessagePort | null = null;
  let waiting: ParentMessage[] | null = [];
  const send = (message: ParentMessage) => {
    if (back === null) {
      waiting?.push(message);
    } else if ("stdin" in message && message.stdin !== null) {
      postChunk(back, message.stdin, (bytes) => ({ stdin: bytes }));
    } else {
      nativePostMessage.call(back, message);
    }
  };

  const received: Record<OutputName, number> = { stdout: 0, stderr: 0 };
  const output = (name: OutputName): Readable => {
    if (kept[name]) {
      // Asking for more is what completes the thread's writes so far.
      return new Readable({ read: () => send({ wants: name, received: received[name] }) });
    }
    const stream = new Readable({ read() {} });
    // Flowing, as Node's is while it pipes the thread's output to the
    // process's own: its 'end' comes without anybody reading it.
    stream.resume();
    return stream;
  };
  const streams: Record<OutputName, Readable> = {
    stdout: output("stdout"),
    stderr: output("stderr"),
  };
  const ended: Record<OutputName, boolean> = { stdout: false, stderr: false };
  const endOutput = (name: OutputName) => {
    if (!ended[name]) {
      ended[name] = true;
      streams[name].push(null);
    }
  };

  const stdin = kept.stdin
    ? new Writable({
        decodeStrings: true,
        write(chunk: Uint8Array, _encoding: string, callback: StreamCallback) {
          send({ stdin: chunk });
          callback();
        },
        final(callback: StreamCallback) {
          send({ stdin: null });
          callback();
        },
      })
    : null;

  return {
    stdin,
    stdout: streams.stdout,
    stderr: streams.stderr,
    receive(message) {
      if (isOutputMessage(message)) {
        const { stream, chunk } = message;
        if (chunk === null) {
          endOutput(stream);
        } else {
          received[stream] += 1;
          if (!ended[stream]) {
            streams[stream].push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          }
        }
        return true;
      }
      if (isPortMessage(message)) {
        back = message.port;
        for (const held of waiting ?? []) {
          send(held);
        }
        waiting = null;
        return true;
      }
      return false;
    },
    end() {
      endOutput("stdout");
      endOutput("stderr");
      // Nothing reads what the parent sends any more.
      waiting = null;
      if (back !== null) {
        nativeClose.call(back);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The thread's side
// ---------------------------------------------------------------------------

/** `process.stdout` or `process.stderr` of a thread whose Worker kept that stream. */
class ThreadOutput extends Writable {
  readonly #port: MessagePort;
  readonly #name: OutputName;
  /** How many chunks were handed over. */
  #posted = 0;
  /** The callbacks of writes the parent's stream has not asked past yet, each with its chunk's number. */
  readonly #callbacks: { chunk: number; done: StreamCallback }[] = [];

  constructor(port: MessagePort, name: OutputName) {
    super({ decodeStrings: true });
    this.#port = port;
    this.#name = name;
  }

  #message(chunk: Uint8Array | null): OutputMessage {
    return { type: THREAD_OUTPUT_MESSAGE, stream: this.#name, chunk };
  }

  override _write(chunk: Uint8Array, _encoding: string, callback: StreamCallback): void {
    this.#posted += 1;
    postChunk(this.#port, chunk, (bytes) => this.#message(bytes));
    callback();
  }

  override _final(callback: StreamCallback): void {
    nativePostMessage.call(this.#port, this.#message(null));
    callback();
  }

  /**
   * Writes at once, and keeps the write's callback for the parent's stream to
   * ask for more, as Node's does. Until then the callback holds the thread.
   */
  override write(
    chunk: Chunk,
    encoding?: string | StreamCallback,
    callback?: StreamCallback,
  ): boolean {
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done !== "function" || this.writableEnded || this.destroyed) {
      // No callback to keep, or a write the stream refuses and answers itself.
      return typeof encoding === "function"
        ? super.write(chunk, encoding)
        : super.write(chunk, encoding, callback);
    }
    const more = typeof encoding === "function" ? super.write(chunk) : super.write(chunk, encoding);
    if (this.#callbacks.push({ chunk: this.#posted, done }) === 1) {
      runtime().ref();
    }
    return more;
  }

  /** The parent's stream asked for more after `received` chunks: the writes up to there are complete. */
  taken(received: number): void {
    const callbacks = this.#callbacks;
    let complete = 0;
    while (complete < callbacks.length && callbacks[complete].chunk <= received) {
      complete += 1;
    }
    if (complete === 0) {
      return;
    }
    const completed = callbacks.splice(0, complete);
    if (callbacks.length === 0) {
      runtime().unref();
    }
    for (const { done } of completed) {
      done(null);
    }
  }
}

/**
 * `process.stdin` of a thread whose Worker kept it. As in Node, reading it
 * holds the thread until the parent ends `worker.stdin`.
 */
class ThreadInput extends Readable {
  #holding = false;
  #ended = false;

  override _read(): void {
    if (!this.#holding && !this.#ended) {
      this.#holding = true;
      runtime().ref();
    }
  }

  /** What the parent wrote; null when it ended its stream. */
  receive(chunk: Uint8Array | null): void {
    if (chunk !== null) {
      this.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      return;
    }
    this.#ended = true;
    this.push(null);
    if (this.#holding) {
      this.#holding = false;
      runtime().unref();
    }
  }
}

/**
 * Makes the streams of `process` that this thread's Worker kept go through
 * `port`, the thread's end of its port, and the parent's answers come back
 * through a port of their own, which the thread hands over first.
 */
export function connectThreadStdio(process: object, kept: KeptStdio, port: MessagePort): void {
  const define = (name: string, stream: unknown) => {
    Object.defineProperty(process, name, {
      configurable: true,
      enumerable: true,
      get: () => stream,
    });
  };
  const stdout = kept.stdout ? new ThreadOutput(port, "stdout") : null;
  const stderr = kept.stderr ? new ThreadOutput(port, "stderr") : null;
  const stdin = new ThreadInput();
  if (stdout !== null) {
    define("stdout", stdout);
  }
  if (stderr !== null) {
    define("stderr", stderr);
  }
  define("stdin", stdin);
  if (!kept.stdin) {
    stdin.receive(null);
  }
  if (!kept.stdin && stdout === null && stderr === null) {
    return;
  }

  const channel = new PlatformMessageChannel();
  nativePostMessage.call(port, { type: THREAD_STDIO_PORT_MESSAGE, port: channel.port2 }, [
    channel.port2,
  ]);
  addMacrotaskListener(channel.port1, "message", (event) => {
    const message = (event as MessageEvent<ParentMessage>).data;
    if ("wants" in message) {
      (message.wants === "stdout" ? stdout : stderr)?.taken(message.received);
    } else if (kept.stdin) {
      stdin.receive(message.stdin);
      if (message.stdin === null && stdout === null && stderr === null) {
        nativeClose.call(channel.port1);
      }
    }
  });
  nativeStart.call(channel.port1);
}
