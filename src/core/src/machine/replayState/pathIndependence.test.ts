import fc from "fast-check";
import type * as monaco from "monaco-editor";
import { describe, expect, it } from "vite-plus/test";
import type {
  ChatCheckpoint,
  ChatDelta,
  ChatItem,
  ChatRecordingEvent,
  ChatRole,
  ChatStatus,
} from "../../chat";
import type {
  RuntimeRecordingEvent,
  RuntimeRecordingSnapshot,
  RuntimeStatus,
  RuntimeTerminalSessionSnapshot,
} from "../../runtime";
import {
  toWorkspaceDeltaSnapshot,
  type WorkspaceRecordingEvent,
  type WorkspaceRecordingSnapshot,
} from "../../workspace";
import { diffRuntimeSnapshot, resolveRuntimeSnapshotAt } from "../../runtimeTrack";
import type { PreviewEvent, PreviewState } from "../../preview";
import type { Slide, SlideEvent } from "../../slides";
import type { EditorFrame, EditorSelection, Recording } from "../../types";
import type { TextEditEvent } from "../../textEdit";
import { applyChatDelta, INITIAL_CHAT_FOLD_STATE, type ChatFoldState } from "../../utils/chatDelta";
import {
  createContentDelta,
  createContentEditDelta,
  type CreatedContentEditDelta,
} from "../../utils/contentDelta";
import type { DeltaFrame } from "../../utils/deltaTypes";
import { normalizeEditorFrame } from "../../utils/editorState";
import { createFrameStreamEncoder, pushFrame } from "../../utils/frameStreamEncoder";
import {
  EMPTY_WHITEBOARD_SCENE,
  type WhiteboardElementJSON,
  type WhiteboardEvent,
  type WhiteboardSceneState,
} from "../../whiteboard";
import { RECORDING_TRACK_NAMES, type RecordingTracks } from "../recordingAssembly";
import { grow, load, send, type PlaybackMachine } from "../testing/replayWalk";
import type { EditorMachineContext, EditorMachineHostHooks } from "../types";
import type { ViewerPanel } from "../viewerPanels";
import { getChatReplayResult } from "./chat";
import { getPreviewReplayResult } from "./preview";
import { getRuntimeReplayResult } from "./runtime";
import { getSlideReplayResult, type SlideReplayApplication } from "./slide";
import { getWhiteboardReplayResult } from "./whiteboard";

// ============================================================================
// Seeking lands where playing does.
//
// Whatever path of ticks, seeks, pauses, stops and streamed appends brings
// playback to time T, what a track shows follows one of two laws:
//
// - Replay owns the page: after a tick or a seek while ready or playing, a seek
//   while paused or ended, STOP, PLAY (ended then PLAY too), SET_EDITOR_REF when
//   it re-syncs the editor, SET_EDITOR_REF when it binds the file a seek while
//   paused or ended (or the end) put in front, and growth while replay owns, the
//   track shows what a cold resolve at T shows.
// - The viewer owns the page: paused, ended, or after a viewer's WORKSPACE_EVENT,
//   a tick, growth, SET_EDITOR_REF and a panel view change leave what the track
//   shows as it was, the viewer's own changes included. The next PLAY, SEEK or
//   STOP hands it back to the first law. The one exception is the binding above:
//   when a seek while paused or ended, or the end, puts another file in front,
//   the editor's first SET_EDITOR_REF after it (with no PLAY, SEEK, STOP, viewer
//   WORKSPACE_EVENT or growth between) shows that file as a cold resolve at T
//   does, once, and the page stays the viewer's.
//
// Each test below generates a time-sorted log and a walk of those moves, and
// checks the law the move falls under after the load and after every move.
//
// The walk drives the real machine without an actor (testing/replayWalk.ts): for
// each event it runs the actions editorMachine.ts runs, read from the machine's
// own state nodes and setup(), on a context made by createInitialContext. So the
// cursor resets (REPLAY_CURSORS_RESET), the resync rule (isReplayResync), the
// replay time, the hand-over to the viewer and every apply action under test are
// the real ones. Only the host hooks and the editor are fakes: they record what
// each track shows, and the viewer may change it while they own the page.
//
// Each track adapter says which recording fields it replays, which host hooks
// show it, and how to resolve it cold.
// ============================================================================

/** Enough runs to find a broken cursor rule, few enough to keep the suite fast. */
const NUM_RUNS = 150;

/**
 * A move of a walk once a recording is loaded. A new trigger, or a new transition that
 * resets replay cursors or hands the page over, must be added here and to `walk`, or
 * the property cannot see it.
 */
type Move =
  | { kind: "tick"; dt: number }
  /** Seek near a recorded stamp: `pick` chooses the record, `offset` moves off its stamp. */
  | { kind: "seek"; pick: number; offset: number }
  /**
   * PLAY. While playing, a PAUSE comes first, so this is also a resume. Before it the
   * viewer may change what the track shows (`viewerEdits`).
   */
  | { kind: "play"; viewerEdits: boolean }
  | { kind: "pause" }
  /** The viewer changes the workspace (WORKSPACE_EVENT), maybe after changing the track. */
  | { kind: "viewerWorkspaceEvent"; viewerEdits: boolean }
  /** The timeline reaches the end: its last TICK, then FINISHED. */
  | { kind: "finish" }
  | { kind: "stop" }
  /**
   * The next `count` records stream in: pushed into the loaded arrays in place
   * (APPEND_RECORDING_DELTA), or as a longer copy of the recording (EXTEND_RECORDING).
   */
  | { kind: "append"; count: number; extend: boolean }
  /** The app tells the machine its editor again (SET_EDITOR_REF), as a re-render does. */
  | { kind: "editorRef" }
  /** The viewer opens, closes or resizes a replayed panel (VIEWER_PANEL_VIEW_CHANGED). */
  | { kind: "panelView"; panel: ViewerPanel };

