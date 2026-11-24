import { describe, expect, it } from "vite-plus/test";
import type * as monaco from "monaco-editor";
import type { ChatRecordingEvent } from "./chat";
import { applyFrameAtTime } from "./machine/frameReplay";
import { getChatReplayResult } from "./machine/replayState/chat";
import { getWhiteboardReplayResult } from "./machine/replayState/whiteboard";
import { getWorkspaceReplayResult } from "./machine/replayState/workspace";
import { createInitialContext } from "./machine/types";
import { applyRecordingEdit, mapTimeThroughCuts } from "./recordingEdit";
import type { RuntimeRecordingEvent, RuntimeRecordingSnapshot } from "./runtime";
import { diffRuntimeSnapshot, resolveRuntimeSnapshotAt } from "./runtimeTrack";
import type { EditorFrame, Recording } from "./types";
import { createContentDelta } from "./utils/contentDelta";
import { compressFrames } from "./utils/frameStreamEncoder";
import type { WhiteboardElementJSON, WhiteboardEvent } from "./whiteboard";
import type { WorkspaceRecordingEvent, WorkspaceRecordingSnapshot } from "./workspace";

// Text that exists only inside the cut: typed, pasted, printed or drawn there, and
// gone again before the cut ends.
const SECRET = "sk-live-SECRET";
const cut = { start: 2_000, end: 5_000 };
const cuts = [cut];
const edit = { cuts, mutes: [] };

const selection = {
  startLineNumber: 1,
  startColumn: 1,
  endLineNumber: 1,
  endColumn: 1,
  selectionStartLineNumber: 1,
  selectionStartColumn: 1,
  positionLineNumber: 1,
  positionColumn: 1,
};

const frame = (timestamp: number, content: string): EditorFrame => ({
  timestamp,
  state: { content, selection, position: { lineNumber: 1, column: 1 }, viewState: null },
});

const recordingWith = (overrides: Partial<Recording> = {}): Recording => ({
  version: 4,
  id: "take",
  name: "Take",
  createdAt: 1,
  duration: 10_000,
  keyframeInterval: 120,
  frames: compressFrames([
    frame(0, "a"),
    frame(1_000, "ab"),
    frame(3_000, `ab ${SECRET}`),
    frame(4_000, "ab"),
    frame(6_000, "abc"),
  ]),
  ...overrides,
});

const holds = (value: unknown, text: string) => JSON.stringify(value).includes(text);

const STUB_EDITOR = { getModel: () => null } as unknown as monaco.editor.IStandaloneCodeEditor;

describe("workspace events inside a cut", () => {
  const snapshot = (
    content: string,
    extra: Partial<WorkspaceRecordingSnapshot> = {},
  ): WorkspaceRecordingSnapshot => ({
    project: {
      id: "p",
      name: "P",
      lessonType: "html-css",
      entryFilePath: "a.txt",
      folders: [],
      files: {
        "a.txt": { path: "a.txt", name: "a.txt", language: "plaintext", content },
        "b.txt": { path: "b.txt", name: "b.txt", language: "plaintext", content: "b" },
      },
    },
    activeFilePath: "a.txt",
    ...extra,
  });
  const events: WorkspaceRecordingEvent[] = [
    { timestamp: 0, snapshot: snapshot("a") },
    // A sidebar resize while the pasted key was still in the file.
    { timestamp: 2_500, snapshot: snapshot(`ab ${SECRET}`, { sidebarWidthDelta: 10 }) },
    { timestamp: 3_200, snapshot: snapshot(`ab ${SECRET}`, { sidebarWidthDelta: -4 }) },
    {
      timestamp: 3_500,
      snapshot: snapshot(`ab ${SECRET}`, { previewDockWidthDelta: 5, collapsedFolders: ["src"] }),
    },
    { timestamp: 6_000, snapshot: snapshot("abc") },
  ];

  it("keeps the last snapshot, with the widths of the others and the final text", () => {
    const edited = applyRecordingEdit(recordingWith({ workspaceEvents: events }), edit);

    expect(edited.workspaceEvents).toEqual([
      events[0],
      {
        timestamp: mapTimeThroughCuts(3_500, cuts),
        // The editor's last frame in the cut (4_000, "ab") came after this event.
        snapshot: snapshot("ab", {
          sidebarWidthDelta: 6,
          previewDockWidthDelta: 5,
          collapsedFolders: ["src"],
        }),
      },
      { timestamp: mapTimeThroughCuts(6_000, cuts), snapshot: snapshot("abc") },
    ]);
    expect(holds(edited.workspaceEvents, SECRET)).toBe(false);
    expect(holds(events, SECRET)).toBe(true);
  });

  it("leaves the snapshot's text alone when no frame follows it inside the cut", () => {
    const late = [...events.slice(0, 4), { timestamp: 4_500, snapshot: snapshot("ab late") }];
    const edited = applyRecordingEdit(recordingWith({ workspaceEvents: late }), edit);

    expect(edited.workspaceEvents?.[1].snapshot.project.files["a.txt"].content).toBe("ab late");
    expect(edited.workspaceEvents).toHaveLength(2);
  });

  it("never folds the first event into a cut: loading applies it whatever its time", () => {
    const first = { timestamp: 2_100, snapshot: snapshot("opening") };
    const edited = applyRecordingEdit(
      recordingWith({ workspaceEvents: [first, ...events.slice(1)] }),
      edit,
    );

    expect(edited.workspaceEvents).toHaveLength(3);
    expect(edited.workspaceEvents?.[0].snapshot).toBe(first.snapshot);
  });
});

