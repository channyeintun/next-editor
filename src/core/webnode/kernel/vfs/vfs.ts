// The in-memory filesystem the whole runtime shares: the inode tree, path
// resolution with symbolic links, POSIX errors and timestamps, permission
// checks, open files and change notification. The kernel owns the one
// instance; everything else reaches it through `VfsApi`/`OpenFile` (types.ts).
// Every call is checked as the user every process runs as, who owns every
// file but those the kernel gave to root (types.ts, `OWNER_*`, `callerBits`);
// `privileged` makes the same calls unchecked, for the page and the kernel's
// setup.
import { createSystemError, type ErrnoCode } from "../../errors";
import { DEFAULT_UMASK, umaskBits } from "../../umask";
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
import {
  compareNames,
  lastComponentIndex,
  lastPart,
  lexicalParent,
  ordersByCodePointOnly,
  trimTrailingSlashes,
} from "./path";
import { privilegedView } from "./privileged";
import {
  accessBits,
  callerBits,
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
  OWNER_R,
  OWNER_W,
  OWNER_X,
  X_OK,
  type DirEntry,
  type OpenFile,
  type PermissionedVfs,
  type StatData,
  type VfsApi,
  type VfsWatchEvent,
} from "./types";
import { WatchRegistry } from "./watchers";

export { normalizePath } from "./path";

const SLASH = 47;
/** Linux's limit on symbolic links followed while resolving one path. */
const MAX_LINKS = 40;
/** The mode a file or a directory is created with when the caller names none, before the mask. */
const DEFAULT_FILE_MODE = 0o666;
const DEFAULT_DIR_MODE = 0o777;
/** The root directory's mode. */
const ROOT_MODE = 0o755;
/** The mode mkdtemp(3) asks for, before the mask. */
const TEMP_DIR_MODE = 0o700;
/**
 * What mkdir(2) keeps of the mode it is given: the permission bits and the
 * sticky bit, never set-user-ID or set-group-ID (Linux's `S_IRWXUGO |
 * S_ISVTX`). A file keeps all twelve; chmod sets any of them.
 */
const DIR_CREATION_BITS = 0o1777;
/** What adding, removing or renaming an entry needs on its directory. */
const OWNER_WX = OWNER_W | OWNER_X;
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
/**
 * `resolve`'s answer for a path whose last part is a symbolic link, when it is
 * not asked to follow it: the link itself, slash or not. The calls that make,
 * remove or move a name look up its directory and the name in it (Linux's
 * `filename_parentat`), so a trailing slash does not follow the name there:
 * `rmdir("link/")` is ENOTDIR and `mkdir("link/")` EEXIST. A last part of `.`
 * after the name still follows it, as any directory on the way is.
 */
const ENTRY = "entry";

/**
 * How `resolve` takes a symbolic link in the path's last part: `true`
 * follows it; `false` names the link, unless a trailing slash asks for a
 * directory (lstat(2), readlink(2), `O_NOFOLLOW`); `ENTRY` names the link.
 */
type LastLink = boolean | typeof ENTRY;

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
  /** Fails with EPERM for `syscall` when the caller may not change `node`'s mode or times. */
  owned(node: Inode, syscall: string): void;
  changed(node: Inode): void;
  closed(node: FileNode | DirNode): void;
}

function fail(code: ErrnoCode, syscall: string, path?: string, dest?: string): never {
  throw createSystemError(code, syscall, path, dest);
}

/** The single in-memory filesystem: see the file comment. */
export class Vfs implements PermissionedVfs {
  readonly privileged: VfsApi;
  private readonly clock: () => number;
  private readonly root: DirNode;
  private readonly watchers = new WatchRegistry();
  private readonly host: FileHost;
  private nextIno = 1;
  private inodeCount = 0;
  private byteCount = 0;
  /** Whether calls are checked against the permission bits; off inside `privileged`. */
  private checking = true;
  /** The mask of the caller the current call creates for (`withUmask`). */
  private umask = DEFAULT_UMASK;
  /**
   * Whether a name JavaScript's own order may misplace was ever entered
   * (`ordersByCodePointOnly`): until then the built-in sort gives the names'
   * order, far faster than a comparison function.
   */
  private wideNames = false;

