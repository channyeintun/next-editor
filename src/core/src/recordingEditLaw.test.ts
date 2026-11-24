import fc from "fast-check";
import type * as monaco from "monaco-editor";
import { describe, expect, it } from "vite-plus/test";
import type { ChatDelta, ChatRecordingEvent } from "./chat";
import { applyFrameAtTime } from "./machine/frameReplay";
import { getChatReplayResult } from "./machine/replayState/chat";
import { getPreviewReplayResult } from "./machine/replayState/preview";
import { getRuntimeReplayResult } from "./machine/replayState/runtime";
import { getSlideReplayResult } from "./machine/replayState/slide";
import {
  getWhiteboardReplayResult,
  INTERPOLATION_WINDOW_MS,
} from "./machine/replayState/whiteboard";
import { getWorkspaceReplayResult } from "./machine/replayState/workspace";
import { createInitialContext } from "./machine/types";
import type { PreviewEvent } from "./preview";
import { applyRecordingEdit, mapTimeThroughCuts } from "./recordingEdit";
import type { RuntimeRecordingEvent, RuntimeRecordingSnapshot } from "./runtime";
import { diffRuntimeSnapshot } from "./runtimeTrack";
import type { Slide, SlideEvent } from "./slides";
import type { EditorFrame, Recording } from "./types";
import { applyChatDelta, INITIAL_CHAT_FOLD_STATE } from "./utils/chatDelta";
import { createContentDelta } from "./utils/contentDelta";
import { compressFrames } from "./utils/frameStreamEncoder";
import { normalizeMediaSpans, type MediaSpan } from "./utils/mediaSpans";
import type { WhiteboardEvent } from "./whiteboard";
import type {
  WorkspaceProject,
  WorkspaceRecordingEvent,
  WorkspaceRecordingSnapshot,
} from "./workspace";

// ============================================================================
// A cut keeps what is outside it.
//
// For every time t outside the cuts, what the edited recording shows at the time t
// moves to equals what the original shows at t. "Shows" is what a seek resolves,
// through replay's own per-track steps, never a copy of them:
//
//   * editor: the frame replay's frame step applies (text, selection, view state),
//     or none, and then the open file's text;
//   * workspace: the open project and file, every file but the open one, and the
//     panel width offsets. The open file's text in the snapshot may differ on
//     purpose: the cut writes the editor's text at its end into it;
//   * runtime, chat, slides and the preview's retained state: exactly;
//   * whiteboard: exactly, except within INTERPOLATION_WINDOW_MS before a cut's start
//     or after its end. Replay animates toward the next event over a window before
//     it, and a cut moves the next event (the squashed one) closer, or the event
//     before the next one further.
//
// Captions and the pointer are outside the law. A caption said across a cut loses
// the words that were cut, so it reads differently before the cut too. The pointer
// glides toward its next sample over the gap between them, which a cut shortens,
// and its cleanup of short hides depends on the samples around them.
// ============================================================================

/** Enough runs to find a cut that breaks a track, few enough to keep the suite fast. */
const NUM_RUNS = 200;

const STUB_EDITOR = { getModel: () => null } as unknown as monaco.editor.IStandaloneCodeEditor;

/** `scratch.html` is created inside a take and may be deleted again. */
type FilePath = "index.html" | "style.css" | "scratch.html";
type ProjectId = "p" | "q";

const SLIDES: Slide[] = [
  { id: "one", order: 0, content: "one", contentType: "html" },
  { id: "two", order: 1, content: "two", contentType: "html" },
];

type Op =
  /** Typing in the open file; `save` also writes a workspace event a moment later. */
  | { k: "type"; at: number; drop: number; text: string; save: boolean }
  | { k: "caret"; column: number; scrollTop: number }
  /** A switch to another file or project, and maybe the editor's first frame of it. */
  | { k: "file"; path: FilePath; frame: boolean }
  | { k: "project"; frame: boolean }
  /** Creates and opens `scratch.html`, or deletes it and opens `index.html`. */
  | { k: "scratch"; frame: boolean }
  | { k: "resize"; sidebar: number; dock: number }
  | { k: "runtime"; text: string; checkpoint: boolean }
  | { k: "chat"; kind: "start" | "content" | "draft" | "checkpoint"; text: string }
  | { k: "whiteboard"; id: string; remove: boolean; x: number }
  | { k: "slide"; type: SlideEvent["type"]; slideId: string }
  | {
      k: "preview";
      type: "preview_open" | "preview_close" | "preview_route_change" | "preview_scroll";
      route: string;
      scrollTop: number;
    };

