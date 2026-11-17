// @vitest-environment node
// Several worker threads on one memory, as webnode runs it: each builds its own
// SharedFs on the same module and memory and calls it at the same time as the
// others. Nothing may be lost or torn, nobody may deadlock, and retiring a
// worker in the middle of its calls must never leave the lock held.
//
// The main thread only waits on messages while workers run, so a deadlock
// fails the watchdog instead of hanging the run; it calls the filesystem
// itself only once every worker has stopped.
//
// Not covered: a trap poisoning the filesystem. Nothing outside the module can
// make it trap, and it has no test-only export to do so.
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../kernel/vfs/types";
import { OFFSET } from "./abi";
import { createSharedFilesystem, type SharedFilesystem } from "./boot";

const WRITE = O_WRONLY | O_CREAT | O_TRUNC;
/** Bytes of one record a worker appends to the shared log: its number, repeated. */
const RECORD = 16;

/**
 * The worker's program. Node runs the TypeScript sources itself (type
 * stripping); the hook adds the `.ts` the engine's imports leave out.
 */
const WORKER_SOURCE = `
const { registerHooks } = require("node:module");
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error;
      return next(specifier + ".ts", context);
    }
  },
});
const { parentPort, workerData } = require("node:worker_threads");
import(workerData.url).then(({ SharedFs }) => {
  const { role, index, entry, stop, progress } = workerData;
  const fs = new SharedFs({
    module: workerData.module,
    memory: workerData.memory,
    now: Date.now,
    entry,
    deliversEvents: role === "kernel",
  });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  // The kernel stops last, so it drains what the others logged to the end.
  const stopped = () => Atomics.load(stop, role === "kernel" ? 1 : 0) !== 0;
  const tick = () => Atomics.add(progress, index, 1);
  // Races between workers make some calls fail; only filesystem errors may.
  const tolerate = (call) => {
    try {
      return call();
    } catch (error) {
      if (typeof error?.code !== "string" || error.code === "EIO") throw error;
      return undefined;
    }
  };

  if (role === "kernel") {
    let logChanges = 0;
    let overflowed = false;
    fs.watch("/shared", true, (event) => {
      if (event.path === "/shared/log" && event.eventType === "change") logChanges++;
      if (event.path === "/shared") overflowed = true;
    });
    while (!stopped()) {
      fs.drainEvents();
      tolerate(() => fs.readdir("/shared/t"));
      tick();
    }
    fs.drainEvents();
    parentPort.postMessage({ logChanges, overflowed });
    return;
  }

  if (role === "spinner") {
    let announced = false;
    for (let i = 0; ; i++) {
      fs.stat("/", true);
      fs.writeFile("/spin/" + index, encoder.encode(String(i)), ${WRITE}, 0o644);
      tolerate(() => fs.rename("/spin/" + index, "/spin/" + index + ".moved"));
      fs.readdir("/spin");
      if (!announced) {
        announced = true;
        parentPort.postMessage("running");
      }
    }
  }

  // "hammer": its own subtree, the shared log, and churn in a shared subtree.
  const own = "/w" + index;
  fs.mkdir(own, true, 0o777);
  const record = new Uint8Array(${RECORD}).fill(index);
  const last = {};
  let writes = 0;
  let appends = 0;
  for (let n = 0; !stopped(); n++) {
    const name = own + "/f" + (n % 23);
    const content = index + ":" + writes;
    fs.writeFile(name, encoder.encode(content), ${WRITE}, 0o644);
    last[name] = content;
    writes++;
    if (decoder.decode(fs.readFile(name)) !== content) throw new Error("read back " + name);
    fs.writeFile("/shared/log", record, ${O_WRONLY | O_CREAT} | 0o2000, 0o644);
    appends++;
    if (!workerData.churn) {
      tick();
      continue;
    }
    const r = (n * 7 + index) % 5;
    const s = (n * 3 + index) % 5;
    tolerate(() => fs.mkdir("/shared/t/" + r + "/deep/er", true, 0o777));
    tolerate(() => fs.writeFile("/shared/t/" + r + "/deep/x", encoder.encode(content), ${WRITE}, 0o644));
    tolerate(() => fs.symlink("../" + s, "/shared/t/" + r + "/link"));
    tolerate(() => fs.rename("/shared/t/" + r, "/shared/t/" + s + "/moved"));
    tolerate(() => fs.stat("/shared/t/" + s + "/moved/link/deep", true));
    tolerate(() => fs.readdir("/shared/t/" + s));
    if (n % 3 === 0) tolerate(() => fs.rm("/shared/t/" + s, true, false));
    const file = fs.open(own + "/handle", ${O_WRONLY | O_CREAT}, 0o644);
    file.write(encoder.encode(content), 0);
    tolerate(() => fs.rename(own + "/handle", own + "/handle.old"));
    file.close();
    tick();
  }
  parentPort.postMessage({ writes, appends, last });
}).catch((error) => {
  parentPort.postMessage({ error: String(error?.stack ?? error) });
});
`;

