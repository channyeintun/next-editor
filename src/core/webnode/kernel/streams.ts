// The byte streams behind file descriptors that are not files: pipes and
// terminals. A reader either takes what is buffered or leaves a callback that
// runs when bytes (or the end) arrive, which is how a blocked `read` and a
// streaming `readStart` both work. A pipe holds 64 KiB, counting what it sent
// a streaming reader until the reader says it arrived (`Delivery`).

/** A source of bytes a file descriptor can read from. */
export interface ByteSource {
  /**
   * Takes up to `maxLength` buffered bytes. Null is the end of the stream;
   * undefined means nothing is buffered yet.
   */
  take(maxLength: number, reader: number): Uint8Array | null | undefined;
  /** Runs `callback` once, when `take` may have something for `reader`. */
  whenReadable(reader: number, callback: () => void): () => void;
}

/** What a pipe holds before a writer waits, as on Linux. */
export const PIPE_CAPACITY = 65536;
/** A write of at most this many bytes goes into a pipe whole or not at all (POSIX PIPE_BUF). */
export const PIPE_BUF = 4096;

/**
 * How a write that waited ended: every byte went in, or the last reader went
 * away first, after `written` of its bytes.
 */
export type WriteSettled = (written: number, broken: boolean) => void;

interface QueuedWrite {
  data: Uint8Array;
  /** Bytes of `data` already in the pipe. */
  offset: number;
  /** Whether the whole write must go in at once (it is at most PIPE_BUF bytes). */
  atomic: boolean;
  settled: WriteSettled | null;
}

/**
 * A one-way byte stream between two file descriptors, holding at most
 * `capacity` bytes. What it holds is what is buffered here plus what was
 * delivered to a reading process that has not yet acknowledged handing it to
 * its reader. A write that does not fit waits in a queue, in order, and goes
 * in as room appears.
 */
export class Pipe implements ByteSource {
  readonly capacity: number;
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private inFlight = 0;
  private queue: QueuedWrite[] = [];
  private waiters = new Set<() => void>();
  private writers = 0;
  private readers = 0;

  constructor(capacity = PIPE_CAPACITY) {
    this.capacity = capacity;
  }

  addWriter(): void {
    this.writers += 1;
  }

  addReader(): void {
    this.readers += 1;
  }

  /**
   * Drops a write end. The last one going ends the stream for readers once
   * the writes still waiting for room are in.
   */
  removeWriter(): void {
    this.writers -= 1;
    if (this.writers <= 0) {
      this.wake();
    }
  }

  /** Drops a read end. With the last one, what is held is lost and every waiting write fails. */
  removeReader(): void {
    this.readers -= 1;
    if (this.readers > 0) {
      return;
    }
    this.chunks = [];
    this.buffered = 0;
    this.inFlight = 0;
    const waiting = this.queue;
    this.queue = [];
    for (const write of waiting) {
      write.settled?.(write.offset, true);
    }
  }

  /** False once every read end is closed: a write would be a broken pipe. */
  get hasReaders(): boolean {
    return this.readers > 0;
  }

  /** The bytes the pipe holds: buffered, and delivered but not yet acknowledged. */
  get size(): number {
    return this.buffered + this.inFlight;
  }

  /** The bytes waiting writes still have to put in. */
  get waitingBytes(): number {
    let total = 0;
    for (const write of this.queue) {
      total += write.data.byteLength - write.offset;
    }
    return total;
  }

  /**
   * Puts in what fits now, without waiting, and returns how many bytes that
   * was: none while earlier writes wait, and none of a write of at most
   * PIPE_BUF bytes that does not fit whole (a non-blocking write(2)).
   */
  tryWrite(data: Uint8Array): number {
    if (this.readers <= 0 || this.queue.length > 0 || data.byteLength === 0) {
      return 0;
    }
    const room = this.room();
    const count =
      data.byteLength <= PIPE_BUF
        ? room >= data.byteLength
          ? data.byteLength
          : 0
        : Math.min(room, data.byteLength);
    if (count > 0) {
      this.append(data.subarray(0, count));
      this.wake();
    }
    return count;
  }