const arbText = fc.constantFrom("", "a", "b1", "key", "<p>", "}\n");

const arbOp: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      k: fc.constant("type"),
      at: fc.nat(),
      drop: fc.nat({ max: 3 }),
      text: arbText,
      save: fc.boolean(),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant("caret"),
      column: fc.nat({ max: 9 }),
      scrollTop: fc.constantFrom(0, 20),
    }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      k: fc.constant("file"),
      path: fc.constantFrom<FilePath>("index.html", "style.css"),
      frame: fc.boolean(),
    }),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("project"), frame: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("scratch"), frame: fc.boolean() }) },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant("resize"),
      sidebar: fc.integer({ min: -40, max: 40 }),
      dock: fc.integer({ min: -40, max: 40 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ k: fc.constant("runtime"), text: arbText, checkpoint: fc.boolean() }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant("chat"),
      kind: fc.constantFrom("start", "content", "draft", "checkpoint"),
      text: arbText,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant("whiteboard"),
      id: fc.constantFrom("a", "b", "c"),
      remove: fc.boolean(),
      x: fc.nat({ max: 50 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant("slide"),
      type: fc.constantFrom<SlideEvent["type"]>(
        "slide_open",
        "slide_close",
        "slide_change",
        "slide_maximize",
      ),
      slideId: fc.constantFrom("one", "two"),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant("preview"),
      type: fc.constantFrom(
        "preview_open",
        "preview_close",
        "preview_route_change",
        "preview_scroll",
      ),
      route: fc.constantFrom("/", "/about"),
      scrollTop: fc.nat({ max: 200 }),
    }),
  },
);

/** Gaps between steps: often 0, since a studio take on its own clock stamps a burst alike. */
const arbGap = fc.oneof(
  { weight: 1, arbitrary: fc.constant(0) },
  { weight: 4, arbitrary: fc.integer({ min: 1, max: 900 }) },
);

const arbSteps = fc.array(fc.tuple(arbGap, arbOp), { minLength: 1, maxLength: 40 });

/**
 * Cuts placed by the recording's own stamps, where tracks change: each starts and ends
 * at a picked stamp, nudged a little either way, so a cut's edges fall just before,
 * on and just after events. A stamp is picked by `pick` modulo the stamps there are.
 */
const arbNudge = fc.constantFrom(-1, -0.5, 0, 0.5, 1, 40);
const arbCuts = fc.array(fc.tuple(fc.nat(), arbNudge, fc.nat({ max: 12 }), arbNudge), {
  minLength: 1,
  maxLength: 3,
});

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

function projectOf(id: ProjectId, files: Partial<Record<FilePath, string>>): WorkspaceProject {
  return {
    id,
    name: id,
    lessonType: "html-css",
    entryFilePath: "index.html",
    folders: [],
    files: Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        path,
        { path, name: path, language: "plaintext", content },
      ]),
    ),
  };
}

/**
 * Records `steps` the way a take does: frames carry the open file's text (typing
 * fires no workspace event), a file or project switch writes a workspace snapshot of
 * every file, and the first workspace, runtime and editor records are at 0.
 */