  constructor(options: VfsOptions = {}) {
    this.clock = options.now ?? Date.now;
    this.root = this.newDir(ROOT_MODE, this.clock());
    this.root.parent = this.root;
    this.host = {
      now: () => this.clock(),
      write: (node, data, position) => this.writeData(node, data, position),
      resize: (node, length) => this.resizeData(node, length),
      setMode: (node, mode) => this.setMode(node, mode),
      setTimes: (node, atimeMs, mtimeMs) => this.setTimes(node, atimeMs, mtimeMs),
      owned: (node, syscall) => this.owned(node, syscall),
      changed: (node) => this.emitNode("change", node),
      closed: (node) => this.fileClosed(node),
    };
    this.privileged = privilegedView(this, (run) => this.unchecked(run));
  }

  /** Runs `run` with the permission checks off and the default mask (`privileged`). */
  private unchecked<T>(run: () => T): T {
    const was = this.checking;
    const mask = this.umask;
    this.checking = false;
    this.umask = DEFAULT_UMASK;
    try {
      return run();
    } finally {
      this.checking = was;
      this.umask = mask;
    }
  }

  withUmask<T>(umask: number, create: () => T): T {
    const was = this.umask;
    this.umask = umaskBits(umask);
    try {
      return create();
    } finally {
      this.umask = was;
    }
  }

  /**
   * Fails with EACCES unless the user has every one of `bits` (`OWNER_*`) on
   * `node` (`callerBits`), as Linux's `inode_permission` does for a user who
   * is not root.
   */
  private permit(node: Inode, bits: number, syscall: string, path?: string, dest?: string): void {
    if (this.checking && (callerBits(node.perm, node.rootOwned) & bits) !== bits) {
      fail("EACCES", syscall, path, dest);
    }
  }

  /**
   * Fails with EACCES unless the user may take the entry naming `node` (none:
   * a new name) out of `parent`, as Linux's `may_delete` asks: write and
   * search on the directory. The entry of a node root owns stays, whatever
   * path reaches it: on Linux such an entry is in a directory of root's
   * (/dev in /), which the user may not change.
   */
  private mayRemove(
    parent: DirNode,
    node: Inode | undefined,
    syscall: string,
    path?: string,
    dest?: string,
  ): void {
    this.permit(parent, OWNER_WX, syscall, path, dest);
    if (this.checking && node?.rootOwned === true) {
      fail("EACCES", syscall, path, dest);
    }
  }

  /**
   * Fails with EPERM unless the user owns `node`: what chmod(2) and utimes(2)
   * with times ask (`inode_owner_or_capable`).
   */
  private owned(node: Inode, syscall: string, path?: string): void {
    if (this.checking && node.rootOwned) {
      fail("EPERM", syscall, path);
    }
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
    this.permit(node, OWNER_R, "scandir", path);
    return this.sortedNames(node).map((name) => ({
      name,
      type: (node.entries.get(name) as Inode).kind,
    }));
  }

  mkdir(path: string, recursive: boolean, mode: number, floor?: string): string | undefined {
    const perm = creationMode(mode, DEFAULT_DIR_MODE, this.umask) & DIR_CREATION_BITS;
    if (!recursive) {
      this.createDir(this.lookup(path, ENTRY, "mkdir", path), perm, path);
      return undefined;
    }
    const lowest = floor === undefined ? 0 : trimTrailingSlashes(floor).length;
    return this.mkdirp(trimTrailingSlashes(path), perm, path, lowest);
  }

  rmdir(path: string): void {
    const found = this.lookup(path, ENTRY, "rmdir", path);
    const node = found.node;
    if (node === undefined) {
      fail("ENOENT", "rmdir", path);
    }
    // As Linux, by the path's own last part: `.` cannot be removed, and `..`
    // is never empty (it holds the path walked through it).
    const last = lastPart(path);
    if (last === ".") {
      fail("EINVAL", "rmdir", path);
    }
    if (last === "..") {
      fail("ENOTEMPTY", "rmdir", path);
    }
    if (node === this.root) {
      fail("EBUSY", "rmdir", path);
    }
    if (found.parent === null) {
      fail("EINVAL", "rmdir", path);
    }
    // Linux's `may_delete`: the directory's permission first, then the kind.
    this.mayRemove(found.parent, node, "rmdir", path);
    if (node.kind !== "dir") {
      fail("ENOTDIR", "rmdir", path);
    }
    if (node.entries.size > 0) {
      fail("ENOTEMPTY", "rmdir", path);
    }
    this.removeEntry(found.parent, found.name, node, true);
  }

