// The shell's I/O plumbing: the table that maps a command's fd numbers to this
// process's real fds (what redirections and pipes rewrite), and the readers
// and writers built-in commands use on it. Writes are synchronous and ordered.
// Reads from files are synchronous; reads from pipes and terminals are
// asynchronous (`fdStream`), so the shell keeps handling signals while a
// built-in waits for input, with a per-fd buffer for what one read got beyond
// what it needed.
import { toSystemErrorRecord } from "../../../errors";
import { runtime } from "../../runtime";

const encoder = new TextEncoder();

/** Encodes text as UTF-8. */
export function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Decodes UTF-8 bytes. */
export function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Joins byte chunks. */
export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * A command's fds: logical fd → this process's fd, or null when closed
 * (`n>&-`). Commands get a copy; the shell's own table stays `{0:0, 1:1, 2:2}`
 * unless `exec` changes it.
 */
export type FdTable = Map<number, number | null>;

/** The table of a shell that has not redirected anything. */
export function baseFdTable(): FdTable {
  return new Map([
    [0, 0],
    [1, 1],
    [2, 2],
  ]);
}

/**
 * Read offsets of the files the shell opened itself. The shell reads them at
 * an explicit position so a line-by-line `read` does not consume more than
 * one line per call.
 */
const offsetsByRuntime = new WeakMap<object, Map<number, number>>();

function fileOffsetsMap(): Map<number, number> {
  const rt = runtime();
  let map = offsetsByRuntime.get(rt);
  if (!map) {
    map = new Map();
    offsetsByRuntime.set(rt, map);
  }
  return map;
}

/** Starts tracking a file the shell opened for reading. */
export function trackFileOffset(fd: number): void {
  fileOffsetsMap().set(fd, 0);
}

/** Buffered asynchronous readers of pipes and terminals, by real fd. */
const readersByRuntime = new WeakMap<object, Map<number, StreamReader>>();

function streamReadersMap(): Map<number, StreamReader> {
  const rt = runtime();
  let map = readersByRuntime.get(rt);
  if (!map) {
    map = new Map();
    readersByRuntime.set(rt, map);
  }
  return map;
}

/** Closes a real fd the shell owns. */
export function closeFd(fd: number): void {
  fileOffsetsMap().delete(fd);
  const readers = streamReadersMap();
  readers.get(fd)?.stop();
  readers.delete(fd);
  try {
    runtime().fs.close(fd);
  } catch {
    // Already closed.
  }
}

/** Reads up to `length` bytes from a real fd that is a file; an empty array is end of file. */
export function readFd(fd: number, length: number): Uint8Array {
  const fileOffsets = fileOffsetsMap();
  const offset = fileOffsets.get(fd);
  if (offset !== undefined) {
    const bytes = runtime().fs.read(fd, length, offset);
    fileOffsets.set(fd, offset + bytes.length);
    return bytes;
  }
  return runtime().fs.read(fd, length, null);
}

/** Reads a pipe or terminal through `fdStream`, pausing it whenever data is buffered. */
class StreamReader {
  private readonly fd: number;
  private chunks: Uint8Array[] = [];
  private ended = false;
  private listening = false;
  private wake: (() => void) | null = null;
  private readonly terminal: boolean;

  constructor(fd: number, terminal: boolean) {
    this.fd = fd;
    this.terminal = terminal;
  }

  /** Bytes already received and not yet consumed. */
  takeBuffered(): Uint8Array {
    const all = concatBytes(this.chunks);
    this.chunks = [];
    return all;
  }

  stop(): void {
    if (this.listening) {
      this.listening = false;
      try {
        runtime().fdStream.readStop(this.fd);
      } catch {
        // Already closed.
      }
    }
    this.wake?.();
    this.wake = null;
  }

  private async fill(): Promise<void> {
    while (this.chunks.length === 0 && !this.ended) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        if (!this.listening) {
          this.listening = true;
          runtime().fdStream.readStart(this.fd, (chunk) => {
            if (chunk === null) {
              this.ended = true;
            } else if (chunk.length > 0) {
              this.chunks.push(chunk);
            }
            this.stop();
          });
        }
      });
    }
  }

  private consumeEnd(): void {
    // A terminal's end of file (Ctrl+D) ends one read, not the stream.
    if (this.terminal && this.chunks.length === 0) {
      this.ended = false;
    }
  }

  async read(length: number): Promise<Uint8Array> {
    await this.fill();
    if (this.chunks.length === 0) {
      this.consumeEnd();
      return new Uint8Array(0);
    }
    const head = this.chunks[0];
    if (head.length <= length) {
      this.chunks.shift();
      return head;
    }
    this.chunks[0] = head.subarray(length);
    return head.subarray(0, length);
  }

  /** One line without its newline; null at end of input with nothing read. */
  async readLine(delimiter = 10): Promise<{ line: string; eof: boolean } | null> {
    const parts: Uint8Array[] = [];
    for (;;) {
      await this.fill();
      if (this.chunks.length === 0) {
        this.consumeEnd();
        return parts.length === 0 ? null : { line: decode(concatBytes(parts)), eof: true };
      }
      const head = this.chunks[0];
      const at = head.indexOf(delimiter);
      if (at >= 0) {
        parts.push(head.subarray(0, at));
        if (at + 1 < head.length) {
          this.chunks[0] = head.subarray(at + 1);
        } else {
          this.chunks.shift();
        }
        return { line: decode(concatBytes(parts)), eof: false };
      }
      parts.push(head);
      this.chunks.shift();
    }
  }
}

