import type { StudioPlan, StudioPlanAction } from "./plan";
import type { StudioDriver } from "./driver";
import { StudioActionError, abortableSleep } from "./async";
import type { ActionReceipt } from "./report";

/**
 * The deterministic Performer (docs/agent-lesson-production.md §4): walks a
 * compiled plan's actions at their planned recording-clock times, invokes the
 * StudioDriver, and collects acknowledgement receipts. No generative
 * decision-making happens here — a failure aborts the remaining plan and the
 * render fails closed.
 */

export interface StudioClock {
  /** Milliseconds since the recording session origin. */
  nowMs(): number;
}

export interface PerformPlanResult {
  status: "completed" | "failed";
  receipts: ActionReceipt[];
  /** First failure message, when status is "failed". */
  error: string | null;
}

export interface PerformPlanOptions {
  plan: StudioPlan;
  driver: StudioDriver;
  clock: StudioClock;
  signal: AbortSignal;
  abort: (reason: string) => void;
  onProgress?: (receipt: ActionReceipt) => void;
}

async function invokeAction(
  action: StudioPlanAction,
  driver: StudioDriver,
): Promise<Record<string, unknown>> {
  switch (action.type) {
    case "workspace.openFile":
      return driver.openFile(action.path, action.timeoutMs);
    case "cursor.moveTo":
      return driver.moveCursor({ target: action.target, durationMs: action.durationMs });
    case "editor.type":
      return driver.typeText({ path: action.path, anchor: action.anchor, chunks: action.chunks });
    case "runtime.run":
      return driver.runWorkspace(action.timeoutMs);
    case "expect.output":
      return driver.waitForOutput({ contains: action.contains, timeoutMs: action.timeoutMs });
    case "expect.file":
      return driver.expectFile({ path: action.path, contains: action.contains });
  }
}

/**
 * Race an action against its declared deadline. Timing out abandons the
 * command's promise; the caller then aborts the shared signal, so an orphaned
 * command can never keep mutating state behind a "failed" report.
 */
async function invokeWithDeadline(
  action: StudioPlanAction,
  driver: StudioDriver,
): Promise<Record<string, unknown>> {
  // editor.type spends its planned chunk delays before acknowledging, and
  // expect/run actions own their internal waits; the outer deadline covers the
  // whole command either way.
  const typingBudgetMs =
    action.type === "editor.type"
      ? action.chunks.reduce((total, chunk) => total + chunk.delayMs, 0)
      : 0;
  const deadlineMs = action.timeoutMs + typingBudgetMs;

  let deadlineTimer: number | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = window.setTimeout(() => {
      reject(
        new StudioActionError(`Action "${action.id}" did not acknowledge within ${deadlineMs}ms`),
      );
    }, deadlineMs);
  });

  try {
    return await Promise.race([invokeAction(action, driver), deadline]);
  } finally {
    window.clearTimeout(deadlineTimer);
  }
}

export async function performPlan({
  plan,
  driver,
  clock,
  signal,
  abort,
  onProgress,
}: PerformPlanOptions): Promise<PerformPlanResult> {
  const receipts: ActionReceipt[] = [];
  let failure: string | null = null;

  for (const action of plan.actions) {
    if (failure !== null || signal.aborted) {
      const receipt: ActionReceipt = {
        actionId: action.id,
        actionType: action.type,
        status: "skipped",
        plannedAtMs: action.at,
        startedAtMs: null,
        endedAtMs: null,
      };
      receipts.push(receipt);
      onProgress?.(receipt);
      continue;
    }

    try {
      const waitMs = action.at - clock.nowMs();
      if (waitMs > 0) {
        await abortableSleep(waitMs, signal);
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : "The render was cancelled";
      const receipt: ActionReceipt = {
        actionId: action.id,
        actionType: action.type,
        status: "skipped",
        plannedAtMs: action.at,
        startedAtMs: null,
        endedAtMs: null,
        error: failure,
      };
      receipts.push(receipt);
      onProgress?.(receipt);
      continue;
    }

    const startedAtMs = clock.nowMs();
    try {
      const detail = await invokeWithDeadline(action, driver);
      const receipt: ActionReceipt = {
        actionId: action.id,
        actionType: action.type,
        status: "ok",
        plannedAtMs: action.at,
        startedAtMs,
        endedAtMs: clock.nowMs(),
        detail,
      };
      receipts.push(receipt);
      onProgress?.(receipt);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      abort(`Action "${action.id}" failed: ${failure}`);
      const receipt: ActionReceipt = {
        actionId: action.id,
        actionType: action.type,
        status: "failed",
        plannedAtMs: action.at,
        startedAtMs,
        endedAtMs: clock.nowMs(),
        error: failure,
      };
      receipts.push(receipt);
      onProgress?.(receipt);
    }
  }

  return {
    status: failure === null ? "completed" : "failed",
    receipts,
    error: failure,
  };
}
