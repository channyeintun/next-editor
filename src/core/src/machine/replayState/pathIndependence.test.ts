import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import type { UnknownAction } from "xstate";
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
  toWorkspaceDeltaSnapshot,
  type WorkspaceRecordingEvent,
  type WorkspaceRecordingSnapshot,
} from "../../../../types/workspace";
import { diffRuntimeSnapshot, resolveRuntimeSnapshotAt } from "../../runtimeTrack";
import type { PreviewEvent, Slide, SlideEvent } from "../../slides";
import type { Recording, RecordingStreamDelta } from "../../types";
import { applyChatDelta, INITIAL_CHAT_FOLD_STATE, type ChatFoldState } from "../../utils/chatDelta";
import { createContentDelta } from "../../utils/frameDelta";
import type {
  WhiteboardElementJSON,
  WhiteboardEvent,
  WhiteboardSceneState,
} from "../../whiteboard";
import { editorMachine } from "../editorMachine";
import { setRecording } from "../replayActions";
import {
  createInitialContext,
  type EditorActionArgs,
  type EditorContextUpdate,
  type EditorMachineContext,
  type EditorMachineEvent,
  type EditorMachineHostHooks,
} from "../types";
import { getChatReplayResult } from "./chat";
import { getPreviewReplayResult } from "./preview";
import { getRuntimeReplayResult } from "./runtime";
import { getSlideReplayResult, type SlideReplayApplication } from "./slide";
import { getWhiteboardReplayResult } from "./whiteboard";

// ============================================================================
// Seeking lands where playing does.
//
// Whatever path of ticks, seeks, resumes and streamed appends brings playback
// to time T, a track must show what a cold resolve at T shows. Each test below
// generates a time-sorted event log and a walk, and checks this after the load
// and after every move of the walk.
//
// The walk runs the machine's real replay actions (replayActions.ts) on a small
// context made by createInitialContext. For each trigger it runs the actions
// editorMachine.ts runs, in the same order, and merges each returned patch into
// the context the way `assign` does (MACHINE_STEPS below). So the cursor resets
// (REPLAY_CURSORS_RESET), the resync rule (isReplayResync), the replay time and
// every apply action under test are the real ones. Only the host hooks are
// fakes: they record what the track shows, and before a PLAY the viewer may
// change it, as a paused viewer can. PLAY must then show the recording again.
//
// Each track adapter says which recording field it replays, which host hook
// shows it, and how to resolve it cold.
// ============================================================================

/** Enough runs to find a broken cursor rule, few enough to keep the suite fast. */
const NUM_RUNS = 150;

/**
 * A walk the machine can take once a recording is loaded. A new trigger, or a new
 * transition that resets replay cursors, must be added here and to MACHINE_STEPS,
 * or the property cannot see it.
 */
type Move =
  | { kind: "tick"; dt: number }
  /** Seek near a recorded stamp: `pick` chooses the event, `offset` moves off its stamp. */
  | { kind: "seek"; pick: number; offset: number }
  /**
   * PLAY: the first one from ready, later ones after a PAUSE at the same moment.
   * Before it the viewer may change what the track shows (`viewerEdits`).
   */
  | { kind: "resume"; viewerEdits: boolean }
  /**
   * The next `count` records stream in: pushed into the loaded arrays in place
   * (APPEND_RECORDING_DELTA), or as a longer copy of the recording (EXTEND_RECORDING).
   */
  | { kind: "append"; count: number; extend: boolean };

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
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("resume"), viewerEdits: fc.boolean() }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("append"),
      count: fc.integer({ min: 1, max: 4 }),
      extend: fc.boolean(),
    }),
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

// ============================================================================
// The machine's side of the walk.
// ============================================================================

/**
 * An action as editorMachine's setup() holds it. xstate 5.33.2's `assign(fn)`
 * keeps `fn` as `assignment`; a plain action is the function itself, with no
 * `type`. Other built-ins (enqueueActions, sendTo, ...) carry their own `type`.
 */
type MachineAction = ((args: EditorActionArgs) => void) & {
  type?: string;
  assignment?: (args: EditorActionArgs) => EditorContextUpdate;
};

/** The machine's own actions and guards, so the walk runs exactly what it runs. */
const MACHINE_ACTIONS = editorMachine.implementations.actions as unknown as Record<
  string,
  MachineAction | undefined
