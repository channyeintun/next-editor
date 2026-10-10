import type { WebContainerRuntimeRecordingSnapshot } from "../../contexts/WebContainerRuntimeContext";
import type { StudioPreviewCommandResult } from "../../utils/iframeStudioCommandBridge";
import { StudioActionError, abortableSleep, throwIfAborted, waitUntil } from "../async";
import type { StudioRuntime } from "../plan";
import { previewCommandTarget, previewExpectationMismatches } from "../previewExpectation";
import type { StudioDriver, StudioDriverDeps } from "./index";
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
const PREVIEW_HANDSHAKE_PING_TIMEOUT_MS = 500;
const PREVIEW_HANDSHAKE_RETRY_INTERVAL_MS = 100;

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

export function webContainerCommands(
  deps: Pick<
    StudioDriverDeps,
    "runtime" | "webContainerRuntime" | "workspace" | "preview" | "notifyPreviewEvent" | "signal"
  >,
): Pick<
  StudioDriver,
  "startRuntime" | "waitForRuntimeReady" | "openPreview" | "executePreviewCommand" | "expectPreview"
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
      if (deps.workspace.getProject().lessonType === "python") {
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