// Frames carry no file: replay gives a frame to the open file only when no workspace
// event opened another file or project after it. So a cut must keep where the file it
// ends on was opened, or the editor after the cut shows what the recording did not.
describe("file switches inside a cut", () => {
  const event = (
    timestamp: number,
    activeFilePath: string,
    files: { a: string; b: string },
    extra: Partial<WorkspaceRecordingSnapshot> = {},
  ): WorkspaceRecordingEvent => ({
    timestamp,
    snapshot: {
      project: {
        id: "p",
        name: "P",
        lessonType: "html-css",
        entryFilePath: "a.txt",
        folders: [],
        files: {
          "a.txt": { path: "a.txt", name: "a.txt", language: "plaintext", content: files.a },
          "b.txt": { path: "b.txt", name: "b.txt", language: "plaintext", content: files.b },
        },
      },
      activeFilePath,
      ...extra,
    },
  });

  // The editor of a seek, as replay's own steps resolve it: the workspace step sets
  // the cursor the frame step reads. The stub editor has no model, so the frame step
  // folds the frame without writing it anywhere.
  const shownAt = (recording: Recording, time: number) => {
    const workspace = getWorkspaceReplayResult({
      workspaceEvents: recording.workspaceEvents ?? [],
      currentTime: time,
      lastAppliedIndex: -1,
    });
    const initial = createInitialContext({ editorRef: { current: STUB_EDITOR } });
    const context = {
      ...initial,
      recording,
      timeline: { ...initial.timeline, currentTime: time, duration: recording.duration },
      lastAppliedWorkspaceEventIndex: workspace.nextIndex,
    };
    const frame = applyFrameAtTime({ context, event: { type: "SEEK", time } }).currentFrame;
    const snapshot = workspace.snapshotToApply;
    return {
      activeFilePath: snapshot?.activeFilePath,
      frame: frame ? frame.state.content : null,
      text: frame ? frame.state.content : snapshot?.project.files[snapshot.activeFilePath].content,
    };
  };

  /** What the edited recording shows at each time outside `edit`'s cuts, against the original. */
  const expectSameOutsideCuts = (recording: Recording, cutEdit: typeof edit, times: number[]) => {
    const edited = applyRecordingEdit(recording, cutEdit);
    for (const time of times) {
      expect(shownAt(edited, mapTimeThroughCuts(time, cutEdit.cuts)), `at ${time}`).toEqual(
        shownAt(recording, time),
      );
    }
    expect(holds(edited.workspaceEvents, SECRET)).toBe(false);
    return edited;
  };

  it("keeps the switches of a cut that switches away and back", () => {
    // b.txt is opened inside the cut, and a.txt again after the cut's last frame,
    // which is b.txt's text: after the cut replay must not apply it to a.txt.
    const recording = recordingWith({
      frames: compressFrames([
        frame(0, "a"),
        frame(1_000, "ab"),
        frame(3_000, `b ${SECRET}`),
        frame(4_000, "b2"),
        frame(6_000, "abc"),
      ]),
      workspaceEvents: [
        event(0, "a.txt", { a: "a", b: "b" }),
        event(2_500, "b.txt", { a: "ab", b: "b" }),
        event(3_200, "b.txt", { a: "ab", b: `b ${SECRET}` }),
        event(4_500, "a.txt", { a: "ab", b: "b2" }),
      ],
    });

    const edited = expectSameOutsideCuts(recording, edit, [1_500, 5_001, 5_500, 6_500]);
    expect(shownAt(recording, 5_500)).toEqual({ activeFilePath: "a.txt", frame: null, text: "ab" });
    // b.txt was opened inside the cut, so another file is opened at a.txt's moment.
    expect(edited.workspaceEvents?.map((kept) => kept.timestamp)).toEqual(
      [0, 4_500, 4_500].map((time) => mapTimeThroughCuts(time, cuts)),
    );
    expect(edited.workspaceEvents?.[1].snapshot.activeFilePath).toBe("");
  });

  it("keeps the switch of a cut that opens a file before its last frame", () => {
    // a.txt is opened inside the cut and typed in, and the cut's last workspace event
    // comes after its last frame: that frame is still a.txt's after the cut.
    const recording = recordingWith({
      frames: compressFrames([
        frame(0, "b"),
        frame(1_000, "b1"),
        frame(2_600, "a"),
        frame(4_000, "ab"),
        frame(6_000, "abc"),
      ]),
      workspaceEvents: [
        event(0, "b.txt", { a: "a", b: "b" }),
        event(2_500, "a.txt", { a: "a", b: "b1" }),
        event(4_500, "a.txt", { a: "ab", b: "b1" }),
      ],
    });

    expectSameOutsideCuts(recording, edit, [1_500, 5_001, 5_500, 6_500]);
    expect(shownAt(recording, 5_500)).toEqual({ activeFilePath: "a.txt", frame: "ab", text: "ab" });
  });

  it("keeps a switch that comes after the cut's last frame where it was", () => {
    const recording = recordingWith({
      frames: compressFrames([frame(0, "b"), frame(3_000, "b1"), frame(6_000, "a1")]),
      workspaceEvents: [
        event(0, "b.txt", { a: "a", b: "b" }),
        event(2_500, "b.txt", { a: "a", b: "b1" }),
        event(4_500, "a.txt", { a: "a", b: "b1" }),
      ],
    });

    const edited = expectSameOutsideCuts(recording, edit, [1_500, 5_500, 6_500]);
    expect(shownAt(edited, mapTimeThroughCuts(5_500, cuts)).frame).toBeNull();
    expect(edited.workspaceEvents).toHaveLength(2);
  });

  it("keeps the switches of two cuts in a row", () => {
    const twoCuts = { cuts: [cut, { start: 6_000, end: 9_000 }], mutes: [] };
    const recording = recordingWith({
      duration: 12_000,
      frames: compressFrames([
        frame(0, "a"),
        frame(3_000, "b"),
        frame(5_500, "a1"),
        frame(7_500, "b1"),
        frame(10_000, "a2"),
      ]),
      workspaceEvents: [
        event(0, "a.txt", { a: "a", b: "b" }),
        event(2_500, "b.txt", { a: "a", b: "b" }),
        event(4_500, "a.txt", { a: "a", b: "b" }),
        event(7_000, "b.txt", { a: "a1", b: "b" }),
        event(8_500, "a.txt", { a: "a1", b: "b1" }),
      ],
    });

    const edited = expectSameOutsideCuts(
      recording,
      twoCuts,
      [1_500, 5_001, 5_800, 9_001, 9_500, 11_000],
    );
    expect(edited.workspaceEvents?.map((kept) => kept.timestamp)).toEqual(
      [0, 4_500, 4_500, 8_500, 8_500].map((time) => mapTimeThroughCuts(time, twoCuts.cuts)),
    );
  });

  it("keeps the switches of a cut at the very start", () => {
    const fromStart = { cuts: [{ start: 0, end: 5_000 }], mutes: [] };
    const recording = recordingWith({
      frames: compressFrames([frame(0, "a"), frame(3_000, "b"), frame(6_000, "a1")]),
      workspaceEvents: [
        event(0, "a.txt", { a: "a", b: "b" }),
        event(2_500, "b.txt", { a: "a", b: "b" }),
        event(4_500, "a.txt", { a: "a", b: "b" }),
      ],
    });

    const edited = expectSameOutsideCuts(recording, fromStart, [0, 5_001, 5_500, 6_500]);
    expect(edited.workspaceEvents?.map((kept) => kept.timestamp)).toEqual(
      [0, 4_500, 4_500].map((time) => mapTimeThroughCuts(time, fromStart.cuts)),
    );
  });

  it("keeps a project switch away and back", () => {
    const inProject = (id: string, kept: WorkspaceRecordingEvent): WorkspaceRecordingEvent => ({
      ...kept,
      snapshot: { ...kept.snapshot, project: { ...kept.snapshot.project, id } },
    });
    const recording = recordingWith({
      frames: compressFrames([frame(0, "a"), frame(3_000, "other"), frame(6_000, "a1")]),
      workspaceEvents: [
        event(0, "a.txt", { a: "a", b: "b" }),
        inProject("q", event(2_500, "a.txt", { a: "other", b: "b" })),
        event(4_500, "a.txt", { a: "a", b: "b" }),
      ],
    });

    const edited = expectSameOutsideCuts(recording, edit, [1_500, 5_001, 5_500, 6_500]);
    // The project opened inside the cut is not kept: no file is open for a moment, in
    // the project and files the cut ends on.
    expect(edited.workspaceEvents?.map(({ snapshot }) => snapshot.project.id)).toEqual([
      "p",
      "p",
      "p",
    ]);
    expect(edited.workspaceEvents?.[1].snapshot.activeFilePath).toBe("");
    expect(edited.workspaceEvents?.[1].snapshot.project.files["a.txt"].content).toBe("a");
  });

  it("opens no other project or file for a moment inside the cut", () => {
    // Project q and b.txt are opened inside the cut, and the cut ends where it started.
    const inProject = (id: string, kept: WorkspaceRecordingEvent): WorkspaceRecordingEvent => ({
      ...kept,
      snapshot: { ...kept.snapshot, project: { ...kept.snapshot.project, id } },
    });
    const recording = recordingWith({
      frames: compressFrames([frame(0, "a"), frame(3_000, "other"), frame(6_000, "a1")]),
      workspaceEvents: [
        event(0, "a.txt", { a: "a", b: "b" }),
        inProject("q", event(2_500, "a.txt", { a: "other", b: "b" })),
        event(3_500, "b.txt", { a: "a", b: "b" }),
        event(4_000, "a.txt", { a: "a", b: "b" }, { sidebarWidthDelta: 4 }),
        event(4_500, "a.txt", { a: "a", b: "b" }),
      ],
    });
    const edited = expectSameOutsideCuts(recording, edit, [1_500, 5_001, 5_500, 6_500]);

    // Walk the cut's window the way playback ticks do, and the way a seek lands.
    const workspaceEvents = edited.workspaceEvents ?? [];
    const from = mapTimeThroughCuts(cut.start, cuts);
    const to = mapTimeThroughCuts(cut.end, cuts);
    let lastAppliedIndex = 0;
    for (let time = from; time <= to; time += 0.01) {
      for (const startIndex of [lastAppliedIndex, -1]) {
        const shown = getWorkspaceReplayResult({
          workspaceEvents,
          currentTime: time,
          lastAppliedIndex: startIndex,
        });
        const snapshot = workspaceEvents[shown.nextIndex].snapshot;
        expect([snapshot.project.id, snapshot.activeFilePath], `at ${time}`).toEqual([
          "p",
          "a.txt",
        ]);
        if (startIndex === lastAppliedIndex) lastAppliedIndex = shown.nextIndex;
      }
    }
  });

  it("keeps no name of a file created and deleted inside the cut", () => {
    const withKeys = event(2_500, "keys.txt", { a: "ab", b: "b" });
    withKeys.snapshot.project.files["keys.txt"] = {
      path: "keys.txt",
      name: "keys.txt",
      language: "plaintext",
      content: SECRET,
    };
    const recording = recordingWith({
      frames: compressFrames([frame(0, "a"), frame(3_000, SECRET), frame(6_000, "a1")]),
      workspaceEvents: [
        event(0, "a.txt", { a: "a", b: "b" }),
        withKeys,
        event(4_500, "a.txt", { a: "ab", b: "b" }),
      ],
    });

    const edited = expectSameOutsideCuts(recording, edit, [1_500, 5_001, 5_500, 6_500]);
    expect(holds(edited.workspaceEvents, "keys.txt")).toBe(false);
    for (const { snapshot } of edited.workspaceEvents ?? []) {
      expect(["", ...Object.keys(snapshot.project.files)]).toContain(snapshot.activeFilePath);
    }
  });

  it("keeps where switches made at one moment opened the file", () => {
    // A studio take on its own clock can stamp several switches with one time.
    const recording = recordingWith({
      frames: compressFrames([frame(0, "a"), frame(4_000, "a1"), frame(6_000, "a2")]),
      workspaceEvents: [
        event(0, "b.txt", { a: "a", b: "b" }),
        event(2_500, "a.txt", { a: "a", b: "b" }),
        event(3_000, "b.txt", { a: "a", b: "b" }),
        event(3_000, "a.txt", { a: "a", b: "b" }),
        event(4_500, "a.txt", { a: "a1", b: "b" }),
      ],
    });

    const edited = expectSameOutsideCuts(recording, edit, [1_500, 5_001, 5_500, 6_500]);
    expect(edited.workspaceEvents?.map((kept) => kept.timestamp)).toEqual(
      [0, 3_000, 4_500].map((time) => mapTimeThroughCuts(time, cuts)),
    );

    // The same moment can also switch away and back to the file open before the cut.
    const backAtOnce = recordingWith({
      frames: recording.frames,
      workspaceEvents: [
        event(0, "a.txt", { a: "a", b: "b" }),
        event(3_000, "b.txt", { a: "a", b: "b" }),
        event(3_000, "a.txt", { a: "a", b: "b" }),
        event(4_500, "a.txt", { a: "a1", b: "b" }),
      ],
    });
    const editedBack = expectSameOutsideCuts(backAtOnce, edit, [1_500, 5_001, 5_500, 6_500]);
    expect(editedBack.workspaceEvents?.map((kept) => kept.timestamp)).toEqual(
      [0, 3_000, 3_000, 4_500].map((time) => mapTimeThroughCuts(time, cuts)),
    );
  });

  it("adds the widths of the run to the survivor only", () => {
    const recording = recordingWith({
      frames: compressFrames([frame(0, "a"), frame(3_000, "b"), frame(4_800, "a1")]),
      workspaceEvents: [
        event(0, "a.txt", { a: "a", b: "b" }, { sidebarWidthDelta: 0 }),
        event(2_500, "b.txt", { a: "a", b: "b" }, { sidebarWidthDelta: 10 }),
        event(3_500, "a.txt", { a: "a", b: "b" }, { previewDockWidthDelta: -6 }),
        event(4_500, "a.txt", { a: "a", b: "b" }, { sidebarWidthDelta: 3 }),
      ],
    });

    const edited = applyRecordingEdit(recording, edit);
    const widths = edited.workspaceEvents?.map(({ snapshot }) => [
      snapshot.sidebarWidthDelta,
      snapshot.previewDockWidthDelta,
    ]);
    expect(widths).toEqual([
      [0, undefined],
      [undefined, undefined],
      [undefined, undefined],
      [13, -6],
    ]);
    expectSameOutsideCuts(recording, edit, [1_500, 5_001, 5_500]);
  });

  it("leaves a cut that holds no workspace event alone", () => {
    const events = [
      event(0, "a.txt", { a: "a", b: "b" }),
      event(6_000, "b.txt", { a: "a", b: "b" }),
    ];
    const edited = applyRecordingEdit(recordingWith({ workspaceEvents: events }), edit);

    expect(edited.workspaceEvents).toEqual([
      events[0],
      { ...events[1], timestamp: mapTimeThroughCuts(6_000, cuts) },
    ]);
  });
});