>;
const MACHINE_GUARDS = editorMachine.implementations.guards as unknown as Record<
  string,
  ((args: EditorActionArgs) => boolean) | undefined
>;

/**
 * Actions that change no replay state: they drive the timeline and narration
 * actors, or keep the viewer's own workspace files (the walk edits none). Any
 * other action that is not an assign or a plain action stops the walk, because
 * it may move a replay cursor.
 */
const SKIPPED_ACTIONS = new Set([
  "spawnPlaybackAudio",
  "startPlaybackActors",
  "pausePlaybackActors",
  "seekPlaybackActors",
  "syncPlaybackAudioToTimeline",
  "syncStreamedRecordingGrowth",
  "preserveLearnerWorkspace",
]);

const { playback } = editorMachine.root.states;
const { ready, playing, paused } = playback.states;

/** The editor machine during playback, as far as the walk takes it. */
interface PlaybackMachine {
  context: EditorMachineContext;
  state: "ready" | "playing";
}

/** One step of the walk: the actions the machine runs for `event` from where it is now. */
type MachineStep = (
  machine: PlaybackMachine,
  event: EditorMachineEvent,
) => readonly UnknownAction[];

/**
 * The actions of the `node` transition the machine takes for `event`: like xstate,
 * the first branch whose guard holds, checked against the context before the step.
 */
function takenActions(
  node: typeof playback,
  machine: PlaybackMachine,
  event: EditorMachineEvent,
): readonly UnknownAction[] {
  const branch = (node.transitions.get(event.type) ?? []).find((each) => {
    if (each.guard === undefined) return true;
    const guard = typeof each.guard === "string" ? MACHINE_GUARDS[each.guard] : undefined;
    if (!guard) throw new Error(`The walk cannot check the guard of ${node.key}.${event.type}`);
    return guard({ context: machine.context, event });
  });
  if (!branch) {
    throw new Error(`No branch of ${node.key}.${event.type} holds where the walk sends it`);
  }
  return branch.actions;
}

/** A transition of `playback` itself, which the walk takes from ready and from playing. */
const playbackStep: MachineStep = (machine, event) => {
  if (ready.transitions.has(event.type) || playing.transitions.has(event.type)) {
    throw new Error(`ready or playing now handles ${event.type} itself; walk that transition`);
  }
  return takenActions(playback, machine, event);
};

/**
 * The actions the machine runs for each step of the walk. They are read from the
 * machine itself (editorMachine.ts: `loading`'s onDone near line 1026, and the
 * `playback` state near lines 1067-1265), so the walk follows the machine's lists,
 * guards and order: the source state's exit, the actions of the branch whose guard
 * holds, then the target's entry. Kept by hand here: which transition each step
 * takes, and loading's onDone, whose setRecording is an inline assign (see `load`).
 * A new trigger, or a new transition that resets replay cursors, belongs here and
 * in the Move union, or the walk cannot see it.
 *
 * The walk never stays paused (a resume is PAUSE then PLAY at once), so paused's
 * own TICK and SEEK, and growth while the viewer owns the workspace, are not
 * walked. Neither are STOP, the end (FINISHED, ended), WORKSPACE_EVENT and
 * SET_EDITOR_REF.
 */
const MACHINE_STEPS = {
  LOAD: () => [...playback.entry, ...ready.entry],
  TICK: playbackStep,
  SEEK: playbackStep,
  // The first PLAY: ready -> playing.
  PLAY: (machine, event) => [
    ...ready.exit,
    ...takenActions(ready, machine, event),
    ...playing.entry,
  ],
  // playing -> paused hands the workspace to the viewer (detachPlaybackWorkspace) ...
  PAUSE: (machine, event) => [
    ...playing.exit,
    ...takenActions(playing, machine, event),
    ...paused.entry,
  ],
  // ... and paused -> playing takes it back (reattachPlaybackWorkspace).
  RESUME: (machine, event) => [
    ...paused.exit,
    ...takenActions(paused, machine, event),
    ...playing.entry,
  ],
  // Streamed growth. The replay owns the workspace here, so the branch that
  // catches the replay up is the one that holds.
  APPEND_RECORDING_DELTA: playbackStep,
  EXTEND_RECORDING: playbackStep,
} satisfies Record<string, MachineStep>;

