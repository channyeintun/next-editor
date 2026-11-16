// `fs.Dirent` (a directory entry with its type) and `fs.Dir` (the handle
// `opendir` returns). A Dir lists its directory when it is opened and hands the
// entries out one by one; with `recursive` it lists each subdirectory when it
// reaches it.
import type { DirEntry, DirEntryType } from "../../../kernel/vfs/types";
import { validateFunction } from "../internalErrors";
import path from "../path";
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

/** `fs.Dirent`. */
export class Dirent {
  name: string | Uint8Array;
  parentPath: string;
  path: string;
  declare [kType]: number;

  constructor(name: string | Uint8Array, type: number, path: string) {
    this.name = name;
    this.parentPath = path;
    this.path = path;
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

  /** @internal Built by `opendir`, with the directory's first listing. */
  constructor(dirPath: string, entries: DirEntry[], source: DirSource, recursive: boolean) {
    this.#path = dirPath;
    this.#source = source;
    this.#recursive = recursive;
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
        try {
          resolve(this.#next());
        } catch (error) {
          reject(error);
        }
      });
    }
    validateFunction(callback, "callback");
    let result: Dirent | null;
    try {
      result = this.#next();
    } catch (error) {
      queueMicrotask(() => callback(error as Error));
      return undefined;
    }
    queueMicrotask(() => callback(null, result));
    return undefined;
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
      this.#closed = true;
      return Promise.resolve();
    }
    validateFunction(callback, "callback");
    if (this.#closed) {
      queueMicrotask(() => callback(dirClosed()));
      return undefined;
    }
    this.#closed = true;
    queueMicrotask(() => callback(null));
    return undefined;
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