describe("runtime events inside a cut", () => {
  const state = (output: string, extra: Partial<RuntimeRecordingSnapshot> = {}) =>
    ({
      mode: "webcontainer",
      status: "ready",
      terminalSessions: [{ id: "t", title: "Terminal", output }],
      ...extra,
    }) satisfies RuntimeRecordingSnapshot;
  const states = [
    state(""),
    state("$ start\n"),
    state(`$ start\n${SECRET}\n`),
    // The rolling window dropped the line again.
    state("$ start\n", { activeCommand: "pnpm dev" }),
    state("$ start\ndone\n", { activeCommand: null }),
  ];
  const times = [0, 1_000, 2_500, 3_000, 6_000];
  const events: RuntimeRecordingEvent[] = states.map((next, index) =>
    index === 0
      ? { timestamp: times[index], snapshot: next }
      : { timestamp: times[index], delta: diffRuntimeSnapshot(states[index - 1], next) },
  );

  it("replaces them with one checkpoint of the state they resolve to", () => {
    expect(holds(events, SECRET)).toBe(true);
    const edited = applyRecordingEdit(recordingWith({ runtimeEvents: events }), edit);
    const runtimeEvents = edited.runtimeEvents!;

    expect(runtimeEvents.map((event) => event.timestamp)).toEqual([
      0,
      1_000,
      mapTimeThroughCuts(3_000, cuts),
      mapTimeThroughCuts(6_000, cuts),
    ]);
    expect(runtimeEvents[2]).toEqual({
      timestamp: runtimeEvents[2].timestamp,
      snapshot: states[3],
    });
    expect(holds(runtimeEvents, SECRET)).toBe(false);
    // The delta after the cut still resolves to the state it did before the edit.
    expect(resolveRuntimeSnapshotAt(runtimeEvents, 3)).toEqual(states[4]);
  });

  it("leaves a lone event inside a cut as it was recorded", () => {
    const lone = [events[0], events[1], { ...events[2], timestamp: 2_500 }];
    const edited = applyRecordingEdit(recordingWith({ runtimeEvents: lone }), edit);

    expect(edited.runtimeEvents?.[2]).toEqual({
      ...lone[2],
      timestamp: mapTimeThroughCuts(2_500, cuts),
    });
  });
});

