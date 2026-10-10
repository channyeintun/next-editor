import type { PlaygroundFile } from "../runtime/playgroundFiles";
import { PLAYGROUND_LANGUAGES } from "../runtime/playgroundLanguages";
import type { WorkspaceProject } from "../types/workspace";
import { StudioActionError, abortableSleep, cancelledError } from "./async";
import { fixtureRunConsoleLines } from "./fixtureConsoleLines";
import {
  PLAYGROUND_TRANSIENT_ERROR_KINDS,
  type StudioPlaygroundRuntime,
  type StudioPlaygroundRuntimeKind,
} from "./plan";

/**
 * Execution-kind adapters for `runtime.run` (docs/agent-lesson-production.md
 * §2/§8), one per selective-Playground lesson type — Go, Kotlin, Rust, Zig,
 * and Haskell share a protocol (collect sources → proxy run → normalized
 * result → prefixed console lines), so one retry engine drives each kind's
 * `PlaygroundLanguage` (runtime/playgroundLanguages.ts), the runner panel's own.
 * Kite and asm follow the same protocol with the network removed: their
 * compiler and machine run in the page, so their "live" path calls nothing.
 * Runs have no local side effects, making a declared-idempotent retry safe
 * for transient service failures; compile and program errors are terminal.
 * Retries are silent in the recorded console (the receipt carries the attempt
 * history) — only a *final* failure surfaces error lines. Fixture mode
 * replays the pinned result, optionally simulating transient failures first.
 */

const RETRYABLE_KINDS = new Set<string>(PLAYGROUND_TRANSIENT_ERROR_KINDS);
const RETRY_DELAY_MS = 500;
const MAX_RUN_ATTEMPTS = 2;

export interface PlaygroundRunFailure {
  attempt: number;
  kind: string;
  message: string;
}

export class PlaygroundTerminalError extends StudioActionError {
  /** Console lines describing the failure; appended by the caller. */
  readonly consoleLines: string[];
  readonly attempts: number;

  constructor(message: string, consoleLines: string[], attempts: number) {
    super(message);
    this.name = "PlaygroundTerminalError";
    this.consoleLines = consoleLines;
    this.attempts = attempts;
  }
}

export interface PlaygroundRunOutcome {
  /** Console lines for the normalized result (success or program failure). */
  resultLines: string[];
  /** True when the program compiled and ran cleanly. */
  ok: boolean;
  status: string;
  attempts: number;
  transientFailures: PlaygroundRunFailure[];
}

interface PlaygroundEngine {
  /** e.g. "go" — console error lines are `[<label>-run error] …`. */
  label: string;
  collectFiles(project: Pick<WorkspaceProject, "files">): PlaygroundFile[];
  /** The runner panel's refusal line when the workspace shape can't run, else null. */
  validateFiles(files: PlaygroundFile[]): string | null;
  /**
   * Throws a `ServiceFailure` carrying the client's own error for a workspace
   * whose entry it cannot resolve — the check a live client makes before
   * anything else, which a fixture run makes itself because it never reaches one.
   */
  checkEntry(files: PlaygroundFile[]): void;
  startedLines(files: PlaygroundFile[]): string[];
  runLive(
    files: PlaygroundFile[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ resultLines: string[]; ok: boolean; status: string }>;
  /** Console lines for a terminal service failure. */
  serviceErrorLines(kind: string, message: string): string[];
}

/**
 * Wrap a live client call with a hard deadline and normalize its failure
 * modes: deadline → "timeout" (retryable), external render abort →
 * cancellation, service errors pass through as {kind, message}.
 */
async function liveAttempt<TResult>(
  run: () => Promise<TResult>,
  abort: () => void,
  isServiceError: (error: unknown) => { kind: string; message: string } | null,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<TResult> {
  let deadlineHit = false;
  const deadline = setTimeout(() => {
    deadlineHit = true;
    abort();
  }, timeoutMs);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await run();
  } catch (error) {
    const service = isServiceError(error);
    if (service?.kind === "aborted") {
      if (deadlineHit && !signal.aborted) {
        throw new ServiceFailure("timeout", `No response within ${timeoutMs}ms`);
      }
      throw cancelledError();
    }
    if (service) {
      throw new ServiceFailure(service.kind, service.message);
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", abort);
  }
}

/**
 * Console lines for a terminal service failure, guaranteed non-empty strings.
 *
 * Each language's error table is keyed by the kinds *its* client raises, but
 * the deadline above synthesizes `"timeout"` for every kind — including the
 * in-page runners that have no such kind, whose table then answers `undefined`.
 * An undefined console line reaches the shared store's `lines[0].startsWith(…)`
 * and throws a TypeError there, turning a failed run into a crashed render with
 * no error line anywhere. Normalizing once here covers every engine, present
 * and future, rather than depending on each table to cover a kind it does not
 * own.
 */
function serviceErrorLinesFor(engine: PlaygroundEngine, kind: string, message: string): string[] {
  const lines = engine
    .serviceErrorLines(kind, message)
    .filter((line): line is string => typeof line === "string" && line.length > 0);
  return lines.length > 0
    ? lines
    : [`[${engine.label}-run error] The run could not be completed (${message})`];
}

/** Internal normalized service failure (any playground). */
class ServiceFailure extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "ServiceFailure";
    this.kind = kind;
  }
}

