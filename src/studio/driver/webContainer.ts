import type { WebContainerRuntimeRecordingSnapshot } from "../../contexts/WebContainerRuntimeContext";
import type {
  StudioPreviewCommandResult,
  StudioPreviewTargetBox,
} from "../../utils/iframeStudioCommandBridge";
import { StudioActionError, abortableSleep, throwIfAborted, waitUntil } from "../async";
import type { StudioRuntime } from "../plan";
import { previewCommandTarget, previewExpectationMismatches } from "../previewExpectation";
import { runtimeStartIsOneShotRun } from "../runtimeContract";
import { resolveStudioTarget } from "../targets";
import type { StudioDriver, StudioDriverDeps } from "./index";
import { isCoveredAt, pointAndRest, roundPoint, type StudioPointer } from "./pointer";
import { RECORDER_ASSIGNS_TIMESTAMP } from "./recorderTimestamp";

/**
 * The WebContainer runtime and its preview: starting the runtime, waiting for
 * its server, the preview.open handshake, preview commands and expectations,
 * and where a preview element sits on screen for the pointer.
 */

// The preview.open handshake re-sends instead of waiting. A command message
// posted before the frame's document exists lands in a window with no listener
// and is dropped, so that request can never be answered — only time out. One
// long ping would therefore spend the whole action budget proving nothing,
// which is why each attempt is short and the loop keeps knocking until the
// injected bridge answers.
export const PREVIEW_HANDSHAKE_PING_TIMEOUT_MS = 500;
export const PREVIEW_HANDSHAKE_RETRY_INTERVAL_MS = 100;

type StudioWebContainerRuntime = Extract<StudioRuntime, { kind: "webcontainer" }>;

function webContainerDiagnostic(snapshot: WebContainerRuntimeRecordingSnapshot) {
  return {
    status: snapshot.status,
    previewUrl: snapshot.previewUrl,
    previewPort: snapshot.previewPort,
    activeCommand: snapshot.activeCommand,
    errorMessage: snapshot.errorMessage,
    lastOutput: snapshot.lastOutput,
    latestPreviewMessage: snapshot.latestPreviewMessage,
    latestLifecycleEvent: snapshot.latestLifecycleEvent,
  };
}

function assertWebContainerHealthy(snapshot: WebContainerRuntimeRecordingSnapshot): void {
  if (snapshot.status === "error" || snapshot.errorMessage) {
    throw new StudioActionError(
      `WebContainer runtime failed: ${snapshot.errorMessage ?? "unknown runtime error"}`,
      { runtime: webContainerDiagnostic(snapshot) },
    );
  }
  if (snapshot.latestPreviewMessage) {
    throw new StudioActionError(
      `Preview ${snapshot.latestPreviewMessage.kind}: ${snapshot.latestPreviewMessage.text}`,
      { runtime: webContainerDiagnostic(snapshot) },
    );
  }
}

// Where a preview element sits in host coordinates. The element lives in a
// cross-origin frame, so the preview bridge reports its box and the point is
// mapped through the frame's own box. Null when it is hidden or scrolled out
// of the preview's view — the pointer has nothing on screen to aim at then.
export async function previewAimPoint(
  deps: Pick<StudioDriverDeps, "preview" | "signal">,
  testId: string,
  frame: Element,
  timeoutMs: number,
): Promise<{ x: number; y: number } | null> {
  const acknowledgement = await deps.preview.executeCommand(
    { type: "inspect", target: { testId } },
    { timeoutMs, signal: deps.signal },
  );
  const box = acknowledgement.targetBox;
  if (!box || (box.width === 0 && box.height === 0)) {
    return null;
  }
  const centerX = box.left + box.width / 2;
  const centerY = box.top + box.height / 2;
  if (centerX < 0 || centerY < 0 || centerX > box.viewportWidth || centerY > box.viewportHeight) {
    return null;
  }
  const frameRect = frame.getBoundingClientRect();
  return {
    x: frameRect.left + centerX * (frameRect.width / Math.max(1, box.viewportWidth)),
    y: frameRect.top + centerY * (frameRect.height / Math.max(1, box.viewportHeight)),
  };
}

// An element at most this tall is a line of something — a heading, a label, a
// button, a field — and is pointed at from underneath. Taller, it is a region
// (a card, a list, an image), and the pointer goes to the middle of it.
const PREVIEW_LINE_MAX_HEIGHT_PX = 64;