  /**
   * Puts `data` in, waiting for room as a blocking write(2) does: `settled`
   * runs once every byte is in, or when the last reader goes first. Writes
   * keep their order. Returns the function that withdraws the write (its
   * writer is gone); bytes already in stay.
   */
  write(data: Uint8Array, settled?: WriteSettled): () => void {
    if (this.readers <= 0) {
      settled?.(0, true);
      return () => {};
    }
    if (data.byteLength === 0) {
      settled?.(0, false);
      return () => {};
    }
    const write: QueuedWrite = {
      data,
      offset: 0,
      atomic: data.byteLength <= PIPE_BUF,
      settled: settled ?? null,
    };
    this.queue.push(write);
    this.flush();
    return () => {
      const index = this.queue.indexOf(write);
      if (index < 0) {
        return;
      }
      this.queue.splice(index, 1);
      // The next write may fit now, and the end may have come.
      this.flush();
      if (this.queue.length === 0 && this.writers <= 0) {
        this.wake();
      }
    };
  }

  /**
   * Takes up to `maxLength` of the bytes buffered, as read(2) does: several
   * writes' worth at once when they are there, so a reader that asks for a
   * buffer's worth is not answered a line at a time.
   */
  take(maxLength: number): Uint8Array | null | undefined {
    const first = this.chunks[0];
    const chunk =
      first && this.chunks.length > 1 && first.byteLength < maxLength
        ? this.takeSeveral(maxLength)
        : this.takeBuffered(maxLength);
    if (chunk) {
      this.flush();
    }
    return chunk;
  }

  /** Takes `maxLength` bytes, or all there are, from the buffered writes joined. */
  private takeSeveral(maxLength: number): Uint8Array {
    const length = Math.min(maxLength, this.buffered);
    const joined = new Uint8Array(length);
    let offset = 0;
    let whole = 0;
    while (whole < this.chunks.length && offset + this.chunks[whole].byteLength <= length) {
      joined.set(this.chunks[whole], offset);
      offset += this.chunks[whole].byteLength;
      whole += 1;
    }
    this.chunks.splice(0, whole);
    if (offset < length) {
      // The write that does not fit whole gives its start.
      const rest = length - offset;
      joined.set(this.chunks[0].subarray(0, rest), offset);
      this.chunks[0] = this.chunks[0].subarray(rest);
    }
    this.buffered -= length;
    return joined;
  }