/**
 * The engine for one prepared run, built from the kind's `PlaygroundLanguage`
 * — the same client binding, refusal line and console builders the runner
 * panel uses, so a recorded run prints what a learner's Run prints. The client
 * is created on the first live attempt and reused by its retry.
 */
function engineFor(kind: StudioPlaygroundRuntimeKind): PlaygroundEngine {
  const language = PLAYGROUND_LANGUAGES[kind];
  const serviceErrorOf = (error: unknown) =>
    error instanceof language.client.ServiceError
      ? { kind: error.kind, message: error.message }
      : null;
  let client: unknown = null;
  return {
    label: language.label,
    collectFiles: language.collectFiles,
    // Kite and asm have no refusal line: their client picks the entry, and
    // `checkEntry` asks it the same question.
    validateFiles: (files) => language.run.rejectFiles?.(files) ?? null,
    checkEntry: (files) => {
      try {
        language.run.pickEntry?.(files);
      } catch (error) {
        const service = serviceErrorOf(error);
        if (service) throw new ServiceFailure(service.kind, service.message);
        throw error;
      }
    },
    startedLines: language.run.startedLines,
    runLive: async (files, timeoutMs, signal) => {
      client ??= language.client.create();
      const activeClient = client;
      const result: { status: string } = await liveAttempt(
        () => language.run.execute(activeClient, files),
        () => language.client.stop(activeClient),
        serviceErrorOf,
        timeoutMs,
        signal,
      );
      return {
        resultLines: language.run.resultLines(result),
        ok: result.status === "success",
        status: result.status,
      };
    },
    serviceErrorLines: language.run.serviceErrorLines,
  };
}

export interface PlaygroundRunInput {
  runtime: StudioPlaygroundRuntime;
  mode: "live" | "fixture";
  project: Pick<WorkspaceProject, "files">;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface PlaygroundRunPrepared {
  startedLines: string[];
  run(): Promise<PlaygroundRunOutcome>;
}

/** `[<label>-run error]` prefix for the runtime's console error lines. */
export function runErrorPrefixFor(kind: StudioPlaygroundRuntimeKind): string {
  return `[${PLAYGROUND_LANGUAGES[kind].label}-run error]`;
}

/**
 * Validate the workspace and prepare a run: the caller appends
 * `startedLines`, then awaits `run()` for the normalized outcome (or a
 * `PlaygroundTerminalError` carrying its console lines).
 */
export function preparePlaygroundRun(input: PlaygroundRunInput): PlaygroundRunPrepared {
  const engine = engineFor(input.runtime.kind);
  const files = engine.collectFiles(input.project);
  const invalid = engine.validateFiles(files);
  if (invalid) {
    throw new StudioActionError(invalid);
  }

  const run = async (): Promise<PlaygroundRunOutcome> => {
    const transientFailures: PlaygroundRunFailure[] = [];

    for (let attempt = 1; attempt <= MAX_RUN_ATTEMPTS; attempt++) {
      try {
        if (input.mode === "fixture") {
          engine.checkEntry(files);
          const fixture = input.runtime.fixture;
          await abortableSleep(fixture.latencyMs, input.signal);
          const transientKind = fixture.transientErrorKinds[attempt - 1];
          if (transientKind) {
            throw new ServiceFailure(transientKind, `Simulated transient ${transientKind}`);
          }
          // The pinned result goes through the same console builders a live
          // run's result does; every runner reports a clean run as "success".
          return {
            resultLines: fixtureRunConsoleLines(input.runtime),
            ok: fixture.result.status === "success",
            status: fixture.result.status,
            attempts: attempt,
            transientFailures,
          };
        }
        const outcome = await engine.runLive(files, input.timeoutMs, input.signal);
        return { ...outcome, attempts: attempt, transientFailures };
      } catch (error) {
        if (error instanceof ServiceFailure) {
          const retryable = RETRYABLE_KINDS.has(error.kind) && attempt < MAX_RUN_ATTEMPTS;
          if (retryable) {
            transientFailures.push({ attempt, kind: error.kind, message: error.message });
            await abortableSleep(RETRY_DELAY_MS, input.signal);
            continue;
          }
          throw new PlaygroundTerminalError(
            `Run failed (${error.kind}) after ${attempt} attempt(s): ${error.message}`,
            serviceErrorLinesFor(engine, error.kind, error.message),
            attempt,
          );
        }
        throw error;
      }
    }

    // Unreachable: the loop always returns or throws.
    throw new StudioActionError("Run retry loop exited unexpectedly");
  };

  return { startedLines: engine.startedLines(files), run };
}
