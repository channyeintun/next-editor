import { describe, expect, it } from "vite-plus/test";
import type { CursorRecordingEvent, EditorFrame, Recording, WhiteboardEvent } from "../core/src";
import type { RuntimeRecordingEvent } from "../core/src/runtime";
import type { WorkspaceRecordingEvent } from "../core/src/workspace";
import { RECORDING_SCHEMA_VERSION } from "../core/src/utils/deltaTypes";
import { compressFrames } from "../core/src/utils/frameStreamEncoder";
import { decompressBinaryToRecording, encodeRecordingToStream } from "../storage/recordingCodec";
import { diffRecordings, isEqual, type TrackComparison, type TrackName } from "./trackDiff";

const DURATION_MS = 4_000;

function selectionAt(column: number) {
  return {
    startLineNumber: 1,
    startColumn: column,
    endLineNumber: 1,
    endColumn: column,
    selectionStartLineNumber: 1,
    selectionStartColumn: column,
    positionLineNumber: 1,
    positionColumn: column,
  };
}

interface FrameSpec {
  at: number;
  content: string;
  scrollLeft?: number;
  /** A pointer sample riding on the frame, which is not an editor change. */
  pointer?: { x: number; y: number };
}

function frame({ at, content, scrollLeft = 0, pointer }: FrameSpec): EditorFrame {
  const column = content.length + 1;
  const selection = selectionAt(column);
  return {
    timestamp: at,
    state: {
      content,
      selection,
      position: { lineNumber: 1, column },
      // Shaped as the recorder stores it: normalizeEditorViewState gives each
      // cursor state its selection, which Monaco's own type leaves out.
      viewState: {
        cursorState: [
          {
            inSelectionMode: false,
            selectionStart: { lineNumber: 1, column },
            position: { lineNumber: 1, column },
            selection,
          },
        ],
        viewState: {
          scrollLeft,
          firstPosition: { lineNumber: 1, column: 1 },
          firstPositionDeltaTop: 0,
        },
        contributionsState: {},
      } as unknown as EditorFrame["state"]["viewState"],
      mouseCursor: pointer ? { ...pointer, visible: true, coordinateSpace: "root" } : undefined,
    },
  };
}

function project(main: string) {
  return {
    id: "track-diff",
    name: "T",
    lessonType: "go" as const,
    entryFilePath: "main.go",
    folders: [],
    files: { "main.go": { path: "main.go", name: "main.go", language: "go", content: main } },
  };
}

function workspaceEvent(at: number, main: string): WorkspaceRecordingEvent {
  return { timestamp: at, snapshot: { project: project(main), activeFilePath: "main.go" } };
}

function runtimeEvent(
  at: number,
  status: "idle" | "ready",
  lines: string[],
): RuntimeRecordingEvent {
  return {
    timestamp: at,
    snapshot: { mode: "single-file", status, consoleLines: lines, activeTab: "runner" },
  };
}

function stroke(at: number, id: string, version = 1): WhiteboardEvent {
  return {
    timestamp: at,
    upserts: [
      { id, version, type: "freedraw" } as unknown as NonNullable<
        WhiteboardEvent["upserts"]
      >[number],
    ],
  };
}

/** A straight, linear pointer move from `from` to `to`, sampled every `stepMs`. */
function move(
  startAt: number,
  durationMs: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
  stepMs: number,
): CursorRecordingEvent[] {
  const samples: CursorRecordingEvent[] = [];
  for (let elapsed = 0; ; elapsed = Math.min(durationMs, elapsed + stepMs)) {
    const progress = elapsed / durationMs;
    samples.push({
      timestamp: startAt + elapsed,
      x: from.x + (to.x - from.x) * progress,
      y: from.y + (to.y - from.y) * progress,
      visible: true,
    });
    if (elapsed === durationMs) return samples;
  }
}

interface LessonSpec {
  /** When the second keystroke lands. */
  keystrokeAt?: number;
  scrollLeft?: number;
  finalText?: string;
  strokes?: string[];
  /** Runtime event index the program's output lands on. */
  outputLate?: boolean;
  pointerEnd?: { x: number; y: number };
  pointerStepMs?: number;
}