function record(steps: Array<[number, Op]>): Recording {
  const files: Record<ProjectId, Partial<Record<FilePath, string>>> = {
    p: { "index.html": "<h1>", "style.css": "" },
    q: { "index.html": "q", "style.css": "q{}" },
  };
  let project: ProjectId = "p";
  let path: FilePath = "index.html";
  let column = 1;
  let scrollTop = 0;
  let time = 0;

  const frames: EditorFrame[] = [];
  const workspaceEvents: WorkspaceRecordingEvent[] = [];
  const runtimeEvents: RuntimeRecordingEvent[] = [];
  const chatEvents: ChatRecordingEvent[] = [];
  const whiteboardEvents: WhiteboardEvent[] = [];
  const slideEvents: SlideEvent[] = [];
  const previewEvents: PreviewEvent[] = [];

  const pushFrame = (timestamp: number) => {
    frames.push({
      timestamp,
      state: {
        content: files[project][path] ?? "",
        selection: selectionAt(column),
        position: { lineNumber: 1, column },
        viewState: { scrollTop } as unknown as monaco.editor.ICodeEditorViewState,
      },
    });
  };
  const pushWorkspace = (timestamp: number, widths: Partial<WorkspaceRecordingSnapshot> = {}) => {
    workspaceEvents.push({
      timestamp,
      snapshot: {
        project: projectOf(project, { ...files[project] }),
        activeFilePath: path,
        ...widths,
      },
    });
  };

  let runtime: RuntimeRecordingSnapshot = {
    mode: "webcontainer",
    status: "ready",
    terminalSessions: [{ id: "t1", title: "t1", output: "" }],
  };
  let chat = INITIAL_CHAT_FOLD_STATE;
  let serial = 0;

  pushFrame(0);
  pushWorkspace(0, { sidebarWidthDelta: 0 });
  runtimeEvents.push({ timestamp: 0, snapshot: runtime });

  for (const [gap, op] of steps) {
    time += gap;
    serial += 1;
    switch (op.k) {
      case "type": {
        const text = files[project][path] ?? "";
        const at = op.at % (text.length + 1);
        files[project][path] = text.slice(0, at) + op.text + text.slice(at + op.drop);
        column = at + op.text.length + 1;
        pushFrame(time);
        if (op.save) pushWorkspace(time + (serial % 3));
        break;
      }
      case "caret":
        column = op.column + 1;
        scrollTop = op.scrollTop;
        pushFrame(time);
        break;
      case "file":
      case "project":
      case "scratch":
        if (op.k === "file") {
          path = op.path;
        } else if (op.k === "project") {
          project = project === "p" ? "q" : "p";
        } else if (files[project]["scratch.html"] === undefined) {
          files[project]["scratch.html"] = "";
          path = "scratch.html";
        } else {
          delete files[project]["scratch.html"];
          if (path === "scratch.html") path = "index.html";
        }
        // A file can only be open in a project that has it.
        if (files[project][path] === undefined) files[project][path] = "";
        pushWorkspace(time);
        if (op.frame) pushFrame(time + (serial % 2));
        break;
      case "resize":
        pushWorkspace(time, { sidebarWidthDelta: op.sidebar, previewDockWidthDelta: op.dock });
        break;
      case "runtime": {
        const [session] = runtime.terminalSessions ?? [];
        const next: RuntimeRecordingSnapshot = {
          ...runtime,
          terminalSessions: [{ ...session, output: (session.output + op.text).slice(-12) }],
        };
        runtimeEvents.push(
          op.checkpoint
            ? { timestamp: time, snapshot: next }
            : { timestamp: time, delta: diffRuntimeSnapshot(runtime, next) },
        );
        runtime = next;
        break;
      }
      case "chat": {
        if (op.kind === "checkpoint") {
          const state = { items: chat.items, status: chat.status, draft: chat.draft };
          chatEvents.push({ timestamp: time, event: { k: "checkpoint", state } });
          break;
        }
        let delta: ChatDelta | null = null;
        if (op.kind === "start") {
          delta = { k: "message_start", id: `m${serial}`, role: "user" };
        } else if (op.kind === "draft") {
          delta = { k: "draft", text: op.text };
        } else {
          const active = chat.items.findLast((item) => item.kind === "message");
          const contentDelta =
            active?.kind === "message"
              ? createContentDelta(active.text, active.text + op.text)
              : null;
          delta = contentDelta ? { k: "content", delta: contentDelta } : null;
        }
        if (delta) {
          chatEvents.push({ timestamp: time, event: delta });
          chat = applyChatDelta(chat, delta);
        }
        break;
      }
      case "whiteboard":
        whiteboardEvents.push(
          op.remove
            ? { timestamp: time, removedIds: [op.id] }
            : {
                timestamp: time,
                upserts: [
                  {
                    id: op.id,
                    type: "rectangle",
                    version: serial,
                    versionNonce: serial,
                    isDeleted: false,
                    x: op.x,
                    y: 0,
                    width: 10,
                    height: 10,
                  },
                ],
              },
        );
        break;
      case "slide":
        slideEvents.push({ timestamp: time, type: op.type, slideId: op.slideId });
        break;
      case "preview":
        previewEvents.push({
          timestamp: time,
          type: op.type,
          ...(op.type === "preview_route_change" ? { route: op.route } : {}),
          ...(op.type === "preview_scroll" ? { scrollTop: op.scrollTop, scrollLeft: 0 } : {}),
        });
        break;
    }
  }

  // Saves and first frames land a moment after their step, so a log can be out of
  // order by a millisecond at the end of a burst; a take's stamps never go back.
  const byTime = <T extends { timestamp: number }>(events: T[]) =>
    events.sort((left, right) => left.timestamp - right.timestamp);

  return {
    version: 4,
    id: "take",
    name: "Take",
    createdAt: 1,
    duration: time + 1_000,
    keyframeInterval: 120,
    frames: compressFrames(byTime(frames)),
    workspaceEvents: byTime(workspaceEvents),
    runtimeEvents,
    chatEvents,
    whiteboardEvents,
    slideEvents,
    slides: SLIDES,
    previewEvents,
  };
}

