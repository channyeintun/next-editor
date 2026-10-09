import { monaco, workspacePathFromMonacoModelUri } from "../monaco";
import type { WorkspaceActions } from "../stores/workspaceActions";
import { selectIsCollapsed, type RuntimePanelStoreInstance } from "../stores/runtimePanelStore";
import { selectPreviewState, type SlidesStoreInstance } from "../stores/slidesStore";
import type { WhiteboardStoreInstance } from "../stores/whiteboardStore";
import { appendRunnerConsoleLines } from "../runtime/playgroundConsoleStore";
import type { Terminal } from "@xterm/xterm";
import type { SlideEvent } from "../core/src/slides";
import { getXtermTerminal } from "../components/xtermRegistry";
import { applyWhiteboardEvent, type WhiteboardEvent } from "../core/src/whiteboard";
import { findCursorReplayRoot } from "../core/src/utils/cursorCoordinates";
import {
  POINTER_PRESS_MS,
  POINTER_SETTLE_MS,
  easePointerAim,
  easePointerDrag,
  pointerAimDurationMs,
} from "../core/src/utils/pointerMotion";
import { dispatchRecordedCursorVisibility } from "../core/src/utils/recordedCursorVisibility";
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
import { consoleLineAimPoint, findConsoleLine, type ConsoleLineLookup } from "./consoleLines";
import { chunkPlacements, easeInOutCubic } from "./cadence";
import {
  PlaygroundTerminalError,
  preparePlaygroundRun,
  runErrorPrefixFor,
} from "./playgroundRuntime";
import { isPlaygroundRuntime, isPlaygroundRuntimeKind } from "./plan";
import type {
  ConsoleLineTarget,
  SelectionAnchor,
  StudioRuntime,
  StudioRuntimeMode,
  StudioPreviewTarget,
  StudioTargetRef,
  StudioWhiteboardAsset,
  TextAnchor,
  TypingChunk,
} from "./plan";
import { describeStudioTarget, resolveStudioTarget, studioTargetAimPoint } from "./targets";
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
    press?: boolean;
  }): Promise<Record<string, unknown>>;
  selectRange(input: {
    path: string;
    selection: SelectionAnchor;
    durationMs: number;
  }): Promise<Record<string, unknown>>;
  pointConsole(input: {
    target: ConsoleLineTarget;
    durationMs: number;
    timeoutMs: number;
  }): Promise<Record<string, unknown>>;
  runWorkspace(timeoutMs: number): Promise<Record<string, unknown>>;
  startRuntime(timeoutMs: number): Promise<Record<string, unknown>>;
  waitForRuntimeReady(timeoutMs: number): Promise<Record<string, unknown>>;
  collapseRuntimeDock(timeoutMs: number): Promise<Record<string, unknown>>;
  expandRuntimeDock(timeoutMs: number): Promise<Record<string, unknown>>;
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

// How long a drag-select holds the button on its first character before the
// sweep starts. A hand starts a drag from rest: the press lands, then the
// pointer accelerates — the recordings rest ~360ms at the anchor, of which the
// replay's settle before the gesture shows the first ~220ms.
const DRAG_PRESS_HOLD_MS = 120;

// How long a pointer move waits for its control to render (see moveCursor).
const TARGET_APPEAR_MS = 500;

// The shortest scroll toward off-screen code before a drag-select.
const MIN_SELECT_SCROLL_MS = 150;

// The quickest a pointer move may be squeezed to: one quick stroke, about what
// a single recorded hand movement took at any range.
const MIN_TRAVEL_MS = 150;

interface PointerPoint {
  x: number;
  y: number;
}

const roundPoint = (point: PointerPoint): PointerPoint => ({
  x: Math.round(point.x),
  y: Math.round(point.y),
});

/**
 * The topmost element at (x, y) inside the cursor-replay root, or null.
 *
 * The mouse-tracking actor drops any sample whose target sits outside the
 * cursor-replay root, and the studio console panel is fixed above the editor
 * but mounted outside that root — so the plain topmost hit would be that panel.
 * Hit-testing through the stack finds what the app itself shows at the point.
 */
function topmostInReplayRoot(x: number, y: number): Element | null {
  const root = findCursorReplayRoot(document);
  const stack =
    typeof document.elementsFromPoint === "function" ? document.elementsFromPoint(x, y) : [];
  return stack.find((candidate) => !root || root.contains(candidate)) ?? null;
}

