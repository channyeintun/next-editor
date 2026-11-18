// @vitest-environment node
// The shared filesystem against the reference (kernel/vfs/vfs.ts), on random
// operation sequences: every call's result or error, the clock reads, the
// watch events, and at intervals the whole tree, must be the same on both.
// Names come from a small alphabet so collisions, links, renames into each
// other and deep trees are common. A failing sequence is shrunk and printed.
//
// It runs twice: on the kernel's instance, and the way a process works
// (processBackend.ts): paths on an instance of its own in a slot, open files
// and watches on the kernel's, which is told when events were left for it.
//
// Modes are random too, so the permission checks refuse many calls: every
// EACCES must be the same on both. What a step took bits away from is asked
// for again and again afterwards, itself and what it holds, so that each
// check is the one thing that decides some call. Some steps are made through
// the `privileged` view (the page's, unchecked), which also opens up what
// earlier modes closed; the trees are compared through it.
//
// Some nodes are given to root (`giveToRoot`), mostly through the unchecked
// view, so that what the others' bits allow and the owner alone may do
// (chmod, utimes) is compared on them too.
//
// Masks are random as well: many steps are made as a caller with a file mode
// creation mask of its own (`withUmask`), so that what each side creates under
// it, and what its bits then refuse, is compared too.
import { isDeepStrictEqual } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SystemError } from "../errors";
import {
  O_APPEND,
  O_CREAT,
  O_DIRECTORY,
  O_EXCL,
  O_NOFOLLOW,
  O_RDONLY,
  O_RDWR,
  O_TRUNC,
  O_WRONLY,
  type OpenFile,
  type PermissionedVfs,
  type VfsApi,
} from "../kernel/vfs/types";
import { Vfs } from "../kernel/vfs/vfs";
import { createSharedFilesystem, type SharedFilesystem } from "./boot";
import { SharedFs } from "./sharedFs";

const SEQUENCES = 4000;
const STEPS = 80;
/** Walk and compare both trees every this many steps. */
const WALK_EVERY = 15;

const encoder = new TextEncoder();

/** A seeded generator (mulberry32): the same seed gives the same sequence. */
class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(below: number): number {
    return Math.floor(this.next() * below);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  chance(percent: number): boolean {
    return this.int(100) < percent;
  }
}

// Astral (😀) and high-BMP (ｱ) names sort differently as UTF-8 bytes (and by
// code point) than as JavaScript strings: both filesystems list and remove by
// code point.
const NAMES = ["a", "b", "c", "a", "b", "é", "😀", "ｱ"];
const SPECIAL_COMPONENTS = [".", "..", ""];

const MODES = [0o777, 0o644, 0o700, 0o755, 0o4755, -1, NaN, 1.5, 2 ** 40 + 0o755, 0o20000000000];
const CHMOD_MODES = [
  0o600,
  0o755,
  0o7777,
  0,
  -1,
  NaN,
  2 ** 33 + 5,
  1.9,
  0o555,
  0o311,
  0o644,
  0o444,
  0o222,
];
/**
 * Modes that take reading, writing or searching away, one or two at a time:
 * a directory that can be searched but not changed, changed but not listed,
 * and so on. What a step sets one of these on is remembered (`Paths.closed`).
 */
const CLOSING_MODES = [0o555, 0o555, 0o500, 0o311, 0o300, 0o444, 0o400, 0o100, 0o666, 0o222, 0];
/** What a privileged chmod sets, to open up what the random modes closed. */
const OPEN_MODES = [0o755, 0o777, 0o700];
/**
 * Masks a step is made under: usual ones, ones that take the owner's own
 * bits off what is created, and numbers that are no mask, of which both
 * sides must keep the same permission bits.
 */
