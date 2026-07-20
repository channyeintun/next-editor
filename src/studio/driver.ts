import { monaco, workspacePathFromMonacoModelUri } from "../monaco";
import type { WorkspaceActions } from "../contexts/WorkspaceContext";
import type { RuntimePanelStoreInstance } from "../stores/runtimePanelStore";
import { GoPlaygroundClient, GoPlaygroundServiceError } from "../runtime/goPlayground/client";
import {
  goRunResultToConsoleLines,
  goRunServiceErrorToConsoleLines,
  goRunStartedConsoleLines,
} from "../runtime/goPlayground/console";
import { appendGoConsoleLines } from "../runtime/goPlayground/consoleStore";
import { collectGoPlaygroundFiles } from "../runtime/goPlayground/files";
import type { GoPlaygroundRunResult } from "../runtime/goPlayground/types";
import { isWorkspaceTextFile } from "../types/workspace";
import { StudioActionError, abortableSleep, resolveAnchorOffset, waitUntil } from "./async";
import { easeInOutCubic } from "./cadence";
import type {
  StudioPlan,
  StudioRuntimeMode,
  StudioTargetRef,
  TextAnchor,
  TypingChunk,
} from "./plan";
import { describeStudioTarget, resolveStudioTarget } from "./targets";

export { StudioActionError, abortableSleep, resolveAnchorOffset, waitUntil };

/**
 * StudioDriver — the narrow application seam the Performer drives
 * (docs/agent-lesson-production.md §4.2). Every command goes through the same
 * domain operation the UI uses (workspace store triggers, live Monaco edits,
 * the shared Go console append path), resolves only once the requested state
 * is observable, and fails closed instead of guessing.
 */

export interface StudioDriverDeps {
  getEditor: () => monaco.editor.IStandaloneCodeEditor | null;
  workspace: Pick<WorkspaceActions, "getFile" | "getProject" | "setActiveFilePath">;
  /** Records the active-file change on the workspace track (same call the sidebar makes). */
  notifyWorkspaceEvent: () => void;
  runtimePanelStore: RuntimePanelStoreInstance;
  runtimeMode: StudioRuntimeMode;
  runFixture: StudioPlan["runtime"]["fixture"];
  signal: AbortSignal;
}

export interface StudioDriver {
  openFile(path: string, timeoutMs: number): Promise<Record<string, unknown>>;
  typeText(input: {
    path: string;
    anchor: TextAnchor;
    chunks: readonly TypingChunk[];
  }): Promise<Record<string, unknown>>;
  moveCursor(input: {
    target: StudioTargetRef;
    durationMs: number;
  }): Promise<Record<string, unknown>>;
  runWorkspace(timeoutMs: number): Promise<Record<string, unknown>>;
  waitForOutput(input: { contains: string; timeoutMs: number }): Promise<Record<string, unknown>>;
  expectFile(input: { path: string; contains: string }): Promise<Record<string, unknown>>;
  dispose(): void;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new StudioActionError("The render was cancelled");
  }
}

const CURSOR_STEP_MS = 32;

