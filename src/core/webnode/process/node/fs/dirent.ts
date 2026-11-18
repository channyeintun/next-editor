// `fs.Dirent` (a directory entry with its type) and `fs.Dir` (the handle
// `opendir` returns). A Dir lists its directory when it is opened and hands the
// entries out one by one; with `recursive` it lists each subdirectory when it
// reaches it. Its asynchronous reads arrive when Node's do: Node reads a
// directory `bufferSize` entries at a time from the event loop and hands out
// the entries a read brought beyond its own without waiting.
import type { DirEntry, DirEntryType } from "../../../kernel/vfs/types";
import { nextTick } from "../eventLoop";
import { validateFunction } from "../internalErrors";
import path from "../path";
import { complete } from "./completion";
import {
  UV_DIRENT_BLOCK,
  UV_DIRENT_CHAR,
  UV_DIRENT_DIR,
  UV_DIRENT_FIFO,
  UV_DIRENT_FILE,
  UV_DIRENT_LINK,
  UV_DIRENT_SOCKET,
} from "./constants";
import { dirClosed } from "./errors";

const kType = Symbol("type");

/** The libuv type number for a backend entry type. */
export function direntType(type: DirEntryType): number {
  switch (type) {
    case "file":
      return UV_DIRENT_FILE;
    case "dir":
      return UV_DIRENT_DIR;
    case "symlink":
      return UV_DIRENT_LINK;
  }
}

/**
 * `fs.Dirent`, as Node 26 makes it: `name` and `parentPath` (the directory as
 * the call spelled it). Node 22's deprecated `path`, the same as `parentPath`,
 * is gone.
 */
export class Dirent {
  name: string | Uint8Array;
  parentPath: string;
  declare [kType]: number;

  constructor(name: string | Uint8Array, type: number, parentPath: string) {
    this.name = name;
    this.parentPath = parentPath;
    this[kType] = type;
  }

  isDirectory(): boolean {
    return this[kType] === UV_DIRENT_DIR;
  }

  isFile(): boolean {
    return this[kType] === UV_DIRENT_FILE;
  }

  isBlockDevice(): boolean {
    return this[kType] === UV_DIRENT_BLOCK;
  }

  isCharacterDevice(): boolean {
    return this[kType] === UV_DIRENT_CHAR;
  }

  isSymbolicLink(): boolean {
    return this[kType] === UV_DIRENT_LINK;
  }

  isFIFO(): boolean {
    return this[kType] === UV_DIRENT_FIFO;
  }

  isSocket(): boolean {
    return this[kType] === UV_DIRENT_SOCKET;
  }
}

/** How a Dir lists a directory (by the caller's spelling of its path) and encodes names. */
export interface DirSource {
  list(dirPath: string): DirEntry[];
  encodeName(name: string): string | Uint8Array;
}

/** `fs.Dir`: see the file comment. */
export class Dir {
  #path: string;
  #pending: Dirent[];
  #closed = false;
  #recursive: boolean;
  #source: DirSource;
  #bufferSize: number;
  /** How many more entries the last read of the directory brought with it. */
  #buffered = 0;
  /**
   * What was asked while a read of the directory is on its way from the event
   * loop; null when none is. It runs on the tick after that read's answer.
   */
  #behind: (() => void)[] | null = null;

