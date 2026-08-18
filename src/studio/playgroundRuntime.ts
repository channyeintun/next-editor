import { GoPlaygroundClient, GoPlaygroundServiceError } from "../runtime/goPlayground/client";
import {
  goRunResultToConsoleLines,
  goRunServiceErrorToConsoleLines,
  goRunStartedConsoleLines,
} from "../runtime/goPlayground/console";
import { collectGoPlaygroundFiles } from "../runtime/goPlayground/files";
import {
  KotlinPlaygroundClient,
  KotlinPlaygroundServiceError,
} from "../runtime/kotlinPlayground/client";
import {
  kotlinRunResultToConsoleLines,
  kotlinRunServiceErrorToConsoleLines,
  kotlinRunStartedConsoleLines,
} from "../runtime/kotlinPlayground/console";
import { collectKotlinPlaygroundFiles } from "../runtime/kotlinPlayground/files";
import { KitePlaygroundClient, KitePlaygroundServiceError } from "../runtime/kitePlayground/client";
import {
  kiteRunResultToConsoleLines,
  kiteRunServiceErrorToConsoleLines,
  kiteRunStartedConsoleLines,
} from "../runtime/kitePlayground/console";
import { collectKitePlaygroundFiles } from "../runtime/kitePlayground/files";
import { RustPlaygroundClient, RustPlaygroundServiceError } from "../runtime/rustPlayground/client";
import {
  rustRunResultToConsoleLines,
  rustRunServiceErrorToConsoleLines,
  rustRunStartedConsoleLines,
} from "../runtime/rustPlayground/console";
import { collectRustPlaygroundFiles } from "../runtime/rustPlayground/files";
import { ZigPlaygroundClient, ZigPlaygroundServiceError } from "../runtime/zigPlayground/client";
import {
  zigRunResultToConsoleLines,
  zigRunServiceErrorToConsoleLines,
  zigRunStartedConsoleLines,
} from "../runtime/zigPlayground/console";
import { collectZigPlaygroundFiles } from "../runtime/zigPlayground/files";
import { AsmPlaygroundClient, AsmPlaygroundServiceError } from "../runtime/asmPlayground/client";
import {
  asmRegisterConsoleLines,
  asmRunResultToConsoleLines,
  asmRunServiceErrorToConsoleLines,
  asmRunStartedConsoleLines,
} from "../runtime/asmPlayground/console";
import { collectAsmPlaygroundFiles, ASM_ENTRY_PATH } from "../runtime/asmPlayground/files";
import type { WorkspaceProject } from "../types/workspace";
import { StudioActionError, abortableSleep } from "./async";
import type { StudioRuntime } from "./plan";

/**
 * Execution-kind adapters for `runtime.run` (docs/agent-lesson-production.md
 * §2/§8), one per selective-Playground lesson type — Go, Kotlin, Rust, and
 * Zig share a protocol (collect sources → proxy run → normalized result →
 * prefixed console lines), so one retry engine drives kind-specific configs.
 * Kite and asm follow the same protocol with the network removed: their
 * compiler and machine run in the page, so their "live" path calls nothing.
 * Runs have no local side effects, making a declared-idempotent retry safe
 * for transient service failures; compile and program errors are terminal.
 * Retries are silent in the recorded console (the receipt carries the attempt
 * history) — only a *final* failure surfaces error lines. Fixture mode
 * replays the pinned result, optionally simulating transient failures first.
 */

const RETRYABLE_KINDS = new Set(["rate-limited", "timeout", "unavailable"]);
const RETRY_DELAY_MS = 500;
export const MAX_RUN_ATTEMPTS = 2;

type PlaygroundRuntime = Extract<
  StudioRuntime,
  {
    kind:
      | "go-playground"
      | "kotlin-playground"
      | "rust-playground"
      | "zig-playground"
      | "kite-playground"
      | "asm-playground";
  }
>;
type FixtureOf<K extends PlaygroundRuntime["kind"]> = Extract<
  PlaygroundRuntime,
  { kind: K }
>["fixture"];

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
  collectFiles(project: Pick<WorkspaceProject, "files">): { path: string; content: string }[];
  /** Human message when the workspace shape can't run, else null. */
  validateFiles(files: { path: string }[]): string | null;
  startedLines(files: { path: string }[]): string[];
  runLive(
    files: { path: string; content: string }[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ resultLines: string[]; ok: boolean; status: string }>;
  runFixtureResult(fixture: { result: unknown }): {
    resultLines: string[];
    ok: boolean;
    status: string;
  };
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
      throw new StudioActionError("The render was cancelled");
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

/** Internal normalized service failure (any playground). */
class ServiceFailure extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "ServiceFailure";
    this.kind = kind;
  }
}