const UMASKS = [
  0o077,
  0o027,
  0o002,
  0,
  0o022,
  0o277,
  0o300,
  0o111,
  0o777,
  0o7022,
  -1,
  NaN,
  1.5,
  2 ** 32 + 0o077,
];
const TIMES = [0, -5, 1.5, NaN, Infinity, -Infinity, 1e15, -0];
/** A path's times may also be null (now), which needs only write permission when both are. */
const PATH_TIMES = [...TIMES, null, null, null, null, null, null];
const LENGTHS = [-1, NaN, 1.5, 0, 1, 3, 7, 100, 2 ** 32 + 1, Infinity, -Infinity];
const TRUNCATE_LENGTHS = [-1, NaN, Infinity, 0, 1, 2.7, 5, 1000, 2 ** 32 + 1];
const READ_POSITIONS = [null, null, 0, 1, 2, 1.5, -1, -3, NaN, 1000, Infinity, -Infinity];
/** Positions vfs.ts handles as defined behaviour; others are below (NEGATIVE_POSITIONS). */
const WRITE_POSITIONS = [null, null, null, 0, 1, 3, 7, 40, 2 ** 32, 2 ** 33, Infinity];
/** Node rejects these before they reach a filesystem; both refuse them with EINVAL. */
const NEGATIVE_POSITIONS = [-1, -4];
const ACCESS_MODES = [0, 1, 2, 4, 7, -1, NaN];
const COPY_MODES = [0, 1, 3, -1, 2];
const ACCMODES = [O_RDONLY, O_WRONLY, O_RDWR, 3];
const FLAG_BITS = [O_CREAT, O_EXCL, O_TRUNC, O_APPEND, O_DIRECTORY, O_NOFOLLOW];

/** The paths a sequence named so far, and those of them a step meant to make into each kind. */
interface Paths {
  any: string[];
  file: string[];
  dir: string[];
  link: string[];
  /** Those a step set a closing mode on. */
  closed: string[];
}

type Made = "file" | "dir" | "link";

/**
 * A path: often one the sequence used before (one meant to be a `kind`, when
 * given), or a child of one, so that operations meet what earlier ones made;
 * otherwise a new one, remembered.
 */
function pickPath(random: Random, paths: Paths, kind?: Made): string {
  if (paths.closed.length > 0 && random.chance(15)) {
    // What the permission checks decide: something closed, or an entry of it.
    const closed = random.pick(paths.closed);
    return random.chance(35) ? closed : `${closed === "/" ? "" : closed}/${random.pick(NAMES)}`;
  }
  if (kind !== undefined && paths[kind].length > 0 && random.chance(60)) {
    return random.pick(paths[kind]);
  }
  if (paths.any.length > 0 && random.chance(50)) {
    const known = random.pick(paths.any);
    if (random.chance(25)) {
      return `${known === "/" ? "" : known}/${random.pick(NAMES)}`;
    }
    return known;
  }
  const path = freshPath(random);
  paths.any.push(path);
  return path;
}

/** `pickPath` for a step that makes a `kind` there. */
function pickNew(random: Random, paths: Paths, kind: Made): string {
  const path = pickPath(random, paths);
  paths[kind].push(path);
  return path;
}

function freshPath(random: Random): string {
  const roll = random.int(100);
  if (roll < 2) {
    return "";
  }
  const relative = roll < 5;
  const depth = random.int(3) + (roll < 15 ? 0 : 1);
  const parts: string[] = [];
  for (let i = 0; i < depth; i++) {
    parts.push(random.chance(12) ? random.pick(SPECIAL_COMPONENTS) : random.pick(NAMES));
  }
  let path = relative ? parts.join("/") : `/${parts.join("/")}`;
  if (random.chance(8)) {
    path += "/";
  } else if (random.chance(4)) {
    path += "/.";
  }
  return path;
}

function pickTarget(random: Random, paths: Paths): string {
  if (random.chance(3)) {
    return "";
  }
  const path = pickPath(random, paths);
  // Relative targets resolve from the link's directory.
  return random.chance(50) && path.startsWith("/") ? path.slice(1) || "." : path;
}

/** What `writeFile` is usually given (`fs.writeFileSync`, with and without `flag: "a"`). */
const WRITE_FLAGS = [O_WRONLY | O_CREAT | O_TRUNC, O_WRONLY | O_CREAT | O_APPEND];