  /** @internal Built by `opendir`, with the directory's first listing. */
  constructor(
    dirPath: string,
    entries: DirEntry[],
    source: DirSource,
    recursive: boolean,
    bufferSize: number,
  ) {
    this.#path = dirPath;
    this.#source = source;
    this.#recursive = recursive;
    this.#bufferSize = bufferSize;
    this.#pending = entries.map(
      (entry) => new Dirent(source.encodeName(entry.name), direntType(entry.type), dirPath),
    );
  }

  get path(): string {
    return this.#path;
  }

  /** `dir.read()` → Promise; `dir.read(callback)`. */
  read(
    callback?: (error: Error | null, dirent?: Dirent | null) => void,
  ): Promise<Dirent | null> | undefined {
    if (this.#closed) {
      throw dirClosed();
    }
    if (callback === undefined) {
      return new Promise((resolve, reject) => {
        this.#read(false, (error, dirent) =>
          error === null ? resolve(dirent ?? null) : reject(error),
        );
      });
    }
    validateFunction(callback, "callback");
    this.#read(true, callback);
    return undefined;
  }

  /**
   * Answers `callback` with the next entry when Node would: from the event
   * loop when the directory has to be read, and otherwise at once, or on the
   * next tick when `deferred` (the callback form, which never calls back
   * inside the call).
   */
  #read(deferred: boolean, callback: (error: Error | null, dirent?: Dirent | null) => void): void {
    if (this.#behind !== null) {
      this.#behind.push(() => this.#read(deferred, callback));
      return;
    }
    let dirent: Dirent | null = null;
    let failure: Error | null = null;
    try {
      dirent = this.#next();
    } catch (error) {
      failure = error as Error;
    }
    const answer = () => (failure === null ? callback(null, dirent) : callback(failure));
    if (this.#buffered > 0) {
      this.#buffered -= 1;
      if (deferred) {
        nextTick(answer);
      } else {
        answer();
      }
      return;
    }
    this.#buffered = Math.min(this.#bufferSize - 1, this.#pending.length);
    // What is asked until the answer has run waits for the tick after it.
    this.#behind = [];
    complete(() => {
      nextTick(() => {
        const behind = this.#behind ?? [];
        this.#behind = null;
        for (const ask of behind) {
          ask();
        }
      });
      answer();
    });
  }

  /** `dir.readSync()`. */
  readSync(): Dirent | null {
    if (this.#closed) {
      throw dirClosed();
    }
    return this.#next();
  }

  /** `dir.close()` → Promise; `dir.close(callback)`. */
  close(callback?: (error: Error | null) => void): Promise<void> | undefined {
    if (callback === undefined) {
      if (this.#closed) {
        return Promise.reject(dirClosed());
      }
      return new Promise((resolve) => this.#close(() => resolve()));
    }
    validateFunction(callback, "callback");
    if (this.#closed) {
      nextTick(callback, dirClosed());
      return undefined;
    }
    this.#close(callback);
    return undefined;
  }

  /** Closes from the event loop, behind a read that is on its way. */
  #close(callback: (error: Error | null) => void): void {
    if (this.#behind !== null) {
      this.#behind.push(() => this.#close(callback));
      return;
    }
    this.#closed = true;
    complete(() => callback(null));
  }

  /** `dir.closeSync()`. */
  closeSync(): void {
    if (this.#closed) {
      throw dirClosed();
    }
    this.#closed = true;
  }

  /** Yields every entry, then closes the directory. */
  async *entries(): AsyncGenerator<Dirent, void, undefined> {
    try {
      for (;;) {
        const dirent = await (this.read() as Promise<Dirent | null>);
        if (dirent === null) {
          break;
        }
        yield dirent;
      }
    } finally {
      if (!this.#closed) {
        await this.close();
      }
    }
  }

  [Symbol.asyncIterator](): AsyncGenerator<Dirent, void, undefined> {
    return this.entries();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.#closed) {
      await this.close();
    }
  }

  [Symbol.dispose](): void {
    if (!this.#closed) {
      this.closeSync();
    }
  }

  #next(): Dirent | null {
    const dirent = this.#pending.shift();
    if (dirent === undefined) {
      return null;
    }
    if (this.#recursive && dirent.isDirectory()) {
      const name =
        typeof dirent.name === "string" ? dirent.name : new TextDecoder().decode(dirent.name);
      const child = path.join(dirent.parentPath, name);
      for (const entry of this.#source.list(child)) {
        this.#pending.push(
          new Dirent(this.#source.encodeName(entry.name), direntType(entry.type), child),
        );
      }
    }
    return dirent;
  }
}
