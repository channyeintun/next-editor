// The kernel's entries for large ES modules (process/loader/preparedEntry.ts).
// A process asks where a file's entry is (`module.prepared`). The kernel
// answers with one it has: in the filesystem already, or kept between visits
// by the editor's page (preparedStorage.ts), which it reaches through
// `PagePreparedStore`. For a file it has none for, the process rewrites the
// file itself, as it always did, and the kernel has the entry made a while
// later, for the next visit.
//
// Why the kernel has them made, and a second time at that: an entry outlives
// the project that made it, and a process runs the project's code. So the
// kernel reads the file itself, names the entry by a SHA-256 of what it read,
// and hands those same bytes to a worker it starts for nothing else
// (`prepareInWorker`, process/loader/prepareWorker.ts), which runs only the
// runtime's own code: an entry is always the rewrite of exactly the source
// its key names, whatever a process wrote where. And the entries are kept on
// the editor's origin, which nothing a project runs can reach: a process
// cannot put one there.
//
// Why a while later: the rewrite of a large file takes tens of megabytes of
// heap, and the browser gives no heap back once a worker has used it. Made
// while the project's processes start, that heap would add to theirs (a first
// visit measured 70 to 100 MB higher). A minute on, their heaps have shrunk,
// and the rewrite fits in what they let go. Why in a worker of its own: the
// kernel answers every process, and a rewrite would hold it for a third of a
// second.
import { PREPARED_DIR, decodePreparedEntry, isPreparable } from "../process/loader/preparedEntry";
import type { KernelEvent } from "../protocol";
import type { KernelWorker } from "./kernel";
import { O_CREAT, O_TRUNC, O_WRONLY, S_IFMT, S_IFREG } from "./vfs/types";
import type { VfsApi } from "./vfs/types";

/** Where entries are kept between visits. */
export interface PreparedStore {
  /** The entry kept under `key`; null when there is none, or the store does not answer. */
  get(key: string): Promise<Uint8Array | null>;
  /** Keeps `entry` under `key`. */
  put(key: string, entry: Uint8Array): void;
}

/** How long the page has to answer for an entry before the process rewrites the file instead. */
const PAGE_ANSWER_MS = 1500;
/** How long after the last module was asked for the waiting entries are made. */
const MAKE_AFTER_MS = 60_000;
/** How long a worker has to make one entry. */
const MAKE_WITHIN_MS = 60_000;
/**
 * How long the worker stays after its last entry. Ended at once, the heap its
 * rewrites used stays the runtime's for the rest of the session; left idle,
 * the browser shrinks that heap first (it does within some thirty seconds),
 * and gives it back.
 */
const WORKER_STAYS_MS = 45_000;

/** What makes entries. */
export interface EntryMaker {
  /** The entry of `filename` from its `source`; null for a source that cannot be rewritten. One at a time. */
  make(filename: string, source: Uint8Array): Promise<Uint8Array | null>;
  /** Nothing more is asked of it. */
  stop(): void;
}

/**
 * Makes entries in a worker of their own: the process script, sent a
 * `prepare` request where a process is sent `init`. The worker is started for
 * the first entry and ended a while after the last.
 */
export function prepareInWorker(createWorker: (name: string) => KernelWorker): EntryMaker {
  let worker: KernelWorker | null = null;
  let leaving: ReturnType<typeof setTimeout> | null = null;
  const end = () => {
    if (leaving !== null) {
      clearTimeout(leaving);
      leaving = null;
    }
    worker?.terminate();
    worker = null;
  };
  return {
    make: (filename, source) =>
      new Promise((resolve) => {
        if (leaving !== null) {
          clearTimeout(leaving);
          leaving = null;
        }
        const working = (worker ??= createWorker("webnode prepare"));
        const late = setTimeout(() => {
          end();
          resolve(null);
        }, MAKE_WITHIN_MS);
        working.onmessage = (event) => {
          if (event.data.type === "prepared") {
            clearTimeout(late);
            leaving = setTimeout(end, WORKER_STAYS_MS);
            resolve(event.data.entry);
          }
        };
        working.onerror = (event) => {
          event.preventDefault?.();
          clearTimeout(late);
          end();
          resolve(null);
        };
        working.postMessage({ type: "prepare", filename, source }, [source.buffer as ArrayBuffer]);
      }),
    stop: end,
  };
}

/** The page's store (preparedStorage.ts), asked over the kernel's events and answered by a request. */
export class PagePreparedStore implements PreparedStore {
  private readonly emit: (event: KernelEvent) => void;
  private readonly version: string;
  private readonly waiting = new Map<number, (entry: Uint8Array | null) => void>();
  private nextAsk = 1;

  /** `version` names the entries this build reads (`PREPARED_VERSION`): the page keeps no others. */
  constructor(emit: (event: KernelEvent) => void, version: string) {
    this.emit = emit;
    this.version = version;
  }

  get(key: string): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      const ask = this.nextAsk++;
      // A page busy with its own work answers late: the module is rewritten instead.
      const timer = setTimeout(() => this.answer(ask, null), PAGE_ANSWER_MS);
      this.waiting.set(ask, (entry) => {
        clearTimeout(timer);
        resolve(entry);
      });
      this.emit({ event: "prepared-get", ask, version: this.version, key });
    });
  }

  put(key: string, entry: Uint8Array): void {
    this.emit({ event: "prepared-put", version: this.version, key, entry });
  }

  /** The page's answer to `ask`. */
  answer(ask: number, entry: Uint8Array | null): void {
    const done = this.waiting.get(ask);
    this.waiting.delete(ask);
    done?.(entry);
  }
}