/**
 * Takes `step` for `event`. Like `assign`, each action sees what the ones before
 * it changed; a plain action only calls host hooks.
 */
function run(machine: PlaybackMachine, event: EditorMachineEvent, step: MachineStep): void {
  for (const action of step(machine, event)) {
    if (typeof action !== "string") throw new Error("The walk cannot run an inline action");
    if (SKIPPED_ACTIONS.has(action)) continue;
    const implementation = MACHINE_ACTIONS[action];
    const args = { context: machine.context, event };
    if (implementation?.type === "xstate.assign" && implementation.assignment) {
      machine.context = { ...machine.context, ...implementation.assignment(args) };
    } else if (implementation && implementation.type === undefined) {
      implementation(args);
    } else {
      throw new Error(
        `The walk cannot run "${action}" (${implementation?.type ?? "unknown"}); ` +
          "add it to SKIPPED_ACTIONS if it changes no replay state",
      );
    }
  }
}

/** Longer than any walk, so the timeline never clamps the playhead. */
const DURATION = 60_000;

/**
 * The recording around one track's log. Its one frame makes it playable (canPlay).
 * The context has no editor, so applyFrameAtTime applies nothing (the frame track
 * needs Monaco and is left out), and with no current frame
 * adoptPlaybackWorkspaceAtPause adopts nothing at a pause either.
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
        selection: {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 1,
          selectionStartLineNumber: 1,
          selectionStartColumn: 1,
          positionLineNumber: 1,
          positionColumn: 1,
        },
        position: { lineNumber: 1, column: 1 },
        viewState: null,
      },
    },
  ],
};

/** loading's onDone: setRecording, then playback's entry. */
function load(recording: Recording, hooks: EditorMachineHostHooks): PlaybackMachine {
  const initial = createInitialContext({
    editorRef: { current: null },
    ...hooks,
    // A replay action reports a damaged track here, and the walk's tracks are whole.
    onError: (error) => {
      throw error;
    },
  });
  const loaded = { recording, duration: DURATION };
  const machine: PlaybackMachine = {
    context: { ...initial, ...setRecording({ context: initial }, loaded) },
    state: "ready",
  };
  // The loadRecording invoke's done event. The replay actions read only its type,
  // which is neither TICK nor SEEK.
  const done = { type: "xstate.done.actor.0.editor.loading", output: loaded };
  run(machine, done as unknown as EditorMachineEvent, MACHINE_STEPS.LOAD);
  return machine;
}

/** Where each track's records are, in a recording and in a streamed delta. */
const TRACK_FIELDS = {
  chatEvents: "newChatEvents",
  runtimeEvents: "newRuntimeEvents",
  workspaceEvents: "newWorkspaceEvents",
  whiteboardEvents: "newWhiteboardEvents",
  slideEvents: "newSlideEvents",
  previewEvents: "newPreviewEvents",
} as const satisfies { [F in keyof Recording]?: keyof RecordingStreamDelta };

type TrackField = keyof typeof TRACK_FIELDS;

const NO_NEW_RECORDS: Omit<RecordingStreamDelta, "cursor" | "recordingId" | "duration"> = {
  streamFinalized: false,
  newFrames: [],
  newSlideEvents: [],
  newPreviewEvents: [],
  newPreviewInitialDocuments: [],
  newPreviewPatchBatches: [],
  newWorkspaceEvents: [],
  newRuntimeEvents: [],
  newCursorEvents: [],
  newWhiteboardEvents: [],
  newChatEvents: [],
};

/** Streams `records` of one track in, in place (a delta) or as a longer copy (`extend`). */
function grow(
  machine: PlaybackMachine,
  field: TrackField,
  records: readonly unknown[],
  extend: boolean,
): void {
  const recording = machine.context.recording!;
  if (extend) {
    const longer = { ...recording, [field]: [...(recording[field] ?? []), ...records] };
    run(machine, { type: "EXTEND_RECORDING", recording: longer }, MACHINE_STEPS.EXTEND_RECORDING);
    return;
  }
  const delta: RecordingStreamDelta = {
    ...NO_NEW_RECORDS,
    cursor: machine.context.recordingStreamCursor + 1,
    recordingId: recording.id,
    duration: DURATION,
    [TRACK_FIELDS[field]]: records,
  };
  run(machine, { type: "APPEND_RECORDING_DELTA", delta }, MACHINE_STEPS.APPEND_RECORDING_DELTA);
}

