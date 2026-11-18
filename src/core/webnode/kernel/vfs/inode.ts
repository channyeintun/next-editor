// The filesystem's nodes (regular files, directories, symbolic links), how a
// node reports itself to `stat`, and the byte-level edits of a file's data.
// Nothing here knows about paths, times policy or watchers.
import { GID, UID } from "../../process/platform";
import { ROOT_ID, S_IFDIR, S_IFLNK, S_IFREG, type StatData } from "./types";

/** Fields every node has. `parent`/`name` locate its primary link; null once detached. */
export interface InodeBase {
  ino: number;
  /** Permission bits only (`0o7777`); the type bits come from `kind`. */
  perm: number;
  /** Root's rather than the user's (`VfsApi.giveToRoot`). */
  rootOwned: boolean;
  nlink: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  parent: DirNode | null;
  name: string;
}

export interface FileNode extends InodeBase {
  kind: "file";
  /** Capacity buffer; bytes past `size` are always zero. */
  data: Uint8Array;
  size: number;
  /** Open files referring to this node; data is kept while it is above zero. */
  openCount: number;
}

export interface DirNode extends InodeBase {
  kind: "dir";
  entries: Map<string, Inode>;
}

export interface LinkNode extends InodeBase {
  kind: "symlink";
  target: string;
}

export type Inode = FileNode | DirNode | LinkNode;

export const EMPTY_BYTES = new Uint8Array(0);

/** The largest file the filesystem holds (4 GiB). */
export const MAX_FILE_SIZE = 2 ** 32;

const DEV = 1;
const BLKSIZE = 4096;
const DIR_SIZE = 4096;

/** The `stat` record for `node`. */
export function statOf(node: Inode): StatData {
  let mode: number;
  let size: number;
  if (node.kind === "file") {
    mode = S_IFREG | node.perm;
    size = node.size;
  } else if (node.kind === "dir") {
    mode = S_IFDIR | node.perm;
    size = DIR_SIZE;
  } else {
    mode = S_IFLNK | node.perm;
    size = utf8Length(node.target);
  }
  return {
    dev: DEV,
    ino: node.ino,
    mode,
    nlink: node.nlink,
    uid: node.rootOwned ? ROOT_ID : UID,
    gid: node.rootOwned ? ROOT_ID : GID,
    rdev: 0,
    size,
    blksize: BLKSIZE,
    blocks: Math.ceil(size / 512),
    atimeMs: node.atimeMs,
    mtimeMs: node.mtimeMs,
    ctimeMs: node.ctimeMs,
    birthtimeMs: node.birthtimeMs,
  };
}

/** Up to `length` bytes of `file` from `position`, as a copy. */
export function readBytes(file: FileNode, length: number, position: number): Uint8Array {
  if (position >= file.size || length <= 0) {
    return new Uint8Array(0);
  }
  const end = Math.min(file.size, position + length);
  return file.data.slice(position, end);
}

/**
 * Writes `source` into `file` at `position`, zero-filling any gap, and
 * returns how many bytes the file grew by.
 */
export function writeBytes(file: FileNode, source: Uint8Array, position: number): number {
  const end = position + source.length;
  if (end > file.data.length) {
    reserve(file, end);
  }
  file.data.set(source, position);
  if (end <= file.size) {
    return 0;
  }
  const grown = end - file.size;
  file.size = end;
  return grown;
}

/** Sets `file`'s size to `length` and returns the change in size. */
export function resizeBytes(file: FileNode, length: number): number {
  const before = file.size;
  if (length < before) {
    file.data.fill(0, length, before);
  } else if (length > file.data.length) {
    reserve(file, length);
  }
  file.size = length;
  return length - before;
}

/** Grows `file`'s buffer to hold at least `needed` bytes, doubling for amortized appends. */
function reserve(file: FileNode, needed: number): void {
  const capacity = file.data.length === 0 ? needed : Math.max(needed, file.data.length * 2);
  const next = new Uint8Array(capacity);
  next.set(file.data.subarray(0, file.size));
  file.data = next;
}

/** How many bytes `text` takes as UTF-8 (a lone surrogate as three, as TextEncoder writes it). */
export function utf8Length(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      length += 1;
    } else if (code < 0x800) {
      length += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(text.charCodeAt(i + 1))) {
      length += 4;
      i++;
    } else {
      length += 3;
    }
  }
  return length;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