const arbMove: fc.Arbitrary<Move> = fc.oneof(
  {
    weight: 10,
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
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("seek"),
      pick: fc.nat(),
      offset: fc.constantFrom(-100, -1, 0, 1, 500),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant("play"), viewerEdits: fc.boolean() }),
  },
  { weight: 2, arbitrary: fc.constant({ kind: "pause" } as const) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("viewerWorkspaceEvent"),
      viewerEdits: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "finish" } as const) },
  { weight: 1, arbitrary: fc.constant({ kind: "stop" } as const) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("append"),
      count: fc.integer({ min: 1, max: 4 }),
      extend: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "editorRef" } as const) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("panelView"),
      panel: fc.constantFrom<ViewerPanel>("whiteboard", "slides", "runtimeDock"),
    }),
  },
);

/** Logs and walks of up to 30 steps; "medium" keeps most of them long enough to matter. */
const SIZE = { maxLength: 30, size: "medium" } as const;

const arbMoves = fc.array(arbMove, SIZE);

/** How many records the load has; the rest stream in through appends. Often few. */
const arbInitialCount = fc.oneof(fc.constant(0), fc.nat({ max: 3 }), fc.nat({ max: 30 }));

/**
 * How many moves after the machine starts waiting for the editor the app tells it the
 * editor again. Cycled through for each wait of a walk.
 */
const arbEditorRefDelays = fc.array(fc.nat({ max: 3 }), { minLength: 1, maxLength: 4 });

/** The type of value an arbitrary generates. */
type ValueOf<A> = A extends fc.Arbitrary<infer T> ? T : never;

/** Gaps between events: often 0, since everything captured during a pause shares one stamp. */
const arbGap = fc.oneof(
  { weight: 1, arbitrary: fc.constant(0) },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 400 }) },
);

// ============================================================================
// The recording a walk loads.
// ============================================================================

/** Longer than any walk, so the timeline never clamps the playhead before `finish`. */
const DURATION = 60_000;

const START_SELECTION: EditorSelection = {
  startLineNumber: 1,
  startColumn: 1,
  endLineNumber: 1,
  endColumn: 1,
  selectionStartLineNumber: 1,
  selectionStartColumn: 1,
  positionLineNumber: 1,
  positionColumn: 1,
};

/**
 * The recording around a track's log. Its one frame makes it playable (canPlay). With
 * no editor, applyFrameAtTime applies nothing, and with no current frame
 * adoptPlaybackWorkspaceAtPause adopts nothing at a pause either. The frames property
 * replaces the frame with its own log and gives the walk an editor.
 */
const RECORDING: Recording = {
  version: 4,
  id: "walk",
  name: "Walk",
  createdAt: 0,
  duration: DURATION,
  keyframeInterval: 120,
  frames: [
    {
      timestamp: 0,
      isKeyframe: true,
      state: {
        content: "",
        selection: START_SELECTION,
        position: { lineNumber: 1, column: 1 },
        viewState: null,
      },
    },
  ],
};

type TrackField = keyof RecordingTracks;

/** One record of a walk's log, on the track it belongs to. */
interface LogRecord {
  field: TrackField;
  record: { timestamp: number };
  /** For a frame: what the editor shows from it, as the recorder captured it. */
  shows?: EditorShows;
}

/** A single track's events as a log. */
const logOf = (field: TrackField, events: ReadonlyArray<{ timestamp: number }>): LogRecord[] =>
  events.map((record) => ({ field, record }));

/** The records of `log`, grouped into the recording fields they belong to. */
function tracksOf(
  fields: readonly TrackField[],
  log: readonly LogRecord[],
): Partial<RecordingTracks> {
  const tracks: Partial<Record<TrackField, unknown[]>> = {};
  for (const field of fields) tracks[field] = [];
  for (const { field, record } of log) tracks[field]!.push(record);
  return tracks as Partial<RecordingTracks>;
}

/** The recording with a copy of every track, so a cold resolve shares no cache with the walk. */
function copyTracks(recording: Recording): Recording {
  const copy = { ...recording };
  const tracks = copy as Partial<Record<TrackField, unknown[]>>;
  for (const name of RECORDING_TRACK_NAMES) {
    const events = recording[name];
    if (events) tracks[name] = [...events];
  }
  return copy;
}

// ============================================================================
// The walk.
// ============================================================================

interface TrackHost {
  hooks: EditorMachineHostHooks;
  /** The editor the app has, or none (the machine then applies no frame). */
  editor?: FramesEditor;
  /** What the page shows of the track now, the viewer's own changes included. */
  shown(context: EditorMachineContext): unknown;
  /**
   * What replay landed on, to compare with the cold resolve `expected`; `shown` when
   * left out. A track whose machine state is what a seek lands on (the preview's
   * retained state), or whose host may be waiting for the editor (frames), says so here.
   * `handedBack` says the step gave the page back to the viewer as it ended (a seek
   * while paused or ended), which drops the machine's record of what it applied.
   */
  landed?(context: EditorMachineContext, expected: unknown, handedBack: boolean): unknown;
  /** The viewer changes what the track shows, as they may while they own the page. */
  viewerEdit?(): void;
  /** A move starts. */
  startMove?(): void;
  /** Whether the app has an editor change still to tell the machine about. */
  awaitsEditorRef?(context: EditorMachineContext): boolean;
  /** The app shows the open file's model in its editor, just before it says so. */
  rebind?(context: EditorMachineContext): void;
  /** Whether the editor still shows another file than the one the workspace has open. */
  opensAnotherFile?(): boolean;
}

