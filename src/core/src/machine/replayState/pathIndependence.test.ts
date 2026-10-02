import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import type {
  ChatCheckpoint,
  ChatDelta,
  ChatItem,
  ChatRecordingEvent,
  ChatRole,
  ChatStatus,
} from "../../../../types/chat";
import type {
  RuntimeRecordingEvent,
  RuntimeRecordingSnapshot,
  RuntimeTerminalSessionSnapshot,
} from "../../../../types/runtime";
import {
  areWorkspaceSnapshotsEqual,
  toWorkspaceDeltaSnapshot,
  type WorkspaceRecordingEvent,
  type WorkspaceRecordingSnapshot,
} from "../../../../types/workspace";
import { diffRuntimeSnapshot, resolveRuntimeSnapshotAt } from "../../runtimeTrack";
import type { PreviewEvent, PreviewState, Slide, SlideEvent } from "../../slides";
import { applyChatDelta, INITIAL_CHAT_FOLD_STATE, type ChatFoldState } from "../../utils/chatDelta";
import { createContentDelta } from "../../utils/frameDelta";
import type {
  WhiteboardElementJSON,
  WhiteboardEvent,
  WhiteboardSceneState,
} from "../../whiteboard";
import { getChatReplayResult } from "./chat";
import { isReplayResync } from "./cursor";
import { getPreviewReplayResult } from "./preview";
import { getRuntimeReplayResult } from "./runtime";
import { getSlideReplayResult, type SlideReplayApplication } from "./slide";
import { getWhiteboardReplayResult } from "./whiteboard";
import { getWorkspaceReplayResult } from "./workspace";

// ============================================================================
// Seeking lands where playing does.
//
// Whatever path of ticks, seeks, resumes and streamed appends brings playback
// to time T, a track must show what a cold resolve at T shows. Each test below
// generates a time-sorted event log and a walk, and checks this after every
// move of the walk.
//
// The walk follows the machine's cursor protocol (replayActions.ts):
//   * TICK advances from the track's cursor.
//   * SEEK runs REPLAY_CURSORS_RESET, then resyncs at the new time.
//   * PLAY after a pause runs invalidateAppliedPlaybackState, then resyncs.
//   * APPEND_RECORDING_DELTA pushes records into the same array, then applies.
// Each track has its own adapter, because each one keeps its cursor and shows
// its state a little differently.
// ============================================================================

/** Enough runs to find a broken cursor rule, few enough to keep the suite fast. */
const NUM_RUNS = 150;

/** The event a track's apply action runs for. "LOAD" is the playback entry after a load. */
type ReplayTrigger = "LOAD" | "TICK" | "SEEK" | "PLAY" | "APPEND_RECORDING_DELTA";

/**
 * Tracks with transient interactions (slide hops, preview clicks) replay every
 * event a tick or a streamed append crosses. A load, a seek or a resume lands on
 * one state and must never fire the recorded interactions again.
 */
function expectAtMostOneState(trigger: ReplayTrigger, applied: readonly unknown[]): void {
  if (trigger === "LOAD" || trigger === "SEEK" || trigger === "PLAY") {
    expect(applied.length, `states applied on ${trigger}`).toBeLessThanOrEqual(1);
  }
}

type Move =
  | { kind: "tick"; dt: number }
  /** Seek near a recorded stamp: `pick` chooses the event, `offset` moves off its stamp. */
  | { kind: "seek"; pick: number; offset: number }
  | { kind: "resume" }
  | { kind: "append"; count: number };

interface TrackWalk {
  /** The track's apply action (applyChatEventsAtTime and the others) at `time`. */
  apply(time: number, trigger: ReplayTrigger): void;
  /** What SEEK (seekToTime) or PLAY (invalidateAppliedPlaybackState) resets for this track. */
  invalidate(trigger: "SEEK" | "PLAY"): void;
  /** The next `count` records of the log, pushed into the array the walk replays. */
  append(count: number): void;
  /** What the track shows now. */
  shown(): unknown;
  /** What a cold resolve at `time` shows, from a copy that shares no cache with the walk. */
  cold(time: number): unknown;
}