describe("chat events inside a cut", () => {
  const text = (previous: string, next: string) => {
    const delta = createContentDelta(previous, next);
    if (!delta) throw new Error("expected a content delta");
    return delta;
  };
  const events: ChatRecordingEvent[] = [
    { timestamp: 1_000, event: { k: "message_start", id: "m1", role: "user" } },
    { timestamp: 1_100, event: { k: "content", delta: text("", "hello") } },
    // A key pasted into the prompt and cleared, then a turn that was sent and removed.
    { timestamp: 2_500, event: { k: "draft", text: SECRET } },
    { timestamp: 2_600, event: { k: "draft", text: "" } },
    { timestamp: 2_700, event: { k: "message_start", id: "m2", role: "user" } },
    { timestamp: 2_800, event: { k: "content", delta: text("", `use ${SECRET}`) } },
    { timestamp: 2_900, event: { k: "remove", fromId: "m2" } },
    { timestamp: 3_000, event: { k: "status", status: "done" } },
    { timestamp: 6_000, event: { k: "draft", text: "next" } },
  ];
  const transcriptAt = (chatEvents: ChatRecordingEvent[], currentTime: number) =>
    getChatReplayResult({ chatEvents, currentTime, lastAppliedIndex: -1, isResync: true })
      .snapshotToApply;

  it("replaces them with one checkpoint of the transcript they fold to", () => {
    const edited = applyRecordingEdit(recordingWith({ chatEvents: events }), edit);
    const chatEvents = edited.chatEvents!;

    expect(chatEvents).toEqual([
      events[0],
      events[1],
      {
        timestamp: mapTimeThroughCuts(3_000, cuts),
        event: {
          k: "checkpoint",
          state: {
            items: [{ kind: "message", id: "m1", role: "user", text: "hello" }],
            status: "done",
            draft: "",
          },
        },
      },
      { timestamp: mapTimeThroughCuts(6_000, cuts), event: { k: "draft", text: "next" } },
    ]);
    // The transcript after the cut, and at the take's end, is the one the take had.
    expect(transcriptAt(chatEvents, mapTimeThroughCuts(5_000, cuts))).toEqual(
      transcriptAt(events, 5_000),
    );
    expect(transcriptAt(chatEvents, 9_000)).toEqual(transcriptAt(events, 9_000));
  });

  it("keeps the track as recorded when a delta in it no longer applies", () => {
    const damaged: ChatRecordingEvent[] = [
      ...events.slice(0, 2),
      // Made against a text the message never held.
      { timestamp: 2_500, event: { k: "content", delta: text("some other text", "x") } },
      { timestamp: 2_600, event: { k: "draft", text: "kept" } },
    ];
    const edited = applyRecordingEdit(recordingWith({ chatEvents: damaged }), edit);

    expect(edited.chatEvents?.map(({ event }) => event)).toEqual(damaged.map(({ event }) => event));
  });
});