/** The buffered reader for a pipe or terminal fd, or null when `fd` is a file. */
function streamReader(fd: number): StreamReader | null {
  const streamReaders = streamReadersMap();
  const existing = streamReaders.get(fd);
  if (existing) {
    return existing;
  }
  let kind: string;
  try {
    kind = runtime().fdStream.kind(fd);
  } catch {
    return null;
  }
  if (kind !== "pipe" && kind !== "tty") {
    return null;
  }
  const reader = new StreamReader(fd, kind === "tty");
  streamReaders.set(fd, reader);
  return reader;
}

/** Bytes the shell has read from `fd` but not used (type-ahead), removed from its buffer. */
export function takeBuffered(fd: number): Uint8Array {
  return streamReadersMap().get(fd)?.takeBuffered() ?? new Uint8Array(0);
}

/** Reads up to `length` bytes from any real fd; empty at end of input. */
export async function readAsync(fd: number, length: number): Promise<Uint8Array> {
  const reader = streamReader(fd);
  if (reader) {
    return reader.read(length);
  }
  return readFd(fd, length);
}

/** Reads a real fd to end of input. */
export async function readAllAsync(fd: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (;;) {
    const chunk = await readAsync(fd, 65536);
    if (chunk.length === 0) {
      break;
    }
    chunks.push(chunk);
  }
  return concatBytes(chunks);
}

/** Reads one line from a real fd that is a file (without its newline); null at end of file. */
function readFileLine(fd: number, delimiter: number): { line: string; eof: boolean } | null {
  const chunks: number[] = [];
  const fileOffsets = fileOffsetsMap();
  const offset = fileOffsets.get(fd);
  if (offset !== undefined) {
    let position = offset;
    for (;;) {
      const bytes = runtime().fs.read(fd, 4096, position);
      if (bytes.length === 0) {
        fileOffsets.set(fd, position);
        return chunks.length === 0 ? null : { line: decode(Uint8Array.from(chunks)), eof: true };
      }
      const at = bytes.indexOf(delimiter);
      if (at >= 0) {
        for (let i = 0; i < at; i++) {
          chunks.push(bytes[i]);
        }
        fileOffsets.set(fd, position + at + 1);
        return { line: decode(Uint8Array.from(chunks)), eof: false };
      }
      for (const byte of bytes) {
        chunks.push(byte);
      }
      position += bytes.length;
    }
  }
  // An fd we did not open may be shared with other processes: read byte by byte.
  for (;;) {
    const bytes = runtime().fs.read(fd, 1, null);
    if (bytes.length === 0) {
      return chunks.length === 0 ? null : { line: decode(Uint8Array.from(chunks)), eof: true };
    }
    if (bytes[0] === delimiter) {
      return { line: decode(Uint8Array.from(chunks)), eof: false };
    }
    chunks.push(bytes[0]);
  }
}

/** Reads one line from any real fd; null at end of input with nothing read. */
export async function readLineAsync(
  fd: number,
  delimiter = 10,
): Promise<{ line: string; eof: boolean } | null> {
  const reader = streamReader(fd);
  if (reader) {
    return reader.readLine(delimiter);
  }
  return readFileLine(fd, delimiter);
}

/** Writes to a real fd; false when the reader is gone (EPIPE) or the fd is bad. */
export function writeFd(fd: number, data: string | Uint8Array): boolean {
  const bytes = typeof data === "string" ? encode(data) : data;
  if (bytes.length === 0) {
    return true;
  }
  try {
    runtime().fs.write(fd, bytes, null);
    return true;
  } catch (error) {
    const record = toSystemErrorRecord(error);
    if (record && (record.code === "EPIPE" || record.code === "EBADF")) {
      return false;
    }
    throw error;
  }
}

/** I/O for one command run in this process, bound to its fd table. */
export class CommandIo {
  readonly fds: FdTable;
  /** Set once a write found the reader gone: the command should stop. */
  broken = false;

  constructor(fds: FdTable) {
    this.fds = fds;
  }

  /** The real fd behind logical `fd`, or null when closed. */
  fd(fd: number): number | null {
    return this.fds.get(fd) ?? null;
  }

  /** Writes to logical fd `fd`. */
  write(fd: number, data: string | Uint8Array): boolean {
    const real = this.fd(fd);
    if (real === null) {
      return false;
    }
    const ok = writeFd(real, data);
    if (!ok && fd === 1) {
      this.broken = true;
    }
    return ok;
  }

  /** Writes to standard output. */
  out(data: string | Uint8Array): boolean {
    return this.write(1, data);
  }

  /** Writes to standard error. */
  err(data: string): boolean {
    return this.write(2, data);
  }

  /** Reads a chunk from standard input; empty at end of input. */
  async readChunk(length = 65536): Promise<Uint8Array> {
    const real = this.fd(0);
    if (real === null) {
      return new Uint8Array(0);
    }
    return readAsync(real, length);
  }

  /** Reads standard input to end of input. */
  async readAll(): Promise<Uint8Array> {
    const real = this.fd(0);
    if (real === null) {
      return new Uint8Array(0);
    }
    return readAllAsync(real);
  }

  /** Reads one line from standard input. */
  async readLine(delimiter = 10): Promise<{ line: string; eof: boolean } | null> {
    const real = this.fd(0);
    if (real === null) {
      return null;
    }
    return readLineAsync(real, delimiter);
  }

  /** True when logical `fd` is a terminal. */
  isTty(fd: number): boolean {
    const real = this.fd(fd);
    if (real === null) {
      return false;
    }
    try {
      return runtime().tty.isatty(real);
    } catch {
      return false;
    }
  }
}