function pickFlags(random: Random): number {
  if (random.chance(3)) {
    return random.pick([-1, 2 ** 32 + O_CREAT + O_RDWR, NaN]);
  }
  let flags = random.pick(ACCMODES);
  for (const bit of FLAG_BITS) {
    if (random.chance(bit === O_CREAT ? 55 : 15)) {
      flags |= bit;
    }
  }
  return flags;
}

function pickData(random: Random): string {
  if (random.chance(5)) {
    return "x".repeat(3000 + random.int(3000));
  }
  return "0123456789abcdefghij".slice(0, random.int(21));
}

/** One operation, as plain data so a failing sequence can be replayed and shrunk. */
interface Step {
  op: string;
  args: (string | number | boolean | null)[];
  /** Made through the unchecked view, as the page's requests are. */
  privileged?: boolean;
  /** Made as a caller with this file mode creation mask (`withUmask`). */
  umask?: number;
}

/** The operations that can make a file or a directory, whose mode a mask cuts. */
const CREATING = ["writeFile", "mkdir", "mkdtemp", "open"];

function pickStep(random: Random, paths: Paths): Step {
  const step = pickCheckedStep(random, paths);
  // A path call made as the page makes it; the descriptor and watch calls stay
  // checked (the page opens no descriptors).
  if (!step.op.startsWith("file.") && step.op !== "unwatch" && random.chance(12)) {
    step.privileged = true;
  }
  // Under a mask: the calls that create mostly, any other now and then (a
  // mask changes nothing of theirs), a privileged one too (it keeps the
  // default mask).
  if (random.chance(CREATING.includes(step.op) ? 45 : 5)) {
    step.umask = random.pick(UMASKS);
  }
  if (random.chance(4)) {
    return {
      op: "chmod",
      args: [pickPath(random, paths), random.pick(OPEN_MODES), true],
      privileged: true,
    };
  }
  if (random.chance(3)) {
    return { op: "giveToRoot", args: [pickPath(random, paths)], privileged: random.chance(70) };
  }
  return step;
}