describe("whiteboard events inside a cut", () => {
  const element = (
    id: string,
    version: number,
    extra: Record<string, unknown> = {},
  ): WhiteboardElementJSON => ({
    id,
    version,
    versionNonce: version,
    isDeleted: false,
    index: `a${id}`,
    ...extra,
  });
  const view = { scrollX: 40, scrollY: 0, zoom: 1 };
  const events: WhiteboardEvent[] = [
    { timestamp: 1_000, upserts: [element("1", 1, { x: 0 })], isOpen: true },
    // Text written on the board and deleted again: a deleted element keeps its text.
    { timestamp: 2_500, upserts: [element("2", 1, { text: SECRET })] },
    { timestamp: 2_600, upserts: [element("2", 2, { text: SECRET, isDeleted: true })] },
    // A shape drawn and removed outright, and one that was there before and moved.
    { timestamp: 2_700, upserts: [element("3", 1, { text: SECRET })] },
    { timestamp: 2_800, upserts: [element("1", 2, { x: 50 })] },
    { timestamp: 2_900, removedIds: ["3"] },
    { timestamp: 3_000, upserts: [element("4", 1)], view },
    { timestamp: 6_000, upserts: [element("4", 2, { x: 9 })] },
  ];
  const sceneAt = (whiteboardEvents: WhiteboardEvent[], currentTime: number) =>
    getWhiteboardReplayResult({ whiteboardEvents, currentTime, lastAppliedIndex: -1 }).stateToApply;

  it("replaces them with the one delta from the scene before to the scene after", () => {
    const edited = applyRecordingEdit(recordingWith({ whiteboardEvents: events }), edit);
    const whiteboardEvents = edited.whiteboardEvents!;

    expect(whiteboardEvents).toEqual([
      events[0],
      {
        timestamp: mapTimeThroughCuts(3_000, cuts),
        upserts: [element("1", 2, { x: 50 }), element("4", 1)],
        view,
      },
      { ...events[7], timestamp: mapTimeThroughCuts(6_000, cuts) },
    ]);
    expect(holds(whiteboardEvents, SECRET)).toBe(false);

    // What a viewer sees after the cut is what the take showed, less the element
    // that was created and deleted inside it.
    const visible = (scene: ReturnType<typeof sceneAt>) =>
      scene && { ...scene, elements: scene.elements.filter((entry) => !entry.isDeleted) };
    expect(visible(sceneAt(whiteboardEvents, 9_000))).toEqual(visible(sceneAt(events, 9_000)));
    expect(sceneAt(whiteboardEvents, 9_000)?.elements.map(({ id }) => id)).toEqual(["1", "4"]);
  });

  it("keeps an element that was on the board before the cut and deleted inside it", () => {
    const deleted: WhiteboardEvent[] = [
      events[0],
      { timestamp: 2_500, upserts: [element("1", 2, { x: 5 })] },
      { timestamp: 2_600, upserts: [element("1", 3, { x: 5, isDeleted: true })] },
    ];
    const edited = applyRecordingEdit(recordingWith({ whiteboardEvents: deleted }), edit);

    expect(edited.whiteboardEvents).toEqual([
      events[0],
      {
        timestamp: mapTimeThroughCuts(2_600, cuts),
        upserts: [element("1", 3, { x: 5, isDeleted: true })],
      },
    ]);
  });
});