interface HammerReport {
  writes: number;
  appends: number;
  last: Record<string, string>;
}

interface Run {
  shared: SharedFilesystem;
  stop: Int32Array;
  progress: Int32Array;
}

function startRun(): Run {
  const shared = createSharedFilesystem();
  if (shared === null) {
    throw new Error("this engine cannot make the shared filesystem");
  }
  shared.fs.mkdir("/shared/t", true, 0o777);
  shared.fs.mkdir("/spin", false, 0o777);
  return {
    shared,
    stop: new Int32Array(new SharedArrayBuffer(8)),
    progress: new Int32Array(new SharedArrayBuffer(4 * 64)),
  };
}

/** A worker running WORKER_SOURCE, and its first message (or its failure). */
function spawn(
  run: Run,
  role: "hammer" | "kernel" | "spinner",
  index: number,
  options: { churn?: boolean } = {},
): { worker: Worker; slot: number; message: Promise<unknown> } {
  const entry = role === "kernel" ? undefined : run.shared.admit();
  if (entry === null) {
    throw new Error("no free slot");
  }
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      url: new URL("./sharedFs.ts", import.meta.url).href,
      module: run.shared.module,
      memory: run.shared.memory,
      entry,
      role,
      index,
      churn: options.churn ?? false,
      stop: run.stop,
      progress: run.progress,
    },
  });
  const message = new Promise<unknown>((resolve, reject) => {
    worker.once("message", (value: unknown) => {
      const failed = (value as { error?: string } | null)?.error;
      if (failed !== undefined) {
        reject(new Error(`worker ${role} ${index}: ${failed}`));
      } else {
        resolve(value);
      }
    });
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`worker ${role} ${index} exited with ${code}`)));
  });
  // A test that fails first terminates the workers it no longer waits for.
  message.catch(() => {});
  return { worker, slot: entry?.slot ?? -1, message };
}