const arbMove: fc.Arbitrary<Move> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant("tick"),
      // Zero-length and short ticks land inside whiteboard animation windows.
      dt: fc.oneof(
        fc.constant(0),
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 61, max: 500 }),
      ),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("seek"),
      pick: fc.nat(),
      offset: fc.constantFrom(-100, -1, 0, 1, 500),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "resume" } as const) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant("append"), count: fc.integer({ min: 1, max: 4 }) }),
  },
);

/** Logs and walks of up to 30 steps; "medium" keeps most of them long enough to matter. */
const SIZE = { maxLength: 30, size: "medium" } as const;

const arbMoves = fc.array(arbMove, SIZE);

/** How many records the load has; the rest stream in through appends. Often few. */
const arbInitialCount = fc.oneof(fc.constant(0), fc.nat({ max: 3 }), fc.nat({ max: 30 }));

/** The type of value an arbitrary generates. */
type ValueOf<A> = A extends fc.Arbitrary<infer T> ? T : never;

/** Gaps between events: often 0, since everything captured during a pause shares one stamp. */
const arbGap = fc.oneof(
  { weight: 1, arbitrary: fc.constant(0) },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 400 }) },
);

/**
 * Plays `moves` on `track`, checking it against a cold resolve after the load and
 * after each move. Returns how many states it compared.
 */
function walk(track: TrackWalk, moves: Move[], stamps: number[]): number {
  let time = 0;
  track.apply(time, "LOAD");
  expect(track.shown(), "after the load").toEqual(track.cold(time));

  moves.forEach((move, index) => {
    if (move.kind === "tick") {
      time += move.dt;
      track.apply(time, "TICK");
    } else if (move.kind === "seek") {
      const stamp = stamps.length ? stamps[move.pick % stamps.length] : 0;
      time = Math.max(0, stamp + move.offset);
      track.invalidate("SEEK");
      track.apply(time, "SEEK");
    } else if (move.kind === "resume") {
      track.invalidate("PLAY");
      track.apply(time, "PLAY");
    } else {
      track.append(move.count);
      track.apply(time, "APPEND_RECORDING_DELTA");
    }
    expect(track.shown(), `after move ${index} (${move.kind}) at ${time}ms`).toEqual(
      track.cold(time),
    );
  });
  return moves.length + 1;
}

/** Pushes the next `count` records of `all` into `events`, in place. */
function appendInPlace<T>(events: T[], all: readonly T[], count: number): void {
  events.push(...all.slice(events.length, events.length + count));
}

// ============================================================================
// Chat: a delta log with checkpoints, folded with a retained fold per array.
// ============================================================================

type ChatOp =
  | { k: "message_start"; role: ChatRole }
  | { k: "content"; at: number; cut: number; text: string }
  | { k: "status"; status: ChatStatus }
  | { k: "draft"; text: string }
  | { k: "tool_call" }
  | { k: "tool_result"; pick: number }
  | { k: "remove"; pick: number }
  | { k: "reset" }
  | { k: "checkpoint" };

const arbChatOp: fc.Arbitrary<ChatOp> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant("message_start"),
      role: fc.constantFrom("user", "assistant"),
    }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      k: fc.constant("content"),
      at: fc.nat(),
      cut: fc.nat({ max: 3 }),
      text: fc.string({ maxLength: 5 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant("status"),
      status: fc.constantFrom("idle", "streaming", "running-tool", "done", "error"),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ k: fc.constant("draft"), text: fc.constantFrom("", "fi", "fix it") }),
  },
  { weight: 1, arbitrary: fc.constant({ k: "tool_call" } as const) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("tool_result"), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("remove"), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.constant({ k: "reset" } as const) },
  { weight: 2, arbitrary: fc.constant({ k: "checkpoint" } as const) },
);

type ChatMessage = Extract<ChatItem, { kind: "message" }>;
type ChatToolCall = Extract<ChatItem, { kind: "tool_call" }>;