// The preview's tracks have no event that states a whole state, so a cut cannot
// squash them: dropping a DOM mutation would break every mutation after it.
describe("preview tracks inside a cut", () => {
  it("keeps every rrweb mutation and preview event, in order", () => {
    const edited = applyRecordingEdit(
      recordingWith({
        previewPatchBatches: [
          {
            version: 2,
            time: 2_500,
            source: "runtime-preview",
            documentId: "d",
            events: [{ type: 3, data: { texts: [{ id: 5, value: SECRET }] }, timestamp: 2_500 }],
          },
          {
            version: 2,
            time: 3_000,
            source: "runtime-preview",
            documentId: "d",
            events: [{ type: 3, data: { texts: [{ id: 5, value: "" }] }, timestamp: 3_000 }],
          },
        ],
        previewEvents: [
          { type: "preview_route_change", timestamp: 2_500, route: `/?key=${SECRET}` },
          { type: "preview_route_change", timestamp: 3_000, route: "/" },
        ],
      }),
      edit,
    );

    expect(edited.previewPatchBatches).toHaveLength(2);
    expect(edited.previewEvents).toHaveLength(2);
    expect(holds(edited.previewPatchBatches, SECRET)).toBe(true);
    expect(holds(edited.previewEvents, SECRET)).toBe(true);
  });
});
