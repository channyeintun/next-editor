// The byte streams behind file descriptors that are not files: pipes and
// terminals. A reader either takes what is buffered or leaves a callback that
// runs when bytes (or the end) arrive, which is how a blocked `read` and a
// streaming `readStart` both work.

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

/** A one-way byte stream between two file descriptors. */
export class Pipe implements ByteSource {
  private chunks: Uint8Array[] = [];
  private waiters = new Set<() => void>();
  private writers = 0;
  private readers = 0;

  addWriter(): void {
    this.writers += 1;
  }

  addReader(): void {
    this.readers += 1;
  }

  /** Drops a write end. The last one going ends the stream for readers. */
  removeWriter(): void {
    this.writers -= 1;
    if (this.writers <= 0) {
      this.wake();
    }
  }

  removeReader(): void {
    this.readers -= 1;
    if (this.readers <= 0) {
      // Nothing will read what is buffered.
      this.chunks = [];
    }
  }

  /** False once every read end is closed: a write would be a broken pipe. */
  get hasReaders(): boolean {
    return this.readers > 0;
  }

  write(chunk: Uint8Array): void {
    if (chunk.byteLength === 0 || this.readers <= 0) {
      return;
    }
    this.chunks.push(chunk);
    this.wake();
  }

  take(maxLength: number): Uint8Array | null | undefined {
    const first = this.chunks[0];
    if (!first) {
      return this.writers <= 0 ? null : undefined;
    }
    if (first.byteLength <= maxLength) {
      this.chunks.shift();
      return first;
    }
    this.chunks[0] = first.subarray(maxLength);
    return first.subarray(0, maxLength);
  }

  whenReadable(_reader: number, callback: () => void): () => void {
    this.waiters.add(callback);
    return () => this.waiters.delete(callback);
  }

  private wake(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
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
 * A terminal: what the page types goes in, what processes print comes out.
 * Input goes to the foreground process — the most recently started member of
 * the terminal's process group that has it as stdin — as lines it can edit
 * (cooked) or as raw keys.
 */
export class Terminal implements ByteSource {
  cols: number;
  rows: number;
  /** Raw mode: keys reach the reader as typed, with no echo. */
  raw = false;
  /**
   * The process group the terminal belongs to (what `tcsetpgrp` sets): only
   * its members attach as readers, so a background job never takes the input
   * or the Ctrl+C. The kernel sets it; 0 is none yet.
   */
  foregroundGroup = 0;

  private pending: Uint8Array[] = [];
  private line: number[] = [];
  private ended = false;
  private waiters = new Map<number, Set<() => void>>();
  /** Pids reading this terminal, oldest first; the last one is the foreground. */
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

  /** The pid input goes to, or null when no process reads this terminal. */
  get foreground(): number | null {
    return this.readers.at(-1) ?? null;
  }

  /**
   * Makes `pid` the foreground reader. The mode (raw or cooked) stays as it
   * is, as termios settings do: whoever changes it restores it.
   */
  attach(pid: number): void {
    this.readers.push(pid);
  }

  /** Removes `pid`; the reader before it becomes the foreground again. */
  detach(pid: number): void {
    const index = this.readers.lastIndexOf(pid);
    if (index >= 0) {
      this.readers.splice(index, 1);
      if (!this.readers.includes(pid)) {
        this.waiters.delete(pid);
      }
      this.wake();
    }
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
    if (this.raw) {
      this.pending.push(bytes);
      this.wake();
      return;
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
    if (this.foreground !== null && reader !== this.foreground) {
      // A background process waits for the terminal.
      return undefined;
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
    waiters.add(callback);
    return () => waiters.delete(callback);
  }

  private cookedInput(byte: number): void {
    if (byte === CTRL_C) {
      this.line = [];
      this.emitOutput("^C\r\n");
      const foreground = this.foreground;
      if (foreground !== null) {
        this.interrupt(foreground);
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

  private wake(): void {
    const foreground = this.foreground;
    // A snapshot: a callback that waits again adds a fresh entry for the next wake.
    for (const [reader, waiters] of Array.from(this.waiters)) {
      if (foreground !== null && reader !== foreground) {
        continue;
      }
      this.waiters.delete(reader);
      for (const callback of waiters) {
        callback();
      }
    }
  }
}
