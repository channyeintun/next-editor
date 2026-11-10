import { describe, expect, it } from "vite-plus/test";
import type { ChatRecordingEvent } from "./chat";
import { getChatReplayResult } from "./machine/replayState/chat";
import { getWhiteboardReplayResult } from "./machine/replayState/whiteboard";
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