  /**
   * Takes buffered bytes (up to `maxLength`, several writes' worth at once)
   * for a reading process. They still count against the capacity until
   * `acknowledge` says the process handed them to its reader.
   */
  deliver(maxLength: number): Uint8Array | null | undefined {
    let length = 0;
    let count = 0;
    while (count < this.chunks.length && length + this.chunks[count].byteLength <= maxLength) {
      length += this.chunks[count].byteLength;
      count += 1;
    }
    if (count <= 1) {
      const chunk = this.takeBuffered(maxLength);
      if (chunk) {
        this.inFlight += chunk.byteLength;
      }
      return chunk;
    }
    const merged = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.chunks.splice(0, count)) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.buffered -= length;
    this.inFlight += length;
    return merged;
  }

  /** A reading process received `bytes` it was delivered: their room is free. */
  acknowledge(bytes: number): void {
    this.inFlight = Math.max(0, this.inFlight - bytes);
    this.flush();
  }

  /**
   * Puts back, in front of what is buffered, bytes delivered to a reading
   * process that never received them (it ended, or closed its fd, first):
   * read(2) would have left them in the pipe for the next reader. `counted`
   * of them still counted as delivered; the rest had stopped counting.
   */
  unread(chunks: readonly Uint8Array[], counted: number): void {
    this.inFlight = Math.max(0, this.inFlight - counted);
    let total = 0;
    for (const chunk of chunks) {
      total += chunk.byteLength;
    }
    if (this.readers <= 0 || total === 0) {
      // Nobody is left to read them.
      this.flush();
      return;
    }
    this.chunks.unshift(...chunks);
    this.buffered += total;
    this.wake();
  }

  whenReadable(_reader: number, callback: () => void): () => void {
    this.waiters.add(callback);
    return () => this.waiters.delete(callback);
  }

  private room(): number {
    return Math.max(0, this.capacity - this.buffered - this.inFlight);
  }

  private append(bytes: Uint8Array): void {
    // A copy: the writer's buffer may be a view of memory it goes on using.
    this.chunks.push(bytes.slice());
    this.buffered += bytes.byteLength;
  }

  private takeBuffered(maxLength: number): Uint8Array | null | undefined {
    const first = this.chunks[0];
    if (!first) {
      return this.writers <= 0 && this.queue.length === 0 ? null : undefined;
    }
    let chunk: Uint8Array;
    if (first.byteLength <= maxLength) {
      this.chunks.shift();
      chunk = first;
    } else {
      this.chunks[0] = first.subarray(maxLength);
      chunk = first.subarray(0, maxLength);
    }
    this.buffered -= chunk.byteLength;
    return chunk;
  }

  /** Moves waiting writes into the room there is, oldest first. */
  private flush(): void {
    let moved = false;
    const done: QueuedWrite[] = [];
    while (this.queue.length > 0) {
      const write = this.queue[0];
      const left = write.data.byteLength - write.offset;
      const room = this.room();
      const count = write.atomic ? (room >= left ? left : 0) : Math.min(room, left);
      if (count === 0) {
        break;
      }
      this.append(write.data.subarray(write.offset, write.offset + count));
      write.offset += count;
      moved = true;
      if (write.offset === write.data.byteLength) {
        this.queue.shift();
        done.push(write);
      }
    }
    for (const write of done) {
      write.settled?.(write.offset, false);
    }
    if (moved) {
      this.wake();
    }
  }

  private wake(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }
}

/**
 * What a pipe delivered to one reading worker (a pump's `fd-data`) and the
 * worker has not yet said it received. Bytes on their way still count
 * against the pipe, as bytes nobody has read(2) do; copies are kept so that
 * bytes that never arrive (the worker ended, or closed the fd) go back.
 */
export class Delivery {
  readonly pipe: Pipe;
  /** The chunks on their way, oldest first. */
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  /**
   * How many of the oldest bytes no longer count against the pipe: they were
   * on their way while the worker waited in a blocking call, which made them
   * its own, as bytes libuv had read would be (see `hold`).
   */
  private uncounted = 0;

  constructor(pipe: Pipe) {
    this.pipe = pipe;
  }

  /** Nothing is on its way. */
  get empty(): boolean {
    return this.bytes === 0;
  }

  /** Bytes on their way stopped counting: no more may be sent until they arrive. */
  get held(): boolean {
    return this.uncounted > 0;
  }

  /** `chunk`, which `Pipe.deliver` gave, was sent (as a copy: this one is kept). */
  sent(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
  }

  /**
   * The worker waits in a blocking call: what is on its way becomes its own,
   * so it no longer takes up room another reader, or the call itself, needs.
   */
  hold(): void {
    const counted = this.bytes - this.uncounted;
    if (counted > 0) {
      this.uncounted = this.bytes;
      this.pipe.acknowledge(counted);
    }
  }

  /** The worker received `bytes` (whole messages, oldest first). True when that ended a hold. */
  received(bytes: number): boolean {
    let left = Math.min(bytes, this.bytes);
    const fromUncounted = Math.min(left, this.uncounted);
    const counted = left - fromUncounted;
    this.uncounted -= fromUncounted;
    this.bytes -= left;
    while (left > 0 && this.chunks.length > 0) {
      const first = this.chunks[0];
      if (first.byteLength <= left) {
        this.chunks.shift();
        left -= first.byteLength;
      } else {
        this.chunks[0] = first.subarray(left);
        left = 0;
      }
    }
    if (counted > 0) {
      this.pipe.acknowledge(counted);
    }
    return fromUncounted > 0 && this.uncounted === 0;
  }

