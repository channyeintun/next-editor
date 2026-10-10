import { expect, vi } from "vite-plus/test";
import { createActor, fromCallback } from "xstate";
import type * as monaco from "monaco-editor";
import { editorMachine } from "../editorMachine";
import type { EditorMachineInput } from "../types";
import type { Recording } from "../../types";
import type { WorkspaceRecordingSnapshot } from "../../workspace";

// ============================================================================
// Test-only fixtures the machine suites share: an editor to record from, pinned
// clocks, a started take, and a small recording and workspace to play back.
// Imported by the machine's test files only; never by production code.
// ============================================================================

/** A collapsed selection at the start of line 1. */
export const selection = {
  startLineNumber: 1,
  startColumn: 1,
  endLineNumber: 1,
  endColumn: 1,
  selectionStartLineNumber: 1,
  selectionStartColumn: 1,
  positionLineNumber: 1,
  positionColumn: 1,
};

/** The Monaco surface createFrame reads during a take. */
export class RecordingEditor {
  content = "const a = 1;";
  versionId = 1;
  readonly model = {
    uri: { toString: () => "file:///main.ts" },
    getVersionId: () => this.versionId,
    getValue: () => this.content,
  };

  getModel() {
    return this.model as unknown as monaco.editor.ITextModel;
  }

  getValue() {
    return this.content;
  }

  /** Replaces the whole text. */
  setContent(text: string) {
    this.content = text;
    this.versionId += 1;
  }

  /** Types `text` at the end. */
  type(text: string) {
    this.content += text;
    this.versionId += 1;
  }

  getPosition() {
    return { lineNumber: 1, column: 1 };
  }

  getSelection() {
    return selection as monaco.Selection;
  }

  getScrollTop() {
    return 0;
  }

  getScrollLeft() {
    return 0;
  }

  saveViewState() {
    return null;
  }
}

/** What startTake records from: RecordingEditor, or a suite's own editor of the same shape. */
type TakeEditor = Pick<
  RecordingEditor,
  | "getModel"
  | "getValue"
  | "getPosition"
  | "getSelection"
  | "getScrollTop"
  | "getScrollLeft"
  | "saveViewState"
>;

/**
 * Pins performance.now() and Date.now(); `advance` moves both together. A take's clock
 * reads both, so its times come out exact. vi.restoreAllMocks() releases them.
 */
export function pinClocks() {
  const clock = { perf: 1_000, wall: 50_000 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.perf);
  vi.spyOn(Date, "now").mockImplementation(() => clock.wall);
  return {
    clock,
    advance(ms: number) {
      clock.perf += ms;
      clock.wall += ms;
    },
  };
}

// Finalize measures a take on performance.now(). Pinning it lets a test assert a take's
// length exactly; vi.restoreAllMocks() in afterEach releases it.
export function pinPerformanceClock() {
  const clock = { now: 1_000 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  return clock;
}

/** The machine with mouse tracking stubbed out, since tests have no document to track. */
export const takeMachine = editorMachine.provide({
  actors: { mouseTracking: fromCallback(() => {}) },
});

/** Starts a take recording from `editor`, and checks that it did start. */
export function startTake(
  editor: TakeEditor = new RecordingEditor(),
  input: Partial<EditorMachineInput> = {},
  machine = takeMachine,
) {
  const actor = createActor(machine, {
    input: {
      editorRef: { current: editor as unknown as monaco.editor.IStandaloneCodeEditor },
      ...input,
    },
  }).start();
  actor.send({ type: "START_RECORDING" });
  expect(actor.getSnapshot().matches("recording")).toBe(true);
  return actor;
}

/** A one-second recording of one keyframe ("hello"), with an optional narration blob. */
export function createRecording(audioBlob?: Blob): Recording {
  return {
    version: 4,
    id: "recording-1",
    name: "Recording 1",
    createdAt: 1,
    duration: 1000,
    keyframeInterval: 120,
    audioBlob,
    frames: [
      {
        timestamp: 0,
        isKeyframe: true,
        state: {
          content: "hello",
          selection,
          position: { lineNumber: 1, column: 1 },
          viewState: null,
          mouseCursor: { x: 0, y: 0, visible: false },
        },
      },
    ],
  };
}

/** A one-file (index.html) workspace holding `content`. */
export function createWorkspaceSnapshot(
  content: string,
  sidebarScrollTop = 0,
): WorkspaceRecordingSnapshot {
  return {
    activeFilePath: "index.html",
    collapsedFolders: [],
    sidebarScrollTop,
    project: {
      id: "project-1",
      name: "Project",
      lessonType: "html-css",
      entryFilePath: "index.html",
      folders: [],
      files: {
        "index.html": {
          path: "index.html",
          name: "index.html",
          language: "html",
          content,
        },
      },
    },
  };
}