function pickCheckedStep(random: Random, paths: Paths): Step {
  const path = (kind?: Made) => pickPath(random, paths, kind);
  const made = (kind: Made) => pickNew(random, paths, kind);
  /** The second path of a two-path step: now and then the first again. */
  const other = (first: string, pick: () => string) => (random.chance(8) ? first : pick());
  const step = (op: string, ...args: Step["args"]): Step => ({ op, args });
  const closing = random.int(100);
  if (closing < 6) {
    const closed = path();
    paths.closed.push(closed);
    return step("chmod", closed, random.pick(CLOSING_MODES), true);
  }
  if (closing < 9) {
    return step("rm", path(random.chance(60) ? "dir" : undefined), true, random.chance(50));
  }
  const roll = random.int(100);
  if (roll < 9) {
    const flags = random.chance(70) ? random.pick(WRITE_FLAGS) : pickFlags(random);
    return step("writeFile", made("file"), pickData(random), flags, random.pick(MODES));
  }
  if (roll < 17) {
    const dir = made("dir");
    // Now and then with a floor: the text up to one of its slashes.
    const slashes = [...dir.matchAll(/\//g)].map((match) => match.index);
    const floor = random.chance(30) ? dir.slice(0, random.pick(slashes) + 1) : null;
    return step("mkdir", dir, random.chance(50), random.pick(MODES), floor);
  }
  if (roll < 23) return step("symlink", pickTarget(random, paths), made("link"));
  if (roll < 29) {
    const from = path();
    return step("rename", from, other(from, path));
  }
  if (roll < 32) {
    const existing = path("file");
    return step(
      "link",
      existing,
      other(existing, () => made("file")),
    );
  }
  if (roll < 36) return step("stat", path(), random.chance(50));
  if (roll < 38) return step("exists", path());
  if (roll < 41) return step("readdir", path("dir"));
  if (roll < 43) return step("rmdir", path("dir"));
  if (roll < 46) return step("unlink", path("file"));
  if (roll < 49) return step("rm", path(), random.chance(50), random.chance(50));
  if (roll < 51) return step("readlink", path("link"));
  if (roll < 53) return step("realpath", path());
  if (roll < 55) return step("chmod", path(), random.pick(CHMOD_MODES), random.chance(50));
  if (roll < 57) {
    return step(
      "utimes",
      path(),
      random.pick(PATH_TIMES),
      random.pick(PATH_TIMES),
      random.chance(50),
    );
  }
  if (roll < 59) return step("truncate", path("file"), random.pick(TRUNCATE_LENGTHS));
  if (roll < 61) {
    const source = path("file");
    const destination = other(source, () => made("file"));
    return step("copyFile", source, destination, random.pick(COPY_MODES));
  }
  if (roll < 62) return step("access", path(), random.pick(ACCESS_MODES));
  if (roll < 64) return step("mkdtemp", path("dir"), random.int(2 ** 30));
  if (roll < 67) return step("readFile", path("file"));
  if (roll < 74) return step("open", path("file"), pickFlags(random), random.pick(MODES));
  if (roll < 77) {
    return step("file.read", random.int(8), random.pick(LENGTHS), random.pick(READ_POSITIONS));
  }
  if (roll < 82) {
    const negative = random.chance(10);
    const position = negative ? random.pick(NEGATIVE_POSITIONS) : random.pick(WRITE_POSITIONS);
    return step("file.write", random.int(8), pickData(random), position);
  }
  if (roll < 84) return step("file.stat", random.int(8));
  if (roll < 86) return step("file.truncate", random.int(8), random.pick(TRUNCATE_LENGTHS));
  if (roll < 87) return step("file.chmod", random.int(8), random.pick(CHMOD_MODES));
  if (roll < 88) return step("file.utimes", random.int(8), random.pick(TIMES), random.pick(TIMES));
  if (roll < 92) return step("file.close", random.int(8));
  if (roll < 96) return step("watch", path(), random.chance(50));
  return step("unwatch", random.int(4));
}

/** One filesystem under test, with its clock and what its watches saw. */
interface Side {
  fs: PermissionedVfs & { totals(): { inodes: number; bytes: number } };
  clock: { reads: number };
  files: OpenFile[];
  stops: (() => void)[];
  events: string[];
}

interface Pair {
  reference: Side;
  shared: Side;
  sharedFs: SharedFs;
}

/**
 * How often each operation succeeded, failed, and was refused (EACCES) on
 * both sides, and how often it succeeded under a mask of its own.
 */
const outcomes = new Map<string, { ok: number; failed: number; refused: number; masked: number }>();

/** What `crypto.getRandomValues` gives mkdtemp: two values, so names collide often. */
let mkdtempRandom = new Random(1);

/** Whose instance makes the path calls: the kernel's own, or a process's. */
type Caller = "kernel" | "process";

/**
 * The shared filesystem as a process has it: the path operations on its own
 * instance, entered through a slot; `open` and `watch` on the kernel's. After
 * a call that left events in an empty log the kernel is told, as the
 * `fs.changed` message does, and delivers them.
 */
function processView(booted: SharedFilesystem, now: () => number): Side["fs"] {
  const entry = booted.admit();
  if (entry === null) {
    throw new Error("no free slot");
  }
  const own = new SharedFs({
    module: booted.module,
    memory: booted.memory,
    now,
    entry,
    deliversEvents: false,
  });
  const kernel = booted.fs;
  return new Proxy(own, {
    get(target, key) {
      if (key === "open" || key === "watch") {
        return Reflect.get(kernel, key).bind(kernel);
      }
      // A process has no unchecked calls: the page's go to the kernel.
      if (key === "privileged") {
        return kernel.privileged;
      }
      // The kernel opens a process's files under the process's mask.
      if (key === "withUmask") {
        return <T>(umask: number, create: () => T): T =>
          target.withUmask(umask, () => kernel.withUmask(umask, create));
      }
      const member: unknown = Reflect.get(target, key);
      if (typeof member !== "function") {
        return member;
      }
      return (...args: unknown[]): unknown => {
        try {
          return member.apply(target, args);
        } finally {
          if (target.takeEventsPending()) {
            kernel.drainEvents();
          }
        }
      };
    },
  });
}

function makePair(caller: Caller): Pair {
  const referenceClock = { reads: 0 };
  const sharedClock = { reads: 0 };
  const now = () => ++sharedClock.reads;
  const booted = createSharedFilesystem({ now });
  if (booted === null) {
    throw new Error("this engine cannot make the shared filesystem");
  }
  const side = (fs: Side["fs"], clock: { reads: number }): Side => ({
    fs,
    clock,
    files: [],
    stops: [],
    events: [],
  });
  return {
    reference: side(new Vfs({ now: () => ++referenceClock.reads }), referenceClock),
    shared: side(caller === "process" ? processView(booted, now) : booted.fs, sharedClock),
    sharedFs: booted.fs,
  };
}

/** Runs one step on one side and returns what it gave: a value, or what it threw. */
function apply(side: Side, step: Step, watchId: number): unknown {
  return step.umask === undefined
    ? applyCall(side, step, watchId)
    : side.fs.withUmask(step.umask, () => applyCall(side, step, watchId));
}

function applyCall(side: Side, step: Step, watchId: number): unknown {
  const fs = step.privileged === true ? side.fs.privileged : side.fs;
  const a = step.args;
  const file = () => side.files[(a[0] as number) % side.files.length];
  switch (step.op) {
    case "writeFile":
      return fs.writeFile(
        a[0] as string,
        encoder.encode(a[1] as string),
        a[2] as number,
        a[3] as number,
      );
    case "mkdir":
      return fs.mkdir(
        a[0] as string,
        a[1] as boolean,
        a[2] as number,
        (a[3] as string | null) ?? undefined,
      );
    case "symlink":
      return fs.symlink(a[0] as string, a[1] as string);
    case "rename":
      return fs.rename(a[0] as string, a[1] as string);
    case "link":
      return fs.link(a[0] as string, a[1] as string);
    case "stat":
      return fs.stat(a[0] as string, a[1] as boolean);
    case "exists":
      return fs.exists(a[0] as string);
    case "readdir":
      return fs.readdir(a[0] as string);
    case "rmdir":
      return fs.rmdir(a[0] as string);
    case "unlink":
      return fs.unlink(a[0] as string);
    case "rm":
      return fs.rm(a[0] as string, a[1] as boolean, a[2] as boolean);
    case "readlink":
      return fs.readlink(a[0] as string);
    case "realpath":
      return fs.realpath(a[0] as string);
    case "chmod":
      return fs.chmod(a[0] as string, a[1] as number, a[2] as boolean);
    case "utimes":
      return fs.utimes(
        a[0] as string,
        a[1] as number | null,
        a[2] as number | null,
        a[3] as boolean,
      );
    case "giveToRoot":
      return fs.giveToRoot(a[0] as string);
    case "truncate":
      return fs.truncate(a[0] as string, a[1] as number);
    case "copyFile":
      return fs.copyFile(a[0] as string, a[1] as string, a[2] as number);
    case "access":
      return fs.access(a[0] as string, a[1] as number);
    case "mkdtemp":
      mkdtempRandom = new Random(a[1] as number);
      return fs.mkdtemp(a[0] as string);
    case "readFile":
      return fs.readFile(a[0] as string);
    case "open": {
      const opened = fs.open(a[0] as string, a[1] as number, a[2] as number);
      side.files.push(opened);
      return { flags: opened.flags };
    }
    case "file.read":
      return file().read(a[1] as number, a[2] as number | null);
    case "file.write":
      return file().write(encoder.encode(a[1] as string), a[2] as number | null);
    case "file.stat":
      return file().stat();
    case "file.truncate":
      return file().truncate(a[1] as number);
    case "file.chmod":
      return file().chmod(a[1] as number);
    case "file.utimes":
      return file().utimes(a[1] as number, a[2] as number);
    case "file.close":
      return file().close();
    case "watch": {
      side.stops.push(
        fs.watch(a[0] as string, a[1] as boolean, (event) =>
          side.events.push(`${watchId} ${event.eventType} ${event.path}`),
        ),
      );
      return undefined;
    }
    case "unwatch":
      return side.stops[(a[0] as number) % side.stops.length]();
    default:
      throw new Error(`unknown step ${step.op}`);
  }
}

/** A step that needs an open file or a watch when there is none does nothing. */
function applicable(pair: Pair, step: Step): boolean {
  if (step.op.startsWith("file.")) {
    return pair.reference.files.length > 0;
  }
  return step.op !== "unwatch" || pair.reference.stops.length > 0;
}

/** The fields of a thrown error that must match, or a marker for a non-system error. */
function describeError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return { thrown: String(error) };
  }
  const { code, errno, syscall, path, dest } = error as SystemError;
  if (typeof code !== "string") {
    return { notSystemError: error.constructor.name };
  }
  return { code, errno, syscall, path, dest, message: error.message };
}