  /** The worker will never receive what is on its way: back into the pipe with it. */
  putBack(): void {
    const chunks = this.chunks;
    const counted = this.bytes - this.uncounted;
    this.chunks = [];
    this.bytes = 0;
    this.uncounted = 0;
    this.pipe.unread(chunks, counted);
  }
}

const CTRL_C = 0x03;
const CTRL_D = 0x04;
const BACKSPACE = 0x08;
const NEWLINE = 0x0a;
const RETURN = 0x0d;
const DELETE = 0x7f;

const textEncoder = new TextEncoder();

/**
 * What a terminal sent one reading worker (a pump's `fd-data`) and the
 * worker has not yet said it handed to its reader. A terminal holds nothing
 * back, so these count against nothing; they are kept so that input that
 * never reaches a reader (the worker ended, or closed the fd, first) goes
 * back to the terminal, where read(2) would have left it for the next
 * reader.
 */
export class TerminalDelivery {
  readonly terminal: Terminal;
  /**
   * The chunks on their way, oldest first, each with whether it is keys as
   * typed (taken in raw mode) or a line edited already, and how often the
   * terminal's input had been flushed when it was sent.
   */
  private chunks: { bytes: Uint8Array; unedited: boolean; flushes: number }[] = [];

  constructor(terminal: Terminal) {
    this.terminal = terminal;
  }

  /** Nothing is on its way. */
  get empty(): boolean {
    return this.chunks.length === 0;
  }

  /** `chunk`, which the terminal gave just now, was sent. */
  sent(chunk: Uint8Array): void {
    this.chunks.push({
      bytes: chunk,
      unedited: this.terminal.raw,
      flushes: this.terminal.flushes,
    });
  }

  /** The worker handed `bytes` to its reader (whole chunks, oldest first). */
  received(bytes: number): void {
    for (let left = bytes; left > 0 && this.chunks.length > 0;) {
      left -= this.chunks.shift()!.bytes.byteLength;
    }
  }

  /**
   * The worker will never hand over what is on its way: back to the terminal
   * with it, except what a Ctrl+C has flushed since, which was input nobody
   * had read.
   */
  putBack(): void {
    const kept = this.chunks.filter((chunk) => chunk.flushes === this.terminal.flushes);
    this.chunks = [];
    this.terminal.putBack(
      kept.map((chunk) => chunk.bytes),
      kept.some((chunk) => chunk.unedited),
    );
  }
}

/**
 * What a terminal remembers of a process that changed its mode, as libuv
 * does for a process's tty handle (`uv_tty_set_mode`).
 */
interface ModeRecord {
  /** Whether the process has raw mode on, by its own account. */
  on: boolean;
  /** The mode it found when it last turned raw mode on: turning it off puts this back. */
  found: boolean;
  /** The mode it found the first time: leaving the foreground puts this back. */
  first: boolean;
}

/**
 * A terminal: what the page types goes in, what processes print comes out.
 * Input goes to a reader in the terminal's foreground — the most recently
 * started one that is waiting to read, as on Linux, where a member of the
 * foreground group that never reads holds up none that does — as lines it
 * can edit (cooked) or as raw keys.
 */
export class Terminal implements ByteSource {
  cols: number;
  rows: number;
  /**
   * The process group the terminal belongs to (what `tcsetpgrp` sets): only
   * its members attach as readers, so a background job never takes the input
   * or the Ctrl+C. The kernel sets it; 0 is none yet.
   */
  foregroundGroup = 0;

