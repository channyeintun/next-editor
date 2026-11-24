import { describe, expect, it, vi } from "vite-plus/test";
import type { EditorFrame, Recording } from "../core/src";
import type { SlideEvent } from "../core/src/slides";
import { reconstructFrameAtIndex } from "../core/src/utils/frameDelta";
import { compressFrames } from "../core/src/utils/frameStreamEncoder";
import {
  EMPTY_WHITEBOARD_SCENE,
  applyWhiteboardEvent,
  type WhiteboardEvent,
} from "../core/src/whiteboard";
import type { WorkspaceFile, WorkspaceProject } from "../core/src/workspace";
import { decompressBinaryToRecording, encodeRecordingToStream } from "../storage/recordingCodec";
import type { StudioActionEndReading, StudioPageReading } from "./driver";
import { runsInBackground } from "./performer";
import { captureGateChecks, firstDifference, type CaptureObservations } from "./qaCapture";
import type { ActionReceipt, StudioCheckResult } from "./report";

// Pass-throughs, so a test can count the folds from a keyframe or move the
// background rule.
vi.mock("../core/src/utils/frameDelta", async (importOriginal) => {
  const original = await importOriginal<typeof import("../core/src/utils/frameDelta")>();
  return {
    ...original,
    reconstructFrameAtIndex: vi.fn<typeof original.reconstructFrameAtIndex>(
      original.reconstructFrameAtIndex,
    ),
  };
});
vi.mock("./performer", async (importOriginal) => {
  const original = await importOriginal<typeof import("./performer")>();
  return {
    ...original,
    runsInBackground: vi.fn<typeof original.runsInBackground>(original.runsInBackground),
  };
});

/*
 * A small render: open main.go, type a comment into it, show a slide, draw a
 * box on the whiteboard, close the slide. `healthy()` builds the recording a
 * faithful recorder makes of it and what the render observed; each broken
 * case changes one thing the way a past capture bug did.
 */

const INITIAL = "package main\n";
const TYPED = "package main\n// cube\n";

const caretAt = (line: number, column: number) => ({
  startLineNumber: line,
  startColumn: column,
  endLineNumber: line,
  endColumn: column,
  selectionStartLineNumber: line,
  selectionStartColumn: column,
  positionLineNumber: line,
  positionColumn: column,
});

function keyframe(timestamp: number, content: string, line: number, column: number) {
  return {
    timestamp,
    isKeyframe: true as const,
    state: {
      content,
      selection: caretAt(line, column),
      position: { lineNumber: line, column },
      viewState: null,
    },
  };
}

function files(content: string): Record<string, WorkspaceFile> {
  return { "main.go": { path: "main.go", name: "main.go", language: "go", content } };
}

function project(content: string): WorkspaceProject {
  return {
    id: "studio-capture",
    name: "T",
    lessonType: "go",
    entryFilePath: "main.go",
    folders: [],
    files: files(content),
  };
}

const BOX = {
  id: "box",
  type: "rectangle",
  version: 1,
  versionNonce: 7,
  isDeleted: false,
  x: 10,
  y: 20,
  width: 100,
  height: 50,
};

/** Events as the driver sends them: the recorder puts the time on. */
const SENT_SLIDES: SlideEvent[] = [
  { type: "slide_open", timestamp: 0, slideId: "s1", isMaximized: true, indexv: 0 },
  { type: "slide_close", timestamp: 0, slideId: "s1" },
];
const SENT_BOARD: WhiteboardEvent[] = [{ timestamp: 0, upserts: [BOX], isOpen: true }];

function receipt(actionId: string, startedAtMs: number, endedAtMs: number): ActionReceipt {
  return {
    actionId,
    actionType: actionId === "start" ? "runtime.start" : "workspace.openFile",
    status: "ok",
    plannedAtMs: startedAtMs,
    startedAtMs,
    endedAtMs,
  };
}

