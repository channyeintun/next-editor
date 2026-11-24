/**
 * A small generated recording for the checks' own tests: a take that types into two
 * files and switches between them, with a runtime, a whiteboard, slides, a pointer
 * and captions. Never a real recording.
 */

import type * as monaco from "monaco-editor";

import type { Recording } from "../../src/core/src";
import type { CursorRecordingEvent } from "../../src/core/src/cursor";
import type { RuntimeRecordingEvent } from "../../src/core/src/runtime";
import type { SlideEvent } from "../../src/core/src/slides";
import type { EditorFrame } from "../../src/core/src/types";
import { compressFrames } from "../../src/core/src/utils/frameStreamEncoder";
import type { WhiteboardEvent } from "../../src/core/src/whiteboard";
import type { WorkspaceRecordingEvent } from "../../src/core/src/workspace";

type FilePath = "index.html" | "style.css";

const selectionAt = (column: number) => ({
  startLineNumber: 1,
  startColumn: column,
  endLineNumber: 1,
  endColumn: column,
  selectionStartLineNumber: 1,
  selectionStartColumn: column,
  positionLineNumber: 1,
  positionColumn: column,
});

/** One step of the take, `gap` ms after the one before it. */
export type TakeStep =
  | { gap: number; k: "type"; text: string }
  | { gap: number; k: "switch"; path: FilePath }
  | { gap: number; k: "run"; output: string }
  | { gap: number; k: "draw"; id: string; x: number }
  | { gap: number; k: "slide"; slideId: "one" | "two" }
  | { gap: number; k: "point"; x: number; y: number };

/** A take every check has something to look at in. */
export const SAMPLE_TAKE: TakeStep[] = [
  { gap: 200, k: "type", text: "<h1>" },
  { gap: 300, k: "point", x: 10, y: 20 },
  { gap: 400, k: "run", output: "ready" },
  { gap: 500, k: "switch", path: "style.css" },
  { gap: 300, k: "type", text: "h1{}" },
  { gap: 600, k: "draw", id: "a", x: 5 },
  { gap: 200, k: "point", x: 40, y: 60 },
  { gap: 700, k: "slide", slideId: "one" },
  { gap: 500, k: "switch", path: "index.html" },
  { gap: 400, k: "type", text: "<p>" },
  { gap: 900, k: "draw", id: "a", x: 30 },
  { gap: 300, k: "run", output: "ready\nbuilt" },
  { gap: 800, k: "slide", slideId: "two" },
  { gap: 400, k: "point", x: 80, y: 10 },
  { gap: 600, k: "type", text: "!" },
];

/**
 * Records `steps` the way a take does: frames carry the open file's text, a switch
 * writes a workspace snapshot of every file and the editor's first frame of the new
 * file, and the first frame, workspace and runtime records are at 0.
 */
export function recordTake(steps: readonly TakeStep[] = SAMPLE_TAKE): Recording {
  const files: Record<FilePath, string> = { "index.html": "", "style.css": "" };
  let path: FilePath = "index.html";
  let time = 0;

  const frames: EditorFrame[] = [];
  const workspaceEvents: WorkspaceRecordingEvent[] = [];
  const runtimeEvents: RuntimeRecordingEvent[] = [];
  const whiteboardEvents: WhiteboardEvent[] = [];
  const slideEvents: SlideEvent[] = [];
  const cursorEvents: CursorRecordingEvent[] = [];

  const pushFrame = () => {
    const column = files[path].length + 1;
    frames.push({
      timestamp: time,
      state: {
        content: files[path],
        selection: selectionAt(column),
        position: { lineNumber: 1, column },
        viewState: { scrollTop: 0 } as unknown as monaco.editor.ICodeEditorViewState,
      },
    });
  };
  const pushWorkspace = () => {
    workspaceEvents.push({
      timestamp: time,
      snapshot: {
        project: {
          id: "p",
          name: "p",
          lessonType: "html-css",
          entryFilePath: "index.html",
          folders: [],
          files: Object.fromEntries(
            Object.entries(files).map(([each, content]) => [
              each,
              { path: each, name: each, language: "plaintext", content },
            ]),
          ),
        },
        activeFilePath: path,
        sidebarWidthDelta: 0,
      },
    });
  };
  const runtimeAt = (output: string): RuntimeRecordingEvent => ({
    timestamp: time,
    snapshot: {
      mode: "webcontainer",
      status: "ready",
      terminalSessions: [{ id: "t1", title: "t1", output }],
    },
  });

  pushFrame();
  pushWorkspace();
  runtimeEvents.push(runtimeAt(""));
  let version = 0;
  for (const step of steps) {
    time += step.gap;
    switch (step.k) {
      case "type":
        files[path] += step.text;
        pushFrame();
        break;
      case "switch":
        path = step.path;
        pushWorkspace();
        pushFrame();
        break;
      case "run":
        runtimeEvents.push(runtimeAt(step.output));
        break;
      case "draw":
        version += 1;
        whiteboardEvents.push({
          timestamp: time,
          upserts: [
            {
              id: step.id,
              type: "rectangle",
              version,
              versionNonce: version,
              isDeleted: false,
              x: step.x,
              y: 0,
              width: 10,
              height: 10,
            },
          ],
        });
        break;
      case "slide":
        slideEvents.push({
          timestamp: time,
          type: slideEvents.length === 0 ? "slide_open" : "slide_change",
          slideId: step.slideId,
        });
        break;
      case "point":
        cursorEvents.push({ timestamp: time, x: step.x, y: step.y, visible: true });
        break;
    }
  }

  const duration = time + 1_000;
  return {
    version: 4,
    id: "take",
    name: "Take",
    createdAt: 1,
    duration,
    keyframeInterval: 120,
    frames: compressFrames(frames),
    workspaceEvents,
    runtimeEvents,
    whiteboardEvents,
    slideEvents,
    slides: [
      { id: "one", order: 0, content: "one", contentType: "html" },
      { id: "two", order: 1, content: "two", contentType: "html" },
    ],
    cursorEvents,
    captions: [
      {
        id: "en",
        language: "en",
        cues: [
          { start: 0, end: duration / 2, text: "first half" },
          { start: duration / 2, end: duration, text: "second half" },
        ],
      },
    ],
  };
}