interface ReplayTrack {
  /** The recording fields the track's log fills. */
  fields: readonly TrackField[];
  /** Anything else the recording needs (the slide deck). */
  recording?: Partial<Recording>;
  /** How many records of the log the load always has. */
  minLoaded?: number;
  /**
   * The host hooks that show the track, made fresh for each walk. A track that lands
   * on one state pushes each state its hook is given into `applied`.
   */
  host(applied: unknown[]): TrackHost;
  /**
   * What a cold resolve at `time` shows. `recording` has copies of the loaded tracks,
   * and `loaded` is the part of the log they hold.
   */
  cold(recording: Recording, time: number, loaded: readonly LogRecord[]): unknown;
  /**
   * Tracks with transient interactions (slide hops, preview clicks) replay every
   * event a tick or a streamed append crosses. A load, a seek, a PLAY or a STOP lands
   * on one state and must never fire the recorded interactions again.
   */
  replaysTransients?: true;
  /** What the host does on its own once playing starts. */
  onPlaying?(context: EditorMachineContext): void;
}

/**
 * Loads the first `initialCount` records of `log`, plays `moves`, and checks the law
 * each move falls under after the load and after each move. Returns how many states
 * it compared.
 */
function walk(
  track: ReplayTrack,
  log: LogRecord[],
  initialCount: number,
  moves: Move[],
  editorRefDelays: number[],
): number {
  const stamps = log.map(({ record }) => record.timestamp);
  const applied: unknown[] = [];
  const host = track.host(applied);
  let loadedCount = Math.min(log.length, Math.max(initialCount, track.minLoaded ?? 0));
  const machine: PlaybackMachine = load({
    recording: {
      ...RECORDING,
      ...track.recording,
      ...tracksOf(track.fields, log.slice(0, loadedCount)),
    },
    hooks: host.hooks,
    duration: DURATION,
    editor: (host.editor as unknown as monaco.editor.IStandaloneCodeEditor | undefined) ?? null,
  });
  let time = 0;
  // Who owns the page, from the transitions each move takes (see the laws above).
  let owner: "replay" | "viewer" = "replay";
  let compared = 1;

  // ---- The checks.
  const playhead = (label: string) =>
    expect(machine.context.timeline.currentTime, `the playhead ${label}`).toBe(time);
  const replayOwns = (label: string, landsOnOneState: boolean, handedBack = false) => {
    if (track.replaysTransients && landsOnOneState) {
      expect(applied.length, `states applied ${label}`).toBeLessThanOrEqual(1);
    }
    playhead(label);
    const loaded = log.slice(0, loadedCount);
    const expected = track.cold(copyTracks(machine.context.recording!), time, loaded);
    const actual = host.landed
      ? host.landed(machine.context, expected, handedBack)
      : host.shown(machine.context);
    expect(actual, `what the track shows ${label}`).toEqual(expected);
    applied.length = 0;
    compared += 1;
  };
  const viewerOwns = (label: string, before: unknown) => {
    expect(applied.length, `states applied ${label}`).toBe(0);
    playhead(label);
    expect(host.shown(machine.context), `what the viewer sees ${label}`).toEqual(before);
    compared += 1;
  };
  /** Runs `act` under the viewer-owns law: what the track shows must not change. */
  const keptForViewer = (label: string, act: () => void) => {
    host.startMove?.();
    const before = host.shown(machine.context);
    act();
    viewerOwns(label, before);
  };
  const hasRecords = () => loadedCount > 0;

  // ---- The app telling the machine its editor again (SET_EDITOR_REF).
  let editorRefIn: number | null = null;
  let waits = 0;
  // A seek while paused or ended, or the end, put another file in front: the editor's
  // next binding shows that file at T (the exception to the viewer-owns law).
  let bindShowsFrame = false;
  const tellEditor = (label: string) => {
    host.startMove?.();
    // What the app shows as it binds the model is the app's, not the machine's.
    host.rebind?.(machine.context);
    const before = host.shown(machine.context);
    send(machine, { type: "SET_EDITOR_REF", editor: machine.context.editorRefs.editor });
    // The machine re-syncs a real editor while replay owns the page
    // (shouldSyncPlaybackEditorRef), and shows the frame the hand-over resolved on the
    // file it opened (showFrameAwaitingEditor). Without an editor, or otherwise for the
    // viewer, nothing re-applies.
    const resolves = Boolean(host.editor) && (owner === "replay" || bindShowsFrame);
    bindShowsFrame = false;
    if (resolves) replayOwns(label, true, owner === "viewer");
    else viewerOwns(label, before);
  };
  // The app re-renders some moves after the change, and always before the viewer's
  // next action, which comes from a later render.
  const deliverEditorRef = (move: Move | "end", label: string) => {
    if (editorRefIn === null) return;
    const viewerActs = move === "end" || !["tick", "append"].includes(move.kind);
    if (editorRefIn > 0 && !viewerActs) {
      editorRefIn -= 1;
      return;
    }
    editorRefIn = null;
    tellEditor(`when the app tells the editor again, ${label}`);
  };
  const awaitEditorRef = () => {
    if (editorRefIn === null && host.awaitsEditorRef?.(machine.context)) {
      editorRefIn = editorRefDelays[waits++ % editorRefDelays.length];
    }
  };

  host.startMove?.();
  replayOwns("after the load", true);
  awaitEditorRef();

  moves.forEach((move, index) => {
    const label = `after move ${index} (${move.kind})`;
    deliverEditorRef(move, `before move ${index} (${move.kind})`);
    host.startMove?.();
    const at = () => `${label} at ${time}ms`;
    switch (move.kind) {
      case "tick": {
        if (machine.state === "paused" || machine.state === "ended") {
          // Paused and ended take a TICK and do nothing.
          keptForViewer(at(), () => send(machine, { type: "TICK", currentTime: time + move.dt }));
        } else if (owner === "replay") {
          // The timeline ticks only once playing, but a TICK in ready runs the same
          // playback.TICK, so the walk also ticks from the cursors the load left.
          time += move.dt;
          send(machine, { type: "TICK", currentTime: time });
          replayOwns(at(), false);
        }
        // Ready after a viewer's WORKSPACE_EVENT gets no TICK: its timeline is not
        // running, and only PLAY starts it.
        break;
      }
      case "seek": {
        const stamp = stamps.length ? stamps[move.pick % stamps.length] : 0;
        time = Math.max(0, stamp + move.offset);
        const handedOver = machine.state === "paused" || machine.state === "ended";
        send(machine, { type: "SEEK", time });
        replayOwns(at(), true, handedOver);
        // A seek while paused or ended takes the page for that step only.
        owner = handedOver ? "viewer" : "replay";
        bindShowsFrame = handedOver && Boolean(host.opensAnotherFile?.());
        break;
      }
      case "play": {
        if (machine.state === "playing") {
          keptForViewer(`${at()}, paused to resume`, () => send(machine, { type: "PAUSE" }));
          owner = "viewer";
          host.startMove?.();
        }
        // With no records loaded the machine has nothing to put back, so the viewer's
        // change would stay.
        if (move.viewerEdits && hasRecords()) host.viewerEdit?.();
        // From the end, PLAY starts the lesson again.
        const restarts = machine.state === "ended" && time === DURATION;
        send(machine, { type: "PLAY" });
        if (restarts) time = 0;
        owner = "replay";
        track.onPlaying?.(machine.context);
        replayOwns(at(), true);
        break;
      }
      case "pause": {
        if (machine.state !== "playing") break;
        keptForViewer(at(), () => send(machine, { type: "PAUSE" }));
        owner = "viewer";
        break;
      }
      case "viewerWorkspaceEvent": {
        if (move.viewerEdits && hasRecords()) host.viewerEdit?.();
        // Playing, it pauses; otherwise it detaches the replay from the workspace.
        keptForViewer(at(), () => send(machine, { type: "WORKSPACE_EVENT" }));
        owner = "viewer";
        break;
      }
      case "finish": {
        if (machine.state !== "playing") break;
        time = DURATION;
        send(machine, { type: "TICK", currentTime: time });
        replayOwns(`${at()}, the last tick`, false);
        keptForViewer(at(), () => send(machine, { type: "FINISHED" }));
        owner = "viewer";
        // The last tick may have opened a file the editor has not bound yet.
        bindShowsFrame = Boolean(host.opensAnotherFile?.());
        break;
      }
      case "stop": {
        send(machine, { type: "STOP" });
        time = 0;
        owner = "replay";
        replayOwns(at(), true);
        break;
      }
      case "append": {
        const next = log.slice(loadedCount, loadedCount + move.count);
        loadedCount += next.length;
        const records = tracksOf(track.fields, next);
        if (owner === "replay") {
          grow(machine, records, move.extend);
          replayOwns(at(), false);
        } else {
          // PLAY, SEEK or STOP picks the new records up. The binding no longer shows a
          // frame: the one resolved before the growth may not be the one at T now.
          bindShowsFrame = false;
          keptForViewer(at(), () => grow(machine, records, move.extend));
        }
        break;
      }
      case "editorRef": {
        tellEditor(at());
        break;
      }
      case "panelView": {
        keptForViewer(at(), () =>
          send(machine, { type: "VIEWER_PANEL_VIEW_CHANGED", panel: move.panel }),
        );
        break;
      }
    }
    awaitEditorRef();
  });
  deliverEditorRef("end", "at the end of the walk");
  return compared;
}

