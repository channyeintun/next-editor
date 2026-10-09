import { planActionBusyMs, type StudioPlan, type StudioPlanAction } from "./plan";
import type { StudioDriver } from "./driver";
import { RENDER_CANCELLED_MESSAGE, StudioActionError, abortableSleep } from "./async";
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
      return driver.moveCursor({
        target: action.target,
        durationMs: action.durationMs,
        press: action.press,
      });
    case "editor.type":
      return driver.typeText({ path: action.path, anchor: action.anchor, chunks: action.chunks });
    case "editor.select":
      return driver.selectRange({
        path: action.path,
        selection: action.selection,
        durationMs: action.durationMs,
      });
    case "console.point":
      return driver.pointConsole({
        target: action.target,
        durationMs: action.durationMs,
        timeoutMs: action.timeoutMs,
      });
    case "runtime.run":
      return driver.runWorkspace(action.timeoutMs);
    case "runtime.start":
      return driver.startRuntime(action.timeoutMs);
    case "runtime.waitForReady":
      return driver.waitForRuntimeReady(action.timeoutMs);
    case "runtime.collapseDock":
      return driver.collapseRuntimeDock(action.timeoutMs);
    case "runtime.expandDock":
      return driver.expandRuntimeDock(action.timeoutMs);
    case "preview.open":
      return driver.openPreview({ mode: action.mode, timeoutMs: action.timeoutMs });
    case "preview.click":
      return driver.executePreviewCommand({
        command: { type: "click", target: { testId: action.target.value } },
        timeoutMs: action.timeoutMs,
      });
    case "preview.input":
      return driver.executePreviewCommand({
        command: {
          type: "input",
          target: { testId: action.target.value },
          value: action.value,
        },
        timeoutMs: action.timeoutMs,
      });
    case "preview.scroll":
      return driver.executePreviewCommand({
        command: {
          type: "scroll",
          target: action.target ? { testId: action.target.value } : undefined,
          top: action.top,
          left: action.left,
        },
        timeoutMs: action.timeoutMs,
      });
    case "preview.route":
      return driver.executePreviewCommand({
        command: { type: "route", route: action.route },
        timeoutMs: action.timeoutMs,
      });
    case "slide.show":
      return driver.showSlide({ slideId: action.slideId, maximized: action.maximized });
    case "slide.close":
      return driver.closeSlide();
    case "whiteboard.apply":
      return driver.applyWhiteboard({
        open: action.open,
        maximized: action.maximized,
        upsertIds: action.upsertIds,
        drawMs: action.drawMs,
        clear: action.clear,
      });
    case "expect.output":
      return driver.waitForOutput({ contains: action.contains, timeoutMs: action.timeoutMs });
    case "expect.file":
      return driver.expectFile({ path: action.path, contains: action.contains });
    case "expect.preview":
      return driver.expectPreview({
        actionId: action.id,
        target: action.target,
        textContains: action.textContains,
        value: action.value,
        route: action.route,
        attribute: action.attribute,
        timeoutMs: action.timeoutMs,
      });
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
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  // Typing spends its planned chunk delays, a select its drag-glide, a console
  // point its travel and a drawn whiteboard apply its frames before
  // acknowledging; expect/run actions own their internal waits. The outer
  // deadline covers the whole command either way.
  const deadlineMs = action.timeoutMs + planActionBusyMs(action);

  let deadlineTimer: number | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = window.setTimeout(() => {
      reject(
        new StudioActionError(`Action "${action.id}" did not acknowledge within ${deadlineMs}ms`),
      );
    }, deadlineMs);
  });

  const invokeWithRetry = async () => {
    const retry = "retry" in action ? action.retry : { maxAttempts: 1, delayMs: 0 };
    let lastError: unknown;
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      try {
        const detail = await invokeAction(action, driver);
        return retry.maxAttempts > 1 ? { ...detail, commandAttempts: attempt } : detail;
      } catch (error) {
        lastError = error;
        if (attempt >= retry.maxAttempts) {
          throw error;
        }
        await abortableSleep(retry.delayMs, signal);
      }
    }
    throw lastError;
  };

  try {
    return await Promise.race([invokeWithRetry(), deadline]);
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
      failure = error instanceof Error ? error.message : RENDER_CANCELLED_MESSAGE;
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
    // A pointer move that starts behind schedule (a slow runtime chain before
    // it) gives the lateness back out of its budget — the idle rest before the
    // travel goes first — so its click still lands as close to the action it
    // performs as the driver can make it, instead of pushing that action later.
    const lateMs = Math.max(0, startedAtMs - action.at);
    const performed =
      action.type === "cursor.moveTo" && lateMs > 0
        ? { ...action, durationMs: Math.max(1, action.durationMs - lateMs) }
        : action;
    try {
      const detail = await invokeWithDeadline(performed, driver, signal);
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
        ...(error instanceof StudioActionError && error.detail ? { detail: error.detail } : {}),
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
