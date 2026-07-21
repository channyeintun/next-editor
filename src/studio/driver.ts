import { monaco, workspacePathFromMonacoModelUri } from "../monaco";
import type { WorkspaceActions } from "../contexts/WorkspaceContext";
import type { RuntimePanelStoreInstance } from "../stores/runtimePanelStore";
import { selectPreviewState, type SlidesStoreInstance } from "../stores/slidesStore";
import type { WhiteboardStoreInstance } from "../stores/whiteboardStore";
import { appendRunnerConsoleLines } from "../runtime/goPlayground/consoleStore";
import type { SlideEvent } from "../core/src/slides";
import type { WhiteboardEvent } from "../core/src/whiteboard";
import { isWorkspaceTextFile } from "../types/workspace";
import { StudioActionError, abortableSleep, resolveAnchorOffset, waitUntil } from "./async";
import { chunkPlacements, easeInOutCubic } from "./cadence";
import {
  PlaygroundTerminalError,
  preparePlaygroundRun,
  runErrorPrefixFor,
} from "./playgroundRuntime";
import type {
  StudioRuntime,
  StudioRuntimeMode,
  StudioTargetRef,
  StudioWhiteboardAsset,
  TextAnchor,
  TypingChunk,
} from "./plan";
import { describeStudioTarget, resolveStudioTarget } from "./targets";
import { buildWhiteboardElement } from "./whiteboardAssets";

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
  slidesStore: SlidesStoreInstance;
  whiteboardStore: WhiteboardStoreInstance;
  /** Records a slide event on the slide track (same send the slides controller makes). */
  notifySlideEvent: (event: SlideEvent) => void;
  /** Records a whiteboard event (same send the whiteboard controller makes). */
  notifyWhiteboardEvent: (event: WhiteboardEvent) => void;
  runtimeMode: StudioRuntimeMode;
  runtime: StudioRuntime;
  planSeed: number;
  whiteboardAssets: readonly StudioWhiteboardAsset[];
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
  showSlide(input: { slideId: string; maximized: boolean }): Promise<Record<string, unknown>>;
  closeSlide(): Promise<Record<string, unknown>>;
  applyWhiteboard(input: {
    open?: boolean;
    maximized?: boolean;
    upsertIds: readonly string[];
  }): Promise<Record<string, unknown>>;
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
  let lastCursorPoint: { x: number; y: number } | null = null;

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

      // Chunks may land out of text order (offsetInText — e.g. the Enter
      // press that opens the line before its body is typed), so each chunk's
      // model offset is derived from what is already inserted before it.
      const { relativeOffsets, expectedText } = chunkPlacements(chunks);
      for (const [index, chunk] of chunks.entries()) {
        await abortableSleep(chunk.delayMs, signal);
        const { editor: liveEditor, model: liveModel } = requireEditorForPath(path);
        const insertOffset = startOffset + relativeOffsets[index];
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
        const caret = liveModel.getPositionAt(insertOffset + chunk.text.length);
        liveEditor.setSelection(
          new monaco.Selection(caret.lineNumber, caret.column, caret.lineNumber, caret.column),
        );
        liveEditor.revealPositionInCenterIfOutsideViewport(caret);
      }

      const expected = expectedText;
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
      if (deps.runtime.kind === "none") {
        throw new StudioActionError(
          'This lesson type has no runnable studio runtime yet (runtime.kind is "none")',
        );
      }

      const prepared = preparePlaygroundRun({
        runtime: deps.runtime,
        mode: deps.runtimeMode,
        project: deps.workspace.getProject(),
        timeoutMs,
        signal,
      });
      appendRunnerConsoleLines(deps.runtimePanelStore, prepared.startedLines);

      let outcome;
      try {
        outcome = await prepared.run();
      } catch (error) {
        if (error instanceof PlaygroundTerminalError) {
          appendRunnerConsoleLines(deps.runtimePanelStore, error.consoleLines);
        }
        throw error;
      }

      appendRunnerConsoleLines(deps.runtimePanelStore, outcome.resultLines);

      if (!outcome.ok) {
        throw new StudioActionError(`The program did not run cleanly (status ${outcome.status})`);
      }

      return {
        kind: deps.runtime.kind,
        mode: deps.runtimeMode,
        status: outcome.status,
        attempts: outcome.attempts,
        transientFailures: outcome.transientFailures,
      };
    },

    async showSlide({ slideId, maximized }) {
      const slides = deps.slidesStore.getSnapshot().context.slides;
      if (!slides.some((slide) => slide.id === slideId)) {
        throw new StudioActionError(`Slide "${slideId}" is not loaded in the slides store`);
      }

      // Same pair the slides controller performs: record the event, then move
      // the store so the panel renders it (no collaboration in studio renders).
      deps.notifySlideEvent({
        type: "slide_open",
        timestamp: performance.now(),
        slideId,
        isMaximized: maximized,
        indexv: 0,
      });
      deps.slidesStore.trigger.setPreviewState({
        previewState: {
          isOpen: true,
          isMaximized: maximized,
          currentSlideId: slideId,
          indexv: 0,
        },
      });

      await waitUntil(
        () => {
          const previewState = selectPreviewState(deps.slidesStore.getSnapshot().context);
          return previewState.isOpen && previewState.currentSlideId === slideId;
        },
        { timeoutMs: 2_000, signal, description: `slide "${slideId}" to open` },
      );
      return { slideId, maximized };
    },

    async closeSlide() {
      const previewState = selectPreviewState(deps.slidesStore.getSnapshot().context);
      deps.notifySlideEvent({
        type: "slide_close",
        timestamp: performance.now(),
        slideId: previewState.currentSlideId ?? undefined,
      });
      deps.slidesStore.trigger.setPreviewState({
        previewState: { isOpen: false, isMaximized: false, currentSlideId: null, indexv: 0 },
      });

      await waitUntil(() => !selectPreviewState(deps.slidesStore.getSnapshot().context).isOpen, {
        timeoutMs: 2_000,
        signal,
        description: "the slide panel to close",
      });
      return {};
    },

    async applyWhiteboard({ open, maximized, upsertIds }) {
      const assets = upsertIds.map((assetId) => {
        const asset = deps.whiteboardAssets.find((candidate) => candidate.id === assetId);
        if (!asset) {
          throw new StudioActionError(`Whiteboard asset "${assetId}" is not pinned in the plan`);
        }
        return asset;
      });
      const upserts = assets.map((asset) => buildWhiteboardElement(asset, deps.planSeed));

      const current = deps.whiteboardStore.getSnapshot().context.scene;
      const event: WhiteboardEvent = {
        timestamp: performance.now(),
        ...(upserts.length > 0 ? { upserts } : {}),
        ...(open === undefined || open === current.isOpen ? {} : { isOpen: open }),
        ...(maximized === undefined || maximized === current.isMaximized
          ? {}
          : { isMaximized: maximized }),
      };
      // Same pair the whiteboard controller's flush performs: record the delta,
      // then publish the updated scene for the mounted panel.
      deps.notifyWhiteboardEvent(event);
      const upsertedIds = new Set(upserts.map((element) => element.id));
      deps.whiteboardStore.trigger.setScene({
        scene: {
          elements: [
            ...current.elements.filter((element) => !upsertedIds.has(element.id)),
            ...upserts,
          ],
          view: current.view,
          isOpen: open ?? current.isOpen,
          isMaximized: maximized ?? current.isMaximized,
        },
      });

      await waitUntil(
        () => {
          const scene = deps.whiteboardStore.getSnapshot().context.scene;
          return (
            (open === undefined || scene.isOpen === open) &&
            upserts.every((element) =>
              scene.elements.some((candidate) => candidate.id === element.id),
            )
          );
        },
        { timeoutMs: 2_000, signal, description: "the whiteboard scene to apply" },
      );
      return { upserted: upserts.length, open: open ?? current.isOpen };
    },

    async waitForOutput({ contains, timeoutMs }) {
      const errorPrefix =
        deps.runtime.kind === "none" ? null : runErrorPrefixFor(deps.runtime.kind);
      let matchedLine: string | null = null;
      await waitUntil(
        () => {
          const lines = deps.runtimePanelStore.getSnapshot().context.consoleLines;
          const errorLine = errorPrefix
            ? lines.find((line) => line.startsWith(errorPrefix))
            : undefined;
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
      // Live playground clients abort via the shared signal; nothing else to
      // release — the engine instances are per-run closures.
    },
  };
}