function lesson(spec: LessonSpec = {}): Recording {
  const {
    keystrokeAt = 1_000,
    scrollLeft = 0,
    finalText = "ab",
    strokes = ["s1", "s2"],
    outputLate = false,
    pointerEnd = { x: 300, y: 200 },
    pointerStepMs = 16,
  } = spec;
  const runtimeEvents = outputLate
    ? [
        runtimeEvent(0, "idle", []),
        runtimeEvent(2_000, "ready", []),
        runtimeEvent(2_100, "ready", ["[go-run] go run main.go"]),
        runtimeEvent(2_200, "ready", ["[go-run] go run main.go", "hello"]),
      ]
    : [
        runtimeEvent(0, "idle", []),
        runtimeEvent(2_000, "ready", ["[go-run] go run main.go"]),
        runtimeEvent(2_200, "ready", ["[go-run] go run main.go", "hello"]),
      ];
  return {
    version: RECORDING_SCHEMA_VERSION,
    id: "take",
    name: "Take",
    createdAt: 1,
    duration: DURATION_MS,
    keyframeInterval: 120,
    frames: compressFrames([
      frame({ at: 0, content: "" }),
      frame({ at: 500, content: "a" }),
      // Pointer-only frames between keystrokes.
      frame({ at: 600, content: "a", pointer: { x: 10, y: 10 } }),
      frame({ at: 700, content: "a", pointer: { x: 20, y: 10 } }),
      frame({ at: keystrokeAt, content: finalText.slice(0, 2), scrollLeft }),
    ]),
    workspaceEvents: [workspaceEvent(0, ""), workspaceEvent(1_500, finalText)],
    runtimeEvents,
    whiteboardEvents: [
      { timestamp: 2_500, isOpen: true },
      ...strokes.map((id, index) => stroke(2_600 + index * 100, id)),
    ],
    slideEvents: [{ timestamp: 3_000, type: "slide_open", slideId: "intro" }],
    cursorEvents: [
      { timestamp: 0, x: 100, y: 100, visible: false },
      { timestamp: 3_100, x: 100, y: 100, visible: true },
      ...move(3_200, 300, { x: 100, y: 100 }, pointerEnd, pointerStepMs),
    ],
    captions: [
      {
        id: "studio-narration",
        language: "en",
        cues: [
          { start: 0, end: 1_500, text: "hello" },
          { start: 1_500, end: 3_500, text: "world" },
        ],
      },
    ],
    chapters: [{ time: 0, title: "Start" }],
  };
}

function trackOf(recordingA: Recording, recordingB: Recording, name: TrackName): TrackComparison {
  const track = diffRecordings(recordingA, recordingB).tracks.find((entry) => entry.track === name);
  if (!track) throw new Error(`no ${name} track`);
  return track;
}

function unequalTracks(recordingA: Recording, recordingB: Recording): TrackName[] {
  return diffRecordings(recordingA, recordingB)
    .tracks.filter((track) => !track.equal)
    .map((track) => track.track);
}

