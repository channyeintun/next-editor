import type { monaco } from "../../monaco";
import type { WorkspaceActions } from "../../stores/workspaceActions";
import type { RuntimePanelStoreInstance } from "../../stores/runtimePanelStore";
import type { SlidesStoreInstance } from "../../stores/slidesStore";
import type { WhiteboardStoreInstance } from "../../stores/whiteboardStore";
import type { SlideEvent } from "../../core/src/slides";
import type { WhiteboardEvent } from "../../core/src/whiteboard";
import type { PreviewEvent, PreviewPanelMode, PreviewState } from "../../types/slides";
import type {
  NodeRuntimeActions,
  NodeRuntimeMetadata,
  NodeRuntimeRecordingSnapshot,
} from "../../contexts/NodeRuntimeContext";
import type {
  PreviewCommandExecutor,
  PreviewScreenshotCapturer,
} from "../../stores/previewAdapterHandle";
import type { StudioPreviewCommand } from "../../utils/iframeStudioCommandBridge";
import type {
  ConsoleLineTarget,
  SelectionAnchor,
  SlidePointTarget,
  WhiteboardPointTarget,
  StudioRuntime,
  StudioRuntimeMode,
  StudioPreviewTarget,
  StudioTargetRef,
  StudioWhiteboardAsset,
  TextAnchor,
  TypingChunk,
} from "../plan";
import type { RenderClock } from "../renderClock";
import type { SlidePreviewState } from "../../core/src/slides";
import type { WhiteboardSceneState } from "../../core/src/whiteboard";
import type { WorkspaceFile } from "../../types/workspace";
import { consoleCommands, readConsoleLines } from "./console";
import { editorCommands, readEditor, readWorkspaceFiles, type EditorReading } from "./editor";
import { createStudioPointer, moveCursor } from "./pointer";
import {
  logStageSends,
  readSlidePanel,
  readWhiteboardScene,
  stageCommands,
  type StageSends,
} from "./stage";
import { nodeRuntimeCommands } from "./nodeRuntime";

export type { EditorReading, EditorSelectionPoints } from "./editor";
export type { StageSends } from "./stage";

export { cursorDispatchTarget } from "./pointer";

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
  nodeRuntime: {
    getActions: () => Pick<
      NodeRuntimeActions,
      "startRuntime" | "resetRuntime" | "configureRuntime"
    >;
    getMetadata: () => NodeRuntimeMetadata;
    getSnapshot: () => NodeRuntimeRecordingSnapshot;
  };
  preview: {
    open: (mode: PreviewPanelMode) => void;
    close: () => void;
    getState: () => PreviewState | null;
    executeCommand: PreviewCommandExecutor;
    captureScreenshot: PreviewScreenshotCapturer;
  };
  signal: AbortSignal;
  /**
   * The clock every performance wait runs on (renderClock.ts): typing delays,
   * pointer steps and rests, drags, whiteboard frames, a fixture run's
   * latency. Waits for the page or the network stay on real timers.
   */
  clock: RenderClock;
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
  /** Performs the `runtime.run` action `actionId`; a fixture-mode run replays its pinned result. */
  runWorkspace(input: { actionId: string; timeoutMs: number }): Promise<Record<string, unknown>>;
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
  /** Points at an element of the running app and rests there (`preview.point`). */
  pointPreview(input: {
    target: StudioPreviewTarget;
    durationMs: number;
    timeoutMs: number;
  }): Promise<Record<string, unknown>>;
  /** Points at a spot on the slide that is showing (`slide.point`). */
  pointSlide(input: {
    target: SlidePointTarget;
    durationMs: number;
    timeoutMs: number;
  }): Promise<Record<string, unknown>>;
  /** Points at an asset drawn on the whiteboard (`whiteboard.point`). */
  pointWhiteboard(input: {
    target: WhiteboardPointTarget;
    durationMs: number;
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
}

/** What an action leaves in the editor and the workspace store. */
export interface StudioActionEndReading {
  editor: EditorReading | null;
  workspaceFiles: Readonly<Record<string, WorkspaceFile>>;
}

/** What the page shows, for each part a recording holds a track of. */
export interface StudioPageReading extends StudioActionEndReading {
  consoleLines: readonly string[];
  slidePanel: SlidePreviewState;
  whiteboard: WhiteboardSceneState;
}

/**
 * A driver that can also say what it did and what the page shows, for checks
 * that compare the recording with the performance. The readers are
 * synchronous and read-only: no flush, no render, no wait. A reading taken
 * during the take therefore cannot move or add anything the recorder stamps.
 */
export interface ObservedStudioDriver extends StudioDriver {
  readActionEnd(): StudioActionEndReading;
  readPage(): StudioPageReading;
  /** Every slide and whiteboard event the driver sent, in order. */
  stageSends: StageSends;
}

/**
 * The hub: composes each domain's commands around one shared pointer. Every
 * command lives with its domain (pointer, editor, console, nodeRuntime,
 * stage); only the pointer is shared, and only through its own controller.
 */
export function createStudioDriver(deps: StudioDriverDeps): ObservedStudioDriver {
  const pointer = createStudioPointer(deps.clock);
  const { deps: stageDeps, sends: stageSends } = logStageSends(deps);
  const readActionEnd = (): StudioActionEndReading => ({
    editor: readEditor(deps),
    workspaceFiles: readWorkspaceFiles(deps),
  });
  return {
    ...editorCommands(deps, pointer),
    moveCursor: (input) => moveCursor(deps, pointer, input),
    ...consoleCommands(deps, pointer),
    ...nodeRuntimeCommands(deps, pointer),
    ...stageCommands(stageDeps, pointer),
    readActionEnd,
    readPage: () => ({
      ...readActionEnd(),
      consoleLines: readConsoleLines(deps),
      slidePanel: readSlidePanel(deps),
      whiteboard: readWhiteboardScene(deps),
    }),
    stageSends,
  };
}