/**
 * Generates logs from `arbLog` and walks over each one. Returns how many states were
 * compared, so a test can see that its walks really ran.
 */
function checkWalks(arbLog: fc.Arbitrary<LogRecord[]>, track: ReplayTrack): number {
  let compared = 0;
  fc.assert(
    fc.property(
      arbLog,
      arbInitialCount,
      arbMoves,
      arbEditorRefDelays,
      (log, initialCount, moves, editorRefDelays) => {
        compared += walk(track, log, initialCount, moves, editorRefDelays);
      },
    ),
    { numRuns: NUM_RUNS },
  );
  return compared;
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

const chatTrack: ReplayTrack = {
  fields: ["chatEvents"],
  host() {
    let shown: ChatCheckpoint | undefined;
    return {
      hooks: {
        applyChatSnapshot: (snapshot) => {
          shown = snapshot;
        },
      },
      shown: () => shown,
      viewerEdit: () => {
        shown = { items: [], status: "idle", draft: "my own question" };
      },
    };
  },
  // A cold resolve is a resync, which shows the empty transcript before the
  // first chat event (setRecording shows it too, before any chat event loads).
  cold: ({ chatEvents }, time) =>
    getChatReplayResult({
      chatEvents: chatEvents!,
      currentTime: time,
      lastAppliedIndex: -1,
      isResync: true,
    }).snapshotToApply,
};

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
  | { k: "status"; status: RuntimeStatus };

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
      status: fc.constantFrom<RuntimeStatus>("starting", "ready", "error"),
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

const runtimeTrack: ReplayTrack = {
  fields: ["runtimeEvents"],
  host() {
    let shown: RuntimeRecordingSnapshot | undefined;
    return {
      hooks: {
        applyRuntimeSnapshot: (snapshot) => {
          shown = snapshot;
        },
      },
      shown: () => shown,
      viewerEdit: () => {
        shown = {
          mode: "webcontainer",
          status: "ready",
          terminalSessions: [{ id: "t1", title: "t1", output: "$ my own command" }],
        };
      },
    };
  },
  cold: ({ runtimeEvents }, time) =>
    getRuntimeReplayResult({
      runtimeEvents: runtimeEvents!,
      currentTime: time,
      lastAppliedIndex: -1,
    }).snapshotToApply,
  // When playing starts, the runtime dock also resolves index 0 on its own
  // (useRuntimeDockRecordedSnapshot). That moves the shared fold cache back to
  // the start, and the cache must not change any result.
  onPlaying: ({ recording }) => {
    if (recording?.runtimeEvents) resolveRuntimeSnapshotAt(recording.runtimeEvents, 0);
  },
};

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

// The machine keeps the workspace cursor through seeks and pauses (it is not in
// REPLAY_CURSORS_RESET): the widths are relative, so the replay must know which
// offsets it has already added. Resetting the cursor to -1 would add them all a
// second time. A pause, the end and a viewer's WORKSPACE_EVENT hand the workspace
// to the viewer (they detach and set hasManualWorkspaceOverride), and PLAY, SEEK
// and STOP take it back. The viewer edits no files here: PLAY keeps their
// edits on purpose until the recording changes the workspace again (see the
// "learner workspace" tests in learnerWorkspace.test.ts).
const workspaceTrack: ReplayTrack = {
  fields: ["workspaceEvents"],
  host() {
    const live = {
      snapshot: VIEWER_WORKSPACE,
      sidebarWidth: BASE_SIDEBAR_WIDTH,
      previewDockWidth: BASE_PREVIEW_DOCK_WIDTH,
    };
    return {
      hooks: {
        getWorkspaceSnapshot: () => live.snapshot,
        // NextEditorProvider's applyWorkspaceSnapshot: the files are replaced, and a
        // non-zero width delta is added to the width the viewer has now.
        applyWorkspaceSnapshot: (snapshot) => {
          const { sidebarWidthDelta, previewDockWidthDelta, ...files } = snapshot;
          live.snapshot = files;
          live.sidebarWidth += sidebarWidthDelta ?? 0;
          live.previewDockWidth += previewDockWidthDelta ?? 0;
        },
      },
      shown: () => ({
        sidebarWidth: live.sidebarWidth,
        previewDockWidth: live.previewDockWidth,
        ...describeWorkspace(live.snapshot),
      }),
    };
  },
  // The law: each width is the viewer's width plus every offset recorded at or
  // before `time`, and the files are those of the latest event.
  cold: ({ workspaceEvents }, time) => {
    const events = workspaceEvents!;
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

const whiteboardTrack: ReplayTrack = {
  fields: ["whiteboardEvents"],
  host() {
    let shown: WhiteboardSceneState | undefined;
    return {
      hooks: {
        applyWhiteboardState: (state) => {
          shown = state;
        },
      },
      shown: () => shown,
      viewerEdit: () => {
        shown = {
          elements: [],
          view: { scrollX: 0, scrollY: 0, zoom: 3 },
          isOpen: true,
          isMaximized: true,
        };
      },
    };
  },
  // An interpolated scene depends only on the time and the events around it,
  // and ticks only move forward, so the walk matches inside animation windows too.
  // Without whiteboard events the load shows the empty board, as before the first event.
  cold: ({ whiteboardEvents }, time) =>
    whiteboardEvents!.length
      ? getWhiteboardReplayResult({
          whiteboardEvents: whiteboardEvents!,
          currentTime: time,
          lastAppliedIndex: -1,
        }).stateToApply
      : EMPTY_WHITEBOARD_SCENE,
};

// ============================================================================
// Slides: forward ticks apply every crossed event, a resync applies one state.
// ============================================================================

const SLIDES: Slide[] = [
  { id: "one", order: 0, content: "one", contentType: "html" },
  { id: "two", order: 1, content: "two", contentType: "html" },
  { id: "three", order: 2, content: "three", contentType: "html" },
];

// "gone" is a slide deleted during the take: the deck is saved at finalize, so
// events can name a slide it no longer has. A tick applies nothing for such an
// event, and a seek must keep the same last placed state. An event without a
// slideId shows the slide named before it.
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
    slideId: fc.constantFrom("one", "two", "three", "gone"),
    isMaximized: fc.boolean(),
    indexv: fc.nat({ max: 2 }),
    clickX: fc.nat({ max: 100 }),
  },
  { requiredKeys: ["gap", "type"] },
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

const slideTrack: ReplayTrack = {
  fields: ["slideEvents"],
  recording: { slides: SLIDES },
  host(applied) {
    let shown: SlideReplayApplication | undefined;
    return {
      hooks: {
        applySlideState: (slideState, slideIndex) => {
          shown = { slideState, slideIndex };
          applied.push(shown);
        },
      },
      shown: () => shown,
      viewerEdit: () => {
        shown = {
          slideIndex: 2,
          slideState: { isOpen: true, isMaximized: true, currentSlideId: "three", indexv: 7 },
        };
      },
    };
  },
  // A resync applies exactly one state: before the first event, the closed deck.
  // Without slide events the machine applies nothing.
  cold: ({ slideEvents }, time) =>
    slideEvents!.length
      ? getSlideReplayResult({
          slideEvents: slideEvents!,
          slides: SLIDES,
          currentTime: time,
          lastAppliedIndex: -1,
          isResync: true,
        }).applications.at(-1)
      : undefined,
  replaysTransients: true,
};

// ============================================================================
// Preview: forward ticks re-emit transient interactions on purpose, so what the
// panel shows is compared without them, along with the retained state (what a seek
// lands on).
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

/**
 * What the panel shows of a state it is given. It never reads the interaction
 * (usePreviewPlaybackRegistration.ts), and never takes the scroll from a state: the
 * iframe keeps its own. Both stay in the retained state, which is compared as well.
 */
function previewPanelShows(state: PreviewState | undefined) {
  if (!state) return state;
  const { currentInteraction: _interaction, scrollTop: _top, scrollLeft: _left, ...shown } = state;
  return shown;
}

const previewTrack: ReplayTrack = {
  fields: ["previewEvents"],
  host(applied) {
    let shown: PreviewState | undefined;
    return {
      hooks: {
        applyPreviewState: (state) => {
          shown = state;
          applied.push(state);
        },
      },
      // While the viewer owns the page, the preview must keep what it was last given.
      shown: () => shown,
      // Two things must match a cold resolve: what the panel shows of the last state
      // it was given, and the retained state the machine keeps (lastAppliedPreviewState),
      // which a tick carries forward with the scroll a mode change did not re-assert. A
      // seek that hands the page back drops the machine's record, so then the panel
      // alone is compared.
      landed: (context, expected, handedBack) => ({
        page: previewPanelShows(shown),
        retained: handedBack
          ? (expected as { retained: unknown }).retained
          : context.lastAppliedPreviewState,
      }),
    };
  },
  cold: ({ previewEvents }, time) => {
    const resolved = getPreviewReplayResult({
      previewEvents: previewEvents!,
      currentTime: time,
      lastAppliedIndex: -1,
      isResync: true,
    });
    return {
      page: previewPanelShows(resolved.appliedStates.at(-1)),
      retained: resolved.retainedState,
    };
  },
  replaysTransients: true,
};

// ============================================================================
// Frames: the editor's text, caret and scroll, encoded by the recorder's own
// frame encoder, and replayed into an editor the walk holds.
//
// Frames carry no file path: which file a frame's text belongs to comes from the
// workspace track. So this log holds both, and the walk also checks which file
// the editor shows. A file switch, the load of another file, and PLAY after the
// viewer had the workspace make the machine wait for the app to bind the new
// model and say so (SET_EDITOR_REF). Until then the frame must not be applied:
// it would land in the model the editor still shows. A seek while paused or
// ended that switches files (or the end, right after a tick that did) puts the
// frame's text into the workspace instead, the model the app binds is made from
// it, and that binding shows the frame's caret and scroll on it.
// ============================================================================

/** What the editor shows from a frame: its text, caret and selection, and scroll. */
interface EditorShows {
  content: string;
  selection: EditorSelection;
  viewState: EditorFrame["state"]["viewState"];
}

const FRAME_FILES = ["index.html", "app.html"] as const;

type FrameFile = (typeof FRAME_FILES)[number];

/**
 * The Monaco surface the frame step writes to, one model per file. The app binds the
 * open file's model when it re-renders (`bind`), then sends SET_EDITOR_REF. Every write
 * replay makes is counted, so a law can say none was made.
 */
class FramesEditor {
  private readonly models = new Map<string, { content: string }>();
  boundPath: string;
  private selection: EditorSelection | null = null;
  private viewState: unknown = null;
  writes = 0;
  viewStateWrites = 0;

  constructor(boundPath: string) {
    for (const path of FRAME_FILES) this.models.set(path, { content: "" });
    this.boundPath = boundPath;
  }

  private get model() {
    return this.models.get(this.boundPath)!;
  }

  bind(path: string): void {
    if (!this.models.has(path)) this.models.set(path, { content: "" });
    this.boundPath = path;
  }

  /** The app gives the bound model a text of its own (not a replay write). */
  load(content: string): void {
    this.model.content = content;
  }

  // The part of IStandaloneCodeEditor the frame step uses. A model that can undo takes
  // the whole text in one write (applyContentDiff).
  getModel() {
    const { model } = this;
    return {
      getValue: () => model.content,
      setValue: (content: string) => {
        model.content = content;
        this.writes += 1;
      },
      canUndo: () => true,
    };
  }
  getSelection() {
    return this.selection;
  }
  getSelections() {
    return this.selection ? [this.selection] : null;
  }
  setSelection(selection: EditorSelection) {
    this.selection = selection;
    this.writes += 1;
  }
  restoreViewState(viewState: unknown) {
    this.viewState = viewState;
    this.writes += 1;
    this.viewStateWrites += 1;
  }
  hasTextFocus() {
    return true;
  }

  /** The viewer types in the open file. */
  type(text: string): void {
    this.model.content += text;
  }

  /** Everything the editor shows, in every model, and how many writes replay made. */
  view() {
    return {
      contents: Object.fromEntries([...this.models].map(([path, { content }]) => [path, content])),
      selection: this.selection,
      viewState: this.viewState,
      writes: this.writes,
    };
  }

  /**
   * The open file and what it shows, as a frame would set it. A frame without a view
   * state leaves the scroll where it is, so then the editor must only not have been
   * given one since `viewStateWritesBefore`.
   */
  frameView(viewState: EditorShows["viewState"], viewStateWritesBefore: number) {
    const restored = this.viewStateWrites > viewStateWritesBefore;
    return {
      path: this.boundPath,
      content: this.model.content,
      selection: this.selection,
      viewState:
        viewState !== null ? this.viewState : restored ? { restoredOneTheFrameHasNot: true } : null,
    };
  }
}

const arbFrameStep = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      k: fc.constant("type"),
      gap: arbGap,
      at: fc.nat(),
      cut: fc.nat({ max: 2 }),
      text: fc.constantFrom("a", "bc", "\n"),
      // Typed edits reach the encoder with their own delta; others it diffs itself.
      asEdit: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant("select"),
      gap: arbGap,
      anchor: fc.nat(),
      caret: fc.nat(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant("scroll"),
      gap: arbGap,
      // No view state after one: the encoder must write a keyframe to say so.
      top: fc.option(fc.nat({ max: 300 }), { nil: null }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant("switch"),
      gap: arbGap,
      // The open file again is a same-file snapshot, as studio writes after typing.
      path: fc.constantFrom<FrameFile>(...FRAME_FILES),
    }),
  },
);