const encoder = new TextEncoder();

/**
 * The key of the entry for `source` read from `filename`: a SHA-256 of both
 * (the prepared code names its file), in hex. Not a quick hash: two sources
 * with one key would let a project choose what another project runs. The
 * name goes in with its length, so no other name and source spell the same
 * bytes.
 */
async function entryKey(filename: string, source: Uint8Array): Promise<string> {
  const path = encoder.encode(filename);
  const name = encoder.encode(`${path.length}:${filename}`);
  const material = new Uint8Array(name.length + source.length);
  material.set(name);
  material.set(source, name.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class PreparedModules {
  private readonly vfs: VfsApi;
  private readonly store: PreparedStore | null;
  private readonly maker: EntryMaker;
  private readonly makeAfterMs: number;
  /** What each file was answered with, by the file's identity: looked for once a session. */
  private readonly located = new Map<string, Promise<string | null>>();
  /** The files whose entries are to be made, by identity. */
  private readonly toMake = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private making = false;
  private disposed = false;

  /**
   * `vfs` unchecked: the entries are the kernel's own files. `store` is where
   * they are kept between visits; with none (null) no file has an entry.
   * `maker` makes one, `makeAfterMs` after the last module was asked for.
   */
  constructor(
    vfs: VfsApi,
    store: PreparedStore | null,
    maker: EntryMaker,
    makeAfterMs: number = MAKE_AFTER_MS,
  ) {
    this.vfs = vfs;
    this.store = store;
    this.maker = maker;
    this.makeAfterMs = makeAfterMs;
  }

  /** Nothing more is made. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.toMake.clear();
    this.maker.stop();
  }

  /**
   * The path of the entry for ES module file `filename`: null, at once, for a
   * file that gets none; else the entry's path once it is in the filesystem,
   * or null when the kernel has none yet (the process then rewrites the file
   * itself, and the entry is made for the next visit).
   */
  locate(filename: string): Promise<string | null> | null {
    const identity = this.store === null ? null : this.identityOf(filename);
    if (identity === null) {
      return null;
    }
    let found = this.located.get(identity);
    if (!found) {
      found = this.find(filename, identity).catch(() => null);
      this.located.set(identity, found);
    }
    return found;
  }

  /** What tells one state of file `filename` from another; null for a file that gets no entry. */
  private identityOf(filename: string): string | null {
    try {
      const stat = this.vfs.stat(filename, true);
      return (stat.mode & S_IFMT) === S_IFREG && isPreparable(filename, stat.size)
        ? `${filename}\n${stat.ino}\n${stat.mtimeMs}\n${stat.size}`
        : null;
    } catch {
      return null;
    }
  }

  private async find(filename: string, identity: string): Promise<string | null> {
    const key = await entryKey(filename, this.vfs.readFile(filename));
    const path = `${PREPARED_DIR}/${key}`;
    if (this.vfs.exists(path)) {
      return path;
    }
    const kept = (await this.store?.get(key)) ?? null;
    if (kept !== null && decodePreparedEntry(kept) !== null) {
      this.write(path, kept);
      return path;
    }
    if (!this.disposed) {
      this.toMake.set(identity, filename);
      // From the last one asked for: a program is still loading until then.
      if (this.timer !== null) {
        clearTimeout(this.timer);
      }
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.makeWaiting();
      }, this.makeAfterMs);
    }
    return null;
  }

  private write(path: string, entry: Uint8Array): void {
    this.vfs.mkdir(PREPARED_DIR, true, 0o755);
    this.vfs.writeFile(path, entry, O_WRONLY | O_CREAT | O_TRUNC, 0o444);
  }

  /** Makes the waiting entries, one after another. */
  private async makeWaiting(): Promise<void> {
    if (this.making) {
      return;
    }
    this.making = true;
    try {
      for (;;) {
        const next = this.toMake.entries().next();
        if (next.done) {
          return;
        }
        const [identity, filename] = next.value;
        this.toMake.delete(identity);
        try {
          await this.make(filename, identity);
        } catch {
          // A file that cannot be read or rewritten gets no entry.
        }
      }
    } finally {
      this.making = false;
    }
  }

  /** Makes the entry of `filename`, if the file is still the one that was asked about. */
  private async make(filename: string, identity: string): Promise<void> {
    if (this.identityOf(filename) !== identity) {
      return;
    }
    // A copy: the key and the entry are of the same bytes, whatever is written meanwhile.
    const source = this.vfs.readFile(filename).slice();
    const key = await entryKey(filename, source);
    const path = `${PREPARED_DIR}/${key}`;
    const entry = await this.maker.make(filename, source);
    if (this.disposed || entry === null || decodePreparedEntry(entry) === null) {
      return;
    }
    this.write(path, entry);
    this.store?.put(key, entry);
    // A process that starts later in this session reads it too.
    this.located.set(identity, Promise.resolve(path));
  }
}
