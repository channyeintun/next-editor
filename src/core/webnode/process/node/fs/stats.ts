// `fs.Stats` and its bigint twin, built from the backend's stat record with
// Node 22's shape: the own fields in Node's order, the Date fields as lazy
// accessors on the prototype, the `is*` checks on a shared base. Also the
// `statfs` result.
import {
  S_IFBLK,
  S_IFCHR,
  S_IFDIR,
  S_IFIFO,
  S_IFLNK,
  S_IFMT,
  S_IFREG,
  S_IFSOCK,
  type StatData,
} from "../../../kernel/vfs/types";

const dates = new WeakMap<object, Partial<Record<DateField, Date>>>();

type DateField = "atime" | "mtime" | "ctime" | "birthtime";

/** The `is*` checks both Stats kinds share (Node's `StatsBase`). */
class StatsBase {
  declare mode: number | bigint;

  isDirectory(): boolean {
    return this._checkModeProperty(S_IFDIR);
  }

  isFile(): boolean {
    return this._checkModeProperty(S_IFREG);
  }

  isBlockDevice(): boolean {
    return this._checkModeProperty(S_IFBLK);
  }

  isCharacterDevice(): boolean {
    return this._checkModeProperty(S_IFCHR);
  }

  isSymbolicLink(): boolean {
    return this._checkModeProperty(S_IFLNK);
  }

  isFIFO(): boolean {
    return this._checkModeProperty(S_IFIFO);
  }

  isSocket(): boolean {
    return this._checkModeProperty(S_IFSOCK);
  }

  _checkModeProperty(property: number): boolean {
    return (Number(this.mode) & S_IFMT) === property;
  }
}

/** `fs.Stats`. */
export class Stats extends StatsBase {
  declare dev: number;
  declare mode: number;
  declare nlink: number;
  declare uid: number;
  declare gid: number;
  declare rdev: number;
  declare blksize: number;
  declare ino: number;
  declare size: number;
  declare blocks: number;
  declare atimeMs: number;
  declare mtimeMs: number;
  declare ctimeMs: number;
  declare birthtimeMs: number;
  declare atime: Date;
  declare mtime: Date;
  declare ctime: Date;
  declare birthtime: Date;

  constructor(
    dev: number,
    mode: number,
    nlink: number,
    uid: number,
    gid: number,
    rdev: number,
    blksize: number,
    ino: number,
    size: number,
    blocks: number,
    atimeMs: number,
    mtimeMs: number,
    ctimeMs: number,
    birthtimeMs: number,
  ) {
    super();
    this.dev = dev;
    this.mode = mode;
    this.nlink = nlink;
    this.uid = uid;
    this.gid = gid;
    this.rdev = rdev;
    this.blksize = blksize;
    this.ino = ino;
    this.size = size;
    this.blocks = blocks;
    this.atimeMs = atimeMs;
    this.mtimeMs = mtimeMs;
    this.ctimeMs = ctimeMs;
    this.birthtimeMs = birthtimeMs;
  }
}

/** The `{ bigint: true }` variant: bigint fields plus nanosecond times. */
export class BigIntStats extends StatsBase {
  declare dev: bigint;
  declare mode: bigint;
  declare nlink: bigint;
  declare uid: bigint;
  declare gid: bigint;
  declare rdev: bigint;
  declare blksize: bigint;
  declare ino: bigint;
  declare size: bigint;
  declare blocks: bigint;
  declare atimeMs: bigint;
  declare mtimeMs: bigint;
  declare ctimeMs: bigint;
  declare birthtimeMs: bigint;
  declare atimeNs: bigint;
  declare mtimeNs: bigint;
  declare ctimeNs: bigint;
  declare birthtimeNs: bigint;
  declare atime: Date;
  declare mtime: Date;
  declare ctime: Date;
  declare birthtime: Date;