// ============================================================================
// The walk.
// ============================================================================

interface ReplayTrack<Event extends { timestamp: number }> {
  /** The recording field the track replays. */
  field: TrackField;
  /** Anything else the recording needs (the slide deck). */
  recording?: Partial<Recording>;
  /**
   * The host hooks that show the track, made fresh for each walk, and what they
   * show now. A track that lands on one state pushes each state its hook is
   * given into `applied`.
   */
  host(applied: unknown[]): {
    hooks: EditorMachineHostHooks;
    shown(context: EditorMachineContext): unknown;
    /** The viewer changes what the track shows, as they may before PLAY. */
    viewerEdit?(): void;
  };
  /** What a cold resolve at `time` shows. `events` is a copy that shares no cache with the walk. */
  cold(events: Event[], time: number): unknown;
  /**
   * Tracks with transient interactions (slide hops, preview clicks) replay every
   * event a tick or a streamed append crosses. A load, a seek or a resume lands on
   * one state and must never fire the recorded interactions again.
   */
  replaysTransients?: true;
  /** What the host does on its own once playing starts. */
  onPlaying?(context: EditorMachineContext): void;
}

/**
 * Loads the first `initialCount` records of `all`, plays `moves`, and checks the
 * track against a cold resolve after the load and after each move. Returns how
 * many states it compared.
 */
function walk<Event extends { timestamp: number }>(
  track: ReplayTrack<Event>,
  all: Event[],
  initialCount: number,
  moves: Move[],
): number {
  const stamps = all.map((event) => event.timestamp);
  const applied: unknown[] = [];
  const host = track.host(applied);
  const machine = load(
    { ...RECORDING, ...track.recording, [track.field]: all.slice(0, initialCount) },
    host.hooks,
  );
  let time = 0;

  const loaded = (): Event[] => (machine.context.recording?.[track.field] ?? []) as Event[];
  const check = (label: string, landsOnOneState: boolean) => {
    if (track.replaysTransients && landsOnOneState) {
      expect(applied.length, `states applied ${label}`).toBeLessThanOrEqual(1);
    }
    expect(machine.context.timeline.currentTime, `the playhead ${label}`).toBe(time);
    expect(host.shown(machine.context), `what the track shows ${label}`).toEqual(
      track.cold([...loaded()], time),
    );
    applied.length = 0;
  };

  check("after the load", true);
  moves.forEach((move, index) => {
    if (move.kind === "tick") {
      // The timeline ticks only once playing, but a TICK in ready runs the same
      // playback.TICK, so the walk also ticks from the cursors the load left.
      time += move.dt;
      run(machine, { type: "TICK", currentTime: time }, MACHINE_STEPS.TICK);
    } else if (move.kind === "seek") {
      const stamp = stamps.length ? stamps[move.pick % stamps.length] : 0;
      time = Math.max(0, stamp + move.offset);
      run(machine, { type: "SEEK", time }, MACHINE_STEPS.SEEK);
    } else if (move.kind === "resume") {
      const wasPlaying = machine.state === "playing";
      if (wasPlaying) run(machine, { type: "PAUSE" }, MACHINE_STEPS.PAUSE);
      // Paused, or not yet playing, the app is the viewer's. With no records
      // loaded the machine has nothing to put back, so the viewer's state stays.
      if (move.viewerEdits && loaded().length) host.viewerEdit?.();
      run(machine, { type: "PLAY" }, wasPlaying ? MACHINE_STEPS.RESUME : MACHINE_STEPS.PLAY);
      machine.state = "playing";
      track.onPlaying?.(machine.context);
    } else {
      const next = all.slice(loaded().length, loaded().length + move.count);
      grow(machine, track.field, next, move.extend);
    }
    const landsOnOneState = move.kind === "seek" || move.kind === "resume";
    check(`after move ${index} (${move.kind}) at ${time}ms`, landsOnOneState);
  });
  return moves.length + 1;
}

/**
 * Generates event logs from `arbSteps` and walks over each one. Returns how many
 * states were compared, so a test can see that its walks really ran.
 */