// How long a preview.point waits between looks for an element that is not
// mounted yet.
const PREVIEW_POINT_RETRY_MS = 100;

/**
 * Where the pointer rests to point at a preview element (`preview.point`), in
 * the preview's own viewport, or null when none of the element is on screen.
 *
 * The arrow's tip is its top-left corner and its body hangs down and to the
 * right, so a line is pointed at from just under the middle of its words: the
 * words stay readable. A region taller than a line is pointed at in the middle
 * of the part of it that is in view.
 */
export function previewPointAim(box: StudioPreviewTargetBox): { x: number; y: number } | null {
  const content = box.content ?? box;
  const left = Math.max(0, content.left);
  const top = Math.max(0, content.top);
  const right = Math.min(box.viewportWidth, content.left + content.width);
  const bottom = Math.min(box.viewportHeight, content.top + content.height);
  if (right <= left || bottom <= top) {
    return null;
  }
  const x = (left + right) / 2;
  const under = content.top + content.height + 2;
  return content.height <= PREVIEW_LINE_MAX_HEIGHT_PX && under <= box.viewportHeight
    ? { x, y: under }
    : { x, y: (top + bottom) / 2 };
}

export function webContainerCommands(
  deps: Pick<
    StudioDriverDeps,
    "runtime" | "webContainerRuntime" | "workspace" | "preview" | "notifyPreviewEvent" | "signal"
  >,
  pointer: StudioPointer,
): Pick<
  StudioDriver,
  | "startRuntime"
  | "waitForRuntimeReady"
  | "openPreview"
  | "executePreviewCommand"
  | "pointPreview"
  | "expectPreview"