  constructor(
    dev: bigint,
    mode: bigint,
    nlink: bigint,
    uid: bigint,
    gid: bigint,
    rdev: bigint,
    blksize: bigint,
    ino: bigint,
    size: bigint,
    blocks: bigint,
    atimeNs: bigint,
    mtimeNs: bigint,
    ctimeNs: bigint,
    birthtimeNs: bigint,
  ) {
    super();
    this.dev = dev;
    this.mode = mode;
    this.nlink = nlink;
    this.uid = uid;
    this.gid = gid;
    this.rdev = rdev;
    this.blksize = blksize;
    this.ino = ino;
    this.size = size;
    this.blocks = blocks;
    this.atimeMs = atimeNs / 1000000n;
    this.mtimeMs = mtimeNs / 1000000n;
    this.ctimeMs = ctimeNs / 1000000n;
    this.birthtimeMs = birthtimeNs / 1000000n;
    this.atimeNs = atimeNs;
    this.mtimeNs = mtimeNs;
    this.ctimeNs = ctimeNs;
    this.birthtimeNs = birthtimeNs;
  }

  _checkModeProperty(property: number): boolean {
    return (this.mode & BigInt(S_IFMT)) === BigInt(property);
  }
}

/** Defines the lazy Date accessors (`atime` from `atimeMs` …) Node 22 puts on the prototype. */
function defineDateFields(prototype: object): void {
  for (const field of ["atime", "mtime", "ctime", "birthtime"] as const) {
    const msField = `${field}Ms`;
    Object.defineProperty(prototype, field, {
      enumerable: true,
      configurable: true,
      get(this: Record<string, number | bigint>) {
        let cache = dates.get(this);
        if (cache === undefined) {
          cache = {};
          dates.set(this, cache);
        }
        return (cache[field] ??= new Date(Math.round(Number(this[msField]))));
      },
      set(this: object, value: unknown) {
        Object.defineProperty(this, field, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      },
    });
  }
}

defineDateFields(Stats.prototype);
defineDateFields(BigIntStats.prototype);

function msToNs(ms: number): bigint {
  const whole = Math.floor(ms);
  return BigInt(whole) * 1000000n + BigInt(Math.round((ms - whole) * 1e6));
}

/** The Stats object for a backend stat record. */
export function makeStats(data: StatData, bigint: unknown): Stats | BigIntStats {
  if (bigint === true) {
    return new BigIntStats(
      BigInt(data.dev),
      BigInt(data.mode),
      BigInt(data.nlink),
      BigInt(data.uid),
      BigInt(data.gid),
      BigInt(data.rdev),
      BigInt(data.blksize),
      BigInt(data.ino),
      BigInt(data.size),
      BigInt(data.blocks),
      msToNs(data.atimeMs),
      msToNs(data.mtimeMs),
      msToNs(data.ctimeMs),
      msToNs(data.birthtimeMs),
    );
  }
  return new Stats(
    data.dev,
    data.mode,
    data.nlink,
    data.uid,
    data.gid,
    data.rdev,
    data.blksize,
    data.ino,
    data.size,
    data.blocks,
    data.atimeMs,
    data.mtimeMs,
    data.ctimeMs,
    data.birthtimeMs,
  );
}

/** The all-zero stat record `watchFile` reports for a missing file. */
export const ZERO_STAT: StatData = Object.freeze({
  dev: 0,
  ino: 0,
  mode: 0,
  nlink: 0,
  uid: 0,
  gid: 0,
  rdev: 0,
  size: 0,
  blksize: 0,
  blocks: 0,
  atimeMs: 0,
  mtimeMs: 0,
  ctimeMs: 0,
  birthtimeMs: 0,
});

/** What `fs.statfs` returns. */
export class StatFs {
  type: number | bigint;
  bsize: number | bigint;
  blocks: number | bigint;
  bfree: number | bigint;
  bavail: number | bigint;
  files: number | bigint;
  ffree: number | bigint;

  constructor(values: readonly number[], bigint: boolean) {
    const [type, bsize, blocks, bfree, bavail, files, ffree] = bigint ? values.map(BigInt) : values;
    this.type = type;
    this.bsize = bsize;
    this.blocks = blocks;
    this.bfree = bfree;
    this.bavail = bavail;
    this.files = files;
    this.ffree = ffree;
  }
}