function attempt(side: Side, step: Step, watchId: number): { value?: unknown; error?: unknown } {
  try {
    return { value: apply(side, step, watchId) };
  } catch (error) {
    return { error: describeError(error) };
  }
}

function join(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

/**
 * Compares both trees from the root: listings, lstat, link targets, contents,
 * totals. Through the unchecked views, so that the modes hide nothing.
 */
function compareTrees(pair: Pair): string | null {
  const reference = pair.reference.fs.privileged;
  const shared = pair.shared.fs.privileged;
  const pending = ["/"];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    const probes: [string, (fs: VfsApi) => unknown][] = [
      [`readdir ${dir}`, (fs) => fs.readdir(dir)],
    ];
    const listing = reference.readdir(dir);
    for (const entry of listing) {
      const path = join(dir, entry.name);
      probes.push([`lstat ${path}`, (fs) => fs.stat(path, false)]);
      if (entry.type === "symlink") {
        probes.push([`readlink ${path}`, (fs) => fs.readlink(path)]);
      } else if (entry.type === "file") {
        probes.push([`readFile ${path}`, (fs) => fs.readFile(path)]);
      } else {
        pending.push(path);
      }
    }
    for (const [label, probe] of probes) {
      const left = attemptProbe(reference, probe);
      const right = attemptProbe(shared, probe);
      if (!isDeepStrictEqual(left, right)) {
        return `${label}: ${show(left)} vs ${show(right)}`;
      }
    }
  }
  const totals = [pair.reference.fs.totals(), pair.shared.fs.totals()];
  if (!isDeepStrictEqual(totals[0], totals[1])) {
    return `totals: ${show(totals[0])} vs ${show(totals[1])}`;
  }
  if (pair.sharedFs.check() !== 0) {
    return "fs_check() reports an inconsistent heap or tree";
  }
  return null;
}

