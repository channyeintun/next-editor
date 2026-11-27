import { wrap } from "comlink";
import { PLAYGROUND_SOURCE_RULES } from "../playgroundFiles";
import type { PlaygroundRunTerminal } from "../playgroundLanguage";
import { explainWorkerStartFailure } from "../playgroundWorker";
import { findPythonRunEntry } from "./files";
import { PYTHON_MAX_RUN_MS, PYTHON_STOPPED_DETAIL, PYTHON_TIME_LIMIT_DETAIL } from "./interpreter";
import { createPythonOperations, type PythonOperations } from "./operations";
import {
  openPythonTerminal,
  type PythonTerminalLink,
  type PythonTerminalView,
} from "./terminalMemory";
import {
  parsePythonPlaygroundRunResult,
  type PythonPlaygroundFile,
  type PythonPlaygroundRunRequest,
  type PythonPlaygroundRunResult,
} from "./types";

/**
 * Why a Python run can fail without producing a result.
 *
 * As with Kite and assembly, the kinds a proxied client carries for a service
 * are missing, because there is none: a Python lesson cannot be rate-limited,
 * disabled or timed out by one. What is left is a workspace with no script to
 * start from, an interpreter that would not load, a page too old to start one
 * (its worker's script is gone from the server since a deploy: trying again
 * cannot work, a reload does), and a run a newer one superseded.
 */
export type PythonPlaygroundServiceErrorKind =
  | "invalid-source"
  | "unavailable"
  | "outdated"
  | "aborted";

export class PythonPlaygroundServiceError extends Error {
  readonly kind: PythonPlaygroundServiceErrorKind;

  constructor(kind: PythonPlaygroundServiceErrorKind, message: string) {
    super(message);
    this.name = "PythonPlaygroundServiceError";
    this.kind = kind;
  }
}

/**
 * Pick the script a run starts from.
 *
 * Which file is the program is a guess with several scripts and none named
 * `main.py`, so rather than run the wrong one quietly, such a workspace says
 * so. Exported as the language's `pickEntry` (runner.ts), so the studio's
 * fixture run refuses the same workspaces.
 */
export function pickPythonRunEntry(files: readonly PythonPlaygroundFile[]): PythonPlaygroundFile {
  const { entryPath } = PLAYGROUND_SOURCE_RULES.python;
  const entry = findPythonRunEntry(files);
  if (entry === "empty") {
    throw new PythonPlaygroundServiceError("invalid-source", "Add a .py file to run this lesson");
  }
  if (entry === "ambiguous") {
    throw new PythonPlaygroundServiceError(
      "invalid-source",
      `Name the file this lesson runs \`${entryPath}\` — with several .py files there is no ` +
        "way to tell which one is the program",
    );
  }
  return entry;
}

/**
 * One interpreter and a way to end it: the operations of `operations.ts`, plus
 * `terminate`. Exported so tests can hand the client a fake one.
 */
export interface PythonEngine extends PythonOperations {
  /**
   * Whether the interpreter runs off this thread, so a program on it can block
   * until the learner has typed a line without freezing the page. Only such an
   * engine is given a terminal's memory.
   */
  readonly offThread?: boolean;
  /** Stop whatever it is running, for good, and free the interpreter. */
  terminate(): void;
}

/** The engine itself died, so nothing it was asked will ever answer. */
class PythonEngineFailedError extends Error {}

/**
 * The engine never started, and never will from this page: its worker's script
 * is no longer on the server. Exported so tests can make a fake engine fail
 * this way.
 */
export class PythonEngineOutdatedError extends Error {}

/**
 * An interpreter in a module worker of its own, or null where one cannot start.
 *
 * Comlink settles a call only on a reply message, so a worker whose module
 * fails after construction would leave every call pending forever. Each call
 * is raced against the worker's own death instead, the arrangement the Kite
 * client uses.
 *
 * A worker that dies before it has answered anything never ran its script:
 * the script could not be loaded. Why is asked of the app's server
 * (playgroundWorker.ts), since the two reasons call for different advice.
 */