/** `promise`, or a failure naming `what` once `ms` pass: a deadlock fails instead of hanging. */
async function watchdog<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`deadlock: ${what} did not finish in ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until every one of `indexes` made progress, which a held lock would stop. */
async function expectProgress(run: Run, indexes: readonly number[], what: string): Promise<void> {
  const before = indexes.map((index) => Atomics.load(run.progress, index));
  // Only a hang must fail this: a loaded machine may take seconds to make progress.
  const deadline = Date.now() + 30_000;
  while (indexes.some((index, i) => Atomics.load(run.progress, index) === before[i])) {
    if (Date.now() > deadline) {
      throw new Error(`deadlock: no progress ${what}`);
    }
    await sleep(1);
  }
}

/** The lock word: once every worker stopped it must be free, or the main thread would block. */
function lockWord(run: Run): number {
  return Atomics.load(
    new Int32Array(run.shared.memory.buffer),
    (run.shared.fs.base + OFFSET.lock) / 4,
  );
}

/** Checks the shared log holds every record each hammer appended, whole. */
function expectLog(run: Run, reports: readonly HammerReport[], first: number): void {
  const log = run.shared.fs.readFile("/shared/log");
  const total = reports.reduce((sum, report) => sum + report.appends, 0);
  expect(log.length).toBe(total * RECORD);
  const counts = new Map<number, number>();
  for (let at = 0; at < log.length; at += RECORD) {
    const owner = log[at];
    for (let i = 1; i < RECORD; i++) {
      if (log[at + i] !== owner) {
        throw new Error(`torn record at ${at}`);
      }
    }
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  reports.forEach((report, i) => expect(counts.get(first + i) ?? 0).toBe(report.appends));
}

describe("SharedFs across worker threads", () => {
  it("loses nothing while five workers and a kernel call it at once", async () => {
    const run = startRun();
    const kernel = spawn(run, "kernel", 0);
    const hammers: ReturnType<typeof spawn>[] = [];
    try {
      // Events are logged only once the kernel watches.
      await expectProgress(run, [0], "before the kernel watched");
      for (let index = 1; index <= 5; index++) {
        hammers.push(spawn(run, "hammer", index, { churn: true }));
      }
      await sleep(500);
      await expectProgress(run, [0, 1, 2, 3, 4, 5], "while hammering");
      await sleep(2500);
      Atomics.store(run.stop, 0, 1);
      const reports = (await watchdog(
        Promise.all(hammers.map((hammer) => hammer.message)),
        30_000,
        "the hammers",
      )) as HammerReport[];
      Atomics.store(run.stop, 1, 1);
      const events = (await watchdog(kernel.message, 30_000, "the kernel")) as {
        logChanges: number;
        overflowed: boolean;
      };
      expect(lockWord(run)).toBe(0);
      expect(run.shared.fs.check()).toBe(0);
      for (const report of reports) {
        expect(report.writes).toBeGreaterThan(100);
        for (const [path, content] of Object.entries(report.last)) {
          expect(new TextDecoder().decode(run.shared.fs.readFile(path))).toBe(content);
        }
      }
      expectLog(run, reports, 1);
      // One change event per append, from every worker: none lost, the log never full.
      expect(events.overflowed).toBe(false);
      expect(events.logChanges).toBe(reports.reduce((sum, report) => sum + report.appends, 0));
    } finally {
      Atomics.store(run.stop, 0, 1);
      Atomics.store(run.stop, 1, 1);
      await Promise.all([...hammers, kernel].map(({ worker }) => worker.terminate()));
    }
  }, 60_000);

  it("retires spinning workers hundreds of times without leaving the lock held", async () => {
    const run = startRun();
    const steady = Array.from({ length: 3 }, (_, i) => spawn(run, "hammer", i + 1));
    const spinners: Worker[] = [];
    let retired = 0;
    // How each retirement went: both ways of retiring must have been taken.
    const outcomes = { outside: 0, inside: 0, abandoned: 0 };
    try {
      await expectProgress(run, [1, 2, 3], "before retiring");
      for (let wave = 0; wave < 50; wave++) {
        const batch = Array.from({ length: 4 }, (_, i) => spawn(run, "spinner", 10 + i));
        spinners.push(...batch.map(({ worker }) => worker));
        await watchdog(
          Promise.all(batch.map(({ message }) => message)),
          30_000,
          `spinner wave ${wave}`,
        );
        await sleep(wave % 5);
        const exits = batch.map(({ worker, slot }) => {
          const exited = new Promise((resolve) => worker.once("exit", resolve));
          outcomes[run.shared.retire(slot, () => void worker.terminate())]++;
          retired++;
          return exited;
        });
        await watchdog(Promise.all(exits), 30_000, `retiring wave ${wave}`);
        await expectProgress(run, [1, 2, 3], `after retiring wave ${wave}`);
      }
      Atomics.store(run.stop, 0, 1);
      const reports = (await watchdog(
        Promise.all(steady.map((worker) => worker.message)),
        30_000,
        "the steady workers",
      )) as HammerReport[];
      expect(retired).toBe(200);
      // A spinner is nearly always inside a call; a test in which none was
      // would prove nothing about retiring one that is.
      expect(outcomes.inside).toBeGreaterThanOrEqual(20);
      expect(outcomes.abandoned).toBe(0);
      expect(lockWord(run)).toBe(0);
      expect(run.shared.fs.check()).toBe(0);
      expectLog(run, reports, 1);
      for (const report of reports) {
        for (const [path, content] of Object.entries(report.last)) {
          expect(new TextDecoder().decode(run.shared.fs.readFile(path))).toBe(content);
        }
      }
      // Every retired slot was freed for the next process.
      const admitted = Array.from({ length: 1021 }, () => run.shared.admit());
      expect(admitted.every((entry) => entry !== null)).toBe(true);
    } finally {
      Atomics.store(run.stop, 0, 1);
      await Promise.all(
        [...steady.map(({ worker }) => worker), ...spinners].map((worker) => worker.terminate()),
      );
    }
  }, 120_000);
});