/** The delta `op` records against the folded transcript, or null when it does not apply. */
function chatDeltaFor(op: ChatOp, state: ChatFoldState, serial: number): ChatDelta | null {
  switch (op.k) {
    case "message_start":
      return { k: "message_start", id: `msg-${serial}`, role: op.role };
    case "content": {
      const active = state.items.findLast((item): item is ChatMessage => item.kind === "message");
      if (!active) return null;
      const at = op.at % (active.text.length + 1);
      const next = active.text.slice(0, at) + op.text + active.text.slice(at + op.cut);
      const delta = createContentDelta(active.text, next);
      return delta ? { k: "content", delta } : null;
    }
    case "status":
      return { k: "status", status: op.status };
    case "draft":
      return { k: "draft", text: op.text };
    case "tool_call":
      return {
        k: "tool_call",
        id: `tool-${serial}`,
        callId: `call-${serial}`,
        name: "read_file",
        arguments: "{}",
      };
    case "tool_result": {
      const calls = state.items.filter((item): item is ChatToolCall => item.kind === "tool_call");
      if (!calls.length) return null;
      return { k: "tool_result", callId: calls[op.pick % calls.length].callId, output: "ok" };
    }
    case "remove":
      if (!state.items.length) return null;
      return { k: "remove", fromId: state.items[op.pick % state.items.length].id };
    case "reset":
      return { k: "reset" };
    case "checkpoint":
      return null;
  }
}

/**
 * Records `steps` the way the agent store does: each delta against the folded
 * transcript, and each checkpoint equal to the fold at its index.
 */
function recordChat(steps: Array<[gap: number, op: ChatOp]>): ChatRecordingEvent[] {
  const events: ChatRecordingEvent[] = [];
  let state = INITIAL_CHAT_FOLD_STATE;
  let time = 0;

  steps.forEach(([gap, op], serial) => {
    time += gap;
    if (op.k === "checkpoint") {
      const checkpoint = { items: state.items, status: state.status, draft: state.draft };
      events.push({ timestamp: time, event: { k: "checkpoint", state: checkpoint } });
      return;
    }
    const delta = chatDeltaFor(op, state, serial);
    if (!delta) return;
    events.push({ timestamp: time, event: delta });
    state = applyChatDelta(state, delta);
  });

  return events;
}

function chatWalk(all: ChatRecordingEvent[], initialCount: number): TrackWalk {
  const events = all.slice(0, initialCount);
  let lastAppliedIndex = -1;
  // setRecording applies the empty transcript before the chat track replays.
  let shown: ChatCheckpoint = { items: [], status: "idle" };

  return {
    apply(time, trigger) {
      if (!events.length) return;
      const result = getChatReplayResult({
        chatEvents: events,
        currentTime: time,
        lastAppliedIndex,
        isResync: isReplayResync({ type: trigger }, lastAppliedIndex),
      });
      if (result.snapshotToApply) shown = result.snapshotToApply;
      lastAppliedIndex = result.nextIndex;
    },
    invalidate() {
      lastAppliedIndex = -1;
    },
    append(count) {
      appendInPlace(events, all, count);
    },
    shown: () => shown,
    // A cold resolve is a resync, which shows the empty transcript before the
    // first chat event.
    cold: (time) =>
      getChatReplayResult({
        chatEvents: [...events],
        currentTime: time,
        lastAppliedIndex: -1,
        isResync: true,
      }).snapshotToApply,
  };
}

// ============================================================================
// Runtime: terminal output as deltas between checkpoints, resolved through a
// fold cache per array (resolveRuntimeSnapshotAt).
// ============================================================================

type RuntimeOp =
  /** Output printed to a session, inside a rolling window of `keep` characters. */
  | { k: "print"; session: number; text: string; keep: number }
  /** The session's screen replaced by unrelated text (a clear). */
  | { k: "clear"; session: number; text: string }
  | { k: "close"; session: number }
  | { k: "status"; status: string };

const RUNTIME_SESSION_IDS = ["t1", "t2"];