> {
  const { signal } = deps;

  // The WebContainer commands' guard. Returns the narrowed runtime so a caller
  // that captures it keeps the narrowing inside its closures. `verb` agrees
  // with a plural subject ("Preview commands require …").
  const requireWebContainerRuntime = (
    actionLabel: string,
    verb: "requires" | "require" = "requires",
  ): StudioWebContainerRuntime => {
    if (deps.runtime.kind !== "webcontainer") {
      throw new StudioActionError(
        `${actionLabel} ${verb} runtime kind "webcontainer", got "${deps.runtime.kind}"`,
      );
    }
    return deps.runtime;
  };

  // A failed runtime wait keeps the diagnostic it already carries (a health
  // assertion's) or gains the runtime's current one (a plain timeout's).
  const withRuntimeDiagnostic = (error: unknown): StudioActionError =>
    error instanceof StudioActionError && error.detail
      ? error
      : new StudioActionError(error instanceof Error ? error.message : String(error), {
          runtime: webContainerDiagnostic(deps.webContainerRuntime.getSnapshot()),
        });

  return {
    async startRuntime(timeoutMs) {
      const runtime = requireWebContainerRuntime("runtime.start");
      try {
        await deps.webContainerRuntime.getActions().startRuntime();
      } catch (error) {
        throw new StudioActionError(
          `WebContainer startup failed: ${error instanceof Error ? error.message : String(error)}`,
          { runtime: webContainerDiagnostic(deps.webContainerRuntime.getSnapshot()) },
        );
      }
      // Server-style JS/TS runners acknowledge once the process has spawned;
      // runtime.waitForReady owns their later server/port gate. Python is a
      // console-only one-shot runner, so no later readiness action is legal:
      // runtime.start itself must wait for a clean process exit (`ready`) or the
      // lesson could pass after printing the expected line while still hung—or
      // before a later non-zero exit is recorded.
      if (runtimeStartIsOneShotRun(deps.workspace.getProject().lessonType)) {
        try {
          await waitUntil(
            () => {
              const snapshot = deps.webContainerRuntime.getSnapshot();
              assertWebContainerHealthy(snapshot);
              return snapshot.status === "ready";
            },
            {
              timeoutMs,
              signal,
              description: "the Python runner to exit cleanly",
              intervalMs: 50,
            },
          );
        } catch (error) {
          throw withRuntimeDiagnostic(error);
        }
      }
      const snapshot = deps.webContainerRuntime.getSnapshot();
      assertWebContainerHealthy(snapshot);
      return {
        adapterVersion: runtime.adapterVersion,
        initCommand: runtime.initCommand,
        runCommand: runtime.runCommand,
        status: snapshot.status,
      };
    },

    async waitForRuntimeReady(timeoutMs) {
      const runtime = requireWebContainerRuntime("runtime.waitForReady");
      try {
        await waitUntil(
          () => {
            const snapshot = deps.webContainerRuntime.getSnapshot();
            assertWebContainerHealthy(snapshot);
            return (
              snapshot.status === "ready" &&
              Boolean(snapshot.previewUrl) &&
              (runtime.expectedPort === undefined || snapshot.previewPort === runtime.expectedPort)
            );
          },
          {
            timeoutMs,
            signal,
            description: `WebContainer server${runtime.expectedPort ? ` on port ${runtime.expectedPort}` : ""} to become ready`,
            intervalMs: 50,
          },
        );
      } catch (error) {
        throw withRuntimeDiagnostic(error);
      }
      const snapshot = deps.webContainerRuntime.getSnapshot();
      return {
        status: snapshot.status,
        previewUrl: snapshot.previewUrl,
        previewPort: snapshot.previewPort,
      };
    },

    async openPreview({ mode, timeoutMs }) {
      requireWebContainerRuntime("preview.open");
      assertWebContainerHealthy(deps.webContainerRuntime.getSnapshot());
      // Both phases below share this single deadline: `timeoutMs` is the whole
      // action's budget, matching what the Performer races the call against.
      // Spending it once per phase made the action unsatisfiable by
      // construction — the outer deadline always fired first, which is why the
      // failure surfaced as a bare "did not acknowledge" with no diagnostic.
      const deadlineAt = performance.now() + timeoutMs;
      const remainingMs = () => Math.max(0, deadlineAt - performance.now());

      deps.preview.open(mode);
      await waitUntil(() => deps.preview.getState()?.isOpen === true, {
        timeoutMs: remainingMs(),
        signal,
        description: `the ${mode} preview panel to open`,
      });

      // Opening the panel only mounts the frame. The controller effect then
      // assigns `src`, and the dev server's document — carrying the injected
      // bridge — starts loading after that. runtime.waitForReady proves the
      // server is listening, never that this frame has finished loading from
      // it, so the bridge is what has to be waited on here.
      let acknowledgement: StudioPreviewCommandResult | null = null;
      let handshakeError: unknown = null;
      while (acknowledgement === null && remainingMs() > 0) {
        throwIfAborted(signal);
        assertWebContainerHealthy(deps.webContainerRuntime.getSnapshot());
        try {
          acknowledgement = await deps.preview.executeCommand(
            { type: "ping" },
            {
              timeoutMs: Math.min(PREVIEW_HANDSHAKE_PING_TIMEOUT_MS, remainingMs()),
              signal,
            },
          );
        } catch (error) {
          handshakeError = error;
          await abortableSleep(
            Math.min(PREVIEW_HANDSHAKE_RETRY_INTERVAL_MS, remainingMs()),
            signal,
          );
        }
      }
      if (acknowledgement === null) {
        const cause =
          handshakeError instanceof Error
            ? handshakeError.message
            : handshakeError === null
              ? "the panel took the whole budget to open"
              : String(handshakeError);
        throw new StudioActionError(
          `Preview iframe did not become ready within ${timeoutMs}ms: ${cause}`,
          { runtime: webContainerDiagnostic(deps.webContainerRuntime.getSnapshot()) },
        );
      }
      assertWebContainerHealthy(deps.webContainerRuntime.getSnapshot());
      return { mode, bridge: "ready", route: acknowledgement.route };
    },

    async executePreviewCommand({ command, timeoutMs }) {
      requireWebContainerRuntime("Preview commands", "require");
      assertWebContainerHealthy(deps.webContainerRuntime.getSnapshot());
      let acknowledgement: StudioPreviewCommandResult;
      try {
        acknowledgement = await deps.preview.executeCommand(command, { timeoutMs, signal });
      } catch (error) {
        throw new StudioActionError(
          `Preview ${command.type} command failed: ${error instanceof Error ? error.message : String(error)}`,
          { command },
        );
      }
      assertWebContainerHealthy(deps.webContainerRuntime.getSnapshot());
      return { acknowledgement };
    },

    async pointPreview({ target, durationMs, timeoutMs }) {
      requireWebContainerRuntime("preview.point");
      const described = `preview element "${target.value}"`;
      const deadlineAt = performance.now() + timeoutMs;
      const remainingMs = () => Math.max(0, deadlineAt - performance.now());

      // The element may not be mounted yet (the app is still rendering what
      // the narration is about to name), so look until it is or the deadline.
      let frame: Element | null = null;
      let box: StudioPreviewTargetBox | undefined;
      let lookupError: unknown = null;
      while (box === undefined) {
        throwIfAborted(signal);
        assertWebContainerHealthy(deps.webContainerRuntime.getSnapshot());
        frame = resolveStudioTarget({ kind: "preview", testId: target.value });
        if (frame) {
          try {
            const acknowledgement = await deps.preview.executeCommand(
              { type: "inspect", target: previewCommandTarget(target) },
              { timeoutMs: Math.max(1, Math.min(2_000, remainingMs())), signal },
            );
            box = acknowledgement.targetBox;
          } catch (error) {
            throwIfAborted(signal);
            lookupError = error;
          }
        }
        if (box === undefined) {
          if (remainingMs() <= 0) {
            const cause =
              lookupError instanceof Error
                ? lookupError.message
                : frame
                  ? "the preview reported no box for it"
                  : "the preview is not open";
            throw new StudioActionError(
              `The ${described} could not be found within ${timeoutMs}ms: ${cause}`,
            );
          }
          await abortableSleep(Math.min(PREVIEW_POINT_RETRY_MS, remainingMs()), signal);
        }
      }

      const inFrame = previewPointAim(box);
      if (!frame || !inFrame) {
        // Pointing at something the viewer cannot see teaches nothing, so this
        // fails the render rather than skipping, the way a console line that
        // scrolled away does.
        throw new StudioActionError(
          `The ${described} is hidden or scrolled out of the preview's view — add a preview.scroll before the point so it is on screen`,
        );
      }
      const surface = frame;
      const scaleX = box.viewportWidth > 0 ? 1 / box.viewportWidth : 0;
      const scaleY = box.viewportHeight > 0 ? 1 / box.viewportHeight : 0;
      // The frame can still be settling into its dock, so its box is read on
      // every step; the element's place inside it was measured once.
      const aim = () => {
        const rect = surface.getBoundingClientRect();
        return {
          x: rect.left + inFrame.x * scaleX * rect.width,
          y: rect.top + inFrame.y * scaleY * rect.height,
        };
      };
      if (isCoveredAt(roundPoint(aim()), surface)) {
        throw new StudioActionError(
          `The ${described} is covered on screen — is a slide or the whiteboard open over the preview?`,
        );
      }
      const { travelMs } = await pointAndRest(pointer, { aim, surface, durationMs, signal });
      return { testId: target.value, travelMs };
    },

    async expectPreview({ actionId, target, textContains, value, route, attribute, timeoutMs }) {
      requireWebContainerRuntime("expect.preview");

      try {
        assertWebContainerHealthy(deps.webContainerRuntime.getSnapshot());
        const inspection = await deps.preview.executeCommand(
          { type: "inspect", target: previewCommandTarget(target) },
          { timeoutMs, signal },
        );
        const mismatches = previewExpectationMismatches(
          { route, textContains, value, attribute },
          inspection,
        );
        if (mismatches.length > 0) {
          throw new StudioActionError(`Preview expectation failed: ${mismatches.join("; ")}`, {
            inspection,
          });
        }
        assertWebContainerHealthy(deps.webContainerRuntime.getSnapshot());
        deps.notifyPreviewEvent({
          type: "preview_checkpoint",
          timestamp: RECORDER_ASSIGNS_TIMESTAMP,
          checkpoint: {
            actionId,
            route: inspection.route,
            target: inspection.target,
          },
        });
        return { inspection };
      } catch (error) {
        let diagnosticScreenshot: Record<string, unknown> | undefined;
        try {
          diagnosticScreenshot = { ...(await deps.preview.captureScreenshot()) };
        } catch (screenshotError) {
          diagnosticScreenshot = {
            error:
              screenshotError instanceof Error ? screenshotError.message : String(screenshotError),
          };
        }
        const detail = error instanceof StudioActionError ? error.detail : undefined;
        throw new StudioActionError(error instanceof Error ? error.message : String(error), {
          ...detail,
          diagnosticScreenshot,
        });
      }
    },
  };
}