describe("diffRecordings", () => {
  it("finds two identical recordings equal on every track", () => {
    const result = diffRecordings(lesson(), lesson());
    expect(result.equal).toBe(true);
    expect(isEqual(lesson(), lesson())).toBe(true);
    expect(result.tracks.map((track) => track.track)).toEqual([
      "editor",
      "workspace",
      "runtime",
      "whiteboard",
      "slides",
      "cursor",
      "captions",
      "chapters",
      "duration",
    ]);
    for (const track of result.tracks) {
      expect(track.firstDifference).toBeNull();
      expect(track.counts.a).toBe(track.counts.b);
    }
  });

  it("keeps only the editor frames a viewer sees change, not pointer-only frames", () => {
    expect(trackOf(lesson(), lesson(), "editor").counts).toEqual({ a: 3, b: 3 });
  });

  it("accepts a keystroke that moved within the tolerance", () => {
    const editor = trackOf(lesson(), lesson({ keystrokeAt: 1_100 }), "editor");
    expect(editor.equal).toBe(true);
    expect(editor.timing?.maxMs).toBe(100);
  });

  it("names a keystroke that moved beyond the tolerance", () => {
    const editor = trackOf(lesson(), lesson({ keystrokeAt: 1_700 }), "editor");
    expect(editor.equal).toBe(false);
    expect(editor.firstDifference).toMatchObject({
      index: 2,
      reason: "time",
      a: { timeMs: 1_000 },
      b: { timeMs: 1_700 },
    });
    expect(isEqual(lesson(), lesson({ keystrokeAt: 1_700 }))).toBe(false);
  });

  it("lets the caller loosen the tolerances", () => {
    expect(isEqual(lesson(), lesson({ keystrokeAt: 1_700 }), { p95Ms: 800, maxMs: 800 })).toBe(
      true,
    );
  });

  it("finds a missing whiteboard stroke", () => {
    const whiteboard = trackOf(lesson(), lesson({ strokes: ["s1"] }), "whiteboard");
    expect(whiteboard.equal).toBe(false);
    expect(whiteboard.counts).toEqual({ a: 3, b: 2 });
    expect(whiteboard.firstDifference).toMatchObject({ index: 2, reason: "missing", b: null });
    expect(whiteboard.firstDifference?.a?.description).toContain("s2@1");
    expect(unequalTracks(lesson(), lesson({ strokes: ["s1"] }))).toEqual(["whiteboard"]);
  });

  it("finds a console line that lands one event later", () => {
    const runtime = trackOf(lesson(), lesson({ outputLate: true }), "runtime");
    expect(runtime.equal).toBe(false);
    expect(runtime.firstDifference).toMatchObject({ index: 1, reason: "content" });
    expect(runtime.firstDifference?.a?.description).toContain("1 console lines");
    expect(runtime.firstDifference?.b?.description).toContain("0 console lines");
    expect(unequalTracks(lesson(), lesson({ outputLate: true }))).toEqual(["runtime"]);
  });

  it("finds a different horizontal scroll", () => {
    const editor = trackOf(lesson(), lesson({ scrollLeft: 40 }), "editor");
    expect(editor.equal).toBe(false);
    expect(editor.firstDifference).toMatchObject({ index: 2, reason: "content" });
    expect(editor.firstDifference?.a?.description).toContain("left 0");
    expect(editor.firstDifference?.b?.description).toContain("left 40");
  });

  it("finds a different final file and says where the text parts", () => {
    const tracks = unequalTracks(lesson(), lesson({ finalText: "ax" }));
    expect(tracks).toEqual(["editor", "workspace"]);
    const workspace = trackOf(lesson(), lesson({ finalText: "ax" }), "workspace");
    expect(workspace.firstDifference).toMatchObject({ index: 1, reason: "content" });
    expect(workspace.firstDifference?.detail).toContain('"b');
    expect(workspace.firstDifference?.detail).toContain('"x');
  });

  it("finds a pointer that rests somewhere else", () => {
    const cursor = trackOf(lesson(), lesson({ pointerEnd: { x: 300, y: 230 } }), "cursor");
    expect(cursor.equal).toBe(false);
    expect(cursor.firstDifference?.reason).toBe("distance");
    expect(cursor.firstDifference?.a?.description).toContain("rests at 300,200");
    expect(cursor.firstDifference?.b?.description).toContain("rests at 300,230");
  });

  it("compares the pointer path, not how often it was sampled", () => {
    const cursor = trackOf(lesson(), lesson({ pointerStepMs: 5 }), "cursor");
    expect(cursor.equal).toBe(true);
    // The hidden start, then the reveal and the move that follows it.
    expect(cursor.counts).toEqual({ a: 2, b: 2 });
    expect(cursor.maxDistancePx).toBeLessThanOrEqual(1);
  });

  it("finds a duration that differs beyond its tolerance", () => {
    const longer = { ...lesson(), duration: DURATION_MS + 300 };
    const duration = trackOf(lesson(), longer, "duration");
    expect(duration.equal).toBe(false);
    expect(duration.firstDifference).toMatchObject({ reason: "time" });
    expect(isEqual(lesson(), longer, { durationMs: 400 })).toBe(true);
  });

  it("compares recordings that went through the codec", async () => {
    const decoded = await decompressBinaryToRecording(await encodeRecordingToStream(lesson()));
    expect(diffRecordings(lesson(), decoded).equal).toBe(true);
  });
});