function actionEnd(actionId: string, endedAtMs: number, text: string) {
  const reading: StudioActionEndReading = {
    editor: {
      path: "main.go",
      text,
      selection: text === TYPED ? caretAt(3, 1) : caretAt(1, 1),
    },
    workspaceFiles: files(text),
  };
  return { actionId, endedAtMs, reading };
}

function healthy(): { recording: Recording; observations: CaptureObservations } {
  const runtimeSnapshot = {
    mode: "single-file" as const,
    status: "idle" as const,
    consoleLines: ["[go-run] go run main.go", "3 cubed is 27"],
  };
  const recording: Recording = {
    version: 4,
    id: "capture",
    name: "capture",
    createdAt: 1,
    duration: 1_000,
    keyframeInterval: 120,
    frames: [keyframe(0, INITIAL, 1, 1), keyframe(80, TYPED, 3, 1)],
    cursorEvents: [{ timestamp: 0, x: 0, y: 0, visible: false }],
    workspaceEvents: [
      { timestamp: 0, snapshot: { project: project(INITIAL), activeFilePath: "main.go" } },
      // The snapshot the driver records once typing ends (783c0ef3).
      { timestamp: 100, snapshot: { project: project(TYPED), activeFilePath: "main.go" } },
    ],
    runtimeEvents: [{ timestamp: 0, snapshot: runtimeSnapshot }],
    slideEvents: [
      { ...SENT_SLIDES[0], timestamp: 150 },
      { ...SENT_SLIDES[1], timestamp: 250 },
    ],
    whiteboardEvents: [{ ...SENT_BOARD[0], timestamp: 200 }],
    slides: [{ id: "s1", content: "# One", contentType: "markdown", name: "One", order: 0 }],
    audioSource: "external",
    audioFile: "lesson.ogg",
    streamFinalized: true,
  } as Recording;

  const endOfTake: StudioPageReading = {
    ...actionEnd("end", 300, TYPED).reading,
    consoleLines: [...runtimeSnapshot.consoleLines],
    slidePanel: { isOpen: false, isMaximized: false, currentSlideId: null, indexv: 0 },
    whiteboard: applyWhiteboardEvent(EMPTY_WHITEBOARD_SCENE, SENT_BOARD[0]),
  };
  return {
    recording,
    observations: {
      clock: "virtual",
      receipts: [
        receipt("open", 10, 10),
        receipt("type", 60, 100),
        receipt("show", 150, 150),
        receipt("draw", 200, 200),
        receipt("close", 250, 250),
      ],
      actionEnds: [
        actionEnd("open", 10, INITIAL),
        actionEnd("type", 100, TYPED),
        actionEnd("show", 150, TYPED),
        actionEnd("draw", 200, TYPED),
        actionEnd("close", 250, TYPED),
      ],
      endOfTake,
      stageSends: { slideEvents: SENT_SLIDES, whiteboardEvents: SENT_BOARD },
    },
  };
}

async function checksFor(
  recording: Recording,
  observations: CaptureObservations,
  { loseInDecode }: { loseInDecode?: "whiteboardEvents" } = {},
): Promise<StudioCheckResult[]> {
  const decoded = await decompressBinaryToRecording(await encodeRecordingToStream(recording));
  if (loseInDecode) delete decoded[loseInDecode];
  return captureGateChecks({ recording, decoded, artifactRecording: decoded, observations });
}

const failed = (checks: StudioCheckResult[]) =>
  checks.filter((check) => !check.ok).map((check) => check.id);

const detailOf = (checks: StudioCheckResult[], id: string) =>
  checks.find((check) => check.id === id)?.detail ?? "";