  unlink(path: string): void {
    const found = this.lookup(path, ENTRY, "unlink", path);
    const node = found.node;
    if (node === undefined) {
      fail("ENOENT", "unlink", path);
    }
    if (found.parent === null) {
      fail("EISDIR", "unlink", path);
    }
    // Linux's `unlinkat` with a trailing slash: no permission is asked.
    if (found.dirTail) {
      fail(node.kind === "dir" ? "EISDIR" : "ENOTDIR", "unlink", path);
    }
    this.mayRemove(found.parent, node, "unlink", path);
    if (node.kind === "dir") {
      fail("EISDIR", "unlink", path);
    }
    this.removeEntry(found.parent, found.name, node, true);
  }

  rm(path: string, recursive: boolean, force: boolean): void {
    let found = this.resolve(path, ENTRY);
    // A trailing slash after a name that is no directory. `force` passes it
    // over as what stat(2) finds missing or below no directory (`f/`, a link
    // to a file or to nothing); a link to a directory is there, but is no
    // directory itself, and is refused.
    if (
      typeof found !== "string" &&
      found.dirTail &&
      found.node !== undefined &&
      found.node.kind !== "dir"
    ) {
      const followed = found.node.kind === "symlink" ? this.resolve(path, false) : "ENOTDIR";
      if (typeof followed !== "string" && followed.node?.kind === "dir") {
        fail("ENOTDIR", "rm", path);
      }
      found = "ENOTDIR";
    }
    if (typeof found === "string") {
      // What `force` passes over as not there: a missing name, and a name
      // below something that is no directory (as GNU `rm -f` and Node's
      // rmSync take it).
      if (force && (found === "ENOENT" || found === "ENOTDIR")) {
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
      // A tree that may all go goes in one walk; else as far as it may, which
      // fails part way (see `removable`).
      if (this.checking && !removable(node)) {
        this.removeUntilRefused(node, path);
      }
      this.removeTree(node);
    } else if (found.parent === null) {
      fail("EINVAL", "rm", path);
    }
    // As Node's rm: a tree's contents go first, then its own entry, which
    // its directory may still refuse.
    this.mayRemove(found.parent, node, "rm", path);
    this.removeEntry(found.parent, found.name, node, true);
  }

  rename(from: string, to: string): void {
    const source = this.lookup(from, ENTRY, "rename", from, to);
    const node = source.node;
    if (node === undefined) {
      fail("ENOENT", "rename", from, to);
    }
    if (source.dirTail && node.kind !== "dir") {
      fail("ENOTDIR", "rename", from, to);
    }
    if (node === this.root) {
      fail("EBUSY", "rename", from, to);
    }
    if (source.parent === null) {
      fail("EINVAL", "rename", from, to);
    }
    const target = this.lookup(to, ENTRY, "rename", from, to);
    if (target.node === this.root) {
      fail("EBUSY", "rename", from, to);
    }
    if (target.parent === null) {
      fail("EINVAL", "rename", from, to);
    }
    if (target.node === node) {
      return;
    }
    // A trailing slash names a directory; only one can take that name.
    // (A last part of `.` is another case, left as it was.)
    if (target.dirTail && node.kind !== "dir" && lastPart(to) !== ".") {
      fail("ENOTDIR", "rename", from, to);
    }
    if (node.kind === "dir" && isWithin(target.parent, node)) {
      fail("EINVAL", "rename", from, to);
    }
    // Linux's rename, before it asks about any permission: a target the
    // source lies in cannot be replaced, whatever the source is.
    const replaced = target.node;
    if (replaced?.kind === "dir" && isWithin(source.parent, replaced)) {
      fail("ENOTEMPTY", "rename", from, to);
    }
    // Linux's `vfs_rename`: both directories, then the kinds, then a moved
    // directory itself (its `..` changes), then whether the target is empty.
    this.mayRemove(source.parent, node, "rename", from, to);
    this.mayRemove(target.parent, replaced, "rename", from, to);
    if (replaced !== undefined) {
      if (node.kind === "dir") {
        if (replaced.kind !== "dir") {
          fail("ENOTDIR", "rename", from, to);
        }
      } else if (replaced.kind === "dir") {
        fail("EISDIR", "rename", from, to);
      }
    }
    if (node.kind === "dir" && source.parent !== target.parent) {
      this.permit(node, OWNER_W, "rename", from, to);
    }
    if (replaced?.kind === "dir" && replaced.entries.size > 0) {
      fail("ENOTEMPTY", "rename", from, to);
    }
    const oldPath = this.watchers.active ? entryPath(source.parent, source.name) : null;
    const t = this.clock();
    if (replaced !== undefined) {
      this.removeEntry(target.parent, target.name, replaced, false);
    }
    source.parent.entries.delete(source.name);
    this.enter(target.parent, target.name, node);
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
    // Linux's order: the new name, its directory's permission, then the kind.
    const target = this.lookup(newPath, ENTRY, "link", existingPath, newPath);
    if (target.node !== undefined || target.parent === null) {
      fail("EEXIST", "link", existingPath, newPath);
    }
    if (target.dirTail) {
      fail("ENOENT", "link", existingPath, newPath);
    }
    this.permit(target.parent, OWNER_WX, "link", existingPath, newPath);
    if (node.kind === "dir") {
      fail("EPERM", "link", existingPath, newPath);
    }
    const t = this.clock();
    this.enter(target.parent, target.name, node);
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
    const found = this.lookup(path, ENTRY, "symlink", target, path);
    if (found.node !== undefined || found.parent === null) {
      fail("EEXIST", "symlink", target, path);
    }
    if (found.dirTail || target === "") {
      fail("ENOENT", "symlink", target, path);
    }
    this.permit(found.parent, OWNER_WX, "symlink", target, path);
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
    this.owned(node, "chmod", path);
    this.setMode(node, mode);
    this.emitFound("change", found);
  }

  utimes(
    path: string,
    atimeMs: number | null,
    mtimeMs: number | null,
    followSymlinks: boolean,
  ): void {
    const found = this.lookup(path, followSymlinks, "utime", path);
    if (found.node === undefined) {
      fail("ENOENT", "utime", path);
    }
    if (atimeMs === null && mtimeMs === null) {
      // utimensat(2) with both UTIME_NOW: the owner, or whoever may write the file.
      if (found.node.rootOwned) {
        this.permit(found.node, OWNER_W, "utime", path);
      }
    } else {
      this.owned(found.node, "utime", path);
    }
    this.setTimes(found.node, atimeMs, mtimeMs);
    this.emitFound("change", found);
  }

  giveToRoot(path: string): void {
    const node = this.existing(path, false, "chown");
    if (this.checking) {
      fail("EPERM", "chown", path);
    }
    node.rootOwned = true;
    node.ctimeMs = this.clock();
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
    // Node truncates by path through `open(path, 'r+')`.
    this.permit(node, OWNER_R | OWNER_W, "open", path);
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
    // libuv opens the source for reading, then the destination for writing,
    // and finds a source that is no file only when it reads it: whatever
    // refuses the destination comes first. (libuv has made or emptied the
    // destination by then and removes it; here it is left as it was.)
    this.permit(node, OWNER_R, "copyfile", source, destination);
    const exclusive = (mode & COPYFILE_EXCL) !== 0;
    const to = this.lookup(destination, !exclusive, "copyfile", source, destination);
    const existing = to.node;
    if (existing !== undefined && exclusive) {
      fail("EEXIST", "copyfile", source, destination);
    }
    if (existing === node && node.kind === "file") {
      this.permit(node, OWNER_W, "copyfile", source, destination);
      return;
    }
    if (to.parent === null || existing?.kind === "dir") {
      fail("EISDIR", "copyfile", source, destination);
    }
    if (existing === undefined && to.dirTail) {
      fail("EISDIR", "copyfile", source, destination);
    }
    /** The source's bytes, once the destination may take them. */
    const contents = (): Uint8Array => {
      if (node.kind !== "file") {
        fail("EISDIR", "copyfile", source, destination);
      }
      return node.data.subarray(0, node.size);
    };
    if (existing === undefined) {
      this.permit(to.parent, OWNER_WX, "copyfile", source, destination);
      const bytes = contents();
      const t = this.clock();
      const copy = this.newFile(node.perm, t);
      this.writeData(copy, bytes, 0);
      this.addEntry(to.parent, to.name, copy, t);
      return;
    }
    if (existing.kind !== "file") {
      fail("EINVAL", "copyfile", source, destination);
    }
    this.permit(existing, OWNER_W, "copyfile", source, destination);
    const bytes = contents();
    this.resizeData(existing, 0);
    this.writeData(existing, bytes, 0);
    this.setMode(existing, node.perm);
    this.emitFound("change", to);
  }

  access(path: string, mode: number): void {
    const node = this.existing(path, true, "access");
    if (this.checking) {
      this.permit(node, accessBits(mode), "access", path);
    } else if ((mode & X_OK) !== 0 && node.kind === "file" && (node.perm & 0o111) === 0) {
      // Unchecked is root's answer: a file runs only when some x bit is set.
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
      const found = this.resolve(path, ENTRY);
      if (typeof found === "string") {
        fail(found, "mkdtemp", shown);
      }
      if (found.node !== undefined) {
        continue;
      }
      if (found.parent === null) {
        fail("EEXIST", "mkdtemp", shown);
      }
      this.createDir(found, TEMP_DIR_MODE & ~this.umask, shown, "mkdtemp");
      return path;
    }
    return fail("EEXIST", "mkdtemp", shown);
  }

  readFile(path: string): Uint8Array {
    const node = this.existing(path, true, "open");
    this.permit(node, OWNER_R, "open", path);
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
      // A new file is not checked against its own mode, only its directory.
      this.permit(found.parent, OWNER_WX, "open", path);
      const t = this.clock();
      node = this.newFile(creationMode(mode, DEFAULT_FILE_MODE, this.umask), t);
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
        this.permit(node, OWNER_R, "open", path);
      } else {
        if ((flags & O_DIRECTORY) !== 0) {
          fail("ENOTDIR", "open", path);
        }
        this.permit(node, openBits(flags), "open", path);
        // O_TRUNC always truncates, as on Linux: even an empty file gets new
        // times and a change event (a "touch by empty write").
        if ((flags & O_TRUNC) !== 0) {
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
    // inotify needs read permission on what it watches.
    this.permit(node, OWNER_R, "watch", path);
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
   * intermediate component, and in the last one as `followLast` says
   * (`LastLink`). `..` is resolved physically, after
   * links. Returns the errno code on failure rather than throwing, so cheap
   * probes like `exists` build no Error.
   *
   * When checking, every directory a name (`.` and `..` included) is looked
   * up in must be searchable, as Linux's `may_lookup` requires before each
   * component: `/` alone, and a trailing `/`, look nothing up.
   */
  private resolve(path: string, followLast: LastLink): Lookup | ErrnoCode {
    if (path.length === 0) {
      return "ENOENT";
    }
    if (path.charCodeAt(0) !== SLASH) {
      return "EINVAL";
    }
    const checking = this.checking;
    let parts = path.split("/");
    let end = lastComponentIndex(parts);
    let dirTail = end < parts.length - 1;
    let dir = this.root;
    let links = 0;
    let i = 0;
    for (;;) {
      while (i <= end && (parts[i] === "" || parts[i] === ".")) {
        if (checking && parts[i] === "." && !searchable(dir)) {
          return "EACCES";
        }
        i++;
      }
      if (i > end) {
        // Only `` and `.` are left; a `.` is looked up in `dir`.
        if (checking && !searchable(dir) && parts.includes(".", i)) {
          return "EACCES";
        }
        return { parent: null, name: "", node: dir, dirTail: true };
      }
      if (checking && !searchable(dir)) {
        return "EACCES";
      }
      const name = parts[i];
      if (name === "..") {
        dir = dir.parent ?? dir;
        i++;
        continue;
      }
      const node = dir.entries.get(name);
      if (i === end) {
        // `name/.` looks `.` up in `name`, as in any directory on the way.
        const dotAfter = dirTail && parts.includes(".", end + 1);
        const follow =
          node !== undefined &&
          node.kind === "symlink" &&
          (followLast === true || (dirTail && followLast === false) || dotAfter);
        if (!follow) {
          // The calls that name an entry decide what a bare trailing slash
          // after a name that is no directory means.
          if (
            dirTail &&
            node !== undefined &&
            node.kind !== "dir" &&
            (followLast !== ENTRY || dotAfter)
          ) {
            return "ENOTDIR";
          }
          // `name/.` needs the directory `name` there, and searchable.
          if (dotAfter && (node === undefined || (checking && !searchable(node)))) {
            return node === undefined ? "ENOENT" : "EACCES";
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
    followLast: LastLink,
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
      rootOwned: false,
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

  /** Sets the entry `name` of `parent` to `node`: the one place a name comes into the tree. */
  private enter(parent: DirNode, name: string, node: Inode): void {
    parent.entries.set(name, node);
    this.wideNames ||= ordersByCodePointOnly(name);
  }

  /**
   * The names in `dir` in the order it lists them: by code point (path.ts,
   * `compareNames`), on both filesystems.
   */
  private sortedNames(dir: DirNode): string[] {
    const names = [...dir.entries.keys()];
    return this.wideNames ? names.sort(compareNames) : names.sort();
  }

  /** Links a newly created `node` into `parent` as `name`. */
  private addEntry(parent: DirNode, name: string, node: Inode, t: number): void {
    this.enter(parent, name, node);
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

  /**
   * Removes what is below `dir` up to the first entry the permissions refuse,
   * then fails with EACCES naming `path`, for a tree `removable` said no to:
   * as Node's rm (std::filesystem::remove_all on Linux) walks, entry by entry
   * in the order readdir lists them (`sortedNames`), a directory's contents
   * before its own entry. Opening a directory needs read on it and search on
   * its parent; removing an entry, write and search on its directory. A loop
   * over the directories the walk is in, so that a deep tree costs no stack.
   */
  private removeUntilRefused(top: DirNode, path: string): void {
    this.permit(top, OWNER_R, "rm", path);
    /** A directory the walk is in, its names in order, and how many are done. */
    const levels = [{ dir: top, names: this.sortedNames(top), done: 0 }];
    while (levels.length > 0) {
      const level = levels[levels.length - 1];
      if (level.done === level.names.length) {
        // Emptied: its own entry goes, the one its directory came to last.
        levels.pop();
        if (levels.length > 0) {
          const above = levels[levels.length - 1];
          this.mayRemove(above.dir, level.dir, "rm", path);
          this.removeEntry(above.dir, above.names[above.done - 1], level.dir, true);
        }
        continue;
      }
      const name = level.names[level.done++];
      const child = level.dir.entries.get(name) as Inode;
      if (child.kind === "dir") {
        this.permit(level.dir, OWNER_X, "rm", path);
        this.permit(child, OWNER_R, "rm", path);
        levels.push({ dir: child, names: this.sortedNames(child), done: 0 });
        continue;
      }
      this.mayRemove(level.dir, child, "rm", path);
      this.removeEntry(level.dir, name, child, true);
    }
  }

  /**
   * Removes everything below `top`, deepest first, each directory's entries
   * in the order they were made. A loop over the directories the walk is in,
   * so that a deep tree costs no stack.
   */
  private removeTree(top: DirNode): void {
    /** A directory the walk is in, its name in the one above, and its entries still to go. */
    const levels = [{ dir: top, name: "", rest: top.entries.entries() }];
    while (levels.length > 0) {
      const level = levels[levels.length - 1];
      const next = level.rest.next();
      if (next.done === true) {
        // Emptied: its own entry goes. (Deleting the entry an iterator is at
        // is safe in a Map.)
        levels.pop();
        if (levels.length > 0) {
          this.removeEntry(levels[levels.length - 1].dir, level.name, level.dir, true);
        }
        continue;
      }
      const [name, child] = next.value;
      if (child.kind === "dir") {
        levels.push({ dir: child, name, rest: child.entries.entries() });
      } else {
        this.removeEntry(level.dir, name, child, true);
      }
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
    this.permit(found.parent, OWNER_WX, syscall, path);
    const t = this.clock();
    this.addEntry(found.parent, found.name, this.newDir(perm, t), t);
  }

  /** Whether `path` itself (its last part, not followed) is a symbolic link. */
  private isLink(path: string): boolean {
    const found = this.resolve(path, ENTRY);
    return typeof found !== "string" && found.node?.kind === "symlink";
  }

  /**
   * `mkdir -p` the way libuv does it: try the directory, and on ENOENT make
   * its textual parent first. Returns the first directory created. Two
   * loops, up to the first ancestor that resolves and back down making each
   * one, so that a long path costs no stack. Nothing `floor` characters
   * long or shorter is made (`VfsApi.mkdir`): ENOENT instead.
   */
  private mkdirp(path: string, perm: number, shown: string, floor: number): string | undefined {
    /** The paths still to make, the requested one first. */
    const pending: string[] = [];
    let first: string | undefined;
    for (let current = path; ; current = lexicalParent(current)) {
      const found = this.resolve(current, true);
      if ((typeof found === "string" || found.node === undefined) && this.isLink(current)) {
        // A symbolic link that leads nowhere: mkdir(2) does not make its
        // target, so `mkdir -p` stops here, as on Linux.
        fail("EEXIST", "mkdir", shown);
      }
      if (typeof found !== "string") {
        if (found.node === undefined) {
          if (current.length <= floor) {
            fail("ENOENT", "mkdir", shown);
          }
          this.createDir(found, perm, shown);
          first = current;
        } else if (found.node.kind !== "dir") {
          fail(pending.length === 0 ? "EEXIST" : "ENOTDIR", "mkdir", shown);
        }
        break;
      }
      if (found !== "ENOENT" || current === "/") {
        fail(found, "mkdir", shown);
      }
      pending.push(current);
    }
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const again = this.lookup(next, true, "mkdir", shown);
      if (again.node === undefined) {
        this.createDir(again, perm, shown);
        first ??= next;
      } else if (again.node.kind !== "dir") {
        fail(pending.length === 0 ? "EEXIST" : "ENOTDIR", "mkdir", shown);
      }
    }
    return first;
  }

  // ---- node edits shared by paths and open files ----

  private writeData(node: FileNode, data: Uint8Array, position: number): void {
    if (position + data.length > MAX_FILE_SIZE) {
      fail("EFBIG", "write");
    }
    // Node rejects such a position before it gets here; refused before the
    // buffer grows, as sharedfs does.
    if (position < 0 || !Number.isInteger(position)) {
      fail("EINVAL", "write");
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

  /** Sets the times, null to now; the change time is now. */
  private setTimes(node: Inode, atimeMs: number | null, mtimeMs: number | null): void {
    const t = this.clock();
    node.atimeMs = atimeMs ?? t;
    node.mtimeMs = mtimeMs ?? t;
    node.ctimeMs = t;
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
    this.host.owned(node, "fchmod");
    this.host.setMode(node, mode);
    this.host.changed(node);
  }

  utimes(atimeMs: number, mtimeMs: number): void {
    const node = this.usable("futime");
    this.host.owned(node, "futime");
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

/**
 * The owner bits opening an existing file with `flags` needs: its access mode
 * (the reserved mode 3 asks for both, as on Linux), and write to truncate.
 */
function openBits(flags: number): number {
  const accmode = flags & O_ACCMODE;
  let bits = accmode === O_RDONLY ? OWNER_R : accmode === O_WRONLY ? OWNER_W : OWNER_R | OWNER_W;
  if ((flags & O_TRUNC) !== 0) {
    bits |= OWNER_W;
  }
  return bits;
}

/**
 * Whether `rm -r` may remove everything below `dir`, as Node's rm does it
 * (std::filesystem::remove_all): it opens every directory, which needs read,
 * and removes each entry, which needs write and search on its directory and
 * is never one of a node root owns (`mayRemove`). When
 * it may not, the walk (`removeUntilRefused`) is refused somewhere: at the
 * first directory it may not open, or the first entry it may not remove. A
 * loop over the directories still to look at, so that a deep tree costs no
 * stack.
 */
function removable(top: DirNode): boolean {
  const pending = [top];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    const bits = callerBits(dir.perm, dir.rootOwned);
    if ((bits & OWNER_R) === 0) {
      return false;
    }
    if (dir.entries.size > 0 && (bits & OWNER_WX) !== OWNER_WX) {
      return false;
    }
    for (const child of dir.entries.values()) {
      if (child.rootOwned) {
        return false;
      }
      if (child.kind === "dir") {
        pending.push(child);
      }
    }
  }
  return true;
}

/**
 * The mode something is created with: the caller's `mode`, or `fallback`
 * when that is no mode, less the permission bits of `umask`.
 */
function creationMode(mode: number, fallback: number, umask: number): number {
  const asked = Number.isInteger(mode) && mode >= 0 ? mode & 0o7777 : fallback;
  return asked & ~umask;
}

/** Whether the user may look names up in `node` (search, `OWNER_X`). */
function searchable(node: Inode): boolean {
  return (callerBits(node.perm, node.rootOwned) & OWNER_X) !== 0;
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