const arbRuntimeOp: fc.Arbitrary<RuntimeOp> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      k: fc.constant("print"),
      session: fc.integer({ min: 0, max: 1 }),
      text: fc.string({ minLength: 1, maxLength: 6 }),
      keep: fc.integer({ min: 4, max: 24 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant("clear"),
      session: fc.integer({ min: 0, max: 1 }),
      text: fc.string({ maxLength: 3 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ k: fc.constant("close"), session: fc.integer({ min: 0, max: 1 }) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant("status"),
      status: fc.constantFrom("running", "ready", "error"),
    }),
  },
);

function nextRuntimeSnapshot(
  previous: RuntimeRecordingSnapshot,
  op: RuntimeOp,
): RuntimeRecordingSnapshot {
  if (op.k === "status") return { ...previous, status: op.status };

  const id = RUNTIME_SESSION_IDS[op.session];
  const sessions = previous.terminalSessions ?? [];
  if (op.k === "close") {
    return { ...previous, terminalSessions: sessions.filter((session) => session.id !== id) };
  }

  const output = sessions.find((session) => session.id === id)?.output ?? "";
  const nextSession: RuntimeTerminalSessionSnapshot = {
    id,
    title: id,
    output: op.k === "print" ? (output + op.text).slice(-op.keep) : op.text,
  };
  return {
    ...previous,
    terminalSessions: [...sessions.filter((session) => session.id !== id), nextSession],
  };
}

/**
 * Records `steps` like createRuntimeRecordingEvent, except that the generator
 * chooses where the checkpoints go. The recorder writes the first runtime event
 * at t=0 (captureActions.ts), so every time has an event at or before it.
 */
function recordRuntime(
  steps: Array<[gap: number, op: RuntimeOp, checkpoint: boolean]>,
): RuntimeRecordingEvent[] {
  let previous: RuntimeRecordingSnapshot = {
    mode: "webcontainer",
    status: "booting",
    terminalSessions: [],
  };
  const events: RuntimeRecordingEvent[] = [{ timestamp: 0, snapshot: previous }];
  let time = 0;

  for (const [gap, op, checkpoint] of steps) {
    time += gap;
    const next = nextRuntimeSnapshot(previous, op);
    events.push(
      checkpoint
        ? { timestamp: time, snapshot: next }
        : { timestamp: time, delta: diffRuntimeSnapshot(previous, next) },
    );
    previous = next;
  }

  return events;
}

function runtimeWalk(all: RuntimeRecordingEvent[], initialCount: number): TrackWalk {
  const events = all.slice(0, initialCount);
  // setRecording applies the state at index 0 and starts the cursor there.
  let shown = resolveRuntimeSnapshotAt(events, 0) ?? undefined;
  let lastAppliedIndex = shown ? 0 : -1;

  return {
    apply(time) {
      if (!events.length) return;
      const result = getRuntimeReplayResult({
        runtimeEvents: events,
        currentTime: time,
        lastAppliedIndex,
      });
      if (result.snapshotToApply) shown = result.snapshotToApply;
      lastAppliedIndex = result.nextIndex;
    },
    invalidate(trigger) {
      lastAppliedIndex = -1;
      // When playing starts, the runtime dock also resolves index 0 on its own
      // (useRuntimeDockRecordedSnapshot). That moves the shared fold cache back to
      // the start, and the cache must not change any result.
      if (trigger === "PLAY") resolveRuntimeSnapshotAt(events, 0);
    },
    append(count) {
      appendInPlace(events, all, count);
    },
    shown: () => shown,
    cold: (time) =>
      events.length
        ? getRuntimeReplayResult({
            runtimeEvents: [...events],
            currentTime: time,
            lastAppliedIndex: -1,
          }).snapshotToApply
        : undefined,
  };
}

// ============================================================================
// Workspace: whole snapshots, but panel widths replay as relative offsets that
// are added to the viewer's own widths.
// ============================================================================

const BASE_SIDEBAR_WIDTH = 240;
const BASE_PREVIEW_DOCK_WIDTH = 400;

function workspaceSnapshot(activeFilePath: string, content: string): WorkspaceRecordingSnapshot {
  return {
    activeFilePath,
    collapsedFolders: [],
    sidebarScrollTop: 0,
    project: {
      id: "project-1",
      name: "Project",
      lessonType: "html-css",
      entryFilePath: "index.html",
      folders: [],
      files: {
        [activeFilePath]: { path: activeFilePath, name: activeFilePath, language: "html", content },
      },
    },
  };
}