function engineFor(kind: PlaygroundRuntime["kind"]): PlaygroundEngine {
  switch (kind) {
    case "go-playground": {
      let client: GoPlaygroundClient | null = null;
      return {
        label: "go",
        collectFiles: collectGoPlaygroundFiles,
        validateFiles: (files) =>
          files.length === 0 ? "Add at least one .go file to run this lesson" : null,
        startedLines: (files) => goRunStartedConsoleLines(files.map((file) => file.path)),
        runLive: async (files, timeoutMs, signal) => {
          client ??= new GoPlaygroundClient();
          const activeClient = client;
          const result = await liveAttempt(
            () => activeClient.run(files),
            () => activeClient.abort(),
            (error) =>
              error instanceof GoPlaygroundServiceError
                ? { kind: error.kind, message: error.message }
                : null,
            timeoutMs,
            signal,
          );
          return {
            resultLines: goRunResultToConsoleLines(result),
            ok: result.status === "success",
            status: result.status,
          };
        },
        runFixtureResult: (fixture) => {
          const result = (fixture as FixtureOf<"go-playground">).result;
          return {
            resultLines: goRunResultToConsoleLines(result),
            ok: result.status === "success",
            status: result.status,
          };
        },
        serviceErrorLines: (errorKind, message) =>
          goRunServiceErrorToConsoleLines(
            errorKind as Parameters<typeof goRunServiceErrorToConsoleLines>[0],
            message,
          ),
      };
    }
    case "kotlin-playground": {
      let client: KotlinPlaygroundClient | null = null;
      return {
        label: "kotlin",
        collectFiles: collectKotlinPlaygroundFiles,
        validateFiles: (files) =>
          files.length === 0 ? "Add at least one .kt file to run this lesson" : null,
        startedLines: (files) => kotlinRunStartedConsoleLines(files.map((file) => file.path)),
        runLive: async (files, timeoutMs, signal) => {
          client ??= new KotlinPlaygroundClient();
          const activeClient = client;
          const result = await liveAttempt(
            () => activeClient.run(files),
            () => activeClient.abort(),
            (error) =>
              error instanceof KotlinPlaygroundServiceError
                ? { kind: error.kind, message: error.message }
                : null,
            timeoutMs,
            signal,
          );
          return {
            resultLines: kotlinRunResultToConsoleLines(result),
            ok: result.status === "success",
            status: result.status,
          };
        },
        runFixtureResult: (fixture) => {
          const result = (fixture as FixtureOf<"kotlin-playground">).result;
          return {
            resultLines: kotlinRunResultToConsoleLines(result),
            ok: result.status === "success",
            status: result.status,
          };
        },
        serviceErrorLines: (errorKind, message) =>
          kotlinRunServiceErrorToConsoleLines(
            errorKind as Parameters<typeof kotlinRunServiceErrorToConsoleLines>[0],
            message,
          ),
      };
    }
    case "rust-playground": {
      let client: RustPlaygroundClient | null = null;
      return {
        label: "rust",
        collectFiles: collectRustPlaygroundFiles,
        // The upstream Playground compiles one crate from one source string.
        validateFiles: (files) =>
          files.length === 1 && files[0].path === "main.rs"
            ? null
            : "Rust lessons run exactly one main.rs",
        startedLines: () => rustRunStartedConsoleLines(),
        runLive: async (files, timeoutMs, signal) => {
          client ??= new RustPlaygroundClient();
          const activeClient = client;
          const result = await liveAttempt(
            () => activeClient.run(files),
            () => activeClient.abort(),
            (error) =>
              error instanceof RustPlaygroundServiceError
                ? { kind: error.kind, message: error.message }
                : null,
            timeoutMs,
            signal,
          );
          return {
            resultLines: rustRunResultToConsoleLines(result),
            ok: result.status === "success",
            status: result.status,
          };
        },
        runFixtureResult: (fixture) => {
          const result = (fixture as FixtureOf<"rust-playground">).result;
          return {
            resultLines: rustRunResultToConsoleLines(result),
            ok: result.status === "success",
            status: result.status,
          };
        },
        serviceErrorLines: (errorKind, message) =>
          rustRunServiceErrorToConsoleLines(
            errorKind as Parameters<typeof rustRunServiceErrorToConsoleLines>[0],
            message,
          ),
      };
    }

    case "zig-playground": {
      let client: ZigPlaygroundClient | null = null;
      return {
        label: "zig",
        collectFiles: collectZigPlaygroundFiles,
        // The upstream compiles one root source file from one text body.
        validateFiles: (files) =>
          files.length === 1 && files[0].path === "main.zig"
            ? null
            : "Zig lessons run exactly one main.zig",
        startedLines: () => zigRunStartedConsoleLines(),
        runLive: async (files, timeoutMs, signal) => {
          client ??= new ZigPlaygroundClient();
          const activeClient = client;
          const result = await liveAttempt(
            () => activeClient.run(files),
            () => activeClient.abort(),
            (error) =>
              error instanceof ZigPlaygroundServiceError
                ? { kind: error.kind, message: error.message }
                : null,
            timeoutMs,
            signal,
          );
          return {
            resultLines: zigRunResultToConsoleLines(result),
            ok: result.status === "success",
            status: result.status,
          };
        },
        runFixtureResult: (fixture) => {
          const result = (fixture as FixtureOf<"zig-playground">).result;
          return {
            resultLines: zigRunResultToConsoleLines(result),
            ok: result.status === "success",
            status: result.status,
          };
        },
        serviceErrorLines: (errorKind, message) =>
          zigRunServiceErrorToConsoleLines(
            errorKind as Parameters<typeof zigRunServiceErrorToConsoleLines>[0],
            message,
          ),
      };
    }

    case "kite-playground": {
      let client: KitePlaygroundClient | null = null;
      return {
        label: "kite",
        collectFiles: collectKitePlaygroundFiles,
        // A Kite module is a directory, so siblings are part of the same
        // program — but a run compiles the entry, so one has to be named.
        validateFiles: (files) =>
          files.length === 0
            ? "Add a .kite file to run this lesson"
            : files.length === 1 || files.some((file) => file.path === "main.kite")
              ? null
              : "Name the file this lesson runs main.kite",
        startedLines: () => kiteRunStartedConsoleLines(),
        runLive: async (files, timeoutMs, signal) => {
          client ??= new KitePlaygroundClient();
          const activeClient = client;
          const result = await liveAttempt(
            () => activeClient.run({ files }),
            () => activeClient.dispose(),
            (error) =>
              error instanceof KitePlaygroundServiceError
                ? { kind: error.kind, message: error.message }
                : null,
            timeoutMs,
            signal,
          );
          return {
            resultLines: kiteRunResultToConsoleLines(result),
            ok: result.status === "success",
            status: result.status,
          };
        },
        runFixtureResult: (fixture) => {
          const result = (fixture as FixtureOf<"kite-playground">).result;
          return {
            resultLines: kiteRunResultToConsoleLines(result),
            ok: result.status === "success",
            status: result.status,
          };
        },
        serviceErrorLines: (errorKind, message) =>
          kiteRunServiceErrorToConsoleLines(
            errorKind as Parameters<typeof kiteRunServiceErrorToConsoleLines>[0],
            message,
          ),
      };
    }
    case "asm-playground": {
      let client: AsmPlaygroundClient | null = null;
      // The register lines follow the run's own output, exactly as the runner
      // panel appends them — a recorded lesson and a live one have to produce
      // the same console or the fixture is not the truth.
      const lines = (result: Parameters<typeof asmRunResultToConsoleLines>[0]): string[] => [
        ...asmRunResultToConsoleLines(result),
        ...asmRegisterConsoleLines(result),
      ];
      return {
        label: "asm",
        collectFiles: collectAsmPlaygroundFiles,
        // There is no linker here, so siblings are never part of the same
        // program — a run assembles the entry, and one has to be named.
        validateFiles: (files) =>
          files.length === 0
            ? `Add a ${ASM_ENTRY_PATH} file to run this lesson`
            : files.length === 1 || files.some((file) => file.path === ASM_ENTRY_PATH)
              ? null
              : `Name the file this lesson runs ${ASM_ENTRY_PATH}`,
        startedLines: () => asmRunStartedConsoleLines(),
        runLive: async (files, timeoutMs, signal) => {
          client ??= new AsmPlaygroundClient();
          const activeClient = client;
          const result = await liveAttempt(
            () => activeClient.run({ files }),
            () => activeClient.dispose(),
            (error) =>
              error instanceof AsmPlaygroundServiceError
                ? { kind: error.kind, message: error.message }
                : null,
            timeoutMs,
            signal,
          );
          return {
            resultLines: lines(result),
            ok: result.status === "success",
            status: result.status,
          };
        },
        runFixtureResult: (fixture) => {
          const result = (fixture as FixtureOf<"asm-playground">).result;
          return {
            resultLines: lines(result),
            ok: result.status === "success",
            status: result.status,
          };
        },
        serviceErrorLines: (errorKind, message) =>
          asmRunServiceErrorToConsoleLines(
            errorKind as Parameters<typeof asmRunServiceErrorToConsoleLines>[0],
            message,
          ),
      };
    }
  }
}

export interface PlaygroundRunInput {
  runtime: PlaygroundRuntime;
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
export function runErrorPrefixFor(kind: PlaygroundRuntime["kind"]): string {
  return `[${engineFor(kind).label}-run error]`;
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
          const fixture = input.runtime.fixture;
          await abortableSleep(fixture.latencyMs, input.signal);
          const transientKind = fixture.transientErrorKinds[attempt - 1];
          if (transientKind) {
            throw new ServiceFailure(transientKind, `Simulated transient ${transientKind}`);
          }
          return { ...engine.runFixtureResult(fixture), attempts: attempt, transientFailures };
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
            engine.serviceErrorLines(error.kind, error.message),
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
