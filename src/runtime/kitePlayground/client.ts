import { wrap } from "comlink";
import { pickPlaygroundEntry, PLAYGROUND_SOURCE_RULES } from "../playgroundFiles";
import { kiteOperations, type KiteOperations } from "./operations";
import {
  parseKitePlaygroundRunResult,
  type KitePlaygroundFile,
  type KitePlaygroundFormatRequest,
  type KitePlaygroundFormatResult,
  type KitePlaygroundRunRequest,
  type KitePlaygroundRunResult,
} from "./types";

/**
 * Why a Kite tool request can fail without producing a result.
 *
 * Three of the kinds the other Playground clients carry are missing, and their
 * absence is the point: **there is no service**, so a Kite lesson cannot be
 * rate-limited, disabled or timed out by one. What is left is a source the
 * compiler will not take, a compiler that would not load, and a request a newer
 * one superseded.
 */
export type KitePlaygroundServiceErrorKind = "invalid-source" | "unavailable" | "aborted";

export class KitePlaygroundServiceError extends Error {
  readonly kind: KitePlaygroundServiceErrorKind;

  constructor(kind: KitePlaygroundServiceErrorKind, message: string) {
    super(message);
    this.name = "KitePlaygroundServiceError";
    this.kind = kind;
  }
}

/**
 * Pick the file to compile.
 *
 * A Kite module is a *directory*, so every `.kite` file beside the entry is
 * part of the same program — but the compiler running here is handed one
 * source, so a lesson with siblings would compile only part of itself. Rather
 * than compile the wrong thing quietly, a workspace with more than one file
 * and none named `main.kite` says so. Exported as the language's `pickEntry`
 * (runner.ts), so the studio's fixture run refuses the same workspaces.
 */
export function pickKiteRunEntry(files: readonly KitePlaygroundFile[]): KitePlaygroundFile {
  const { entryPath } = PLAYGROUND_SOURCE_RULES.kite;
  const entry = pickPlaygroundEntry(files, entryPath);
  if (entry === "empty") {
    throw new KitePlaygroundServiceError("invalid-source", "Add a .kite file to run this lesson");
  }
  if (entry === "ambiguous") {
    throw new KitePlaygroundServiceError(
      "invalid-source",
      `Name the file this lesson runs \`${entryPath}\` — a Kite module is a directory, and with ` +
        `${files.length} files there is no way to tell which one is the program`,
    );
  }
  return entry;
}

/**
 * Where the compiler runs: the operations of `operations.ts`, plus a way to
 * stop them. Exported so tests can hand the client a fake one.
 */
export interface KiteEngine extends KiteOperations {
  /** Stop whatever it is running, for good. */
  terminate(): void;
}

/** The engine itself died, so nothing it was asked will ever answer. */
class KiteEngineFailedError extends Error {}

/**
 * The compiler in a module worker of its own, or null where one cannot start.
 *
 * Comlink settles a call only on a reply message, so a worker whose module
 * fails after construction would leave every call pending forever. Each call
 * is raced against the worker's own death instead, the arrangement
 * `src/storage/recordingCodecClient.ts` uses.
 */
function workerKiteEngine(): KiteEngine | null {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./kite.worker.ts", import.meta.url), {
      name: "next-editor-kite",
      type: "module",
    });
  } catch {
    return null;
  }

  let fail: (error: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  failed.catch(() => {});
  const onFailure = (event: Event) => {
    worker.terminate();
    fail(
      new KiteEngineFailedError(
        event instanceof ErrorEvent && event.message
          ? event.message
          : "the compiler worker stopped",
      ),
    );
  };
  worker.addEventListener("error", onFailure);
  worker.addEventListener("messageerror", onFailure);

  const api = wrap<KiteOperations>(worker);
  return {
    load: () => Promise.race([api.load(), failed]),
    run: (source) => Promise.race([api.run(source), failed]),
    format: (sources) => Promise.race([api.format(sources), failed]),
    terminate: () => worker.terminate(),
  };
}

/**
 * A worker where the page has one, so a program that never returns can be
 * stopped; this page itself where it has none (tests, Node hosts), where a
 * synchronous Wasm call cannot be interrupted.
 */
function createKiteEngine(): KiteEngine {
  const worker =
    typeof window !== "undefined" && typeof Worker !== "undefined" ? workerKiteEngine() : null;
  return worker ?? { ...kiteOperations, terminate: () => {} };
}

/** Where a client gets an engine, and where it hands back one it no longer needs. */
export interface KiteEngineSource {
  acquire(): KiteEngine;
  /** Takes an idle engine; a busy one is terminated instead, never released. */
  release(engine: KiteEngine): void;
}

/**
 * The one idle engine kept between clients. A runner panel's client is
 * disposed at every lesson switch and unmount; parking its idle worker here
 * rather than terminating it keeps the compiler loaded for the next client —
 * only the first Run on the page pays for the load — without ever keeping more
 * than one spare thread alive.
 */