/** The line and column of `offset` in `text`. */
function positionAt(text: string, offset: number) {
  const lines = text.slice(0, offset).split("\n");
  return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
}

function selectionOf(text: string, anchor: number, caret: number): EditorSelection {
  const from = positionAt(text, anchor);
  const to = positionAt(text, caret);
  const [start, end] = anchor <= caret ? [from, to] : [to, from];
  return {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
    selectionStartLineNumber: from.lineNumber,
    selectionStartColumn: from.column,
    positionLineNumber: to.lineNumber,
    positionColumn: to.column,
  };
}

function framesWorkspace(
  activeFilePath: FrameFile,
  contents: Record<FrameFile, string>,
): WorkspaceRecordingSnapshot {
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
      files: Object.fromEntries(
        FRAME_FILES.map((path) => [
          path,
          { path, name: path, language: "html", content: contents[path] },
        ]),
      ),
    },
  };
}

/** The viewer's own workspace before the recording loads, on index.html. */
const FRAMES_VIEWER_WORKSPACE = framesWorkspace("index.html", {
  "index.html": "my notes",
  "app.html": "",
});

/**
 * Records `steps` as the recorder does: a workspace event at t=0 and on every file
 * switch, and each change of the editor captured as a frame through the frame encoder
 * (pushFrame). A switch captures the new file's first frame at the same stamp. Each
 * frame record keeps what the recorder captured, which is what replay must show: an
 * encoder that drops a change shows up as a frame that replays differently.
 */