function workerPythonEngine(): PythonEngine | null {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./python.worker.ts", import.meta.url), {
      name: "next-editor-python",
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
  /** The worker has answered a call, so its script loaded and ran. */
  let answered = false;
  const onFailure = (event: Event) => {
    worker.terminate();
    const message =
      event instanceof ErrorEvent && event.message
        ? event.message
        : "the interpreter worker stopped";
    if (answered) {
      fail(new PythonEngineFailedError(message));
      return;
    }
    void explainWorkerStartFailure().then((why) =>
      fail(
        why === "outdated"
          ? new PythonEngineOutdatedError("the interpreter worker's script is gone")
          : new PythonEngineFailedError(message),
      ),
    );
  };
  worker.addEventListener("error", onFailure);
  worker.addEventListener("messageerror", onFailure);

  const api = wrap<PythonOperations>(worker);
  /** A call to the worker: its answer, or the worker's death, whichever is first. */
  const ask = <Answer>(call: Promise<Answer>): Promise<Answer> => {
    const noteAnswer = () => {
      answered = true;
    };
    call.then(noteAnswer, noteAnswer);
    return Promise.race([call, failed]);
  };
  return {
    offThread: true,
    load: () => ask(api.load()),
    run: (files, entryPath, terminalMemory) => ask(api.run(files, entryPath, terminalMemory)),
    terminate: () => worker.terminate(),
  };
}

/**
 * A worker where the page has one, so a program that never returns can be
 * stopped; this page itself where it has none (tests, Node hosts), where a
 * running program cannot be interrupted.
 */
function createPythonEngine(): PythonEngine {
  const worker =
    typeof window !== "undefined" && typeof Worker !== "undefined" ? workerPythonEngine() : null;
  return worker ?? { ...createPythonOperations(), terminate: () => {} };
}

function supersededError(): PythonPlaygroundServiceError {
  return new PythonPlaygroundServiceError("aborted", "Superseded by a newer operation");
}

function unavailableError(cause: unknown): PythonPlaygroundServiceError {
  return new PythonPlaygroundServiceError(
    "unavailable",
    `Python could not be loaded (${cause instanceof Error ? cause.message : String(cause)})`,
  );
}

/** Why an interpreter did not start, as the error a Run reports. */
function startError(cause: unknown): PythonPlaygroundServiceError {
  return cause instanceof PythonEngineOutdatedError
    ? new PythonPlaygroundServiceError(
        "outdated",
        "Python cannot start in a page opened before the app was last updated",
      )
    : unavailableError(cause);
}

/**
 * A run whose interpreter died under it, told as the program's own error
 * rather than an interpreter that would not load: running the same program
 * again ends it the same way. What it printed before is lost with the worker,
 * unless a terminal's memory holds it: then `output` is what the page read.
 */
function stoppedRunResult(output: string): PythonPlaygroundRunResult {
  return { status: "runtime-error", output, exitDetail: PYTHON_STOPPED_DETAIL };
}

/**
 * When the client ends a run the interpreter did not end by itself. The
 * interpreter stops a program at {@link PYTHON_MAX_RUN_MS} from the inside, and
 * keeps what it printed; it can only do so between bytecodes, so a program
 * waiting inside one call — `time.sleep(3600)` — is past its reach. Two seconds
 * later the worker is terminated instead, and the output goes with it, again
 * unless a terminal's memory holds it.
 */
const HARD_STOP_MS = PYTHON_MAX_RUN_MS + 2_000;

function hardStoppedRunResult(output: string): PythonPlaygroundRunResult {
  return { status: "runtime-error", output, exitDetail: PYTHON_TIME_LIMIT_DETAIL };
}

/**
 * How often the page reads a running program's terminal. The program's thread
 * cannot say when it has printed, so the page looks: often enough that a
 * prompt is on screen as the program starts to wait, seldom enough to cost
 * nothing while it waits for a minute.
 */