/**
 * The element a synthetic pointer sample at (x, y) is dispatched on: the
 * topmost one inside the cursor-replay root (so no sample is silently lost
 * under the studio console), falling back to the action's target.
 */
export function cursorDispatchTarget(x: number, y: number, fallback: Element): Element {
  return topmostInReplayRoot(x, y) ?? fallback;
}

/**
 * Where a console row's text ends on screen (its last non-blank character), or
 * null when the renderer draws no DOM text (a canvas/WebGL renderer) or the
 * page cannot measure it.
 */
function paintedTextRight(row: Element | undefined): number | null {
  if (!row || typeof document.createRange !== "function") return null;
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let lastNode: Text | null = null;
  let lastIndex = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const trimmed = text.data.replace(/\s+$/u, "");
    if (trimmed.length > 0) {
      lastNode = text;
      lastIndex = trimmed.length;
    }
  }
  if (!lastNode) return null;
  try {
    const range = document.createRange();
    range.setStart(row, 0);
    range.setEnd(lastNode, lastIndex);
    const rights = [...range.getClientRects()]
      .filter((rect) => rect.width > 0)
      .map((rect) => rect.right);
    return rights.length > 0 ? Math.max(...rights) : null;
  } catch {
    return null;
  }
}

/**
 * Whether something else covers `element` at `point` — a maximized slide or
 * whiteboard over the runner dock, say. A hand cannot click what it cannot
 * see. Unknown (no hit-testing) counts as uncovered.
 */