function recordFrames({
  firstFile,
  steps,
}: {
  firstFile: FrameFile;
  steps: Array<ValueOf<typeof arbFrameStep>>;
}): LogRecord[] {
  const log: LogRecord[] = [];
  const contents: Record<FrameFile, string> = { "index.html": "", "app.html": "" };
  let active = firstFile;
  let selection = START_SELECTION;
  let viewState: EditorShows["viewState"] = null;
  let encoder = createFrameStreamEncoder();
  let version = 1;
  let time = 0;

  const switchTo = (path: FrameFile) => {
    active = path;
    const event: WorkspaceRecordingEvent = {
      timestamp: time,
      snapshot: framesWorkspace(path, { ...contents }),
    };
    log.push({ field: "workspaceEvents", record: event });
  };
  const capture = (contentEditDelta?: CreatedContentEditDelta) => {
    const frame = normalizeEditorFrame({
      timestamp: time,
      state: {
        content: contents[active],
        selection,
        position: { lineNumber: selection.positionLineNumber, column: selection.positionColumn },
        viewState,
      },
    });
    const pushed = pushFrame(encoder, frame, contentEditDelta);
    encoder = pushed.state;
    if (!pushed.emitted) return;
    const { content, selection: shownSelection, viewState: shownViewState } = frame.state;
    log.push({
      field: "frames",
      record: pushed.emitted as DeltaFrame,
      shows: { content, selection: shownSelection, viewState: shownViewState },
    });
  };

  switchTo(firstFile);
  capture();
  for (const step of steps) {
    time += step.gap;
    if (step.k === "type") {
      const base = contents[active];
      const at = step.at % (base.length + 1);
      const deleteLength = Math.min(step.cut, base.length - at);
      const next = base.slice(0, at) + step.text + base.slice(at + deleteLength);
      const caret = at + step.text.length;
      const edit: TextEditEvent = {
        fileId: active,
        path: active,
        beforeVersion: version,
        afterVersion: (version += 1),
        beforeLength: base.length,
        afterLength: next.length,
        changes: [{ offset: at, deleteLength, text: step.text }],
      };
      const contentEditDelta = step.asEdit ? createContentEditDelta(base, edit) : null;
      contents[active] = next;
      selection = selectionOf(next, caret, caret);
      capture(contentEditDelta ?? undefined);
    } else if (step.k === "select") {
      const text = contents[active];
      selection = selectionOf(
        text,
        step.anchor % (text.length + 1),
        step.caret % (text.length + 1),
      );
      capture();
    } else if (step.k === "scroll") {
      viewState =
        step.top === null
          ? null
          : ({
              cursorState: [],
              viewState: {
                scrollLeft: 0,
                firstPosition: { lineNumber: 1, column: 1 },
                firstPositionDeltaTop: -step.top,
              },
              contributionsState: {},
            } as unknown as EditorShows["viewState"]);
      capture();
    } else {
      const switches = step.path !== active;
      switchTo(step.path);
      if (switches) {
        // The new model opens at its start, without the old file's scroll.
        selection = START_SELECTION;
        viewState = null;
        capture();
      }
    }
  }
  return log;
}

