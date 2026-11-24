import { describe, expect, it } from "vite-plus/test";
import type { CursorRecordingEvent, EditorFrame, Recording, WhiteboardEvent } from "../core/src";
import type { RuntimeRecordingEvent } from "../core/src/runtime";
import type { WorkspaceRecordingEvent } from "../core/src/workspace";
import { RECORDING_SCHEMA_VERSION } from "../core/src/utils/deltaTypes";
import { compressFrames } from "../core/src/utils/frameStreamEncoder";
import { decompressBinaryToRecording, encodeRecordingToStream } from "../storage/recordingCodec";
import {
  DEFAULT_TRACK_DIFF_OPTIONS,
  diffRecordings,
  isEqual,
  type TrackComparison,
  type TrackName,
} from "./trackDiff";

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
  /** A highlight from this column to the caret, instead of a bare caret. */
  anchorColumn?: number;
  caretColumn?: number;
}

function frame({
  at,
  content,
  scrollLeft = 0,
  pointer,
  anchorColumn,
  caretColumn,
}: FrameSpec): EditorFrame {
  const column = caretColumn ?? content.length + 1;
  const selection = {
    ...selectionAt(column),
    ...(anchorColumn === undefined
      ? {}
      : { startColumn: anchorColumn, selectionStartColumn: anchorColumn }),
  };
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
            selectionStart: { lineNumber: 1, column: anchorColumn ?? column },
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

  describe("a press-and-drag, as the studio records it", () => {
    // The studio's drag: press, hold, then an eased sweep whose steps are
    // rounded to whole pixels; the recorder keeps only samples that move.
    const ease = (t: number) => t * t * (3 - 2 * t);
    function drag(pressAt: number, sweepAt: number, stepMs: number, sweep = ease) {
      const samples: CursorRecordingEvent[] = [
        { timestamp: pressAt, x: 315, y: 424, visible: true, flags: 1 },
      ];
      for (let elapsed = 0; ; elapsed = Math.min(630, elapsed + stepMs)) {
        const x = Math.round(315 + 126 * sweep(elapsed / 630));
        if (x !== samples[samples.length - 1].x) {
          samples.push({ timestamp: sweepAt + elapsed, x, y: 424, visible: true, flags: 1 });
        }
        if (elapsed === 630) break;
      }
      samples.push({ timestamp: sweepAt + 640, x: 441, y: 424, visible: true, flags: 0 });
      return { ...lesson(), cursorEvents: samples };
    }

    it("finds a real render's drag, a few ms late and sampled less evenly, equal", () => {
      // Measured on go-error-values: the real render's sweep began 10 ms after
      // the virtual one's, with steps about 20 ms apart instead of 16.
      const virtual = drag(36_037, 36_157, 16);
      const real = drag(36_044, 36_167, 20);
      const cursor = trackOf(virtual, real, "cursor");
      expect(cursor.firstDifference).toBeNull();
      expect(cursor.maxDistancePx).toBeLessThanOrEqual(1.5);
    });

    it("finds a pen stroke equal when it only started later, though it jumps at its press", () => {
      // Measured on clock-check-slides: the pen presses and takes its first
      // step in the same millisecond, then steps every 50 ms; the real render's
      // stroke began 52.7 ms after the virtual one's.
      const xs = [392, 421, 450, 482, 514, 543, 568, 588, 601, 608, 612];
      const stroke = (pressAt: number, firstStepAt: number) => ({
        ...lesson(),
        cursorEvents: [
          { timestamp: pressAt, x: 392, y: 370, visible: true },
          { timestamp: pressAt, x: 392, y: 370, visible: true, flags: 1 },
          ...xs.slice(1).map((x, index) => ({
            timestamp: firstStepAt + index * 50,
            x,
            y: 370,
            visible: true,
            flags: 1,
          })),
        ],
      });
      const cursor = trackOf(stroke(21_915, 21_915), stroke(21_967.7, 21_967.8), "cursor");
      expect(cursor.firstDifference).toBeNull();
      expect(cursor.maxDistancePx).toBeLessThanOrEqual(1);
    });

    it("finds a pen stroke whose steps fire a few ms late equal", () => {
      // Measured on haskell-crash-course: the same seven points, the real
      // render's second step 7 ms late on a stroke moving about 1.5 px/ms.
      const xs = [397, 474, 571, 684, 780, 859, 882];
      const stroke = (times: number[]) => ({
        ...lesson(),
        cursorEvents: [
          { timestamp: times[0], x: 371, y: 497, visible: true, flags: 1 },
          ...xs.map((x, index) => ({
            timestamp: times[index],
            x,
            y: 497,
            visible: true,
            flags: 1,
          })),
        ],
      });
      const virtual = stroke([0, 50, 100, 150, 200, 250, 300]);
      const real = stroke([0.1, 54.2, 98, 148.4, 198.4, 248.5, 297.4]);
      const cursor = trackOf(virtual, real, "cursor");
      expect(cursor.firstDifference).toBeNull();
      // Without the slack, the same points read as several pixels apart.
      const strict = diffRecordings(virtual, real, {
        ...DEFAULT_TRACK_DIFF_OPTIONS,
        cursorTimeSlackMs: 0,
      }).tracks.find((track) => track.track === "cursor");
      expect(strict?.firstDifference?.reason).toBe("distance");
    });

    it("compares only where a hidden pointer waits, not how it got there", () => {
      // Measured on go-error-values: the hidden pointer is placed at the
      // centre at once on a virtual clock and 44 ms in on a real one.
      const placed = (at: number) => ({
        ...lesson(),
        cursorEvents: [
          { timestamp: 0, x: 0, y: 0, visible: false },
          { timestamp: at, x: 720, y: 450, visible: false },
        ],
      });
      expect(trackOf(placed(0), placed(44), "cursor").firstDifference).toBeNull();
      // Measured on next-editor-state-machine: 242 ms in on a real one, longer
      // than a rest gap. A hidden pointer's two placements are still one wait.
      const late = trackOf(placed(0), placed(242), "cursor");
      expect(late.firstDifference).toBeNull();
      expect(late.counts).toEqual({ a: 1, b: 1 });
    });

    it("still finds a hidden pointer that waits to reappear somewhere else", () => {
      const placed = (x: number) => ({
        ...lesson(),
        cursorEvents: [
          { timestamp: 0, x: 0, y: 0, visible: false },
          { timestamp: 242, x, y: 450, visible: false },
        ],
      });
      expect(trackOf(placed(720), placed(600), "cursor").firstDifference?.reason).toBe("distance");
    });

    it("finds a sweep that jumps straight to its end different", () => {
      const jump = drag(36_037, 36_157, 16, (t) => (t < 0.5 ? 0 : 1));
      const cursor = trackOf(drag(36_037, 36_157, 16), jump, "cursor");
      expect(cursor.firstDifference?.reason).toBe("distance");
    });

    it("finds a sweep at another speed different", () => {
      const linear = drag(36_037, 36_157, 16, (t) => t);
      const cursor = trackOf(drag(36_037, 36_157, 16), linear, "cursor");
      expect(cursor.firstDifference?.reason).toBe("distance");
    });
  });

  describe("a drag-select", () => {
    // The highlight grows from column 1 to wherever the pointer is at each
    // step; which columns the steps hit depends on when they fire.
    function sweep(columns: number[], startAt = 1_000): Recording {
      const frames = [frame({ at: 0, content: "abcdefgh" })];
      columns.forEach((column, index) => {
        frames.push(
          frame({
            at: startAt + index * 16,
            content: "abcdefgh",
            anchorColumn: 1,
            caretColumn: column,
          }),
        );
      });
      return { ...lesson(), frames: compressFrames(frames) };
    }

    it("is compared by where it lands, not by the in-between selections", () => {
      // Measured on haskell-crash-course: one render passed through 4:5, the
      // other through 4:6, on the way to the same selection.
      const editor = trackOf(sweep([2, 3, 5, 7, 9]), sweep([2, 4, 6, 8, 9], 1_010), "editor");
      expect(editor.firstDifference).toBeNull();
      expect(editor.counts).toEqual({ a: 2, b: 2 });
    });

    it("still finds a drag that lands somewhere else", () => {
      const editor = trackOf(sweep([2, 3, 5, 7, 9]), sweep([2, 3, 5, 7, 8]), "editor");
      expect(editor.firstDifference?.reason).toBe("content");
    });
  });

  describe("the slide state a frame carries", () => {
    const opened = { isOpen: true, isMaximized: true, currentSlideId: "intro", indexv: 0 };
    // The recorder copies the slide state into whichever frame it captures
    // next: in a real render of clock-check-slides that was the pointer's next
    // move, 2.1 s after the slide opened; on a virtual clock, the same instant.
    function slideCarriedAt(at: number, withTrack: boolean): Recording {
      const carried = frame({ at, content: "a", pointer: { x: 30, y: 10 } });
      carried.state.slideState = opened;
      carried.state.currentSlideIndex = 0;
      const base = lesson();
      return {
        ...base,
        frames: compressFrames([
          frame({ at: 0, content: "" }),
          frame({ at: 500, content: "a" }),
          carried,
        ]),
        slideEvents: withTrack ? base.slideEvents : [],
      };
    }

    it("is not compared when the slide track is what playback shows", () => {
      const editor = trackOf(slideCarriedAt(3_000, true), slideCarriedAt(5_100, true), "editor");
      expect(editor.firstDifference).toBeNull();
    });

    it("is compared when there is no slide track", () => {
      const editor = trackOf(slideCarriedAt(3_000, false), slideCarriedAt(5_100, false), "editor");
      expect(editor.firstDifference?.reason).toBe("time");
    });
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
