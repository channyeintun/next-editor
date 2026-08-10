import { monaco, workspacePathFromMonacoModelUri } from "../monaco";
import type { WorkspaceActions } from "../contexts/WorkspaceContext";
import { selectIsCollapsed, type RuntimePanelStoreInstance } from "../stores/runtimePanelStore";
import { selectPreviewState, type SlidesStoreInstance } from "../stores/slidesStore";
import type { WhiteboardStoreInstance } from "../stores/whiteboardStore";
import { appendRunnerConsoleLines } from "../runtime/goPlayground/consoleStore";
import type { SlideEvent } from "../core/src/slides";
import { applyWhiteboardEvent, type WhiteboardEvent } from "../core/src/whiteboard";
import type { PreviewEvent, PreviewPanelMode, PreviewState } from "../types/slides";
import { isWorkspaceTextFile } from "../types/workspace";
import type {
  WebContainerRuntimeActions,
  WebContainerRuntimeMetadata,
  WebContainerRuntimeRecordingSnapshot,
} from "../contexts/WebContainerRuntimeContext";
import type {
  PreviewCommandExecutor,
  PreviewScreenshotCapturer,
} from "../stores/previewAdapterHandle";
import type {
  StudioPreviewCommand,
  StudioPreviewCommandResult,
} from "../utils/iframeStudioCommandBridge";
import { StudioActionError, abortableSleep, resolveAnchorOffset, waitUntil } from "./async";
import { chunkPlacements, easeInOutCubic, easeOutCubic } from "./cadence";
import {
  PlaygroundTerminalError,
  preparePlaygroundRun,
  runErrorPrefixFor,
} from "./playgroundRuntime";
import { isPlaygroundRuntime, isPlaygroundRuntimeKind } from "./plan";
import type {
  SelectionAnchor,
  StudioRuntime,
  StudioRuntimeMode,
  StudioPreviewTarget,
  StudioTargetRef,
  StudioWhiteboardAsset,
  TextAnchor,
  TypingChunk,
} from "./plan";
import { describeStudioTarget, resolveStudioTarget } from "./targets";
import {
  WHITEBOARD_DRAW_FRAME_MS,
  buildWhiteboardElement,
  planWhiteboardDrawFrames,
} from "./whiteboardAssets";

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
  /** Records the runner dock's state on the runtime track (same send the dock makes). */
  notifyRuntimeEvent: () => void;
  runtimePanelStore: RuntimePanelStoreInstance;
  slidesStore: SlidesStoreInstance;
  whiteboardStore: WhiteboardStoreInstance;
  /** Records a slide event on the slide track (same send the slides controller makes). */
  notifySlideEvent: (event: SlideEvent) => void;
  /** Records a whiteboard event (same send the whiteboard controller makes). */
  notifyWhiteboardEvent: (event: WhiteboardEvent) => void;
  /** Records authored DOM/route observations for artifact-level revalidation. */
  notifyPreviewEvent: (event: PreviewEvent) => void;
  runtimeMode: StudioRuntimeMode;
  runtime: StudioRuntime;
  planSeed: number;
  whiteboardAssets: readonly StudioWhiteboardAsset[];
  webContainerRuntime: {
    getActions: () => Pick<
      WebContainerRuntimeActions,
      "startRuntime" | "resetRuntime" | "configureRuntime"
    >;
    getMetadata: () => WebContainerRuntimeMetadata;
    getSnapshot: () => WebContainerRuntimeRecordingSnapshot;
  };
  preview: {
    open: (mode: PreviewPanelMode) => void;
    close: () => void;
    getState: () => PreviewState | null;
    executeCommand: PreviewCommandExecutor;
    captureScreenshot: PreviewScreenshotCapturer;
  };
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
  selectRange(input: {
    path: string;
    selection: SelectionAnchor;
    durationMs: number;
  }): Promise<Record<string, unknown>>;
  runWorkspace(timeoutMs: number): Promise<Record<string, unknown>>;
  startRuntime(timeoutMs: number): Promise<Record<string, unknown>>;
  waitForRuntimeReady(timeoutMs: number): Promise<Record<string, unknown>>;
  collapseRuntimeDock(timeoutMs: number): Promise<Record<string, unknown>>;
  openPreview(input: {
    mode: PreviewPanelMode;
    timeoutMs: number;
  }): Promise<Record<string, unknown>>;
  executePreviewCommand(input: {
    command: StudioPreviewCommand;
    timeoutMs: number;
  }): Promise<Record<string, unknown>>;
  expectPreview(input: {
    actionId: string;
    target?: StudioPreviewTarget;
    textContains?: string;
    value?: string;
    route?: string;
    attribute?: { name: string; value: string };
    timeoutMs: number;
  }): Promise<Record<string, unknown>>;
  showSlide(input: { slideId: string; maximized: boolean }): Promise<Record<string, unknown>>;
  closeSlide(): Promise<Record<string, unknown>>;
  applyWhiteboard(input: {
    open?: boolean;
    maximized?: boolean;
    upsertIds: readonly string[];
    /** Budget for drawing the upserts in step by step; 0 applies them at once. */
    drawMs?: number;
    /** Remove everything already on the board before drawing this action's assets. */
    clear?: boolean;
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

// One synthetic pointer sample per ~16ms (≈60fps). The reference human
// recording (human-interactions.ne) samples the cursor at a 16–17ms median
// during active motion; the lightweight cursor-events track is captured at
// full rate (only full editor frames are throttled), so stepping this fine is
// what makes the recorded motion read as a hand rather than a 30fps slideshow.
const CURSOR_STEP_MS = 16;

// The preview.open handshake re-sends instead of waiting. A command message
// posted before the frame's document exists lands in a window with no listener
// and is dropped, so that request can never be answered — only time out. One
// long ping would therefore spend the whole action budget proving nothing,
// which is why each attempt is short and the loop keeps knocking until the
// injected bridge answers.
const PREVIEW_HANDSHAKE_PING_TIMEOUT_MS = 500;
const PREVIEW_HANDSHAKE_RETRY_INTERVAL_MS = 100;

/**
 * Placeholder for the `timestamp` field on events handed to the recorder. The
 * capture appenders always overwrite it with the session-relative time
 * (core/machine/recordingSession.ts), so the value here never survives. It used
 * to be `performance.now()`, which reads like exactly the wall-clock/recording-clock
 * mixup the RecordingSession docblock warns against — and would be one the moment
 * an appender stopped overwriting (QA compares recorded timestamps against planned
 * action times, so a raw reading would fail every preview gate).
 */
const RECORDER_ASSIGNS_TIMESTAMP = 0;

function previewCommandTarget(target: StudioPreviewTarget | undefined) {
  return target ? { testId: target.value } : undefined;
}

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

  const dispatchCursorPoint = (x: number, y: number, element: Element, buttons = 0) => {
    // Synthetic pointer input rides the exact capture path human input uses:
    // the mouse-tracking actor listens on the document in the capture phase,
    // so dispatching on the element under the point yields target-aware
    // samples (`createCursorPositionFromClientPoint` walks up from `target`).
    // `buttons` is 0 for a plain attention move and 1 during a select drag, so
    // the recorded cursor reads as a press-drag over the highlighted range.
    const under = document.elementFromPoint(x, y) ?? element;
    under.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerType: "mouse",
        buttons,
      }),
    );
    lastCursorPoint = { x, y };
  };

  // Whether a range sits outside the comfortable viewport band and, if so, the
  // scrollTop that would center it. `needed: false` when it is already visible,
  // so the caller spends no time scrolling.
  const scrollGapForRange = (
    editor: monaco.editor.IStandaloneCodeEditor,
    range: monaco.Range,
  ): { needed: boolean; target: number } => {
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
    const viewH = editor.getLayoutInfo().height;
    const top = editor.getTopForPosition(range.startLineNumber, range.startColumn);
    const bottom = editor.getTopForPosition(range.endLineNumber, range.endColumn) + lineHeight;
    const current = editor.getScrollTop();
    const margin = Math.min(lineHeight * 2, viewH / 4);
    const visible = top >= current + margin && bottom <= current + viewH - margin;
    if (visible) return { needed: false, target: current };
    // Center the range; clamp into the scrollable area.
    const maxTop = Math.max(0, editor.getScrollHeight() - viewH);
    const centered = top - Math.max(margin, (viewH - (bottom - top)) / 2);
    return { needed: true, target: Math.max(0, Math.min(maxTop, centered)) };
  };

  // Scroll to `targetTop` with an eased, synchronously-stepped animation and
  // resolve only once it has settled, so the caller can read final layout
  // coordinates. setScrollTop (not Monaco's async ScrollType.Smooth) keeps the
  // motion captured frame-by-frame and deterministic. Matches the recording,
  // where scrolling only happened to reach off-screen code and moved smoothly,
  // roughly a line per 16–50ms — never an instant jump.
  const smoothScrollTo = async (
    editor: monaco.editor.IStandaloneCodeEditor,
    targetTop: number,
    durationMs: number,
  ): Promise<void> => {
    const fromTop = editor.getScrollTop();
    if (Math.abs(targetTop - fromTop) < 1 || durationMs <= 0) {
      editor.setScrollTop(targetTop, monaco.editor.ScrollType.Immediate);
      return;
    }
    const started = performance.now();
    for (;;) {
      throwIfAborted(signal);
      const progress = Math.min(1, (performance.now() - started) / durationMs);
      const eased = easeInOutCubic(progress);
      editor.setScrollTop(
        Math.round(fromTop + (targetTop - fromTop) * eased),
        monaco.editor.ScrollType.Immediate,
      );
      if (progress >= 1) break;
      await abortableSleep(CURSOR_STEP_MS, signal);
    }
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

      // Record a workspace snapshot of the freshly typed content. Typing is
      // captured as editor-content frames (which rebuild Monaco on replay), but
      // the workspace store the runner reads is restored only from workspace
      // snapshots. Without this, replay leaves the store at the pre-typing
      // (openFile) snapshot, so a Run after playback executes the initial
      // program while the editor shows the final code. Timed at the type
      // action's boundary, it can't disturb the mid-typing animation.
      deps.notifyWorkspaceEvent();

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

    async selectRange({ path, selection, durationMs }) {
      const { editor, model } = requireEditorForPath(path);
      const content = model.getValue();
      const endOffset = resolveAnchorOffset(content, {
        after: selection.text,
        occurrence: selection.occurrence,
      });
      if (endOffset === null) {
        throw new StudioActionError(
          `Selection occurrence ${selection.occurrence} of ${JSON.stringify(selection.text)} not found in "${path}"`,
        );
      }

      const startOffset = endOffset - selection.text.length;
      const startPosition = model.getPositionAt(startOffset);
      const endPosition = model.getPositionAt(endOffset);
      const range = new monaco.Range(
        startPosition.lineNumber,
        startPosition.column,
        endPosition.lineNumber,
        endPosition.column,
      );

      editor.focus();
      // Start the highlight collapsed at the drag's anchor. The selection then
      // grows only as the pointer moves. The recorder captures the model
      // selection (EditorFrame.state.selection via onDidChangeCursorSelection),
      // so every step replays as highlighted text. We dispatch no pointerdown,
      // so Monaco never starts a competing selection of its own; our
      // setSelection stays the sole authority.
      editor.setSelection(
        new monaco.Selection(
          startPosition.lineNumber,
          startPosition.column,
          startPosition.lineNumber,
          startPosition.column,
        ),
      );

      // Scroll the range into view first when it is off-screen (a no-op, 0ms,
      // when already visible — the common case in a small file). The remainder
      // of the budget is the drag, so the select's total wall-clock still equals
      // `durationMs` (the Performer budgets a select by exactly this when
      // checking for overlap). No pointer motion is injected before the drag —
      // the gesture is only the drag itself.
      const node = editor.getDomNode();
      const nodeRect = node?.getBoundingClientRect() ?? null;

      const gap = scrollGapForRange(editor, range);
      const scrollMs = gap.needed ? Math.min(Math.round(durationMs * 0.4), 500) : 0;
      if (scrollMs > 0) {
        await smoothScrollTo(editor, gap.target, scrollMs);
      }

      // Endpoints come from Monaco's own layout, read *after* any scroll settles
      // so the motion tracks the real characters.
      const startVisible = editor.getScrolledVisiblePosition(startPosition);
      const endVisible = editor.getScrolledVisiblePosition(endPosition);
      let dragged = false;
      if (node && nodeRect && startVisible && endVisible) {
        const from = {
          x: nodeRect.left + startVisible.left,
          y: nodeRect.top + startVisible.top + startVisible.height / 2,
        };
        const to = {
          x: nodeRect.left + endVisible.left,
          y: nodeRect.top + endVisible.top + endVisible.height / 2,
        };
        const dragMs = Math.max(1, durationMs - scrollMs);

        // The drag *is* the selection: a button-held pointer sweeps straight
        // from the first character to the last on an ease-out curve (fast start,
        // careful landing — the recording's drag profile), and the selection
        // extends to whatever character sits under the pointer at each step
        // (`getTargetAtClientPoint`). Selection and mouse are one motion — the
        // single behaviour a hand performs — so both cases come out right for
        // free: on one line the highlight grows character by character; across
        // lines it grows line by line, jumping a whole line as the pointer
        // crosses each line's vertical band. It is never a synthetic
        // per-character crawl down a multi-line block.
        let activePosition: monaco.IPosition = startPosition;
        const startedDrag = performance.now();
        for (;;) {
          throwIfAborted(signal);
          const progress = Math.min(1, (performance.now() - startedDrag) / dragMs);
          const eased = easeOutCubic(progress);
          const px = Math.round(from.x + (to.x - from.x) * eased);
          const py = Math.round(from.y + (to.y - from.y) * eased);
          dispatchCursorPoint(px, py, node, 1);
          // The selection end is the character under the pointer. Keep the last
          // good hit if a point momentarily maps to no text (gutter/overscroll);
          // the final re-assert below guarantees the exact range regardless.
          const hit = editor.getTargetAtClientPoint(px, py)?.position;
          if (hit) {
            activePosition = hit;
          }
          editor.setSelection(
            new monaco.Selection(
              startPosition.lineNumber,
              startPosition.column,
              activePosition.lineNumber,
              activePosition.column,
            ),
          );
          if (progress >= 1) {
            break;
          }
          // setTimeout stepping (not rAF) so the drag advances in a background
          // tab, matching moveCursor.
          await abortableSleep(CURSOR_STEP_MS, signal);
        }
        // Release at the range end so the recorded button state returns to idle.
        // The selection then simply holds here while the narration continues —
        // the recording shows a drag settling and the highlight resting, not the
        // selection vanishing the instant it is made.
        dispatchCursorPoint(Math.round(to.x), Math.round(to.y), node, 0);
        dragged = true;
      }

      // Re-assert and verify the final range — a select that drifted off its
      // target would silently teach the wrong lines, so fail closed instead.
      editor.setSelection(range);
      const applied = editor.getSelection();
      if (!applied || !monaco.Range.equalsRange(range, applied)) {
        throw new StudioActionError(
          `Selection did not settle over ${JSON.stringify(selection.text)} in "${path}"`,
        );
      }

      return { path, selectedChars: selection.text.length, dragged };
    },

    async runWorkspace(timeoutMs) {
      const runtime = deps.runtime;
      if (!isPlaygroundRuntime(runtime)) {
        throw new StudioActionError(
          `runtime.run requires a Playground runtime, got "${runtime.kind}"`,
        );
      }

      // The dock is where this output is about to land, so a run opens it — the
      // same reflex TerminalPanel's consoleOpener has when a command writes to
      // the terminal. That lets a script collapse the dock for the long stretch
      // before any code runs (an empty console is 288px of editor spent on
      // nothing) and get it back at the run, with no second action to remember.
      // A no-op when the dock is already open, which is the default.
      deps.runtimePanelStore.trigger.setIsCollapsed({ collapsed: false });

      const prepared = preparePlaygroundRun({
        runtime,
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

    async startRuntime(timeoutMs) {
      if (deps.runtime.kind !== "webcontainer") {
        throw new StudioActionError(
          `runtime.start requires runtime kind "webcontainer", got "${deps.runtime.kind}"`,
        );
      }
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
          if (error instanceof StudioActionError && error.detail) {
            throw error;
          }
          throw new StudioActionError(error instanceof Error ? error.message : String(error), {
            runtime: webContainerDiagnostic(deps.webContainerRuntime.getSnapshot()),
          });
        }
      }
      const snapshot = deps.webContainerRuntime.getSnapshot();
      assertWebContainerHealthy(snapshot);
      return {
        adapterVersion: deps.runtime.adapterVersion,
        initCommand: deps.runtime.initCommand,
        runCommand: deps.runtime.runCommand,
        status: snapshot.status,
      };
    },

    async waitForRuntimeReady(timeoutMs) {
      if (deps.runtime.kind !== "webcontainer") {
        throw new StudioActionError(
          `runtime.waitForReady requires runtime kind "webcontainer", got "${deps.runtime.kind}"`,
        );
      }
      try {
        await waitUntil(
          () => {
            const snapshot = deps.webContainerRuntime.getSnapshot();
            assertWebContainerHealthy(snapshot);
            return (
              snapshot.status === "ready" &&
              Boolean(snapshot.previewUrl) &&
              (deps.runtime.kind !== "webcontainer" ||
                deps.runtime.expectedPort === undefined ||
                snapshot.previewPort === deps.runtime.expectedPort)
            );
          },
          {
            timeoutMs,
            signal,
            description: `WebContainer server${deps.runtime.expectedPort ? ` on port ${deps.runtime.expectedPort}` : ""} to become ready`,
            intervalMs: 50,
          },
        );
      } catch (error) {
        if (error instanceof StudioActionError && error.detail) {
          throw error;
        }
        const snapshot = deps.webContainerRuntime.getSnapshot();
        throw new StudioActionError(error instanceof Error ? error.message : String(error), {
          runtime: webContainerDiagnostic(snapshot),
        });
      }
      const snapshot = deps.webContainerRuntime.getSnapshot();
      return {
        status: snapshot.status,
        previewUrl: snapshot.previewUrl,
        previewPort: snapshot.previewPort,
      };
    },

    async collapseRuntimeDock(timeoutMs) {
      const panel = deps.runtimePanelStore;
      if (selectIsCollapsed(panel.getSnapshot().context)) {
        return { collapsed: true, alreadyCollapsed: true };
      }

      panel.trigger.setIsCollapsed({ collapsed: true });
      await waitUntil(() => selectIsCollapsed(panel.getSnapshot().context), {
        timeoutMs,
        signal,
        description: "the runner dock to collapse",
      });

      // The dock records itself by diffing its own state on render, so the
      // recording only learns about this once the panel has re-rendered. Nudging
      // the runtime track here means the collapse is captured at the action's
      // time rather than whenever the next unrelated runtime change lands — a
      // gap that would otherwise leave the dock covering the editor on replay.
      deps.notifyRuntimeEvent();
      return { collapsed: true };
    },

    async openPreview({ mode, timeoutMs }) {
      if (deps.runtime.kind !== "webcontainer") {
        throw new StudioActionError(
          `preview.open requires runtime kind "webcontainer", got "${deps.runtime.kind}"`,
        );
      }
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
      if (deps.runtime.kind !== "webcontainer") {
        throw new StudioActionError(
          `Preview commands require runtime kind "webcontainer", got "${deps.runtime.kind}"`,
        );
      }
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
      if (deps.runtime.kind !== "webcontainer") {
        throw new StudioActionError(
          `expect.preview requires runtime kind "webcontainer", got "${deps.runtime.kind}"`,
        );
      }

      try {
        assertWebContainerHealthy(deps.webContainerRuntime.getSnapshot());
        const inspection = await deps.preview.executeCommand(
          { type: "inspect", target: previewCommandTarget(target) },
          { timeoutMs, signal },
        );
        const mismatches: string[] = [];
        if (route !== undefined && inspection.route !== route) {
          mismatches.push(
            `route is ${JSON.stringify(inspection.route)}, expected ${JSON.stringify(route)}`,
          );
        }
        if (textContains !== undefined && !inspection.target?.text.includes(textContains)) {
          mismatches.push(`target text does not contain ${JSON.stringify(textContains)}`);
        }
        if (value !== undefined && inspection.target?.value !== value) {
          mismatches.push(
            `target value is ${JSON.stringify(inspection.target?.value)}, expected ${JSON.stringify(value)}`,
          );
        }
        if (
          attribute !== undefined &&
          inspection.target?.attributes[attribute.name] !== attribute.value
        ) {
          mismatches.push(
            `target attribute ${JSON.stringify(attribute.name)} is ${JSON.stringify(inspection.target?.attributes[attribute.name])}, expected ${JSON.stringify(attribute.value)}`,
          );
        }
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

    async showSlide({ slideId, maximized }) {
      const slides = deps.slidesStore.getSnapshot().context.slides;
      if (!slides.some((slide) => slide.id === slideId)) {
        throw new StudioActionError(`Slide "${slideId}" is not loaded in the slides store`);
      }

      // Same pair the slides controller performs: record the event, then move
      // the store so the panel renders it (no collaboration in studio renders).
      deps.notifySlideEvent({
        type: "slide_open",
        timestamp: RECORDER_ASSIGNS_TIMESTAMP,
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
        timestamp: RECORDER_ASSIGNS_TIMESTAMP,
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

    async applyWhiteboard({ open, maximized, upsertIds, drawMs = 0, clear = false }) {
      const assets = upsertIds.map((assetId) => {
        const asset = deps.whiteboardAssets.find((candidate) => candidate.id === assetId);
        if (!asset) {
          throw new StudioActionError(`Whiteboard asset "${assetId}" is not pinned in the plan`);
        }
        return asset;
      });

      // Same pair the whiteboard controller's flush performs: record the delta,
      // then publish the updated scene for the mounted panel — through the same
      // fold replay uses, so the live board and the recording can never disagree
      // about element order. Rebuilding the array by hand appended a re-upserted
      // element at the end while the replay fold kept its original slot, and
      // authored assets carry no `index`, so array order is all Excalidraw has.
      let scene = deps.whiteboardStore.getSnapshot().context.scene;
      const openedAt = scene.isOpen;
      const publish = (event: WhiteboardEvent) => {
        deps.notifyWhiteboardEvent(event);
        scene = applyWhiteboardEvent(scene, event);
        deps.whiteboardStore.trigger.setScene({ scene });
      };
      const panelFlags = (): Partial<WhiteboardEvent> => ({
        ...(open === undefined || open === scene.isOpen ? {} : { isOpen: open }),
        ...(maximized === undefined || maximized === scene.isMaximized
          ? {}
          : { isMaximized: maximized }),
      });

      // Wiping the board removes everything except what this action is about
      // to draw: applyWhiteboardEvent removes *after* it upserts, so an id in
      // both lists would be deleted instead of redrawn.
      const drawnIds = new Set(upsertIds);
      const wipedIds = clear
        ? scene.elements.map((element) => element.id).filter((id) => !drawnIds.has(id))
        : [];
      // Consumed once, by the first event — the board is empty before the pen
      // moves, and later frames of the same draw must not re-remove anything.
      let pendingWipe = wipedIds;
      const wipe = (): Partial<WhiteboardEvent> => {
        if (pendingWipe.length === 0) return {};
        const removedIds = pendingWipe;
        pendingWipe = [];
        return { removedIds };
      };

      const frames = planWhiteboardDrawFrames(assets.length, drawMs);
      if (frames.length === 0) {
        const upserts = assets.map((asset) => buildWhiteboardElement(asset, deps.planSeed));
        publish({
          timestamp: RECORDER_ASSIGNS_TIMESTAMP,
          ...(upserts.length > 0 ? { upserts } : {}),
          ...wipe(),
          ...panelFlags(),
        });
      } else {
        // A drawn apply is the same delta track at a finer grain: one event per
        // step, each carrying only the element being drawn right then. Replay
        // interpolates between those steps (replayState/whiteboard.ts), so the
        // recorded ~20Hz frames come back as a continuous stroke, and the panel
        // opens on the first frame rather than after the drawing.
        for (const frame of frames) {
          publish({
            timestamp: RECORDER_ASSIGNS_TIMESTAMP,
            upserts: [buildWhiteboardElement(assets[frame.assetIndex], deps.planSeed, frame)],
            ...wipe(),
            ...panelFlags(),
          });
          await abortableSleep(WHITEBOARD_DRAW_FRAME_MS, signal);
        }
      }

      await waitUntil(
        () => {
          const applied = deps.whiteboardStore.getSnapshot().context.scene;
          return (
            (open === undefined || applied.isOpen === open) &&
            assets.every((asset) =>
              applied.elements.some((candidate) => candidate.id === asset.id),
            ) &&
            wipedIds.every((id) => !applied.elements.some((candidate) => candidate.id === id))
          );
        },
        { timeoutMs: 2_000, signal, description: "the whiteboard scene to apply" },
      );
      return {
        upserted: assets.length,
        open: open ?? openedAt,
        frames: frames.length,
        wiped: wipedIds.length,
      };
    },

    async waitForOutput({ contains, timeoutMs }) {
      const errorPrefix = isPlaygroundRuntimeKind(deps.runtime.kind)
        ? runErrorPrefixFor(deps.runtime.kind)
        : null;
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