  private rawMode = false;
  /** By pid: the processes that changed the mode and may still put one back. */
  private modes = new Map<number, ModeRecord>();
  private pending: Uint8Array[] = [];
  /**
   * `pending` holds keys nobody has read that cooked mode has not edited yet
   * (typed ahead in raw mode, or given back): the next cooked read edits and
   * echoes them as if typed then, as BSD's PENDIN does.
   */
  private retype = false;
  /** Retyping inside `take`: wakes and Ctrl+C wait until it is over. */
  private retyping = false;
  private line: number[] = [];
  private flushCount = 0;
  private ended = false;
  private waiters = new Map<number, Set<() => void>>();
  /** Pids reading this terminal, in the order they started; the last one is the foreground. */
  private readers: number[] = [];
  private decoder = new TextDecoder();
  private lastWasReturn = false;
  private readonly emitOutput: (text: string) => void;
  private readonly interrupt: (pid: number) => void;

  constructor(
    size: { cols: number; rows: number },
    emitOutput: (text: string) => void,
    interrupt: (pid: number) => void,
  ) {
    this.cols = size.cols;
    this.rows = size.rows;
    this.emitOutput = emitOutput;
    this.interrupt = interrupt;
  }

  /** The newest reader, whose group Ctrl+C interrupts, or null when no process reads this terminal. */
  get foreground(): number | null {
    return this.readers.at(-1) ?? null;
  }

  /** Raw mode: keys reach the reader as typed, with no echo. */
  get raw(): boolean {
    return this.rawMode;
  }

  /**
   * How often Ctrl+C has flushed the input. What a reader was sent before a
   * flush and did not take was input nobody had read: it is gone with the
   * rest (`TerminalDelivery`).
   */
  get flushes(): number {
    return this.flushCount;
  }

  /**
   * Raw mode on or off, as process `pid` asked, the way libuv changes a
   * terminal for Node (`uv_tty_set_mode`). Turning raw mode on remembers the
   * mode the process found; turning it off puts that mode back, which is raw
   * when a parent had made the terminal raw before. A request for the mode
   * the process has already, by its own account, changes nothing.
   */
  setRaw(enabled: boolean, pid: number): void {
    let record = this.modes.get(pid);
    if (enabled) {
      if (!record) {
        record = { on: false, found: this.rawMode, first: this.rawMode };
        this.modes.set(pid, record);
      }
      if (!record.on) {
        record.on = true;
        record.found = this.rawMode;
        this.setMode(true);
      }
    } else if (record?.on) {
      record.on = false;
      this.setMode(record.found);
    }
  }

  /**
   * Makes `pid` a foreground reader, in the order the processes started (a
   * pid is higher the later its process started). The mode (raw or cooked)
   * stays as it is, as termios settings do: whoever changes it restores it.
   */
  attach(pid: number): void {
    if (this.readers.includes(pid)) {
      return;
    }
    let index = this.readers.length;
    while (index > 0 && this.readers[index - 1] > pid) {
      index -= 1;
    }
    this.readers.splice(index, 0, pid);
  }

  /**
   * Takes `pid`, and only it, out of the foreground: it ended, or it was
   * left behind by a process that ended, or it moved to the background. If
   * it changed the mode, the terminal goes back to the mode it first found,
   * as Node puts the terminal back at exit (`uv_tty_reset_mode`), and here
   * however the process leaves: the next reader gets echoed lines and Ctrl+C
   * again, and a parent that had made the terminal raw keeps it raw. A read
   * of `pid`'s waits from now on, as a background reader's does, and a
   * reader that waited behind it may read.
   */
  detach(pid: number): void {
    const record = this.modes.get(pid);
    if (record) {
      this.modes.delete(pid);
      this.setMode(record.first);
    }
    const index = this.readers.indexOf(pid);
    if (index >= 0) {
      this.readers.splice(index, 1);
      this.wake();
    }
  }