/** What a seek to `time` shows, per track, through replay's own steps. */
function shownAt(recording: Recording, time: number) {
  const workspace = getWorkspaceReplayResult({
    workspaceEvents: recording.workspaceEvents ?? [],
    currentTime: time,
    lastAppliedIndex: -1,
  });
  const snapshot = workspace.snapshotToApply;

  // The frame step reads the workspace cursor the workspace step just set. The stub
  // editor has no model, so the step folds the frame without writing it anywhere.
  const initial = createInitialContext({ editorRef: { current: STUB_EDITOR } });
  const context = {
    ...initial,
    recording,
    timeline: { ...initial.timeline, currentTime: time, duration: recording.duration },
    lastAppliedWorkspaceEventIndex: workspace.nextIndex,
  };
  const frame = applyFrameAtTime({ context, event: { type: "SEEK", time } }).currentFrame;
  const openFile = snapshot?.project.files[snapshot.activeFilePath];

  return {
    editor: frame
      ? {
          content: frame.state.content,
          selection: frame.state.selection,
          viewState: frame.state.viewState,
        }
      : { frame: null, text: openFile && "content" in openFile ? openFile.content : undefined },
    workspace: snapshot && {
      project: snapshot.project.id,
      activeFilePath: snapshot.activeFilePath,
      otherFiles: Object.values(snapshot.project.files).filter(
        (file) => file.path !== snapshot.activeFilePath,
      ),
      sidebarWidthDelta: snapshot.sidebarWidthDelta,
      previewDockWidthDelta: snapshot.previewDockWidthDelta,
    },
    runtime: getRuntimeReplayResult({
      runtimeEvents: recording.runtimeEvents ?? [],
      currentTime: time,
      lastAppliedIndex: -1,
    }).snapshotToApply,
    chat: getChatReplayResult({
      chatEvents: recording.chatEvents ?? [],
      currentTime: time,
      lastAppliedIndex: -1,
      isResync: true,
    }).snapshotToApply,
    slides: getSlideReplayResult({
      slideEvents: recording.slideEvents ?? [],
      slides: SLIDES,
      currentTime: time,
      lastAppliedIndex: -1,
      isResync: true,
    }).applications.at(-1),
    preview: getPreviewReplayResult({
      previewEvents: recording.previewEvents ?? [],
      currentTime: time,
      lastAppliedIndex: -1,
      isResync: true,
    }).retainedState,
  };
}

const whiteboardAt = (recording: Recording, time: number) =>
  getWhiteboardReplayResult({
    whiteboardEvents: recording.whiteboardEvents ?? [],
    currentTime: time,
    lastAppliedIndex: -1,
  }).stateToApply;

/** Every time any track of `recording` changes, in order. */
const stampsOf = (recording: Recording): number[] =>
  [
    ...recording.frames,
    ...(recording.workspaceEvents ?? []),
    ...(recording.runtimeEvents ?? []),
    ...(recording.chatEvents ?? []),
    ...(recording.whiteboardEvents ?? []),
    ...(recording.slideEvents ?? []),
    ...(recording.previewEvents ?? []),
  ]
    .map((event) => event.timestamp)
    .sort((left, right) => left - right);

