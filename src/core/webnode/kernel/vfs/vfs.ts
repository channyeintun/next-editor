// The in-memory filesystem the whole runtime shares: the inode tree, path
// resolution with symbolic links, POSIX errors and timestamps, open files and
// change notification. The kernel owns the one instance; everything else
// reaches it through `VfsApi`/`OpenFile` (types.ts).
import { createSystemError, type ErrnoCode } from "../../errors";
import {
  EMPTY_BYTES,
  MAX_FILE_SIZE,
  readBytes,
  resizeBytes,
  statOf,
  writeBytes,
  type DirNode,
  type FileNode,
  type Inode,
  type LinkNode,
} from "./inode";
import { lastComponentIndex, lexicalParent, trimTrailingSlashes } from "./path";
import {
  COPYFILE_EXCL,
  O_ACCMODE,
  O_APPEND,
  O_CREAT,
  O_DIRECTORY,
  O_EXCL,
  O_NOFOLLOW,
  O_RDONLY,
  O_TRUNC,
  O_WRONLY,
  X_OK,
  type DirEntry,
  type OpenFile,
  type StatData,
  type VfsApi,
  type VfsWatchEvent,
} from "./types";
import { WatchRegistry } from "./watchers";

export { normalizePath } from "./path";

const SLASH = 47;
/** Linux's limit on symbolic links followed while resolving one path. */
const MAX_LINKS = 40;
const UMASK = 0o022;
const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;
const TEMP_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export interface VfsOptions {
  /** The clock for timestamps, in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Where a path led. `parent`/`name` are the directory entry that names `node`
 * (absent when it does not exist yet); `parent` is null when the path ends at a
 * directory without naming an entry (`/`, `.` or `..`).
 */
interface Lookup {
  parent: DirNode | null;
  name: string;
  node: Inode | undefined;
  /** The path ended with `/` or `/.`, so the entry must be a directory. */
  dirTail: boolean;
}

/** What an open file needs from the filesystem that owns its node. */
interface FileHost {
  now(): number;
  write(node: FileNode, data: Uint8Array, position: number): void;
  resize(node: FileNode, length: number): void;
  setMode(node: Inode, mode: number): void;
  setTimes(node: Inode, atimeMs: number, mtimeMs: number): void;
  changed(node: Inode): void;
  closed(node: FileNode | DirNode): void;
}

function fail(code: ErrnoCode, syscall: string, path?: string, dest?: string): never {
  throw createSystemError(code, syscall, path, dest);
}

/** The single in-memory filesystem: see the file comment. */
export class Vfs implements VfsApi {
  private readonly clock: () => number;
  private readonly root: DirNode;
  private readonly watchers = new WatchRegistry();
  private readonly host: FileHost;
  private nextIno = 1;
  private inodeCount = 0;
  private byteCount = 0;

  constructor(options: VfsOptions = {}) {
    this.clock = options.now ?? Date.now;
    this.root = this.newDir(DEFAULT_DIR_MODE, this.clock());
    this.root.parent = this.root;
    this.host = {
      now: () => this.clock(),
      write: (node, data, position) => this.writeData(node, data, position),
      resize: (node, length) => this.resizeData(node, length),
      setMode: (node, mode) => this.setMode(node, mode),
      setTimes: (node, atimeMs, mtimeMs) => this.setTimes(node, atimeMs, mtimeMs),
      changed: (node) => this.emitNode("change", node),
      closed: (node) => this.fileClosed(node),
    };
  }

  /** Live inodes and the bytes their files hold, for diagnostics. */
  totals(): { inodes: number; bytes: number } {
    return { inodes: this.inodeCount, bytes: this.byteCount };
  }

  stat(path: string, followSymlinks: boolean): StatData {
    const syscall = followSymlinks ? "stat" : "lstat";
    return statOf(this.existing(path, followSymlinks, syscall));
  }

  exists(path: string): boolean {
    const found = this.resolve(path, true);
    return typeof found !== "string" && found.node !== undefined;
  }

  readdir(path: string): DirEntry[] {
    const node = this.existing(path, true, "scandir");
    if (node.kind !== "dir") {
      fail("ENOTDIR", "scandir", path);
    }
    const names = [...node.entries.keys()].sort();
    return names.map((name) => ({ name, type: (node.entries.get(name) as Inode).kind }));
  }

  mkdir(path: string, recursive: boolean, mode: number): string | undefined {
    const perm = creationMode(mode, DEFAULT_DIR_MODE);
    if (!recursive) {
      this.createDir(this.lookup(path, false, "mkdir", path), perm, path);
      return undefined;
    }
    return this.mkdirp(trimTrailingSlashes(path), perm, path, true);
  }

  rmdir(path: string): void {
    const found = this.lookup(path, false, "rmdir", path);
    const node = found.node;
    if (node === this.root) {
      fail("EBUSY", "rmdir", path);
    }
    if (node === undefined) {
      fail("ENOENT", "rmdir", path);
    }
    if (found.parent === null) {
      fail("EINVAL", "rmdir", path);
    }
    if (node.kind !== "dir") {
      fail("ENOTDIR", "rmdir", path);
    }
    if (node.entries.size > 0) {
      fail("ENOTEMPTY", "rmdir", path);
    }
    this.removeEntry(found.parent, found.name, node, true);
  }

  unlink(path: string): void {
    const found = this.lookup(path, false, "unlink", path);
    const node = found.node;
    if (node === undefined) {
      fail("ENOENT", "unlink", path);
    }
    if (node.kind === "dir" || found.parent === null) {
      fail("EISDIR", "unlink", path);
    }
    this.removeEntry(found.parent, found.name, node, true);
  }

  rm(path: string, recursive: boolean, force: boolean): void {
    const found = this.resolve(path, false);
    if (typeof found === "string") {
      if (found === "ENOENT" && force) {
        return;
      }
      fail(found, "rm", path);
    }
    const node = found.node;
    if (node === undefined) {
      if (force) {
        return;
      }
      fail("ENOENT", "rm", path);
    }
    if (node === this.root) {
      fail("EBUSY", "rm", path);
    }
    if (node.kind === "dir") {
      if (!recursive) {
        fail("EISDIR", "rm", path);
      }
      if (found.parent === null) {
        fail("EINVAL", "rm", path);
      }
      this.removeTree(node);
    } else if (found.parent === null) {
      fail("EINVAL", "rm", path);
    }
    this.removeEntry(found.parent, found.name, node, true);
  }

  rename(from: string, to: string): void {
    const source = this.lookup(from, false, "rename", from, to);
    const node = source.node;
    if (node === undefined) {
      fail("ENOENT", "rename", from, to);
    }
    if (node === this.root) {
      fail("EBUSY", "rename", from, to);
    }
    if (source.parent === null) {
      fail("EINVAL", "rename", from, to);
    }
    const target = this.lookup(to, false, "rename", from, to);
    if (target.node === this.root) {
      fail("EBUSY", "rename", from, to);
    }
    if (target.parent === null) {
      fail("EINVAL", "rename", from, to);
    }
    if (target.node === node) {
      return;
    }
    if (node.kind === "dir" && isWithin(target.parent, node)) {
      fail("EINVAL", "rename", from, to);
    }
    const replaced = target.node;
    if (replaced !== undefined) {
      if (node.kind === "dir") {
        if (replaced.kind !== "dir") {
          fail("ENOTDIR", "rename", from, to);
        }
        if (replaced.entries.size > 0) {
          fail("ENOTEMPTY", "rename", from, to);
        }
      } else if (replaced.kind === "dir") {
        fail("EISDIR", "rename", from, to);
      }
    }
    const oldPath = this.watchers.active ? entryPath(source.parent, source.name) : null;
    const t = this.clock();
    if (replaced !== undefined) {
      this.removeEntry(target.parent, target.name, replaced, false);
    }
    source.parent.entries.delete(source.name);
    target.parent.entries.set(target.name, node);
    if (node.kind === "dir" && source.parent !== target.parent) {
      source.parent.nlink--;
      target.parent.nlink++;
    }
    if (node.parent === source.parent && node.name === source.name) {
      node.parent = target.parent;
      node.name = target.name;
    }
    node.ctimeMs = t;
    touch(source.parent, t);
    touch(target.parent, t);
    if (oldPath !== null) {
      this.watchers.emit("rename", oldPath);
    }
    this.emitEntry("rename", target.parent, target.name);
  }

  link(existingPath: string, newPath: string): void {
    const source = this.lookup(existingPath, false, "link", existingPath, newPath);
    const node = source.node;
    if (node === undefined) {
      fail("ENOENT", "link", existingPath, newPath);
    }
    if (node.kind === "dir") {
      fail("EPERM", "link", existingPath, newPath);
    }
    const target = this.lookup(newPath, false, "link", existingPath, newPath);
    if (target.node !== undefined || target.parent === null) {
      fail("EEXIST", "link", existingPath, newPath);
    }
    if (target.dirTail) {
      fail("ENOENT", "link", existingPath, newPath);
    }
    const t = this.clock();
    target.parent.entries.set(target.name, node);
    node.nlink++;
    node.ctimeMs = t;
    if (node.parent === null) {
      node.parent = target.parent;
      node.name = target.name;
    }
    touch(target.parent, t);
    this.emitEntry("rename", target.parent, target.name);
  }

  symlink(target: string, path: string): void {
    const found = this.lookup(path, false, "symlink", target, path);
    if (found.node !== undefined || found.parent === null) {
      fail("EEXIST", "symlink", target, path);
    }
    if (found.dirTail || target === "") {
      fail("ENOENT", "symlink", target, path);
    }
    const t = this.clock();
    const node: LinkNode = {
      kind: "symlink",
      target,
      ...this.base(0o777, t),
    };
    this.addEntry(found.parent, found.name, node, t);
  }

  readlink(path: string): string {
    const node = this.existing(path, false, "readlink");
    if (node.kind !== "symlink") {
      fail("EINVAL", "readlink", path);
    }
    return node.target;
  }

  realpath(path: string): string {
    const found = this.lookup(path, true, "realpath", path);
    if (found.node === undefined) {
      fail("ENOENT", "realpath", path);
    }
    if (found.parent === null) {
      return dirPath(found.node as DirNode) ?? fail("ENOENT", "realpath", path);
    }
    return entryPath(found.parent, found.name) ?? fail("ENOENT", "realpath", path);
  }

  chmod(path: string, mode: number, followSymlinks: boolean): void {
    const found = this.lookup(path, followSymlinks, "chmod", path);
    const node = found.node;
    if (node === undefined) {
      fail("ENOENT", "chmod", path);
    }
    if (node.kind === "symlink") {
      // Linux cannot change a link's own mode (fchmodat AT_SYMLINK_NOFOLLOW).
      fail("ENOTSUP", "chmod", path);
    }
    this.setMode(node, mode);
    this.emitFound("change", found);
  }

  utimes(path: string, atimeMs: number, mtimeMs: number, followSymlinks: boolean): void {
    const found = this.lookup(path, followSymlinks, "utime", path);
    if (found.node === undefined) {
      fail("ENOENT", "utime", path);
    }
    this.setTimes(found.node, atimeMs, mtimeMs);
    this.emitFound("change", found);
  }

  truncate(path: string, length: number): void {
    const found = this.lookup(path, true, "open", path);
    const node = found.node;
    if (node === undefined) {
      fail("ENOENT", "open", path);
    }
    if (node.kind === "dir") {
      fail("EISDIR", "open", path);
    }
    if (node.kind !== "file" || length < 0 || !Number.isFinite(length)) {
      fail("EINVAL", "ftruncate");
    }
    if (length > MAX_FILE_SIZE) {
      fail("EFBIG", "ftruncate");
    }
    this.resizeData(node, Math.floor(length));
    this.emitFound("change", found);
  }

  copyFile(source: string, destination: string, mode: number): void {
    const from = this.lookup(source, true, "copyfile", source, destination);
    const node = from.node;
    if (node === undefined) {
      fail("ENOENT", "copyfile", source, destination);
    }
    if (node.kind !== "file") {
      fail("EISDIR", "copyfile", source, destination);
    }
    const exclusive = (mode & COPYFILE_EXCL) !== 0;
    const to = this.lookup(destination, !exclusive, "copyfile", source, destination);
    const existing = to.node;
    if (existing !== undefined && exclusive) {
      fail("EEXIST", "copyfile", source, destination);
    }
    if (existing === node) {
      return;
    }
    if (to.parent === null || existing?.kind === "dir") {
      fail("EISDIR", "copyfile", source, destination);
    }
    if (existing === undefined && to.dirTail) {
      fail("EISDIR", "copyfile", source, destination);
    }
    const bytes = node.data.subarray(0, node.size);
    if (existing === undefined) {
      const t = this.clock();
      const copy = this.newFile(node.perm, t);
      this.writeData(copy, bytes, 0);
      this.addEntry(to.parent, to.name, copy, t);
      return;
    }
    if (existing.kind !== "file") {
      fail("EINVAL", "copyfile", source, destination);
    }
    this.resizeData(existing, 0);
    this.writeData(existing, bytes, 0);
    this.setMode(existing, node.perm);
    this.emitFound("change", to);
  }

  access(path: string, mode: number): void {
    const node = this.existing(path, true, "access");
    if ((mode & X_OK) !== 0 && node.kind === "file" && (node.perm & 0o111) === 0) {
      fail("EACCES", "access", path);
    }
  }

  mkdtemp(prefix: string): string {
    const shown = `${prefix}XXXXXX`;
    const random = new Uint8Array(6);
    for (let attempt = 0; attempt < 100; attempt++) {
      crypto.getRandomValues(random);
      let path = prefix;
      for (const byte of random) {
        path += TEMP_CHARS[byte % TEMP_CHARS.length];
      }
      const found = this.resolve(path, false);
      if (typeof found === "string") {
        fail(found, "mkdtemp", shown);
      }
      if (found.node !== undefined) {
        continue;
      }
      if (found.parent === null) {
        fail("EEXIST", "mkdtemp", shown);
      }
      this.createDir(found, 0o700, shown, "mkdtemp");
      return path;
    }
    return fail("EEXIST", "mkdtemp", shown);
  }

  readFile(path: string): Uint8Array {
    const node = this.existing(path, true, "open");
    if (node.kind === "dir") {
      fail("EISDIR", "read");
    }
    if (node.kind !== "file") {
      fail("EINVAL", "read");
    }
    node.atimeMs = this.clock();
    return node.data.slice(0, node.size);
  }

  writeFile(path: string, data: Uint8Array, flags: number, mode: number): void {
    const file = this.open(path, flags, mode);
    try {
      if (data.length > 0) {
        file.write(data, null);
      }
    } finally {
      file.close();
    }
  }

  open(path: string, flags: number, mode: number): OpenFile {
    const create = (flags & O_CREAT) !== 0;
    const exclusive = create && (flags & O_EXCL) !== 0;
    const noFollow = (flags & O_NOFOLLOW) !== 0;
    const found = this.lookup(path, !noFollow && !exclusive, "open", path);
    const accmode = flags & O_ACCMODE;
    let node = found.node;
    if (node === undefined) {
      if (!create) {
        fail("ENOENT", "open", path);
      }
      if ((flags & O_DIRECTORY) !== 0) {
        fail("EINVAL", "open", path);
      }
      if (found.dirTail || found.parent === null) {
        fail("EISDIR", "open", path);
      }
      const t = this.clock();
      node = this.newFile(creationMode(mode, DEFAULT_FILE_MODE), t);
      this.addEntry(found.parent, found.name, node, t);
    } else {
      if (exclusive) {
        fail("EEXIST", "open", path);
      }
      if (node.kind === "symlink") {
        fail("ELOOP", "open", path);
      }
      if (node.kind === "dir") {
        if (accmode !== O_RDONLY || create || (flags & O_TRUNC) !== 0) {
          fail("EISDIR", "open", path);
        }
      } else {
        if ((flags & O_DIRECTORY) !== 0) {
          fail("ENOTDIR", "open", path);
        }
        // Truncating an empty file changes nothing, so it reports nothing.
        if ((flags & O_TRUNC) !== 0 && node.size > 0) {
          this.resizeData(node, 0);
          this.emitFound("change", found);
        }
      }
    }
    if (node.kind === "file") {
      node.openCount++;
    }
    return new VfsFile(node, flags, this.host);
  }

  watch(path: string, recursive: boolean, listener: (event: VfsWatchEvent) => void): () => void {
    const found = this.lookup(path, true, "watch", path);
    const node = found.node;
    if (node === undefined) {
      fail("ENOENT", "watch", path);
    }
    const watched =
      found.parent === null ? dirPath(node as DirNode) : entryPath(found.parent, found.name);
    if (watched === null) {
      fail("ENOENT", "watch", path);
    }
    return this.watchers.add(watched, recursive, listener);
  }

  // ---- path resolution ----

  /**
   * Walks `path` from the root, following symbolic links in every
   * intermediate component and in the last one when `followLast` (or when a
   * trailing slash demands a directory). `..` is resolved physically, after
   * links. Returns the errno code on failure rather than throwing, so cheap
   * probes like `exists` build no Error.
   */
  private resolve(path: string, followLast: boolean): Lookup | ErrnoCode {
    if (path.length === 0) {
      return "ENOENT";
    }
    if (path.charCodeAt(0) !== SLASH) {
      return "EINVAL";
    }
    let parts = path.split("/");
    let end = lastComponentIndex(parts);
    let dirTail = end < parts.length - 1;
    let dir = this.root;
    let links = 0;
    let i = 0;
    for (;;) {
      while (i <= end && (parts[i] === "" || parts[i] === ".")) {
        i++;
      }
      if (i > end) {
        return { parent: null, name: "", node: dir, dirTail: true };
      }
      const name = parts[i];
      if (name === "..") {
        dir = dir.parent ?? dir;
        i++;
        continue;
      }
      const node = dir.entries.get(name);
      if (i === end) {
        if (node === undefined || node.kind !== "symlink" || !(followLast || dirTail)) {
          if (dirTail && node !== undefined && node.kind !== "dir") {
            return "ENOTDIR";
          }
          return { parent: dir, name, node, dirTail };
        }
      } else if (node === undefined) {
        return "ENOENT";
      } else if (node.kind === "dir") {
        dir = node;
        i++;
        continue;
      } else if (node.kind !== "symlink") {
        return "ENOTDIR";
      }
      // `node` is a symbolic link to follow: splice its target in.
      const link = node as LinkNode;
      if (++links > MAX_LINKS) {
        return "ELOOP";
      }
      if (link.target.charCodeAt(0) === SLASH) {
        dir = this.root;
      }
      parts = link.target.split("/").concat(parts.slice(i + 1));
      end = lastComponentIndex(parts);
      dirTail = end < parts.length - 1;
      i = 0;
    }
  }

  /** `resolve`, throwing the failure as a `SystemError` for `syscall`. */
  private lookup(
    path: string,
    followLast: boolean,
    syscall: string,
    errorPath: string,
    errorDest?: string,
  ): Lookup {
    const found = this.resolve(path, followLast);
    if (typeof found === "string") {
      fail(found, syscall, errorPath, errorDest);
    }
    return found;
  }

  /** The node `path` names, or ENOENT. */
  private existing(path: string, followLast: boolean, syscall: string): Inode {
    const node = this.lookup(path, followLast, syscall, path).node;
    if (node === undefined) {
      fail("ENOENT", syscall, path);
    }
    return node;
  }

  // ---- tree edits ----

  private base(perm: number, t: number) {
    this.inodeCount++;
    return {
      ino: this.nextIno++,
      perm,
      nlink: 1,
      atimeMs: t,
      mtimeMs: t,
      ctimeMs: t,
      birthtimeMs: t,
      parent: null,
      name: "",
    };
  }

  private newDir(perm: number, t: number): DirNode {
    const node: DirNode = { kind: "dir", entries: new Map(), ...this.base(perm, t) };
    node.nlink = 2;
    return node;
  }

  private newFile(perm: number, t: number): FileNode {
    return { kind: "file", data: EMPTY_BYTES, size: 0, openCount: 0, ...this.base(perm, t) };
  }

  /** Links a newly created `node` into `parent` as `name`. */
  private addEntry(parent: DirNode, name: string, node: Inode, t: number): void {
    parent.entries.set(name, node);
    node.parent = parent;
    node.name = name;
    if (node.kind === "dir") {
      parent.nlink++;
    }
    touch(parent, t);
    this.emitEntry("rename", parent, name);
  }

  /** Removes the entry `name` (naming `node`) from `parent`, freeing the node once nothing refers to it. */
  private removeEntry(parent: DirNode, name: string, node: Inode, notify: boolean): void {
    const path = notify && this.watchers.active ? entryPath(parent, name) : null;
    const t = this.clock();
    parent.entries.delete(name);
    touch(parent, t);
    if (node.kind === "dir") {
      parent.nlink--;
      node.nlink = 0;
      node.parent = null;
      this.release(node);
    } else {
      node.nlink--;
      node.ctimeMs = t;
      if (node.parent === parent && node.name === name) {
        node.parent = null;
      }
      if (node.nlink === 0 && (node.kind !== "file" || node.openCount === 0)) {
        this.release(node);
      }
    }
    if (path !== null) {
      this.watchers.emit("rename", path);
    }
  }

  /** Removes everything below `dir`, deepest first. */
  private removeTree(dir: DirNode): void {
    // Deleting the entry being visited is safe while iterating a Map.
    for (const [name, child] of dir.entries) {
      if (child.kind === "dir") {
        this.removeTree(child);
      }
      this.removeEntry(dir, name, child, true);
    }
  }

  private release(node: Inode): void {
    this.inodeCount--;
    if (node.kind === "file") {
      this.byteCount -= node.size;
      node.size = 0;
      node.data = EMPTY_BYTES;
    }
  }

  private createDir(found: Lookup, perm: number, path: string, syscall = "mkdir"): void {
    if (found.node !== undefined || found.parent === null) {
      fail("EEXIST", syscall, path);
    }
    const t = this.clock();
    this.addEntry(found.parent, found.name, this.newDir(perm, t), t);
  }

  /**
   * `mkdir -p` the way libuv does it: try the directory, and on ENOENT make
   * its textual parent first. Returns the first directory created.
   */
  private mkdirp(path: string, perm: number, shown: string, final: boolean): string | undefined {
    const found = this.resolve(path, true);
    if (typeof found !== "string") {
      if (found.node !== undefined) {
        if (found.node.kind === "dir") {
          return undefined;
        }
        fail(final ? "EEXIST" : "ENOTDIR", "mkdir", shown);
      }
      this.createDir(found, perm, shown);
      return path;
    }
    if (found !== "ENOENT" || path === "/") {
      fail(found, "mkdir", shown);
    }
    const first = this.mkdirp(lexicalParent(path), perm, shown, false);
    const again = this.lookup(path, true, "mkdir", shown);
    if (again.node !== undefined) {
      if (again.node.kind !== "dir") {
        fail(final ? "EEXIST" : "ENOTDIR", "mkdir", shown);
      }
      return first;
    }
    this.createDir(again, perm, shown);
    return first ?? path;
  }

  // ---- node edits shared by paths and open files ----

  private writeData(node: FileNode, data: Uint8Array, position: number): void {
    if (position + data.length > MAX_FILE_SIZE) {
      fail("EFBIG", "write");
    }
    this.byteCount += writeBytes(node, data, position);
    const t = this.clock();
    node.mtimeMs = t;
    node.ctimeMs = t;
  }

  private resizeData(node: FileNode, length: number): void {
    this.byteCount += resizeBytes(node, length);
    const t = this.clock();
    node.mtimeMs = t;
    node.ctimeMs = t;
  }

  private setMode(node: Inode, mode: number): void {
    node.perm = mode & 0o7777;
    node.ctimeMs = this.clock();
  }

  private setTimes(node: Inode, atimeMs: number, mtimeMs: number): void {
    node.atimeMs = atimeMs;
    node.mtimeMs = mtimeMs;
    node.ctimeMs = this.clock();
  }

  private fileClosed(node: FileNode | DirNode): void {
    if (node.kind !== "file") {
      return;
    }
    node.openCount--;
    if (node.openCount === 0 && node.nlink === 0) {
      this.release(node);
    }
  }

  // ---- notification ----

  private emitEntry(eventType: VfsWatchEvent["eventType"], parent: DirNode, name: string): void {
    if (!this.watchers.active) {
      return;
    }
    const path = entryPath(parent, name);
    if (path !== null) {
      this.watchers.emit(eventType, path);
    }
  }

  private emitFound(eventType: VfsWatchEvent["eventType"], found: Lookup): void {
    if (found.parent !== null) {
      this.emitEntry(eventType, found.parent, found.name);
    } else if (found.node !== undefined) {
      this.emitNode(eventType, found.node);
    }
  }

  /** Reports a change to `node` at its primary link, if it still has one. */
  private emitNode(eventType: VfsWatchEvent["eventType"], node: Inode): void {
    if (!this.watchers.active) {
      return;
    }
    if (node === this.root) {
      this.watchers.emit(eventType, "/");
    } else if (node.parent !== null) {
      this.emitEntry(eventType, node.parent, node.name);
    }
  }
}

/** A file or directory opened with `Vfs.open`. */
class VfsFile implements OpenFile {
  readonly flags: number;
  private readonly node: FileNode | DirNode;
  private readonly host: FileHost;
  private offset = 0;
  private closed = false;

  constructor(node: FileNode | DirNode, flags: number, host: FileHost) {
    this.node = node;
    this.flags = flags;
    this.host = host;
  }

  read(length: number, position: number | null): Uint8Array {
    const node = this.usable("read");
    if ((this.flags & O_ACCMODE) === O_WRONLY) {
      fail("EBADF", "read");
    }
    if (node.kind === "dir") {
      fail("EISDIR", "read");
    }
    const at = position ?? this.offset;
    const bytes = readBytes(node, length, at);
    if (position === null) {
      this.offset = at + bytes.length;
    }
    node.atimeMs = this.host.now();
    return bytes;
  }

  write(data: Uint8Array, position: number | null): number {
    const node = this.usable("write");
    if ((this.flags & O_ACCMODE) === O_RDONLY || node.kind === "dir") {
      fail("EBADF", "write");
    }
    const at = (this.flags & O_APPEND) !== 0 ? node.size : (position ?? this.offset);
    if (data.length > 0) {
      this.host.write(node, data, at);
      this.host.changed(node);
    }
    if (position === null) {
      this.offset = at + data.length;
    }
    return data.length;
  }

  stat(): StatData {
    return statOf(this.usable("fstat"));
  }

  truncate(length: number): void {
    const node = this.usable("ftruncate");
    if (
      node.kind === "dir" ||
      (this.flags & O_ACCMODE) === O_RDONLY ||
      length < 0 ||
      !Number.isFinite(length)
    ) {
      fail("EINVAL", "ftruncate");
    }
    if (length > MAX_FILE_SIZE) {
      fail("EFBIG", "ftruncate");
    }
    this.host.resize(node, Math.floor(length));
    this.host.changed(node);
  }

  chmod(mode: number): void {
    const node = this.usable("fchmod");
    this.host.setMode(node, mode);
    this.host.changed(node);
  }

  utimes(atimeMs: number, mtimeMs: number): void {
    const node = this.usable("futime");
    this.host.setTimes(node, atimeMs, mtimeMs);
    this.host.changed(node);
  }

  close(): void {
    const node = this.usable("close");
    this.closed = true;
    this.host.closed(node);
  }

  private usable(syscall: string): FileNode | DirNode {
    if (this.closed) {
      fail("EBADF", syscall);
    }
    return this.node;
  }
}

/** A caller-supplied creation mode with the umask applied, or the default. */
function creationMode(mode: number, fallback: number): number {
  if (!Number.isInteger(mode) || mode < 0) {
    return fallback;
  }
  return mode & 0o7777 & ~UMASK;
}

function touch(dir: DirNode, t: number): void {
  dir.mtimeMs = t;
  dir.ctimeMs = t;
}

/** True when `dir` is `ancestor` or lies below it. */
function isWithin(dir: DirNode, ancestor: DirNode): boolean {
  let current: DirNode | null = dir;
  while (current !== null) {
    if (current === ancestor) {
      return true;
    }
    if (current.parent === current) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

/** The absolute path of a directory, or null when it is no longer in the tree. */
function dirPath(dir: DirNode): string | null {
  const names: string[] = [];
  let current = dir;
  while (current.parent !== current) {
    if (current.parent === null) {
      return null;
    }
    names.push(current.name);
    current = current.parent;
  }
  if (names.length === 0) {
    return "/";
  }
  names.reverse();
  return `/${names.join("/")}`;
}

/** The absolute path of the entry `name` in `parent`, or null when `parent` is detached. */
function entryPath(parent: DirNode, name: string): string | null {
  const base = dirPath(parent);
  if (base === null) {
    return null;
  }
  return base === "/" ? `/${name}` : `${base}/${name}`;
}
