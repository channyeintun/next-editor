import { GoPlaygroundClient, GoPlaygroundServiceError } from "../runtime/goPlayground/client";
import type { GoPlaygroundFile, GoPlaygroundRunResult } from "../runtime/goPlayground/types";
import { StudioActionError, abortableSleep } from "./async";
import type { StudioPlan } from "./plan";

/**
 * Execution-kind adapter for `runtime.run` on Go lessons
 * (docs/agent-lesson-production.md §2/§8): one bounded run with a declared-
 * idempotent retry for transient service failures. A Go Playground run has no
 * local side effects, so retrying on rate-limit/timeout/unavailability is safe;
 * compile and program errors are terminal. Retries are silent in the recorded
 * console (the receipt carries the attempt history) — only a *final* failure
 * surfaces error lines. Fixture mode replays the pinned result, optionally
 * simulating transient failures first so the retry path is exercised
 * deterministically.
 */

const RETRYABLE_KINDS = new Set(["rate-limited", "timeout", "unavailable"]);
const RETRY_DELAY_MS = 500;
export const MAX_RUN_ATTEMPTS = 2;

export interface GoRunAttemptFailure {
  attempt: number;
  kind: string;
  message: string;
}

export interface GoRunAdapterOutcome {
  result: GoPlaygroundRunResult;
  attempts: number;
  transientFailures: GoRunAttemptFailure[];
}

export class GoRunTerminalError extends StudioActionError {
  /** Console lines describing the failure; appended by the caller. */
  readonly consoleLines: string[];
  readonly attempts: number;

  constructor(message: string, consoleLines: string[], attempts: number) {
    super(message);
    this.name = "GoRunTerminalError";
    this.consoleLines = consoleLines;
    this.attempts = attempts;
  }
}

export interface GoRunAdapterInput {
  mode: "live" | "fixture";
  fixture: StudioPlan["runtime"]["fixture"];
  files: readonly GoPlaygroundFile[];
  timeoutMs: number;
  signal: AbortSignal;
  /** Live-mode client factory (injected so tests never construct a real one). */
  getClient: () => GoPlaygroundClient;
  errorLinesFor: (kind: string, message: string) => string[];
}

async function attemptOnce(
  input: GoRunAdapterInput,
  attempt: number,
): Promise<GoPlaygroundRunResult> {
  if (input.mode === "fixture") {
    await abortableSleep(input.fixture.latencyMs, input.signal);
    const transientKind = input.fixture.transientErrorKinds[attempt - 1];
    if (transientKind) {
      throw new GoPlaygroundServiceError(transientKind, `Simulated transient ${transientKind}`);
    }
    return input.fixture.result;
  }

  const client = input.getClient();
  let deadlineHit = false;
  const deadline = setTimeout(() => {
    deadlineHit = true;
    client.abort();
  }, input.timeoutMs);
  try {
    return await client.run(input.files);
  } catch (error) {
    if (error instanceof GoPlaygroundServiceError && error.kind === "aborted") {
      if (deadlineHit) {
        throw new GoPlaygroundServiceError("timeout", `No response within ${input.timeoutMs}ms`);
      }
      throw new StudioActionError("The render was cancelled");
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

export async function runGoWithRetry(input: GoRunAdapterInput): Promise<GoRunAdapterOutcome> {
  const transientFailures: GoRunAttemptFailure[] = [];

  for (let attempt = 1; attempt <= MAX_RUN_ATTEMPTS; attempt++) {
    try {
      const result = await attemptOnce(input, attempt);
      return { result, attempts: attempt, transientFailures };
    } catch (error) {
      if (error instanceof GoPlaygroundServiceError) {
        const retryable = RETRYABLE_KINDS.has(error.kind) && attempt < MAX_RUN_ATTEMPTS;
        if (retryable) {
          transientFailures.push({ attempt, kind: error.kind, message: error.message });
          await abortableSleep(RETRY_DELAY_MS, input.signal);
          continue;
        }
        throw new GoRunTerminalError(
          `Run failed (${error.kind}) after ${attempt} attempt(s): ${error.message}`,
          input.errorLinesFor(error.kind, error.message),
          attempt,
        );
      }
      throw error;
    }
  }

  // Unreachable: the loop always returns or throws.
  throw new StudioActionError("Run retry loop exited unexpectedly");
}