/** Every recorded stamp, a step either side of it, and the moments just after each cut. */
function timesToCheck(recording: Recording, cuts: readonly MediaSpan[]): number[] {
  const stamps = stampsOf(recording);
  const near = stamps.flatMap((stamp) => [stamp - 1, stamp, stamp + 0.5, stamp + 1]);
  const afterCuts = cuts.flatMap((cut) => [cut.start, cut.end + 0.5, cut.end + 1, cut.end + 50]);
  const inside = (time: number) => cuts.some((cut) => time > cut.start && time <= cut.end);
  return [...new Set([0, ...near, ...afterCuts, recording.duration])].filter(
    (time) => time >= 0 && time <= recording.duration && !inside(time),
  );
}

const nearACut = (time: number, cuts: readonly MediaSpan[]) =>
  cuts.some(
    (cut) =>
      (time <= cut.start && cut.start - time < INTERPOLATION_WINDOW_MS) ||
      (time > cut.end && time - cut.end < INTERPOLATION_WINDOW_MS),
  );

/**
 * What a cut keeps inside its own window, which no time outside the cuts reaches: a
 * playback tick or a chapter seek can still land there. Each workspace event there but
 * the cut's last one (the survivor) holds the survivor's project and files and opens
 * only one of them, or none, and is either stamped like the event after it, so replay
 * never applies it on its own, or in the survivor's project and file.
 */
function expectNothingNewInsideCuts(edited: Recording, cuts: readonly MediaSpan[]) {
  const events = edited.workspaceEvents ?? [];
  const found: string[] = [];
  for (const cut of cuts) {
    const from = mapTimeThroughCuts(cut.start, cuts);
    const to = mapTimeThroughCuts(cut.end, cuts);
    const inside = events.flatMap((event, index) =>
      event.timestamp > from && event.timestamp <= to ? [index] : [],
    );
    const survivor = events[inside.at(-1) ?? -1]?.snapshot;
    for (const index of inside.slice(0, -1)) {
      const { timestamp, snapshot } = events[index];
      const where = `event ${index} in the cut ${JSON.stringify(cut)}`;
      if (JSON.stringify(snapshot.project) !== JSON.stringify(survivor.project)) {
        found.push(`${where} is in another project or files`);
      }
      if (!["", ...Object.keys(snapshot.project.files)].includes(snapshot.activeFilePath)) {
        found.push(`${where} opens ${snapshot.activeFilePath}, which it does not hold`);
      }
      const appliedAlone = events[index + 1].timestamp !== timestamp;
      if (appliedAlone && snapshot.activeFilePath !== survivor.activeFilePath) {
        found.push(`${where} can be shown on its own, with another file open`);
      }
    }
  }
  expect(found).toEqual([]);
}

describe("a cut keeps what is outside it", () => {
  it("shows at the moved time what the original shows, on every track the law covers", () => {
    let compared = 0;
    fc.assert(
      fc.property(arbSteps, arbCuts, (steps, cutPicks) => {
        const recording = record(steps);
        const stamps = stampsOf(recording);
        const cuts = normalizeMediaSpans(
          cutPicks.map(([pick, nudgeStart, length, nudgeEnd]) => {
            const from = pick % stamps.length;
            const to = Math.min(from + length, stamps.length - 1);
            return {
              start: Math.max(0, stamps[from] + nudgeStart),
              end: Math.min(recording.duration, stamps[to] + nudgeEnd),
            };
          }),
        );
        const edited = applyRecordingEdit(recording, { cuts, mutes: [] });
        expectNothingNewInsideCuts(edited, cuts);

        for (const time of timesToCheck(recording, cuts)) {
          const moved = mapTimeThroughCuts(time, cuts);
          expect(shownAt(edited, moved), `at ${time}`).toEqual(shownAt(recording, time));
          const boardAt = (subject: Recording, at: number) =>
            nearACut(time, cuts) ? "not compared" : whiteboardAt(subject, at);
          expect(boardAt(edited, moved), `whiteboard at ${time}`).toEqual(boardAt(recording, time));
          compared += 1;
        }
      }),
      { numRuns: NUM_RUNS },
    );
    expect(compared).toBeGreaterThan(NUM_RUNS);
  });
});