describe("captureGateChecks", () => {
  it("passes a faithful recording, every check advisory", async () => {
    const { recording, observations } = healthy();
    const checks = await checksFor(recording, observations);

    expect(checks.map((check) => check.id)).toEqual([
      "capture.slides.provenance",
      "capture.whiteboard.provenance",
      "capture.tracks.roundTrip",
      "capture.end.editor",
      "capture.end.workspace",
      "capture.end.console",
      "capture.end.whiteboard",
      "capture.end.slides",
      "capture.actions.workspace",
      "capture.actions.editor",
    ]);
    expect(failed(checks)).toEqual([]);
    expect(checks.every((check) => check.advisory === true)).toBe(true);
    expect(detailOf(checks, "capture.slides.provenance")).toBe(
      "2 events sent, all recorded once and in order",
    );
    expect(detailOf(checks, "capture.actions.workspace")).toBe(
      "5 actions, window 0 ms: each action's files recorded, largest lag 0 ms",
    );
  });

  it("reports a slide event the recording dropped", async () => {
    const { recording, observations } = healthy();
    recording.slideEvents = recording.slideEvents!.slice(0, 1);
    const checks = await checksFor(recording, observations);

    expect(failed(checks)).toEqual(["capture.slides.provenance", "capture.end.slides"]);
    expect(detailOf(checks, "capture.slides.provenance")).toBe(
      "1 of 2 sent events missing or changed (first: sent #2, slide_close s1)",
    );
    expect(detailOf(checks, "capture.end.slides")).toBe(
      "the panel is closed, the recording ends open on s1, maximized, step 0",
    );
  });

  it("reports a whiteboard event the driver never sent (the canvas echoing the scene back)", async () => {
    const { recording, observations } = healthy();
    const echo = { timestamp: 300, upserts: [{ ...BOX, version: 2, versionNonce: 9 }] };
    recording.whiteboardEvents = [...recording.whiteboardEvents!, echo];
    observations.endOfTake!.whiteboard = applyWhiteboardEvent(
      observations.endOfTake!.whiteboard,
      echo,
    );
    const checks = await checksFor(recording, observations);

    expect(failed(checks)).toEqual(["capture.whiteboard.provenance"]);
    expect(detailOf(checks, "capture.whiteboard.provenance")).toBe(
      "1 recorded events the driver never sent (first at 300 ms: upserts box)",
    );
  });

  it("reports typing whose workspace snapshot was never recorded", async () => {
    // Before 783c0ef3 the driver sent no workspace event after typing: the
    // store held the typed code while the track still held the file as opened.
    const { recording, observations } = healthy();
    recording.workspaceEvents = recording.workspaceEvents!.slice(0, 1);
    const checks = await checksFor(recording, observations);

    expect(failed(checks)).toEqual(["capture.end.workspace", "capture.actions.workspace"]);
    expect(detailOf(checks, "capture.end.workspace")).toBe("main.go parts at 2:1");
    expect(detailOf(checks, "capture.actions.workspace")).toBe(
      "5 actions, window 0 ms: 4 actions left files the recording does not hold by the window's end: type at 100 ms: main.go parts at 2:1; show at 150 ms: main.go parts at 2:1; draw at 200 ms: main.go parts at 2:1; and 1 more; largest lag 0 ms",
    );
  });

  it("reports frames that stopped while the editor kept changing (a lost editor ref)", async () => {
    const { recording, observations } = healthy();
    recording.frames = recording.frames.slice(0, 1);
    const checks = await checksFor(recording, observations);

    expect(failed(checks)).toEqual(["capture.end.editor", "capture.actions.editor"]);
    expect(detailOf(checks, "capture.end.editor")).toBe(
      "the editor (main.go) and the last frame part at 2:1",
    );
    expect(detailOf(checks, "capture.actions.editor")).toMatch(
      /^5 actions, window 0 ms: 4 actions left editor text no frame holds by the window's end: type at 100 ms: the editor and the frame part at 2:1;/,
    );
  });

  it("reports the selection when only the caret differs from the last frame", async () => {
    const { recording, observations } = healthy();
    observations.endOfTake!.editor!.selection = caretAt(2, 3);
    const checks = await checksFor(recording, observations);

    expect(failed(checks)).toEqual(["capture.end.editor"]);
    expect(detailOf(checks, "capture.end.editor")).toBe(
      "the selection is 2:3→2:3, the last frame has 3:1→3:1",
    );
  });

  it("reports a track the codec lost", async () => {
    const { recording, observations } = healthy();
    const checks = await checksFor(recording, observations, { loseInDecode: "whiteboardEvents" });

    expect(failed(checks)).toContain("capture.tracks.roundTrip");
    expect(detailOf(checks, "capture.tracks.roundTrip")).toBe(
      "changed by encode and decode: whiteboardEvents: 1 items vs 0",
    );
  });

  it("names the field a round trip changed", async () => {
    const { recording, observations } = healthy();
    const decoded = await decompressBinaryToRecording(await encodeRecordingToStream(recording));
    decoded.workspaceEvents![1].snapshot.activeFilePath = "other.go";
    const checks = captureGateChecks({
      recording,
      decoded,
      artifactRecording: decoded,
      observations,
    });
    expect(detailOf(checks, "capture.tracks.roundTrip")).toBe(
      'changed by encode and decode: workspaceEvents[1].snapshot.activeFilePath: "main.go" vs "other.go"',
    );
  });

  it("reports the console lines the runtime track does not end on", async () => {
    const { recording, observations } = healthy();
    observations.endOfTake!.consoleLines = ["[go-run] go run main.go", "3 cubed is 28"];
    const checks = await checksFor(recording, observations);

    expect(failed(checks)).toEqual(["capture.end.console"]);
    expect(detailOf(checks, "capture.end.console")).toBe(
      'the console shows 2 lines, the recording ends on 2 (line[1]: "3 cubed is 28" vs "3 cubed is 27")',
    );
  });

  it("lets a real-clock recording hold console lines printed after the read, and nothing else", async () => {
    const { recording, observations } = healthy();
    observations.clock = "real";
    observations.endOfTake!.consoleLines = ["[go-run] go run main.go"];
    expect(failed(await checksFor(recording, observations))).toEqual([]);

    observations.clock = "virtual";
    expect(failed(await checksFor(recording, observations))).toEqual(["capture.end.console"]);
  });

  describe("the window after an action's end", () => {
    // The typed text lands in a frame `lagMs` after the type action ended.
    function lateFrame(clock: CaptureObservations["clock"], lagMs: number, nextStartMs = 150) {
      const { recording, observations } = healthy();
      recording.frames = [keyframe(0, INITIAL, 1, 1), keyframe(100 + lagMs, TYPED, 3, 1)];
      observations.clock = clock;
      observations.receipts = [
        receipt("open", 10, 10),
        receipt("type", 60, 100),
        receipt("show", nextStartMs, nextStartMs),
      ];
      observations.actionEnds = [actionEnd("open", 10, INITIAL), actionEnd("type", 100, TYPED)];
      return { recording, observations };
    }

    it("allows a capture up to 250 ms late on the real clock, and reports the lag", async () => {
      const { recording, observations } = lateFrame("real", 120, 400);
      const checks = await checksFor(recording, observations);
      expect(failed(checks)).toEqual([]);
      expect(detailOf(checks, "capture.actions.editor")).toBe(
        "2 actions, window 250 ms: each action's editor text recorded, largest lag 120 ms",
      );
    });

    it("reports a capture later than the window, or after the next action began", async () => {
      const tooLate = lateFrame("real", 300, 1_000);
      expect(failed(await checksFor(tooLate.recording, tooLate.observations))).toEqual([
        "capture.actions.editor",
      ]);
      const afterNext = lateFrame("real", 120, 150);
      expect(failed(await checksFor(afterNext.recording, afterNext.observations))).toEqual([
        "capture.actions.editor",
      ]);
    });

    it("allows no lag at all on the virtual clock", async () => {
      const { recording, observations } = lateFrame("virtual", 1, 1_000);
      const checks = await checksFor(recording, observations);
      expect(failed(checks)).toEqual(["capture.actions.editor"]);
      expect(detailOf(checks, "capture.actions.editor")).toContain(
        "type at 100 ms: the editor and the frame part at 2:1",
      );
    });

    it("skips actions that end while a runtime.start is in flight", async () => {
      const { recording, observations } = lateFrame("real", 600, 1_000);
      observations.receipts = [...observations.receipts, receipt("start", 50, 500)];
      const checks = await checksFor(recording, observations);
      expect(failed(checks)).toEqual([]);
      expect(detailOf(checks, "capture.actions.editor")).toBe(
        "1 actions (1 skipped while the runtime started), window 250 ms: each action's editor text recorded, largest lag 0 ms",
      );
    });
  });

  it("compares the editor with the open file's recorded text when no frame of it was recorded", async () => {
    // Replay applies no frame from before a file switch: the editor then shows
    // the file the workspace track opened.
    const { recording, observations } = healthy();
    const other = { ...project(TYPED), files: { ...files(TYPED), "util.go": utilFile() } };
    recording.workspaceEvents = [
      ...recording.workspaceEvents!,
      { timestamp: 260, snapshot: { project: other, activeFilePath: "util.go" } },
    ];
    observations.endOfTake = {
      ...observations.endOfTake!,
      editor: { path: "util.go", text: "package util\n", selection: caretAt(1, 1) },
      workspaceFiles: other.files,
    };
    const checks = await checksFor(recording, observations);
    expect(failed(checks)).toEqual([]);
    expect(detailOf(checks, "capture.end.editor")).toBe(
      "no frame was recorded after the switch to util.go; the editor's text equals that file's recorded text",
    );
  });

  it("reports every check as failed when the page was never read at the end", async () => {
    const { recording, observations } = healthy();
    observations.endOfTake = null;
    const checks = await checksFor(recording, observations);
    expect(failed(checks).filter((id) => id.startsWith("capture.end."))).toHaveLength(5);
  });
});