const TERMINAL_POLL_MS = 30;

/** A timeout that can stand still. */
interface Countdown {
  pause(): void;
  resume(): void;
  stop(): void;
}

function startCountdown(ms: number, onDone: () => void): Countdown {
  let remaining = ms;
  let startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(onDone, ms);
  let stopped = false;
  return {
    pause() {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      remaining -= performance.now() - startedAt;
    },
    resume() {
      if (stopped || timer !== undefined) return;
      startedAt = performance.now();
      timer = setTimeout(onDone, Math.max(remaining, 0));
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * Carries a running program's terminal to whoever drives the run: prints what
 * the program has written as it grows, and when the program waits for a line,
 * asks for one and hands it over. The hard stop stands still while a line is
 * awaited — the interpreter's own limit does the same (interpreter.ts) — so a
 * learner who takes a minute to type is not a program that ran for a minute.
 * Returns what stops it; a line that arrives afterwards is dropped.
 */
function watchPythonTerminal(
  view: PythonTerminalView,
  terminal: PlaygroundRunTerminal,
  hardStop: Countdown,
  pollMs: number,
): () => void {
  let printed = "";
  let asked = false;
  let stopped = false;
  const answer = (line: string | null) => {
    if (stopped) return;
    asked = false;
    view.answer(line);
    hardStop.resume();
  };
  const look = () => {
    const waiting = view.isWaiting();
    const output = view.output();
    if (output !== printed) {
      printed = output;
      terminal.print(output);
    }
    if (waiting && !asked) {
      asked = true;
      hardStop.pause();
      // A terminal that fails to give a line has no more of them.
      terminal.readLine().then(answer, () => answer(null));
    }
  };
  const timer = setInterval(look, pollMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * One run at a time, each in an interpreter of its own.
 *
 * No filesystem, mount, process, PTY, port, preview or teardown surface —
 * exactly like the other Playground clients — and no network either, like
 * Kite's: starting a Run supersedes the previous one, so a stale answer can
 * never land after a newer explicit action, and what it cancels is a
 * computation rather than a request. Superseding terminates the worker, the
 * only thing that stops a program that never returns.
 *
 * Unlike Kite's compiler, an interpreter is not kept between runs. A compiler
 * is the same after every compile; an interpreter remembers what a program did
 * to it — imported modules, a patched `sys.path`, a seeded `random`, files it
 * wrote — and a second run on it would not be `python main.py` again. So a
 * finished run ends its interpreter and starts the next one at once, in the
 * background: by the time the learner presses Run again it is ready, and only
 * the first Run of a lesson waits for a start. Leaving the lesson ends that
 * one too, so no interpreter outlives the panel that used it.
 *
 * A run given a terminal prints as it goes and can wait for a typed line
 * (terminalMemory.ts). A program parked at `input()` is ended the way any
 * other is: by the next Run, a cancel or an unmount, which terminate its
 * worker.
 */
export class PythonPlaygroundClient {
  readonly #createEngine: () => PythonEngine;
  readonly #hardStopMs: number;
  readonly #openTerminal: () => PythonTerminalLink | null;
  readonly #terminalPollMs: number;
  /** The interpreter of the run in flight, or the one started for the next run. */
  #engine: PythonEngine | null = null;
  /** Rejects the run in flight as superseded; null while idle. */
  #supersede: (() => void) | null = null;

  /** The options are for tests; the defaults start a worker and stop it at the limit. */
  constructor({
    createEngine = createPythonEngine,
    hardStopMs = HARD_STOP_MS,
    openTerminal = openPythonTerminal,
    terminalPollMs = TERMINAL_POLL_MS,
  }: {
    createEngine?: () => PythonEngine;
    hardStopMs?: number;
    openTerminal?: () => PythonTerminalLink | null;
    terminalPollMs?: number;
  } = {}) {
    this.#createEngine = createEngine;
    this.#hardStopMs = hardStopMs;
    this.#openTerminal = openTerminal;
    this.#terminalPollMs = terminalPollMs;
  }

  /** End whatever is running or waiting. Called on cancel and on unmount. */
  dispose(): void {
    const supersede = this.#supersede;
    this.#supersede = null;
    this.#engine?.terminate();
    this.#engine = null;
    supersede?.();
  }

  /** An interpreter started ahead of the run that will use it. */
  #startNextEngine(): PythonEngine {
    const engine = this.#createEngine();
    // A failed start is reported by the run that asks this engine to load again.
    void engine.load().catch(() => {});
    return engine;
  }

  /**
   * Run the program. With `terminal`, on an interpreter that can wait and a
   * page that can share memory with it, the program prints to the terminal as
   * it runs and `input()` asks it for a line. Anywhere else, and with no
   * terminal, the output comes with the result and `input()` meets the end of
   * its input.
   */
  async run(
    request: PythonPlaygroundRunRequest,
    terminal?: PlaygroundRunTerminal,
  ): Promise<PythonPlaygroundRunResult> {
    // Superseding comes first, so even a Run the client refuses replaces the
    // one before it. The interpreter waiting for the next run is not in flight
    // and is kept.
    if (this.#supersede) this.dispose();
    const entry = pickPythonRunEntry(request.files);
    const engine = (this.#engine ??= this.#createEngine());
    const link = terminal && engine.offThread ? this.#openTerminal() : null;
    /** What the program printed, as far as this page can tell without a result. */
    const printed = () => link?.view.output() ?? "";

    let supersede: () => void = () => {};
    const superseded = new Promise<never>((_, reject) => {
      supersede = () => reject(supersededError());
    });
    this.#supersede = supersede;

    let loaded = false;
    let hardStop: Countdown | undefined;
    let stopWatching = () => {};
    /** The run is over, however it ended: nothing of it may fire afterwards. */
    const settle = () => {
      hardStop?.stop();
      stopWatching();
    };
    const work = engine.load().then(
      () => {
        // Superseded while the interpreter was starting: the program must not
        // begin on an engine that is already ended.
        if (this.#supersede !== supersede) throw supersededError();
        loaded = true;
        return Promise.race([
          link
            ? engine.run(request.files, entry.path, link.memory)
            : engine.run(request.files, entry.path),
          new Promise<PythonPlaygroundRunResult>((resolve) => {
            const countdown = startCountdown(this.#hardStopMs, () =>
              resolve(hardStoppedRunResult(printed())),
            );
            hardStop = countdown;
            if (link && terminal) {
              stopWatching = watchPythonTerminal(
                link.view,
                terminal,
                countdown,
                this.#terminalPollMs,
              );
            }
          }),
        ]);
      },
      (cause: unknown) => {
        throw startError(cause);
      },
    );
    // Superseded, the race is already settled and nobody reads `work` again.
    work.catch(() => {});

    let result: unknown;
    try {
      result = await Promise.race([work, superseded]);
    } catch (cause) {
      settle();
      if (this.#supersede !== supersede) throw supersededError();
      this.#retire(engine, { startNext: loaded });
      if (cause instanceof PythonPlaygroundServiceError) throw cause;
      // The worker died after Python had started: the program's doing.
      return stoppedRunResult(printed());
    }

    settle();
    if (this.#supersede !== supersede) throw supersededError();
    this.#retire(engine, { startNext: true });

    const parsed = parsePythonPlaygroundRunResult(result);
    if (!parsed) {
      throw new PythonPlaygroundServiceError(
        "unavailable",
        "The interpreter produced a result that does not match the contract",
      );
    }
    return parsed;
  }

  /**
   * End the interpreter a run used and, where Python did start, begin the next
   * one. After a failed start none is begun: the next Run tries, and reports,
   * for itself.
   */
  #retire(engine: PythonEngine, { startNext }: { startNext: boolean }): void {
    this.#supersede = null;
    engine.terminate();
    this.#engine = startNext ? this.#startNextEngine() : null;
  }
}