/** The viewer's own workspace before the recording loads. */
const VIEWER_WORKSPACE = workspaceSnapshot("notes.html", "my notes");

const arbWorkspaceStep = fc.record({
  gap: arbGap,
  activeFilePath: fc.constantFrom("index.html", "app.html"),
  content: fc.constantFrom("", "a", "ab"),
  // Most workspace events are edits and file switches, which carry no width
  // fields at all. A resize moves one panel.
  resize: fc.oneof(
    { weight: 3, arbitrary: fc.constant(undefined) },
    {
      weight: 1,
      arbitrary: fc.oneof(
        fc.record({ sidebarWidthDelta: fc.integer({ min: -60, max: 60 }) }),
        fc.record({ previewDockWidthDelta: fc.integer({ min: -60, max: 60 }) }),
      ),
    },
  ),
});

/**
 * Records `steps` like appendWorkspaceRecordingEvent, without its dedupe. The
 * recorder writes the first workspace event at t=0 with a zero sidebar delta
 * (captureActions.ts), so every time has an event at or before it.
 */
function recordWorkspace(
  steps: Array<ValueOf<typeof arbWorkspaceStep>>,
): WorkspaceRecordingEvent[] {
  const events: WorkspaceRecordingEvent[] = [
    { timestamp: 0, snapshot: { ...workspaceSnapshot("index.html", ""), sidebarWidthDelta: 0 } },
  ];
  let time = 0;

  for (const { gap, activeFilePath, content, resize } of steps) {
    time += gap;
    const snapshot = workspaceSnapshot(activeFilePath, content);
    events.push({
      timestamp: time,
      snapshot: resize ? toWorkspaceDeltaSnapshot(snapshot, resize) : snapshot,
    });
  }

  return events;
}

/** The part of a workspace the walk compares: which file is open, and what it holds. */
function describeWorkspace(snapshot: WorkspaceRecordingSnapshot) {
  return {
    activeFilePath: snapshot.activeFilePath,
    content: snapshot.project.files[snapshot.activeFilePath]?.content,
  };
}

function workspaceWalk(all: WorkspaceRecordingEvent[], initialCount: number): TrackWalk {
  const events = all.slice(0, initialCount);
  const live = {
    snapshot: VIEWER_WORKSPACE,
    sidebarWidth: BASE_SIDEBAR_WIDTH,
    previewDockWidth: BASE_PREVIEW_DOCK_WIDTH,
  };

  // NextEditorProvider's applyWorkspaceSnapshot: the files are replaced, and a
  // non-zero width delta is added to the width the viewer has now.
  const applyWorkspaceSnapshot = (snapshot: WorkspaceRecordingSnapshot) => {
    const { sidebarWidthDelta, previewDockWidthDelta, ...files } = snapshot;
    live.snapshot = files;
    live.sidebarWidth += sidebarWidthDelta ?? 0;
    live.previewDockWidth += previewDockWidthDelta ?? 0;
  };

  // setRecording applies the first event and starts the cursor there.
  let lastAppliedIndex = -1;
  if (events.length) {
    if (!areWorkspaceSnapshotsEqual(live.snapshot, events[0].snapshot)) {
      applyWorkspaceSnapshot(events[0].snapshot);
    }
    lastAppliedIndex = 0;
  }

  return {
    apply(time) {
      if (!events.length) return;
      const result = getWorkspaceReplayResult({
        workspaceEvents: events,
        currentTime: time,
        getCurrentSnapshot: () => live.snapshot,
        lastAppliedIndex,
      });
      if (result.snapshotToApply) applyWorkspaceSnapshot(result.snapshotToApply);
      lastAppliedIndex = result.nextIndex;
    },
    // REPLAY_CURSORS_RESET leaves the workspace cursor alone. The widths are
    // relative, so the replay must know which offsets it has already added:
    // resetting the cursor to -1 here would add them all a second time.
    invalidate() {},
    append(count) {
      appendInPlace(events, all, count);
    },
    shown: () => ({
      sidebarWidth: live.sidebarWidth,
      previewDockWidth: live.previewDockWidth,
      ...describeWorkspace(live.snapshot),
    }),
    // The law: each width is the viewer's width plus every offset recorded at or
    // before `time`, and the files are those of the latest event.
    cold: (time) => {
      const index = events.findLastIndex((event) => event.timestamp <= time);
      let sidebarWidth = BASE_SIDEBAR_WIDTH;
      let previewDockWidth = BASE_PREVIEW_DOCK_WIDTH;
      for (const { snapshot } of events.slice(0, index + 1)) {
        sidebarWidth += snapshot.sidebarWidthDelta ?? 0;
        previewDockWidth += snapshot.previewDockWidthDelta ?? 0;
      }
      return {
        sidebarWidth,
        previewDockWidth,
        ...describeWorkspace(index >= 0 ? events[index].snapshot : VIEWER_WORKSPACE),
      };
    },
  };
}