/** A frame replay leaves out on purpose: it belongs to the file open before a switch. */
const FRAME_SKIPPED = "the frame before the open file's last switch is not shown";

const framesTrack: ReplayTrack = {
  fields: ["frames", "workspaceEvents"],
  // The workspace event and the frame the recorder writes at t=0.
  minLoaded: 2,
  host() {
    const live = { snapshot: FRAMES_VIEWER_WORKSPACE };
    const editor = new FramesEditor(live.snapshot.activeFilePath);
    let writesBefore = 0;
    let viewStateWritesBefore = 0;
    return {
      hooks: {
        getWorkspaceSnapshot: () => live.snapshot,
        applyWorkspaceSnapshot: (snapshot) => {
          const { sidebarWidthDelta: _sidebar, previewDockWidthDelta: _dock, ...files } = snapshot;
          live.snapshot = files;
        },
      },
      editor,
      startMove: () => {
        writesBefore = editor.writes;
        viewStateWritesBefore = editor.viewStateWrites;
      },
      // A model swap the app has not told the machine about yet: the machine waits for
      // it, or the editor shows another file than the workspace.
      awaitsEditorRef: (context) =>
        context.pendingPlaybackEditorSync || editor.boundPath !== live.snapshot.activeFilePath,
      opensAnotherFile: () => editor.boundPath !== live.snapshot.activeFilePath,
      // While the viewer owns the page, the app shows the file's own model, made from the
      // workspace's text for it (CodeEditor's syncWorkspaceModel).
      rebind: (context) => {
        const path = live.snapshot.activeFilePath;
        const opens = editor.boundPath !== path;
        editor.bind(path);
        const { content } = live.snapshot.project.files[path];
        if (opens && context.hasManualWorkspaceOverride && typeof content === "string") {
          editor.load(content);
        }
      },
      shown: () => editor.view(),
      landed: (context, expected) => {
        const written = editor.writes - writesBefore;
        // Waiting for the editor, the frame is not applied: it would land in the model
        // the editor shows now.
        if (
          context.pendingPlaybackEditorSync ||
          editor.boundPath !== live.snapshot.activeFilePath
        ) {
          return written === 0 ? expected : { appliedWhileWaitingForTheEditor: written };
        }
        if (expected === FRAME_SKIPPED) {
          return written === 0 && context.currentFrame === null
            ? FRAME_SKIPPED
            : { appliedASkippedFrame: context.currentFrame?.state };
        }
        return editor.frameView((expected as EditorShows).viewState, viewStateWritesBefore);
      },
      viewerEdit: () => editor.type("!"),
    };
  },
  // The law, read from the log rather than from replay's own folds: the frame on screen
  // at `time` is the last one at or before it (the first one before them all), and it
  // shows what the recorder captured, in the file the workspace has open at `time`.
  // Unless the open file switched after that frame: it belongs to the file before.
  cold: ({ frames, workspaceEvents }, time, loaded) => {
    const shows = loaded.filter(({ field }) => field === "frames").map((frame) => frame.shows!);
    expect(shows.length).toBe(frames.length);
    const frameIndex = Math.max(
      0,
      frames.findLastIndex((frame) => frame.timestamp <= time),
    );
    const events = workspaceEvents!;
    const eventIndex = events.findLastIndex((event) => event.timestamp <= time);
    let lastSwitch = events[0].timestamp;
    for (let index = 1; index <= eventIndex; index++) {
      if (events[index].snapshot.activeFilePath !== events[index - 1].snapshot.activeFilePath) {
        lastSwitch = events[index].timestamp;
      }
    }
    if (frames[frameIndex].timestamp < lastSwitch) return FRAME_SKIPPED;
    return { path: events[eventIndex].snapshot.activeFilePath, ...shows[frameIndex] };
  },
};

