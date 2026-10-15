import { planActionBusyMs, type StudioPlan, type StudioPlanAction } from "./plan";
import type { StudioDriver } from "./driver";
import {
  RENDER_CANCELLED_MESSAGE,
  StudioActionError,
  abortableSleep,
  cancelledError,
} from "./async";
import { previewCommandTarget } from "./previewExpectation";
import { runtimeStartIsOneShotRun } from "./runtimeContract";
import type { ActionReceipt } from "./report";

/**
 * The deterministic Performer (docs/agent-lesson-production.md §4): walks a
 * compiled plan's actions at their planned recording-clock times, invokes the
 * StudioDriver, and collects acknowledgement receipts. Actions run one after
 * another, except a JS/TS runtime.start, which runs in the background while
 * the actions that do not need the runtime keep their times
 * (performsInBackground, actionAwaitsRuntimeStart). No generative decision-making happens here — a
 * failure aborts the remaining plan and the render fails closed.
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

/**
 * The one mapping from a plan action to the driver command that performs it.
 * Exported for drivers outside the page (scripts/studio-verify-lesson.ts),
 * which replay a plan through this same dispatch without its clock.
 */
export async function invokeAction(
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
        command: { type: "click", target: previewCommandTarget(action.target) },
        timeoutMs: action.timeoutMs,
      });
    case "preview.input":
      return driver.executePreviewCommand({
        command: {
          type: "input",
          target: previewCommandTarget(action.target),
          value: action.value,
        },
        timeoutMs: action.timeoutMs,
      });
    case "preview.scroll":
      return driver.executePreviewCommand({
        command: {
          type: "scroll",
          target: previewCommandTarget(action.target),
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

type RuntimeStartAction = Extract<StudioPlanAction, { type: "runtime.start" }>;

/**
 * The one action the Performer runs in the background. A JS/TS WebContainer
 * runtime.start boots, mounts, installs and spawns the dev server — 12–58 s
 * that no lesson can plan around, since install time varies run to run.
 * Lessons start it early, during whiteboard and editor scenes, so the server
 * is up by the time the preview opens; performed in order it held every
 * action planned during the install, and the narration ran seconds ahead of
 * the board it was describing. A Python start stays in the foreground: it
 * installs nothing, and it is the program run itself, so an edit planned
 * after it must not reach main.py before python3 has read it.
 */
export function performsInBackground(
  action: StudioPlanAction,
  plan: Pick<StudioPlan, "workspace">,
): action is RuntimeStartAction {
  return action.type === "runtime.start" && !runtimeStartIsOneShotRun(plan.workspace.lessonType);
}

/**
 * Whether an action must wait for an in-flight background runtime.start to
 * settle before it begins: true for everything that talks to the runtime, its
 * output or its preview. Exhaustive on purpose — a new action type does not
 * compile until someone decides which side it is on.
 */
export function actionAwaitsRuntimeStart(action: StudioPlanAction): boolean {
  switch (action.type) {
    // A second start would join (or race) the install the first one began.
    case "runtime.start":
    case "runtime.waitForReady":
    // Writes to the runner console the start's process is writing to.
    case "runtime.run":
    // Reads lines the runtime prints.
    case "console.point":
    case "expect.output":
    case "preview.open":
    case "preview.click":
    case "preview.input":
    case "preview.scroll":
    case "preview.route":
    case "expect.preview":
      return true;
    // Aiming at a preview element asks the preview bridge where it is.
    case "cursor.moveTo":
      return action.target.kind === "preview";
    // The runner dock's open/shut state is UI the runtime never writes (only
    // runtime.run and these two actions set it), so folding the dock away
    // during an install is safe.
    case "runtime.collapseDock":
    case "runtime.expandDock":
    case "workspace.openFile":
    case "editor.type":
    case "editor.select":
    case "slide.show":
    case "slide.close":
    case "whiteboard.apply":
    case "expect.file":
      return false;
  }
}

interface RuntimeStartInFlight {
  actionId: string;
  /** Resolves (never rejects) once the start's receipt is recorded. */
  settled: Promise<void>;
  /** Records a cancelled receipt for a start the render stops waiting for. */
  abandon: () => void;
}

/** Resolves when `settled` does; rejects with the cancellation once `signal` aborts. */
function settledUnlessAborted(settled: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelledError());
      return;
    }
    const onAbort = () => reject(cancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    void settled.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

export async function performPlan({
  plan,
  driver,
  clock,
  signal,
  abort,
  onProgress,
}: PerformPlanOptions): Promise<PerformPlanResult> {
  // One slot per plan action: a background runtime.start acknowledges after
  // actions planned later, but the returned receipts stay in plan order, so
  // the repeatability semantics' action sequence does not depend on how long
  // an install took. onProgress still reports each receipt as it lands.
  const slots: (ActionReceipt | undefined)[] = Array.from({ length: plan.actions.length });
  let failure: string | null = null;

  const record = (index: number, receipt: ActionReceipt) => {
    slots[index] = receipt;
    onProgress?.(receipt);
  };
  const skip = (index: number, action: StudioPlanAction, error?: string) =>
    record(index, {
      actionId: action.id,
      actionType: action.type,
      status: "skipped",
      plannedAtMs: action.at,
      startedAtMs: null,
      endedAtMs: null,
      ...(error === undefined ? {} : { error }),
    });
  // The first failure owns the render's error and aborts the shared signal;
  // anything that fails after it only failed because of that abort.
  const fail = (action: StudioPlanAction, message: string) => {
    if (failure !== null) return;
    failure = message;
    abort(`Action "${action.id}" failed: ${message}`);
  };
  const failedReceipt = (
    action: StudioPlanAction,
    startedAtMs: number,
    error: unknown,
  ): ActionReceipt => ({
    actionId: action.id,
    actionType: action.type,
    status: "failed",
    plannedAtMs: action.at,
    startedAtMs,
    endedAtMs: clock.nowMs(),
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof StudioActionError && error.detail ? { detail: error.detail } : {}),
  });

  // The in-flight background runtime.start, if any. Only one can be: a second
  // start awaits the first (actionAwaitsRuntimeStart). Assigned from inside
  // startInBackground, so declared without the narrowing a plain `= null`
  // initializer would pin on it.
  let runtimeStart = null as RuntimeStartInFlight | null;

  const startInBackground = (index: number, action: RuntimeStartAction) => {
    const startedAtMs = clock.nowMs();
    let done = false;
    const finish = (receipt: ActionReceipt): boolean => {
      if (done) return false;
      done = true;
      record(index, receipt);
      return true;
    };
    const settled = invokeWithDeadline(action, driver, signal).then(
      (detail) => {
        finish({
          actionId: action.id,
          actionType: action.type,
          status: "ok",
          plannedAtMs: action.at,
          startedAtMs,
          endedAtMs: clock.nowMs(),
          detail,
        });
      },
      (error: unknown) => {
        // Failing the render here, not at the next runtime action: the
        // deadline has abandoned a command that may still be installing, and
        // only aborting the shared signal stops an orphan from mutating state
        // behind a failed report — besides not performing minutes of a render
        // that can no longer pass.
        const receipt = failedReceipt(action, startedAtMs, error);
        if (finish(receipt)) fail(action, receipt.error!);
      },
    );
    runtimeStart = {
      actionId: action.id,
      settled,
      abandon: () => {
        finish(failedReceipt(action, startedAtMs, cancelledError()));
      },
    };
  };

  for (const [index, action] of plan.actions.entries()) {
    if (failure !== null || signal.aborted) {
      skip(index, action);
      continue;
    }

    try {
      const waitMs = action.at - clock.nowMs();
      if (waitMs > 0) {
        await abortableSleep(waitMs, signal);
      }
      // A runtime action — or one authored `afterAction` the start — begins
      // once the start has settled, and records that as its start, so any
      // lateness the install causes stays visible to the timing gate.
      const pending = runtimeStart;
      if (
        pending !== null &&
        (actionAwaitsRuntimeStart(action) || plan.dependencies?.[action.id] === pending.actionId)
      ) {
        await settledUnlessAborted(pending.settled, signal);
      }
    } catch (error) {
      failure ??= error instanceof Error ? error.message : RENDER_CANCELLED_MESSAGE;
      skip(index, action, failure);
      continue;
    }
    // The start this action waited for failed: its error is the render's.
    if (failure !== null) {
      skip(index, action, failure);
      continue;
    }

    if (performsInBackground(action, plan)) {
      startInBackground(index, action);
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
      record(index, {
        actionId: action.id,
        actionType: action.type,
        status: "ok",
        plannedAtMs: action.at,
        startedAtMs,
        endedAtMs: clock.nowMs(),
        detail,
      });
    } catch (error) {
      // A background start that failed while this action ran aborted the
      // shared signal under it: the action did nothing wrong, so it reads as
      // skipped with the start's error, leaving one causal failed receipt.
      if (failure !== null) {
        record(index, {
          ...failedReceipt(action, startedAtMs, error),
          status: "skipped",
          error: failure,
        });
        continue;
      }
      const receipt = failedReceipt(action, startedAtMs, error);
      record(index, receipt);
      fail(action, receipt.error!);
    }
  }

  // A start nothing waited on still decides the render: the perform phase
  // ends only once it has settled, and its failure is the render's. A
  // cancelled render stops waiting at once.
  const pending = runtimeStart;
  if (pending !== null) {
    try {
      await settledUnlessAborted(pending.settled, signal);
    } catch {
      pending.abandon();
      failure ??= RENDER_CANCELLED_MESSAGE;
    }
  }

  return {
    status: failure === null ? "completed" : "failed",
    receipts: slots.filter((receipt) => receipt !== undefined),
    error: failure,
  };
}