let spareEngine: KiteEngine | null = null;

const pageEngines: KiteEngineSource = {
  acquire() {
    const engine = spareEngine ?? createKiteEngine();
    spareEngine = null;
    return engine;
  },
  release(engine) {
    if (spareEngine) engine.terminate();
    else spareEngine = engine;
  },
};

function supersededError(): KitePlaygroundServiceError {
  return new KitePlaygroundServiceError("aborted", "Superseded by a newer operation");
}

function unavailableError(cause: unknown): KitePlaygroundServiceError {
  return new KitePlaygroundServiceError(
    "unavailable",
    `The Kite compiler could not be loaded (${cause instanceof Error ? cause.message : String(cause)})`,
  );
}

/**
 * One operation at a time against a compiler that runs in this page.
 *
 * No filesystem, mount, process, PTY, port, preview or teardown surface —
 * exactly like the Go, Kotlin and Rust Playground clients. It differs from them
 * in having no network either: starting a Run or Format still supersedes the
 * previous operation, so a stale answer can never land after a newer explicit
 * action, but what it cancels is a computation rather than a request. A Kite
 * program runs inside one synchronous Wasm call, so the compiler lives in a
 * worker, and superseding a busy one terminates it: that is the only thing that
 * stops a program that never returns. An idle one is kept, so repeated runs
 * never reload the compiler.
 */
export class KitePlaygroundClient {
  readonly #engines: KiteEngineSource;
  #engine: KiteEngine | null = null;
  /** Rejects the operation in flight as superseded; null while idle. */
  #supersede: (() => void) | null = null;

  /** `engines` is for tests; the default shares one spare engine across the page. */
  constructor({ engines = pageEngines }: { engines?: KiteEngineSource } = {}) {
    this.#engines = engines;
  }

  /** Abort whatever is in flight. Called on unmount and before a new action. */
  dispose(): void {
    const engine = this.#engine;
    if (!this.#supersedeInFlight() && engine) {
      this.#engine = null;
      this.#engines.release(engine);
    }
  }

  /**
   * Reject the operation in flight as superseded, terminating its engine: a
   * busy engine may be running a program that never returns, and ending its
   * thread is the only way to stop a synchronous Wasm call. Whether there was
   * one to supersede.
   */
  #supersedeInFlight(): boolean {
    const supersede = this.#supersede;
    if (!supersede) return false;
    this.#supersede = null;
    this.#engine?.terminate();
    this.#engine = null;
    supersede();
    return true;
  }

  /** Run one operation as the only one in flight, after the compiler loads. */
  async #exclusive<T>(operation: (engine: KiteEngine) => Promise<T>): Promise<T> {
    this.#supersedeInFlight();
    const engine = (this.#engine ??= this.#engines.acquire());

    let superseded = false;
    let supersede: () => void = () => {};
    const abort = new Promise<never>((_, reject) => {
      supersede = () => {
        superseded = true;
        reject(supersededError());
      };
    });
    this.#supersede = supersede;

    const work = engine.load().then(
      () => {
        if (superseded) throw supersededError();
        return operation(engine);
      },
      (cause: unknown) => {
        throw cause instanceof KiteEngineFailedError ? cause : unavailableError(cause);
      },
    );

    try {
      return await Promise.race([work, abort]);
    } catch (cause) {
      if (cause instanceof KiteEngineFailedError) {
        // A dead worker answers nothing again; the next operation starts another.
        if (this.#engine === engine) this.#engine = null;
        throw unavailableError(cause);
      }
      throw cause;
    } finally {
      if (this.#supersede === supersede) this.#supersede = null;
    }
  }

  async run(request: KitePlaygroundRunRequest): Promise<KitePlaygroundRunResult> {
    // Superseding comes first, so even a Run the client refuses replaces the
    // one before it.
    this.#supersedeInFlight();
    const entry = pickKiteRunEntry(request.files);
    const result = await this.#exclusive((engine) => engine.run(entry.content));

    const parsed = parseKitePlaygroundRunResult(result);
    if (!parsed) {
      throw new KitePlaygroundServiceError(
        "unavailable",
        "The compiler produced a result that does not match the contract",
      );
    }
    return parsed;
  }

  async format(request: KitePlaygroundFormatRequest): Promise<KitePlaygroundFormatResult> {
    this.#supersedeInFlight();
    if (request.files.length === 0) {
      throw new KitePlaygroundServiceError(
        "invalid-source",
        "Add a .kite file to format this lesson",
      );
    }

    // Every file, not just the entry: `kitec fmt` works on one file at a time
    // and a lesson's siblings deserve the same treatment as its entry.
    const formatted = await this.#exclusive((engine) =>
      engine.format(request.files.map((file) => file.content)),
    );
    const files = request.files.map((file, index) => ({
      path: file.path,
      content: formatted[index],
    }));

    return { files };
  }
}