function attemptProbe(fs: VfsApi, probe: (fs: VfsApi) => unknown): unknown {
  try {
    return { value: probe(fs) };
  } catch (error) {
    return { error: describeError(error) };
  }
}

/** Runs `steps` on a fresh pair and returns the first difference, or null. */
function run(steps: readonly Step[], caller: Caller): { at: number; difference: string } | null {
  const pair = makePair(caller);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!applicable(pair, step)) {
      continue;
    }
    const left = attempt(pair.reference, step, i);
    const right = attempt(pair.shared, step, i);
    if (!isDeepStrictEqual(left, right)) {
      return { at: i, difference: `result: ${show(left)} vs ${show(right)}` };
    }
    if (pair.reference.clock.reads !== pair.shared.clock.reads) {
      return {
        at: i,
        difference: `clock reads: ${pair.reference.clock.reads} vs ${pair.shared.clock.reads}`,
      };
    }
    if (!isDeepStrictEqual(pair.reference.events, pair.shared.events)) {
      return {
        at: i,
        difference: `events: ${show(pair.reference.events)} vs ${show(pair.shared.events)}`,
      };
    }
    const tally = outcomes.get(step.op) ?? { ok: 0, failed: 0, refused: 0, masked: 0 };
    tally[left.error === undefined ? "ok" : "failed"]++;
    if (left.error === undefined && step.umask !== undefined && step.privileged !== true) {
      tally.masked++;
    }
    if ((left.error as { code?: string } | undefined)?.code === "EACCES") {
      tally.refused++;
    }
    outcomes.set(step.op, tally);
    pair.reference.events.length = 0;
    pair.shared.events.length = 0;
    if ((i + 1) % WALK_EVERY === 0 || i === steps.length - 1) {
      const difference = compareTrees(pair);
      if (difference !== null) {
        return { at: i, difference: `tree: ${difference}` };
      }
    }
  }
  return null;
}