function isCoveredAt(point: PointerPoint, element: Element): boolean {
  const top = topmostInReplayRoot(point.x, point.y);
  return top !== null && top !== element && !element.contains(top);
}

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
  let lastCursorPoint: PointerPoint | null = null;
  // The header line the latest Playground run printed, so pointing at the
  // console reads that run's output and not an earlier one's identical line.
  let lastRunHeader: string | null = null;
  // Whether the recorded pointer is hidden right now (mouseTrackingActor records
  // every sample hidden until it is shown again).
  let pointerHidden = false;

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
    // `buttons` is 1 while the button is held — a click's press, or a select
    // drag — and 0 otherwise, so the recorded cursor shows the press.
    cursorDispatchTarget(x, y, element).dispatchEvent(
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

  // Hands off the mouse. The pointer disappears where it rests — at the start,
  // before it has anything to point at; while typing, as the OS hides it; under
  // a slide or whiteboard that covers what it was resting on — and stays hidden
  // until its next gesture. A pointer parked on stale code reads as noise.
  const hidePointer = () => {
    if (pointerHidden) return;
    const at = lastCursorPoint ?? {
      x: Math.round(window.innerWidth / 2),
      y: Math.round(window.innerHeight / 2),
    };
    dispatchRecordedCursorVisibility({ x: at.x, y: at.y, visible: false });
    pointerHidden = true;
  };

  // A hidden pointer never travels: it reappears on the spot its next gesture
  // starts from, so the only motion a learner sees is the gesture itself.
  const revealPointerAt = (point: PointerPoint) => {
    if (!pointerHidden) return;
    dispatchRecordedCursorVisibility({ x: point.x, y: point.y, visible: true });
    pointerHidden = false;
    lastCursorPoint = point;
  };

  // Pin a resting pointer to the app itself just before the layout under it
  // changes (the runner dock opening or shutting). Replay places a sample
  // relative to the element it was recorded over, so a pointer resting on the
  // dock would ride along with the dock's edge — off the bottom of the screen
  // once it shuts. Recorded against the app root, the same spot stays put while
  // the panel moves under it, whenever replay applies the layout change.
  const pinPointerToApp = () => {
    if (pointerHidden || !lastCursorPoint) return;
    const root = findCursorReplayRoot(document);
    if (!root) return;
    root.dispatchEvent(
      new PointerEvent("pointermove", {
        clientX: lastCursorPoint.x,
        clientY: lastCursorPoint.y,
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerType: "mouse",
        buttons: 0,
      }),
    );
  };

  // Where a preview element sits in host coordinates. The element lives in a
  // cross-origin frame, so the preview bridge reports its box and the point is
  // mapped through the frame's own box. Null when it is hidden or scrolled out
  // of the preview's view — the pointer has nothing on screen to aim at then.
  const previewAimPoint = async (
    testId: string,
    frame: Element,
    timeoutMs: number,
  ): Promise<PointerPoint | null> => {
    const acknowledgement = await deps.preview.executeCommand(
      { type: "inspect", target: { testId } },
      { timeoutMs, signal },
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
  };

  // The console on screen: the visible terminal inside the runtime dock, with
  // the live xterm instance behind it (null while the dock is shut).
  const visibleConsole = (): { container: Element; terminal: Terminal } | null => {
    const dock = document.querySelector('[data-cursor-replay-target="runtime-dock"]');
    if (!dock) return null;
    for (const container of dock.querySelectorAll('[data-cursor-replay-target^="terminal-"]')) {
      const rect = container.getBoundingClientRect();
      const terminal = getXtermTerminal(container);
      if (terminal && rect.width > 0 && rect.height > 0) {
        return { container, terminal };
      }
    }
    return null;
  };

  // Until its first gesture the pointer has nothing to point at.
  hidePointer();

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
    const target = Math.max(0, Math.min(maxTop, centered));
    // Code at the very top or bottom sits inside the margin band but cannot
    // scroll any further — that is no scroll, and the drag keeps its whole time.
    return { needed: Math.abs(target - current) >= 1, target };
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

      // Hands on the keyboard: the caret is where to look, and the OS hides
      // the pointer while typing.
      hidePointer();
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

    async moveCursor({ target, durationMs, press = false }) {
      const started = performance.now();
      // A control can take a frame to appear — the Run button renders once the
      // dock it lives in has opened — so give it a moment before failing.
      if (!resolveStudioTarget(target)) {
        try {
          await waitUntil(() => resolveStudioTarget(target) !== null, {
            timeoutMs: TARGET_APPEAR_MS,
            signal,
            description: describeStudioTarget(target),
          });
        } catch {
          throwIfAborted(signal);
        }
      }
      const frame = resolveStudioTarget(target);
      if (!frame) {
        throw new StudioActionError(`Missing studio target: ${describeStudioTarget(target)}`);
      }

      // Aiming into the preview is best-effort: the authored preview.click /
      // preview.input that follows, with its own timeout and retry, stays the
      // one check that fails the render. An element that is not mounted yet,
      // hidden, or off the preview's view just gets no click from the pointer.
      let previewPoint: PointerPoint | null = null;
      if (target.kind === "preview") {
        let skipped = "the element is hidden or outside the preview's visible area";
        try {
          previewPoint = await previewAimPoint(
            target.testId,
            frame,
            Math.min(2_000, Math.max(250, durationMs)),
          );
        } catch (error) {
          throwIfAborted(signal);
          skipped = `the preview element could not be located: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (!previewPoint) {
          return { target: describeStudioTarget(target), skipped };
        }
      }
      // Re-resolved every step: a React re-render can swap the DOM node, and
      // layout can shift while the pointer travels.
      const destination = (): { point: PointerPoint; element: Element } => {
        if (previewPoint) return { point: previewPoint, element: frame };
        const element = resolveStudioTarget(target);
        const rect = element?.getBoundingClientRect();
        if (!element || !rect || (rect.width === 0 && rect.height === 0)) {
          throw new StudioActionError(
            `Studio target became invisible: ${describeStudioTarget(target)}`,
          );
        }
        return { point: studioTargetAimPoint(element), element };
      };

      if (isCoveredAt(destination().point, destination().element)) {
        return {
          target: describeStudioTarget(target),
          skipped: "something else covers it on screen",
        };
      }

      // The plan budgets the longest approach; the move takes the time its real
      // distance needs (pointerAimDurationMs) and starts later instead of
      // crawling, so it still arrives when the plan said it would.
      const clickMs = press ? POINTER_SETTLE_MS + POINTER_PRESS_MS : 0;
      const travelBudgetMs = Math.max(0, durationMs - clickMs);
      const from = pointerHidden ? null : lastCursorPoint;
      const aim = destination().point;
      // Never squeezed below one quick stroke, even when a late start left no
      // budget: a hand does not teleport.
      const travelMs = from
        ? Math.min(
            Math.max(travelBudgetMs, MIN_TRAVEL_MS),
            pointerAimDurationMs(Math.hypot(aim.x - from.x, aim.y - from.y)),
          )
        : 0;
      const restMs = travelBudgetMs - travelMs - (performance.now() - started);
      if (restMs > 0) {
        await abortableSleep(restMs, signal);
      }

      if (!from) {
        revealPointerAt(roundPoint(destination().point));
      } else {
        const moveStarted = performance.now();
        for (;;) {
          throwIfAborted(signal);
          const progress =
            travelMs > 0 ? Math.min(1, (performance.now() - moveStarted) / travelMs) : 1;
          const eased = easePointerAim(progress);
          const { point, element } = destination();
          dispatchCursorPoint(
            Math.round(from.x + (point.x - from.x) * eased),
            Math.round(from.y + (point.y - from.y) * eased),
            element,
          );
          if (progress >= 1) {
            break;
          }
          // setTimeout stepping (not rAF): rAF pauses in background tabs and
          // would stall an unattended render mid-tween.
          await abortableSleep(CURSOR_STEP_MS, signal);
        }
      }

      if (press) {
        // Rest on the control, then click it: press, hold, release. Only the
        // recorded button state changes — no pointerdown/click reaches the
        // page, so the action itself stays the semantic command it always was.
        await abortableSleep(POINTER_SETTLE_MS, signal);
        const { point, element } = destination();
        const { x, y } = roundPoint(point);
        dispatchCursorPoint(x, y, element, 1);
        await abortableSleep(POINTER_PRESS_MS, signal);
        dispatchCursorPoint(x, y, element, 0);
      }

      return { target: describeStudioTarget(target), travelMs, pressed: press };
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
      // of the budget is the press and the drag, so the select's total
      // wall-clock still equals `durationMs` (the Performer budgets a select by
      // exactly this when checking for overlap). The driver injects no pointer
      // motion before the drag — the pointer rests while the editor scrolls, as
      // a hand on a wheel does; replay carries a resting pointer over to the
      // first character the way a hand would before pressing.
      const node = editor.getDomNode();
      const nodeRect = node?.getBoundingClientRect() ?? null;

      const gap = scrollGapForRange(editor, range);
      const scrollShareMs = gap.needed ? Math.min(Math.round(durationMs * 0.4), 500) : 0;
      // A visible pointer's approach is drawn by replay, landing
      // POINTER_SETTLE_MS before the press. Rest up to that long after the
      // scroll — out of the scroll's own share, so the drag keeps its time — so
      // it lands on text that has stopped moving, not text still sliding in.
      const settleMs =
        scrollShareMs > 0 && !pointerHidden
          ? Math.min(POINTER_SETTLE_MS, Math.max(0, scrollShareMs - MIN_SELECT_SCROLL_MS))
          : 0;
      const scrollMs = scrollShareMs - settleMs;
      if (scrollMs > 0) {
        await smoothScrollTo(editor, gap.target, scrollMs);
      }
      if (settleMs > 0) {
        await abortableSleep(settleMs, signal);
      }

      // Endpoints come from Monaco's own layout, read *after* any scroll settles
      // so the motion tracks the real characters.
      const startVisible = editor.getScrolledVisiblePosition(startPosition);
      const endVisible = editor.getScrolledVisiblePosition(endPosition);
      let dragged = false;
      if (node && nodeRect && startVisible && endVisible) {
        const from = roundPoint({
          x: nodeRect.left + startVisible.left,
          y: nodeRect.top + startVisible.top + startVisible.height / 2,
        });
        const to = {
          x: nodeRect.left + endVisible.left,
          y: nodeRect.top + endVisible.top + endVisible.height / 2,
        };

        // Press on the first character and hold a beat before sweeping: a drag
        // starts from rest. A pointer that was hidden (typing, a slide)
        // reappears right here rather than travelling in from a stale spot.
        revealPointerAt(from);
        const sweepBudgetMs = Math.max(1, durationMs - scrollMs - settleMs);
        const pressHoldMs = Math.min(DRAG_PRESS_HOLD_MS, Math.round(sweepBudgetMs * 0.2));
        dispatchCursorPoint(from.x, from.y, node, 1);
        if (pressHoldMs > 0) {
          await abortableSleep(pressHoldMs, signal);
        }
        const dragMs = Math.max(1, sweepBudgetMs - pressHoldMs);

        // The drag *is* the selection: a button-held pointer sweeps straight
        // from the first character to the last — accelerating off the press,
        // peaking early, then a long careful landing (the recorded hands' drag
        // profile, easePointerDrag) — and the selection
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
          const eased = easePointerDrag(progress);
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

    async pointConsole({ target, durationMs, timeoutMs }) {
      // Wait for the line to be printed (a point lands while the output is still
      // arriving), then point at it. A line that scrolled out of view, or never
      // appears, fails the render: pointing at nothing would teach nothing.
      type VisibleLine = Extract<ConsoleLineLookup, { status: "visible" }>;
      // Written from inside the wait's predicate, so declared without the
      // narrowing a plain `= null` initializer would pin on it.
      let found = null as { container: Element; terminal: Terminal; line: VisibleLine } | null;
      const described = `console line ${target.occurrence} containing ${JSON.stringify(target.text)}`;
      await waitUntil(
        () => {
          const surface = visibleConsole();
          if (!surface) return false;
          const lookup = findConsoleLine({
            buffer: surface.terminal.buffer.active,
            rows: surface.terminal.rows,
            text: target.text,
            occurrence: target.occurrence,
            runHeader: lastRunHeader,
          });
          if (lookup.status === "offscreen") {
            throw new StudioActionError(
              `The ${described} has scrolled out of the console's view — point at lines that are on screen`,
            );
          }
          if (lookup.status !== "visible") return false;
          found = { ...surface, line: lookup };
          return true;
        },
        {
          timeoutMs,
          signal,
          description: `the ${described} in the latest run's output (is the runner dock open?)`,
        },
      );
      if (!found) {
        throw new StudioActionError(`The ${described} was not found`);
      }
      const { container, terminal, line: visible } = found;
      const screenRect = (
        container.querySelector(".xterm-screen") ?? container
      ).getBoundingClientRect();
      const row = container.querySelectorAll(".xterm-rows > div")[visible.viewportRow];
      const aim = roundPoint(
        consoleLineAimPoint(
          visible,
          screenRect,
          { cols: terminal.cols, rows: terminal.rows },
          paintedTextRight(row),
        ),
      );
      if (isCoveredAt(aim, container)) {
        throw new StudioActionError(`The ${described} is covered on screen`);
      }

      // A hidden pointer appears at the line; a visible one travels there the
      // way it does toward a control — no click: it points, then rests.
      const from = pointerHidden ? null : lastCursorPoint;
      const travelMs = from
        ? Math.min(durationMs, pointerAimDurationMs(Math.hypot(aim.x - from.x, aim.y - from.y)))
        : 0;
      if (!from) {
        revealPointerAt(aim);
        // The reveal's own sample is placed by plain hit-testing, which can find
        // an overlay outside the recorded app; record the rest again through
        // the console so it is anchored to the line, as every move is.
        dispatchCursorPoint(aim.x, aim.y, container);
      } else {
        const moveStarted = performance.now();
        for (;;) {
          throwIfAborted(signal);
          const progress =
            travelMs > 0 ? Math.min(1, (performance.now() - moveStarted) / travelMs) : 1;
          const eased = easePointerAim(progress);
          dispatchCursorPoint(
            Math.round(from.x + (aim.x - from.x) * eased),
            Math.round(from.y + (aim.y - from.y) * eased),
            container,
          );
          if (progress >= 1) break;
          await abortableSleep(CURSOR_STEP_MS, signal);
        }
      }
      return { line: visible.line.text, travelMs };
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
      if (selectIsCollapsed(deps.runtimePanelStore.getSnapshot().context)) {
        pinPointerToApp();
      }
      deps.runtimePanelStore.trigger.setIsCollapsed({ collapsed: false });

      const prepared = preparePlaygroundRun({
        runtime,
        mode: deps.runtimeMode,
        project: deps.workspace.getProject(),
        timeoutMs,
        signal,
      });
      lastRunHeader = prepared.startedLines.at(-1) ?? null;
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

    async expandRuntimeDock(timeoutMs) {
      const panel = deps.runtimePanelStore;
      if (!selectIsCollapsed(panel.getSnapshot().context)) {
        return { expanded: true, alreadyExpanded: true };
      }

      // The pointer has just clicked the chevron; it stays where it is while
      // the dock opens under it.
      pinPointerToApp();
      panel.trigger.setIsCollapsed({ collapsed: false });
      await waitUntil(() => !selectIsCollapsed(panel.getSnapshot().context), {
        timeoutMs,
        signal,
        description: "the runner dock to open",
      });
      // Captured at the action's time, as collapseRuntimeDock does.
      deps.notifyRuntimeEvent();
      return { expanded: true };
    },

    async collapseRuntimeDock(timeoutMs) {
      const panel = deps.runtimePanelStore;
      if (selectIsCollapsed(panel.getSnapshot().context)) {
        return { collapsed: true, alreadyCollapsed: true };
      }

      pinPointerToApp();
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
      // The slide takes the stage; the pointer's resting spot under it is stale.
      hidePointer();

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
      if (open ?? scene.isOpen) {
        // The board takes the stage; the pointer's resting spot under it is stale.
        hidePointer();
      }
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