// ============================================================================
// Whiteboard: element deltas folded into a retained scene per event, with
// interpolated scenes inside each event's animation window.
// ============================================================================

const arbWhiteboardElement: fc.Arbitrary<WhiteboardElementJSON> = fc
  .record({
    id: fc.constantFrom("a", "b", "c"),
    freedraw: fc.boolean(),
    x: fc.integer({ min: 0, max: 100 }),
    y: fc.integer({ min: 0, max: 100 }),
    pointCount: fc.nat({ max: 6 }),
    index: fc.option(fc.constantFrom("a0", "a1", "a2"), { nil: undefined }),
  })
  .map(({ id, freedraw, x, y, pointCount, index }) => ({
    id,
    type: freedraw ? "freedraw" : "rectangle",
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    x,
    y,
    width: 10,
    height: 10,
    ...(freedraw
      ? { points: Array.from({ length: pointCount }, (_, point) => [point, point]) }
      : {}),
    ...(index ? { index } : {}),
  }));

const arbWhiteboardStep = fc.record({
  gap: arbGap,
  upserts: fc.array(arbWhiteboardElement, { maxLength: 2 }),
  removedIds: fc.array(fc.constantFrom("a", "b", "c"), { maxLength: 1 }),
  view: fc.option(
    fc.record({
      scrollX: fc.integer({ min: -50, max: 50 }),
      scrollY: fc.integer({ min: -50, max: 50 }),
      zoom: fc.constantFrom(1, 2),
    }),
    { nil: undefined },
  ),
  isOpen: fc.option(fc.boolean(), { nil: undefined }),
});

function recordWhiteboard(steps: Array<ValueOf<typeof arbWhiteboardStep>>): WhiteboardEvent[] {
  let time = 0;
  return steps.map(({ gap, ...change }) => ({ timestamp: (time += gap), ...change }));
}

function whiteboardWalk(all: WhiteboardEvent[], initialCount: number): TrackWalk {
  const events = all.slice(0, initialCount);
  let lastAppliedIndex = -1;
  let shown: WhiteboardSceneState | undefined;

  return {
    apply(time) {
      if (!events.length) return;
      const result = getWhiteboardReplayResult({
        whiteboardEvents: events,
        currentTime: time,
        lastAppliedIndex,
      });
      if (result.stateToApply) shown = result.stateToApply;
      lastAppliedIndex = result.nextIndex;
    },
    invalidate() {
      lastAppliedIndex = -1;
    },
    append(count) {
      appendInPlace(events, all, count);
    },
    shown: () => shown,
    // An interpolated scene depends only on the time and the events around it,
    // and ticks only move forward, so the walk matches inside animation windows too.
    cold: (time) =>
      events.length
        ? getWhiteboardReplayResult({
            whiteboardEvents: [...events],
            currentTime: time,
            lastAppliedIndex: -1,
          }).stateToApply
        : undefined,
  };
}

// ============================================================================
// Slides: forward ticks apply every crossed event, a resync applies one state.
// ============================================================================

const SLIDES: Slide[] = [
  { id: "one", order: 0, content: "one", contentType: "html" },
  { id: "two", order: 1, content: "two", contentType: "html" },
  { id: "three", order: 2, content: "three", contentType: "html" },
];