export function createStudioDriver(deps: StudioDriverDeps): StudioDriver {
  const { signal } = deps;
  let goClient: GoPlaygroundClient | null = null;
  let lastCursorPoint: { x: number; y: number } | null = null;

  const onAbort = () => {
    goClient?.abort();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const activeModelPath = (): string | null => {
    const model = deps.getEditor()?.getModel();
    return model ? workspacePathFromMonacoModelUri(model.uri) : null;
  };

  const requireEditorForPath = (
    path: string,
  ): { editor: monaco.editor.IStandaloneCodeEditor; model: monaco.editor.ITextModel } => {
    const editor = deps.getEditor();
    const model = editor?.getModel();
    if (!editor || !model) {
      throw new StudioActionError("No live editor is attached");
    }
    const modelPath = workspacePathFromMonacoModelUri(model.uri);
    if (modelPath !== path) {
      throw new StudioActionError(
        `The active editor shows "${modelPath ?? "(none)"}" but the action targets "${path}"`,
      );
    }
    return { editor, model };
  };

  const dispatchCursorPoint = (x: number, y: number, element: Element) => {
    // Synthetic pointer input rides the exact capture path human input uses:
    // the mouse-tracking actor listens on the document in the capture phase,
    // so dispatching on the element under the point yields target-aware
    // samples (`createCursorPositionFromClientPoint` walks up from `target`).
    const under = document.elementFromPoint(x, y) ?? element;
    under.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerType: "mouse",
        buttons: 0,
      }),
    );
    lastCursorPoint = { x, y };
  };

  return {
    async openFile(path, timeoutMs) {
      const file = deps.workspace.getFile(path);
      if (!file) {
        throw new StudioActionError(`Workspace has no file "${path}"`);
      }

      deps.workspace.setActiveFilePath(path);
      deps.notifyWorkspaceEvent();

      await waitUntil(() => activeModelPath() === path, {
        timeoutMs,
        signal,
        description: `the editor to show "${path}"`,
      });
      return { path };
    },

    async typeText({ path, anchor, chunks }) {
      const { editor, model } = requireEditorForPath(path);
      const startContent = model.getValue();
      const startOffset = resolveAnchorOffset(startContent, anchor);
      if (startOffset === null) {
        throw new StudioActionError(
          `Anchor occurrence ${anchor.occurrence} of ${JSON.stringify(anchor.after)} not found in "${path}"`,
        );
      }

      editor.focus();
      const startPosition = model.getPositionAt(startOffset);
      editor.setSelection(
        new monaco.Selection(
          startPosition.lineNumber,
          startPosition.column,
          startPosition.lineNumber,
          startPosition.column,
        ),
      );
      editor.revealPositionInCenterIfOutsideViewport(startPosition);

      let insertOffset = startOffset;
      for (const chunk of chunks) {
        await abortableSleep(chunk.delayMs, signal);
        const { editor: liveEditor, model: liveModel } = requireEditorForPath(path);
        const position = liveModel.getPositionAt(insertOffset);
        // executeEdits (not the "type" command) so auto-closing pairs and
        // auto-indent cannot alter the planned text; it still flows through
        // onDidChangeModelContent into the workspace bridge and the recorder's
        // exact-edit capture.
        const applied = liveEditor.executeEdits("studio-performer", [
          {
            range: new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column,
            ),
            text: chunk.text,
            forceMoveMarkers: true,
          },
        ]);
        if (!applied) {
          throw new StudioActionError(`Monaco rejected an edit in "${path}"`);
        }
        insertOffset += chunk.text.length;
        const caret = liveModel.getPositionAt(insertOffset);
        liveEditor.setSelection(
          new monaco.Selection(caret.lineNumber, caret.column, caret.lineNumber, caret.column),
        );
        liveEditor.revealPositionInCenterIfOutsideViewport(caret);
      }

      const expected = chunks.map((chunk) => chunk.text).join("");
      const { model: finalModel } = requireEditorForPath(path);
      const inserted = finalModel.getValue().slice(startOffset, startOffset + expected.length);
      if (inserted !== expected) {
        throw new StudioActionError(
          `Typed content diverged in "${path}": expected ${JSON.stringify(expected.slice(0, 40))}…, found ${JSON.stringify(inserted.slice(0, 40))}…`,
        );
      }

      // The Monaco→workspace bridge applies synchronously on the change event;
      // give it a short bounded window anyway so a broken bridge fails loudly
      // here rather than as a silently divergent workspace snapshot.
      await waitUntil(
        () => {
          const file = deps.workspace.getFile(path);
          return (
            file !== null && isWorkspaceTextFile(file) && file.content === finalModel.getValue()
          );
        },
        {
          timeoutMs: 1000,
          signal,
          description: `the workspace store to sync "${path}"`,
        },
      );

      return { path, insertedChars: expected.length };
    },

    async moveCursor({ target, durationMs }) {
      if (!resolveStudioTarget(target)) {
        throw new StudioActionError(`Missing studio target: ${describeStudioTarget(target)}`);
      }

      const from = lastCursorPoint ?? {
        x: Math.round(window.innerWidth / 2),
        y: Math.round(window.innerHeight / 2),
      };
      const started = performance.now();

      for (;;) {
        throwIfAborted(signal);
        const elapsed = performance.now() - started;
        const progress = Math.min(1, elapsed / durationMs);
        const eased = easeInOutCubic(progress);
        // Re-resolve every step: a React re-render can swap the DOM node, and
        // layout can shift while we tween.
        const element = resolveStudioTarget(target);
        const rect = element?.getBoundingClientRect();
        if (!element || !rect || (rect.width === 0 && rect.height === 0)) {
          throw new StudioActionError(
            `Studio target became invisible: ${describeStudioTarget(target)}`,
          );
        }
        const destX = rect.left + rect.width / 2;
        const destY = rect.top + rect.height / 2;
        dispatchCursorPoint(
          Math.round(from.x + (destX - from.x) * eased),
          Math.round(from.y + (destY - from.y) * eased),
          element,
        );
        if (progress >= 1) {
          break;
        }
        // setTimeout stepping (not rAF): rAF pauses in background tabs and
        // would stall an unattended render mid-tween.
        await abortableSleep(CURSOR_STEP_MS, signal);
      }

      return { target: describeStudioTarget(target) };
    },

    async runWorkspace(timeoutMs) {
      const project = deps.workspace.getProject();
      const goFiles = collectGoPlaygroundFiles(project);
      if (goFiles.length === 0) {
        throw new StudioActionError("The workspace has no .go files to run");
      }

      appendGoConsoleLines(
        deps.runtimePanelStore,
        goRunStartedConsoleLines(goFiles.map((file) => file.path)),
      );

      let result: GoPlaygroundRunResult;
      if (deps.runtimeMode === "fixture") {
        await abortableSleep(deps.runFixture.latencyMs, signal);
        result = deps.runFixture.result;
      } else {
        goClient ??= new GoPlaygroundClient();
        let deadlineHit = false;
        const deadline = window.setTimeout(() => {
          deadlineHit = true;
          goClient?.abort();
        }, timeoutMs);
        try {
          result = await goClient.run(goFiles);
        } catch (error) {
          if (error instanceof GoPlaygroundServiceError) {
            if (error.kind === "aborted") {
              throw new StudioActionError(
                deadlineHit
                  ? `The live run did not finish within ${timeoutMs}ms`
                  : "The render was cancelled",
              );
            }
            appendGoConsoleLines(
              deps.runtimePanelStore,
              goRunServiceErrorToConsoleLines(error.kind, error.message),
            );
            throw new StudioActionError(`Live run failed (${error.kind}): ${error.message}`);
          }
          throw new StudioActionError(
            error instanceof Error ? error.message : "The live run failed",
          );
        } finally {
          window.clearTimeout(deadline);
        }
      }

      appendGoConsoleLines(deps.runtimePanelStore, goRunResultToConsoleLines(result));

      if (result.status !== "success") {
        throw new StudioActionError(
          `The program did not run cleanly (status ${result.status}, exit ${result.exitCode ?? "?"})`,
        );
      }

      return {
        mode: deps.runtimeMode,
        status: result.status,
        exitCode: result.exitCode ?? 0,
      };
    },

    async waitForOutput({ contains, timeoutMs }) {
      let matchedLine: string | null = null;
      await waitUntil(
        () => {
          const lines = deps.runtimePanelStore.getSnapshot().context.consoleLines;
          const errorLine = lines.find((line) => line.startsWith("[go-run error]"));
          if (errorLine) {
            throw new StudioActionError(`The run reported an error: ${errorLine}`);
          }
          matchedLine = lines.find((line) => line.includes(contains)) ?? null;
          return matchedLine !== null;
        },
        {
          timeoutMs,
          signal,
          description: `console output containing ${JSON.stringify(contains)}`,
        },
      );
      return { matchedLine };
    },

    async expectFile({ path, contains }) {
      const file = deps.workspace.getFile(path);
      if (!file || !isWorkspaceTextFile(file)) {
        throw new StudioActionError(`Workspace has no text file "${path}"`);
      }
      if (!file.content.includes(contains)) {
        throw new StudioActionError(`File "${path}" does not contain ${JSON.stringify(contains)}`);
      }
      return { path };
    },

    dispose() {
      signal.removeEventListener("abort", onAbort);
      goClient?.abort();
      goClient = null;
    },
  };
}
