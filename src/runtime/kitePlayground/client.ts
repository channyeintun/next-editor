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
 * part of the same program, and a run compiles them together. Which file is
 * the program is a guess with several files and none named `main.kite`, so
 * rather than run the wrong one quietly, such a workspace says so. Exported as
 * the language's `pickEntry` (runner.ts), so the studio's fixture run refuses
 * the same workspaces.
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

/** The folder part of a workspace path, "" at the root. */
function directoryOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

/**
 * The rest of the entry's module: every other `.kite` file in its directory,
 * keyed by module name — `helper`, not `helper.kite`, because that is what
 * `use` names. A file in another folder is not part of this module.
 */
function kiteModuleSiblings(
  files: readonly KitePlaygroundFile[],
  entry: KitePlaygroundFile,
): Record<string, string> {
  const directory = directoryOf(entry.path);
  return Object.fromEntries(
    files
      .filter((file) => file !== entry && directoryOf(file.path) === directory)
      .map((file) => [file.path.slice(directory.length).replace(/\.kite$/, ""), file.content]),
  );
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
 * The engine's compiler stopped partway through an operation: in practice a
 * program that grew without bound and ran the Wasm memory out, which traps out
 * of the call as a plain Error. The program's doing, not the compiler's load.
 */
class KiteOperationStoppedError extends Error {}

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
    run: (source, siblings) => Promise.race([api.run(source, siblings), failed]),
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

/** A source with its layout taken out, which is all a formatter may change. */
function withoutWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

function supersededError(): KitePlaygroundServiceError {
  return new KitePlaygroundServiceError("aborted", "Superseded by a newer operation");
}

/**
 * A run whose engine stopped partway, told as the program's own error rather
 * than a compiler that would not load: retrying the same program stops it again.
 * What it printed before is lost with the call.
 */
const STOPPED_RUN_RESULT: KitePlaygroundRunResult = {
  status: "runtime-error",
  stdout: "",
  stderr: "",
  exitDetail: "The program stopped unexpectedly — it may have run out of memory",
};

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
        return operation(engine).catch((cause: unknown) => {
          if (
            cause instanceof KiteEngineFailedError ||
            cause instanceof KitePlaygroundServiceError
          ) {
            throw cause;
          }
          // Wasm memory never shrinks, so an engine a program ran out of memory
          // is dropped rather than kept, or parked as the page's spare.
          engine.terminate();
          if (this.#engine === engine) this.#engine = null;
          throw new KiteOperationStoppedError("the compiler stopped partway", { cause });
        });
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
    const siblings = kiteModuleSiblings(request.files, entry);
    const result = await this.#exclusive((engine) => engine.run(entry.content, siblings)).catch(
      (cause: unknown) => {
        if (cause instanceof KiteOperationStoppedError) return STOPPED_RUN_RESULT;
        throw cause;
      },
    );

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
    ).catch((cause: unknown) => {
      if (cause instanceof KiteOperationStoppedError) {
        throw new KitePlaygroundServiceError(
          "invalid-source",
          "kitec stopped while formatting this program",
        );
      }
      throw cause;
    });
    // `kite_format` lays out what it can parse and silently drops what it
    // cannot: an open block comment takes the rest of the file with it. The
    // dock writes a sibling file's answer straight to the workspace, with no
    // undo, so an answer that changed more than layout is refused here, for
    // whichever engine produced it, before anything is written.
    const damaged = request.files.find(
      (file, index) => withoutWhitespace(formatted[index]) !== withoutWhitespace(file.content),
    );
    if (damaged) {
      throw new KitePlaygroundServiceError(
        "invalid-source",
        `Format would remove code from ${damaged.path}; fix the errors first`,
      );
    }
    const files = request.files.map((file, index) => ({
      path: file.path,
      content: formatted[index],
    }));

    return { files };
  }
}