// Every event names a slide in the deck, so each one resolves to a state. An
// event the deck cannot place applies nothing, on a tick and on a seek alike.
const arbSlideStep = fc.record(
  {
    gap: arbGap,
    type: fc.constantFrom(
      "slide_open",
      "slide_close",
      "slide_change",
      "slide_maximize",
      "slide_minimize",
      "slide_interaction",
    ),
    slideId: fc.constantFrom("one", "two", "three"),
    isMaximized: fc.boolean(),
    indexv: fc.nat({ max: 2 }),
    clickX: fc.nat({ max: 100 }),
  },
  { requiredKeys: ["gap", "type", "slideId"] },
);

function recordSlides(steps: Array<ValueOf<typeof arbSlideStep>>): SlideEvent[] {
  let time = 0;
  return steps.map(({ gap, clickX, ...event }) => {
    time += gap;
    return {
      ...event,
      timestamp: time,
      ...(clickX === undefined
        ? {}
        : {
            interaction: {
              type: "click",
              timestamp: time,
              target: { tagName: "BUTTON", xpath: "/html/body/button" },
              data: { clientX: clickX, clientY: 10 },
            },
          }),
    };
  });
}

function slideWalk(all: SlideEvent[], initialCount: number): TrackWalk {
  const events = all.slice(0, initialCount);
  let lastAppliedIndex = -1;
  let shown: SlideReplayApplication | undefined;

  return {
    apply(time, trigger) {
      if (!events.length) return;
      const result = getSlideReplayResult({
        slideEvents: events,
        slides: SLIDES,
        currentTime: time,
        lastAppliedIndex,
        isResync: isReplayResync({ type: trigger }, lastAppliedIndex),
      });
      expectAtMostOneState(trigger, result.applications);
      shown = result.applications.at(-1) ?? shown;
      lastAppliedIndex = result.nextIndex;
    },
    invalidate() {
      lastAppliedIndex = -1;
    },
    append(count) {
      appendInPlace(events, all, count);
    },
    shown: () => shown,
    // A resync applies exactly one state: before the first event, the closed deck.
    cold: (time) =>
      events.length
        ? getSlideReplayResult({
            slideEvents: [...events],
            slides: SLIDES,
            currentTime: time,
            lastAppliedIndex: -1,
            isResync: true,
          }).applications.at(-1)
        : undefined,
  };
}

// ============================================================================
// Preview: forward ticks re-emit transient interactions on purpose, so only the
// retained state (what a seek lands on) is compared.
// ============================================================================

const API_REQUEST = { method: "GET", path: "/api/todos", headers: {}, body: undefined };

const arbPreviewStep = fc.record(
  {
    gap: arbGap,
    type: fc.constantFrom(
      "preview_open",
      "preview_close",
      "preview_float",
      "preview_unfloat",
      "preview_scroll",
      "preview_interaction",
      "preview_route_change",
      "preview_refresh",
      "preview_resize",
      "api_client_mode",
      "api_client_request",
      "api_client_response",
      "api_client_request_tab",
      "api_client_inspect_history",
    ),
    size: fc.constantFrom("small", "medium", "large"),
    isOpen: fc.boolean(),
    mode: fc.constantFrom("floating", "docked"),
    content: fc.constantFrom("<p>one</p>", "<p>two</p>"),
    route: fc.constantFrom("/", "/about"),
    scrollTop: fc.nat({ max: 300 }),
    scrollLeft: fc.nat({ max: 30 }),
    clickX: fc.nat({ max: 100 }),
    activeMode: fc.constantFrom("browser", "api"),
    requestTab: fc.constantFrom("headers", "body"),
    apiClientRequest: fc.constant(API_REQUEST),
    status: fc.constantFrom(200, 404),
  },
  { requiredKeys: ["gap", "type"] },
);