describe("captureGateChecks on a long take", () => {
  // One typed character per action, recorded as delta frames between keyframes.
  function typedTake(actions: number) {
    const fullFrames: EditorFrame[] = [];
    const actionEnds: CaptureObservations["actionEnds"][number][] = [];
    const receipts: ActionReceipt[] = [];
    const workspaceEvents: NonNullable<Recording["workspaceEvents"]> = [];
    let text = INITIAL;
    for (let index = 0; index < actions; index++) {
      text += "x";
      const endedAtMs = index * 100 + 50;
      fullFrames.push({
        timestamp: endedAtMs - 10,
        state: {
          content: text,
          position: { lineNumber: 2, column: index + 2 },
          selection: caretAt(2, index + 2),
          viewState: null,
        },
      });
      workspaceEvents.push({
        timestamp: endedAtMs - 10,
        snapshot: { project: project(text), activeFilePath: "main.go" },
      });
      receipts.push({ ...receipt(`t${index}`, endedAtMs - 20, endedAtMs) });
      actionEnds.push(actionEnd(`t${index}`, endedAtMs, text));
    }
    const { recording, observations } = healthy();
    recording.frames = compressFrames(fullFrames);
    recording.workspaceEvents = workspaceEvents;
    observations.receipts = receipts;
    observations.actionEnds = actionEnds;
    observations.endOfTake = null;
    return { recording, observations };
  }

  it("reads each action's frame by folding the track forward once, not from a keyframe each time", () => {
    const { recording, observations } = typedTake(300);
    expect(recording.frames.filter((frame) => frame.isKeyframe).length).toBeLessThan(10);
    vi.mocked(reconstructFrameAtIndex).mockClear();
    const checks = captureGateChecks({
      recording,
      decoded: recording,
      artifactRecording: recording,
      observations,
    });

    expect(detailOf(checks, "capture.actions.editor")).toBe(
      "300 actions, window 0 ms: each action's editor text recorded, largest lag 0 ms",
    );
    // A fold from the keyframe is started at most once per keyframe passed.
    expect(vi.mocked(reconstructFrameAtIndex).mock.calls.length).toBeLessThan(10);
  });

  it("finds the same frames, and lists misses in take order, when actions end out of time order", () => {
    const { recording, observations } = typedTake(200);
    // A miss early and one late, then the ends read in reverse.
    observations.actionEnds = observations.actionEnds.map((end, index) =>
      index === 20 || index === 150
        ? { ...end, reading: { ...end.reading, editor: { ...end.reading.editor!, text: "?" } } }
        : end,
    );
    observations.actionEnds = [...observations.actionEnds].reverse();
    const checks = captureGateChecks({
      recording,
      decoded: recording,
      artifactRecording: recording,
      observations,
    });

    expect(detailOf(checks, "capture.actions.editor")).toMatch(
      /^200 actions, window 0 ms: 2 actions left editor text no frame holds by the window's end: t150 at 15050 ms: .*; t20 at 2050 ms: /,
    );
  });
});