/** Drops steps one at a time while the sequence still fails, so what is printed is short. */
function shrink(steps: Step[], caller: Caller): Step[] {
  let current = steps;
  for (let changed = true; changed;) {
    changed = false;
    for (let i = current.length - 1; i >= 0; i--) {
      const shorter = [...current.slice(0, i), ...current.slice(i + 1)];
      if (run(shorter, caller) !== null) {
        current = shorter;
        changed = true;
      }
    }
  }
  return current;
}

function show(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "number" && (!Number.isFinite(item) || Object.is(item, -0))) {
      return Object.is(item, -0) ? "-0" : String(item);
    }
    if (item instanceof Uint8Array) {
      return `bytes[${Array.from(item).join(",")}]`;
    }
    return item === undefined ? "undefined" : item;
  });
}

function sequence(seed: number): Step[] {
  const random = new Random(seed);
  const paths: Paths = { any: [], file: [], dir: [], link: [], closed: [] };
  return Array.from({ length: STEPS }, () => pickStep(random, paths));
}

describe("SharedFs against Vfs", () => {
  beforeAll(() => {
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        const bytes = array as unknown as Uint8Array;
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = mkdtempRandom.int(2);
        }
        return array;
      },
    );
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it.each<Caller>(["kernel", "process"])(
    `agrees on ${SEQUENCES} random sequences of ${STEPS} operations, called by the %s`,
    (caller) => {
      outcomes.clear();
      for (let seed = 1; seed <= SEQUENCES; seed++) {
        const steps = sequence(seed);
        const failed = run(steps, caller);
        if (failed !== null) {
          const minimal = shrink(steps.slice(0, failed.at + 1), caller);
          const last = run(minimal, caller);
          const lines = minimal.map(
            (step, i) =>
              `  ${i}: ${step.privileged ? "privileged " : ""}${step.op}${show(step.args)}${
                step.umask === undefined ? "" : ` under umask ${show(step.umask)}`
              }`,
          );
          throw new Error(
            `seed ${seed} differs at step ${last?.at}: ${last?.difference}\n${lines.join("\n")}`,
          );
        }
      }
      const operations = [
        "stat",
        "exists",
        "readdir",
        "mkdir",
        "rmdir",
        "unlink",
        "rm",
        "rename",
        "link",
        "symlink",
        "readlink",
        "realpath",
        "chmod",
        "utimes",
        "giveToRoot",
        "truncate",
        "copyFile",
        "access",
        "mkdtemp",
        "readFile",
        "writeFile",
        "open",
        "watch",
        "unwatch",
        "file.read",
        "file.write",
        "file.stat",
        "file.truncate",
        "file.chmod",
        "file.utimes",
        "file.close",
      ];
      for (const op of operations) {
        expect(outcomes.get(op)?.ok ?? 0, `${op} succeeded`).toBeGreaterThan(50);
        // Only these two cannot fail: every other operation's errors were compared too.
        const canFail = op !== "exists" && op !== "unwatch";
        expect(outcomes.get(op)?.failed ?? 0, `${op} failed`).toBeGreaterThan(canFail ? 50 : -1);
        // Every path operation was refused by the permission checks too. An
        // open file is checked when it is opened, not after.
        const canBeRefused = canFail && !op.startsWith("file.");
        expect(outcomes.get(op)?.refused ?? 0, `${op} refused`).toBeGreaterThan(
          canBeRefused ? 10 : -1,
        );
        // Each call that creates did so under masks of its own, many times.
        expect(outcomes.get(op)?.masked ?? 0, `${op} under a mask`).toBeGreaterThan(
          CREATING.includes(op) ? 500 : -1,
        );
      }
    },
    600_000,
  );
});