function recordPreview(steps: Array<ValueOf<typeof arbPreviewStep>>): PreviewEvent[] {
  let time = 0;
  return steps.map(({ gap, clickX, status, ...event }) => {
    time += gap;
    return {
      ...event,
      timestamp: time,
      ...(clickX === undefined
        ? {}
        : {
            interaction: {
              type: "click",
              timestamp: time,
              target: { tagName: "A", xpath: "/html/body/a" },
              data: { clientX: clickX, clientY: 10 },
            },
          }),
      ...(status === undefined
        ? {}
        : {
            apiClientResult: {
              ok: true,
              status,
              statusText: status === 200 ? "OK" : "Not Found",
              headers: [],
              body: "[]",
              durationMs: 12,
            },
          }),
    };
  });
}

function previewWalk(all: PreviewEvent[], initialCount: number): TrackWalk {
  const events = all.slice(0, initialCount);
  let lastAppliedIndex = -1;
  let lastAppliedState: PreviewState | undefined;

  return {
    apply(time, trigger) {
      if (!events.length) return;
      const result = getPreviewReplayResult({
        previewEvents: events,
        currentTime: time,
        lastAppliedIndex,
        lastAppliedState,
        isResync: isReplayResync({ type: trigger }, lastAppliedIndex),
      });
      expectAtMostOneState(trigger, result.appliedStates);
      lastAppliedIndex = result.nextIndex;
      lastAppliedState = result.retainedState;
    },
    // seekToTime resets only the index; invalidateAppliedPlaybackState drops the
    // retained state too.
    invalidate(trigger) {
      lastAppliedIndex = -1;
      if (trigger === "PLAY") lastAppliedState = undefined;
    },
    append(count) {
      appendInPlace(events, all, count);
    },
    shown: () => lastAppliedState,
    cold: (time) =>
      events.length
        ? getPreviewReplayResult({
            previewEvents: [...events],
            currentTime: time,
            lastAppliedIndex: -1,
            isResync: true,
          }).retainedState
        : undefined,
  };
}

// ============================================================================

/**
 * Generates event logs from `arbSteps` and walks over each one. Returns how many
 * states were compared, so a test can see that its walks really ran.
 */
function checkWalks<Step, Event extends { timestamp: number }>(
  arbSteps: fc.Arbitrary<Step[]>,
  record: (steps: Step[]) => Event[],
  startWalk: (events: Event[], initialCount: number) => TrackWalk,
): number {
  let compared = 0;
  fc.assert(
    fc.property(arbSteps, arbInitialCount, arbMoves, (steps, initialCount, moves) => {
      const events = record(steps);
      const stamps = events.map((event) => event.timestamp);
      compared += walk(startWalk(events, initialCount), moves, stamps);
    }),
    { numRuns: NUM_RUNS },
  );
  return compared;
}

describe("seeking lands where playing does", () => {
  it("chat", () => {
    const compared = checkWalks(fc.array(fc.tuple(arbGap, arbChatOp), SIZE), recordChat, chatWalk);
    expect(compared).toBeGreaterThan(NUM_RUNS);
  });

  it("runtime", () => {
    const compared = checkWalks(
      fc.array(fc.tuple(arbGap, arbRuntimeOp, fc.boolean()), SIZE),
      recordRuntime,
      runtimeWalk,
    );
    expect(compared).toBeGreaterThan(NUM_RUNS);
  });

  it("workspace panel widths and files", () => {
    const compared = checkWalks(fc.array(arbWorkspaceStep, SIZE), recordWorkspace, workspaceWalk);
    expect(compared).toBeGreaterThan(NUM_RUNS);
  });

  it("whiteboard", () => {
    const compared = checkWalks(
      fc.array(arbWhiteboardStep, SIZE),
      recordWhiteboard,
      whiteboardWalk,
    );
    expect(compared).toBeGreaterThan(NUM_RUNS);
  });

  it("slides", () => {
    const compared = checkWalks(fc.array(arbSlideStep, SIZE), recordSlides, slideWalk);
    expect(compared).toBeGreaterThan(NUM_RUNS);
  });

  it("preview retained state", () => {
    const compared = checkWalks(fc.array(arbPreviewStep, SIZE), recordPreview, previewWalk);
    expect(compared).toBeGreaterThan(NUM_RUNS);
  });
});