describe("a capture check that throws", () => {
  it("is reported as a warning naming the throw, and the other checks still run", async () => {
    const { recording, observations } = healthy();
    const decoded = await decompressBinaryToRecording(await encodeRecordingToStream(recording));
    // A frame whose delta cannot be applied: replaying the editor track throws.
    const broken = {
      ...decoded,
      frames: [
        ...decoded.frames,
        {
          timestamp: 90,
          isKeyframe: false,
          contentDelta: { ops: [] },
          contentEditDelta: { edits: [] },
        },
      ],
    } as unknown as Recording;
    const checks = captureGateChecks({
      recording,
      decoded,
      artifactRecording: broken,
      observations,
    });

    expect(checks).toHaveLength(10);
    expect(checks.every((check) => check.advisory === true)).toBe(true);
    const threw = checks.filter((check) => check.detail.startsWith("the check threw: "));
    expect(threw.map((check) => check.id)).toEqual([
      "capture.end.editor",
      "capture.end.workspace",
      "capture.end.console",
      "capture.end.whiteboard",
      "capture.end.slides",
      "capture.actions.workspace",
      "capture.actions.editor",
    ]);
    expect(threw.every((check) => !check.ok)).toBe(true);
    expect(threw[0].detail).toContain("conflicting content delta variants");
    expect(failed(checks.filter((check) => !threw.includes(check)))).toEqual([]);
  });
});