  /**
   * Puts `bytes` a reader took but did not use back in front of the input,
   * for the next reader: the keys a shell's line editor got after the line it
   * runs. In cooked mode they are edited and echoed when read, as keys typed
   * ahead are, and before an unfinished line typed since.
   */
  unread(bytes: Uint8Array): void {
    if (bytes.byteLength > 0) {
      // A copy: the bytes may be a view of memory the caller goes on using.
      this.putBack([bytes.slice()], true);
    }
  }

  /**
   * Puts `chunks` taken from the input back in front of it, in their order.
   * `unedited` ones are keys as typed: in cooked mode they are edited and
   * echoed when read, before an unfinished line typed since. The others are
   * lines edited and echoed already, and stay those lines.
   */
  putBack(chunks: readonly Uint8Array[], unedited: boolean): void {
    if (chunks.length === 0) {
      return;
    }
    this.pending.unshift(...chunks);
    if (unedited && !this.rawMode) {
      this.unfinishedLineToPending();
      this.retype = true;
    }
    this.wake();
  }

  /** What a process printed: decoded, with every line feed made a CR LF. */
  write(chunk: Uint8Array): void {
    const text = this.decoder.decode(chunk, { stream: true });
    if (!text) {
      return;
    }
    let output = "";
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character === "\n" && !this.lastWasReturn) {
        output += "\r\n";
      } else {
        output += character;
      }
      this.lastWasReturn = character === "\r";
    }
    this.emitOutput(output);
  }

  /** What the page typed. */
  input(text: string): void {
    const bytes = textEncoder.encode(text);
    if (this.rawMode) {
      this.pending.push(bytes);
      this.wake();
      return;
    }
    if (this.retype) {
      // The keys typed earlier come first.
      this.retypePending();
      this.wake();
    }
    for (const byte of bytes) {
      this.cookedInput(byte);
    }
  }

  /** Ends the input stream, as closing the terminal does. */
  end(): void {
    this.ended = true;
    this.wake();
  }

  take(maxLength: number, reader: number): Uint8Array | null | undefined {
    if (!this.mayRead(reader)) {
      // A background process waits for the terminal, and so does a reader
      // while a newer one is waiting to read.
      return undefined;
    }
    if (this.retype && !this.rawMode) {
      this.retypePending();
    }
    const first = this.pending[0];
    if (!first) {
      return this.ended ? null : undefined;
    }
    if (first.byteLength === 0) {
      // An end-of-file mark (Ctrl+D on an empty line).
      this.pending.shift();
      return null;
    }
    if (first.byteLength <= maxLength) {
      this.pending.shift();
      return first;
    }
    this.pending[0] = first.subarray(maxLength);
    return first.subarray(0, maxLength);
  }

  whenReadable(reader: number, callback: () => void): () => void {
    let waiters = this.waiters.get(reader);
    if (!waiters) {
      waiters = new Set();
      this.waiters.set(reader, waiters);
    }
    const waiting = waiters;
    waiting.add(callback);
    return () => {
      waiting.delete(callback);
      // A reader with nothing waiting is not waiting to read (`mayRead`).
      if (waiting.size === 0 && this.waiters.get(reader) === waiting) {
        this.waiters.delete(reader);
      }
    };
  }

  /** Changes the mode, and with it what the keys nobody has read are. */
  private setMode(raw: boolean): void {
    if (raw === this.rawMode) {
      return;
    }
    this.rawMode = raw;
    if (raw) {
      // A raw reader takes keys as they were typed, an unfinished line among
      // them (turning ICANON off makes it readable), and an end of file as
      // the Ctrl+D it was typed as: raw input has no end.
      this.retype = false;
      this.unfinishedLineToPending();
      this.pending = this.pending.map((chunk) =>
        chunk.byteLength === 0 ? Uint8Array.of(CTRL_D) : chunk,
      );
      this.wake();
    } else if (this.pending.length > 0) {
      this.retype = true;
    }
  }

  /** Makes the line being typed keys nobody has read, after those already there. */
  private unfinishedLineToPending(): void {
    if (this.line.length > 0) {
      this.pending.push(new Uint8Array(this.line));
      this.line = [];
    }
  }

  /** Edits and echoes the keys `pending` holds unedited, as cooked input. */
  private retypePending(): void {
    this.retype = false;
    const typed = this.pending;
    this.pending = [];
    this.retyping = true;
    try {
      for (const chunk of typed) {
        if (chunk.byteLength === 0) {
          // An end-of-file mark stays one.
          this.cookedInput(CTRL_D);
        }
        for (const byte of chunk) {
          this.cookedInput(byte);
        }
      }
    } finally {
      this.retyping = false;
    }
  }

  private cookedInput(byte: number): void {
    if (byte === CTRL_C) {
      // INTR flushes the input queue, as the tty driver does unless NOFLSH
      // is set: the unfinished line, and the lines typed ahead of it.
      this.line = [];
      this.pending = [];
      this.flushCount += 1;
      this.emitOutput("^C\r\n");
      const foreground = this.foreground;
      if (foreground !== null) {
        if (this.retyping) {
          // Not from inside a read: the signal may end the reader.
          queueMicrotask(() => this.interrupt(foreground));
        } else {
          this.interrupt(foreground);
        }
      }
      return;
    }
    if (byte === CTRL_D) {
      if (this.line.length === 0) {
        this.pending.push(new Uint8Array(0));
      } else {
        this.flushLine();
      }
      this.wake();
      return;
    }
    if (byte === BACKSPACE || byte === DELETE) {
      if (this.line.length > 0) {
        // Drop a whole UTF-8 character: its continuation bytes, then its lead.
        while (this.line.length > 0 && (this.line.at(-1)! & 0xc0) === 0x80) {
          this.line.pop();
        }
        this.line.pop();
        this.emitOutput("\b \b");
      }
      return;
    }
    if (byte === RETURN || byte === NEWLINE) {
      this.line.push(NEWLINE);
      this.emitOutput("\r\n");
      this.flushLine();
      this.wake();
      return;
    }
    this.line.push(byte);
    // Echo once the character is complete.
    if ((byte & 0x80) === 0) {
      this.emitOutput(String.fromCharCode(byte));
    } else if ((byte & 0xc0) === 0x80 && this.isCompleteCharacterAtEnd()) {
      this.emitOutput(new TextDecoder().decode(new Uint8Array(this.lastCharacterBytes())));
    }
  }

  private lastCharacterBytes(): number[] {
    let start = this.line.length - 1;
    while (start > 0 && (this.line[start] & 0xc0) === 0x80) {
      start -= 1;
    }
    return this.line.slice(start);
  }

  private isCompleteCharacterAtEnd(): boolean {
    const bytes = this.lastCharacterBytes();
    const lead = bytes[0];
    const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    return bytes.length === expected;
  }

  private flushLine(): void {
    this.pending.push(new Uint8Array(this.line));
    this.line = [];
  }

  /** Whether `reader` may take input now: it is a reader, and no newer reader is waiting to read. */
  private mayRead(reader: number): boolean {
    if (this.readers.length === 0) {
      return true;
    }
    const index = this.readers.lastIndexOf(reader);
    if (index < 0) {
      return false;
    }
    for (let newer = index + 1; newer < this.readers.length; newer += 1) {
      if ((this.waiters.get(this.readers[newer])?.size ?? 0) > 0) {
        return false;
      }
    }
    return true;
  }

  private wake(): void {
    if (this.retyping) {
      // The reader retyping takes what it made; whoever retyped wakes the rest.
      return;
    }
    // Chosen before any runs: a callback that waits again adds a fresh entry for the next wake.
    const woken = Array.from(this.waiters).filter(
      ([reader, waiters]) => waiters.size > 0 && this.mayRead(reader),
    );
    for (const [reader, waiters] of woken) {
      this.waiters.delete(reader);
      for (const callback of waiters) {
        callback();
      }
    }
  }
}