function checkWalks<Step, Event extends { timestamp: number }>(
  arbSteps: fc.Arbitrary<Step[]>,
  record: (steps: Step[]) => Event[],
  track: ReplayTrack<Event>,
): number {
  let compared = 0;
  fc.assert(
    fc.property(arbSteps, arbInitialCount, arbMoves, (steps, initialCount, moves) => {
      compared += walk(track, record(steps), initialCount, moves);
    }),
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

const chatTrack: ReplayTrack<ChatRecordingEvent> = {
  field: "chatEvents",
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
  cold: (events, time) =>
    getChatReplayResult({
      chatEvents: events,
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

const runtimeTrack: ReplayTrack<RuntimeRecordingEvent> = {
  field: "runtimeEvents",
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
  cold: (events, time) =>
    getRuntimeReplayResult({ runtimeEvents: events, currentTime: time, lastAppliedIndex: -1 })
      .snapshotToApply,
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
// second time. A pause also hands the workspace to the viewer (it detaches and
// sets hasManualWorkspaceOverride) and the PLAY after it takes it back, and the
// walk's resume runs both. The viewer edits no files here: PLAY keeps their
// edits on purpose until the recording changes the workspace again (see the
// "learner workspace" tests in editorMachine.test.ts).
const workspaceTrack: ReplayTrack<WorkspaceRecordingEvent> = {
  field: "workspaceEvents",
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
  cold: (events, time) => {
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

const whiteboardTrack: ReplayTrack<WhiteboardEvent> = {
  field: "whiteboardEvents",
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
  // Without whiteboard events the machine applies nothing.
  cold: (events, time) =>
    events.length
      ? getWhiteboardReplayResult({
          whiteboardEvents: events,
          currentTime: time,
          lastAppliedIndex: -1,
        }).stateToApply
      : undefined,
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
// event, and a seek must keep the same last placed state.
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

const slideTrack: ReplayTrack<SlideEvent> = {
  field: "slideEvents",
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
  cold: (events, time) =>
    events.length
      ? getSlideReplayResult({
          slideEvents: events,
          slides: SLIDES,
          currentTime: time,
          lastAppliedIndex: -1,
          isResync: true,
        }).applications.at(-1)
      : undefined,
  replaysTransients: true,
};

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

const previewTrack: ReplayTrack<PreviewEvent> = {
  field: "previewEvents",
  host(applied) {
    return {
      hooks: {
        applyPreviewState: (state) => {
          applied.push(state);
        },
      },
      // The retained state the machine keeps (lastAppliedPreviewState), not the
      // last state the hook was given, which carries the transient parts. So a
      // viewer's change to the live preview is not what the walk compares.
      shown: (context) => context.lastAppliedPreviewState,
    };
  },
  cold: (events, time) =>
    getPreviewReplayResult({
      previewEvents: events,
      currentTime: time,
      lastAppliedIndex: -1,
      isResync: true,
    }).retainedState,
  replaysTransients: true,
};

describe("seeking lands where playing does", () => {
  it("chat", () => {
    const compared = checkWalks(fc.array(fc.tuple(arbGap, arbChatOp), SIZE), recordChat, chatTrack);
    expect(compared).toBeGreaterThan(NUM_RUNS);
  });

  it("runtime", () => {
    const compared = checkWalks(
      fc.array(fc.tuple(arbGap, arbRuntimeOp, fc.boolean()), SIZE),
      recordRuntime,
      runtimeTrack,
    );
    expect(compared).toBeGreaterThan(NUM_RUNS);
  });

  it("workspace panel widths and files", () => {
    const compared = checkWalks(fc.array(arbWorkspaceStep, SIZE), recordWorkspace, workspaceTrack);
    expect(compared).toBeGreaterThan(NUM_RUNS);
  });

  it("whiteboard", () => {
    const compared = checkWalks(
      fc.array(arbWhiteboardStep, SIZE),
      recordWhiteboard,
      whiteboardTrack,
    );
    expect(compared).toBeGreaterThan(NUM_RUNS);
  });

  it("slides", () => {
    const compared = checkWalks(fc.array(arbSlideStep, SIZE), recordSlides, slideTrack);
    expect(compared).toBeGreaterThan(NUM_RUNS);
  });

  it("preview retained state", () => {
    const compared = checkWalks(fc.array(arbPreviewStep, SIZE), recordPreview, previewTrack);
    expect(compared).toBeGreaterThan(NUM_RUNS);
  });
});