describe("the background rule", () => {
  it("is the performer's: an action type it runs in the background is skipped", async () => {
    const { recording, observations } = healthy();
    // The frames stop, so every action after the first would miss its text.
    recording.frames = recording.frames.slice(0, 1);
    vi.mocked(runsInBackground).mockImplementation((type) => type === "workspace.openFile");
    try {
      const checks = await checksFor(recording, observations);
      expect(detailOf(checks, "capture.actions.editor")).toMatch(
        /^0 actions \(5 skipped while the runtime started\)/,
      );
    } finally {
      vi.mocked(runsInBackground).mockRestore();
    }
  });
});

function utilFile(): WorkspaceFile {
  return { path: "util.go", name: "util.go", language: "go", content: "package util\n" };
}

describe("firstDifference", () => {
  it("treats data the way the recording file stores it", () => {
    expect(firstDifference({ a: 1, b: undefined }, { a: 1 }, "x")).toBeNull();
    expect(firstDifference([undefined], [null], "x")).toBeNull();
    expect(firstDifference(new Uint8Array([1, 2]), new Uint8Array([1, 2]), "x")).toBeNull();
    expect(firstDifference(new Uint8Array([1, 2]), new Uint8Array([1, 3]), "x")).toBe(
      "x: bytes differ at 1",
    );
    expect(firstDifference({ a: [1, { b: "c" }] }, { a: [1, { b: "d" }] }, "x")).toBe(
      'x.a[1].b: "c" vs "d"',
    );
    expect(firstDifference({ a: 1 }, {}, "x")).toBe("x.a: 1 vs nothing");
  });
});