describe("seeking lands where playing does", () => {
  it("chat", () => {
    const compared = checkWalks(
      fc
        .array(fc.tuple(arbGap, arbChatOp), SIZE)
        .map((steps) => logOf("chatEvents", recordChat(steps))),
      chatTrack,
    );
    expect(compared).toBeGreaterThan(NUM_RUNS);
  });

  it("runtime", () => {
    const compared = checkWalks(
      fc
        .array(fc.tuple(arbGap, arbRuntimeOp, fc.boolean()), SIZE)
        .map((steps) => logOf("runtimeEvents", recordRuntime(steps))),
      runtimeTrack,
    );
    expect(compared).toBeGreaterThan(NUM_RUNS);
  });

  it("workspace panel widths and files", () => {
    const compared = checkWalks(
      fc
        .array(arbWorkspaceStep, SIZE)
        .map((steps) => logOf("workspaceEvents", recordWorkspace(steps))),
      workspaceTrack,
    );
    expect(compared).toBeGreaterThan(NUM_RUNS);
  });

  it("whiteboard", () => {
    const compared = checkWalks(
      fc
        .array(arbWhiteboardStep, SIZE)
        .map((steps) => logOf("whiteboardEvents", recordWhiteboard(steps))),
      whiteboardTrack,
    );
    expect(compared).toBeGreaterThan(NUM_RUNS);
  });

  it("slides", () => {
    const compared = checkWalks(
      fc.array(arbSlideStep, SIZE).map((steps) => logOf("slideEvents", recordSlides(steps))),
      slideTrack,
    );
    expect(compared).toBeGreaterThan(NUM_RUNS);
  });

  it("preview panel and retained state", () => {
    const compared = checkWalks(
      fc.array(arbPreviewStep, SIZE).map((steps) => logOf("previewEvents", recordPreview(steps))),
      previewTrack,
    );
    expect(compared).toBeGreaterThan(NUM_RUNS);
  });

  it("editor frames, with the file switches they follow", () => {
    const compared = checkWalks(
      fc
        .record({
          firstFile: fc.constantFrom<FrameFile>(...FRAME_FILES),
          steps: fc.array(arbFrameStep, SIZE),
        })
        .map(recordFrames),
      framesTrack,
    );
    expect(compared).toBeGreaterThan(NUM_RUNS);
  });
});

describe("the walk's load", () => {
  // More item-list deltas than the chat fold takes between checkpoints, all at t=0, so
  // the load's own apply finds the track damaged.
  const damagedChat: Recording = {
    ...RECORDING,
    chatEvents: Array.from({ length: 2_001 }, (_, index): ChatRecordingEvent => ({
      timestamp: 0,
      event: { k: "message_start", id: `msg-${index}`, role: "user" },
    })),
  };
  const loadDamaged = (onError?: (error: Error) => void) =>
    load({
      recording: damagedChat,
      hooks: { applyChatSnapshot: () => {} },
      duration: DURATION,
      editor: null,
      onError,
    });

  it("throws a damaged track by default", () => {
    expect(() => loadDamaged()).toThrow("too many changes between checkpoints");
  });

  it("reports a damaged track found by the load itself to the reporter it is given", () => {
    const reported: string[] = [];
    const machine = loadDamaged((error) => reported.push(error.message));
    expect(reported).toEqual([expect.stringContaining("too many changes between checkpoints")]);
    expect(machine.state).toBe("ready");
  });
});
