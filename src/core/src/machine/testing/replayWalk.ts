import type * as monaco from "monaco-editor";
import type { UnknownAction } from "xstate";
import type { Recording, RecordingStreamDelta } from "../../types";
import { editorMachine } from "../editorMachine";
import { RECORDING_TRACK_NAMES, type RecordingTracks } from "../recordingAssembly";
import { setRecording, STREAM_DELTA_KEY } from "../replayActions";
import {
  createInitialContext,
  type EditorActionArgs,
  type EditorContextUpdate,
  type EditorMachineContext,
  type EditorMachineEvent,
  type EditorMachineHostHooks,
} from "../types";

// ============================================================================
// The editor machine during playback, driven without an actor.
//
// A replay test loads a recording and sends playback events, and each event runs
// exactly the actions editorMachine.ts runs for it: the branch is the one xstate
// takes (the first whose guard holds, from the playback substate up to the root),
// and its actions run between the source's exit and the target's entry, all read
// from the machine's own state nodes and setup(). Each assign's patch is merged
// into the context the way `assign` does, so every cursor reset, resync rule and
// apply action is the real one. Only the host hooks and the editor are the test's.
//
// Imported by the machine's test files and by the hand-run check of real
// recordings (scripts/recordings-check.ts); never by production code.
// ============================================================================

/**
 * An action as editorMachine's setup() holds it. xstate 5.33's `assign(fn)` keeps
 * `fn` as `assignment`; a plain action is the function itself, with no `type`.
 * Other built-ins (enqueueActions, sendTo, ...) carry their own `type`.
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
 * actors, or hand the viewer's own workspace edits to the app to keep. Any other
 * action that is not an assign or a plain action stops the walk, because it may
 * move a replay cursor.
 */
export const SKIPPED_ACTIONS: ReadonlySet<string> = new Set([
  "spawnPlaybackAudio",
  "startPlaybackActors",
  "pausePlaybackActors",
  "seekPlaybackActors",
  "syncPlaybackAudioToTimeline",
  "syncStreamedRecordingGrowth",
  "preserveLearnerWorkspace",
]);

const { playback } = editorMachine.root.states;

/** The playback substates a walk can be in. */
export type PlaybackState = "ready" | "playing" | "paused" | "ended";

type StateNode = typeof playback;

/** The editor machine during playback, as far as a walk takes it. */
export interface PlaybackMachine {
  context: EditorMachineContext;
  state: PlaybackState;
}

/**
 * Runs `actions` for `event`. Like `assign`, each action sees what the ones before it
 * changed; a plain action only calls host hooks.
 */
export function run(
  machine: PlaybackMachine,
  event: EditorMachineEvent,
  actions: readonly UnknownAction[],
): void {
  for (const action of actions) {
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

/** The first branch of `node` for `event` whose guard holds against the context now. */
function enabledBranch(node: StateNode, machine: PlaybackMachine, event: EditorMachineEvent) {
  return (node.transitions.get(event.type) ?? []).find((each) => {
    if (each.guard === undefined) return true;
    const guard = typeof each.guard === "string" ? MACHINE_GUARDS[each.guard] : undefined;
    if (!guard) throw new Error(`The walk cannot check the guard of ${node.key}.${event.type}`);
    return guard({ context: machine.context, event });
  });
}

/** A state's own actions on the way in or out, with those of its initial child. */
function withInitialChild(node: StateNode, side: "entry" | "exit"): readonly UnknownAction[] {
  const child = node.initial?.target?.[0];
  if (!child) return node[side];
  return side === "entry" ? [...node.entry, ...child.entry] : [...child.exit, ...node.exit];
}

/**
 * Sends `event` to the machine in its playback substate: takes the first enabled branch
 * from the substate up to the root, as xstate does, and runs the substate's exit, the
 * branch's actions and the target's entry. An event no branch takes stops the walk: xstate
 * would drop it, so a walk that sends one is not walking what it means to.
 */
export function send(machine: PlaybackMachine, event: EditorMachineEvent): void {
  const current = playback.states[machine.state];
  for (const node of [current, playback, editorMachine.root]) {
    const branch = enabledBranch(node, machine, event);
    if (!branch) continue;
    const target = branch.target?.[0];
    if (!target) {
      run(machine, event, branch.actions);
      return;
    }
    if (target.parent !== playback) {
      throw new Error(`The walk only moves between playback's substates, not to ${target.id}`);
    }
    run(machine, event, [
      ...withInitialChild(current, "exit"),
      ...branch.actions,
      ...withInitialChild(target, "entry"),
    ]);
    machine.state = target.key as PlaybackState;
    return;
  }
  throw new Error(`No branch takes ${event.type} in ${machine.state}`);
}

/**
 * What `load` needs. Every field but `onError` is required: a replay test states what
 * it loads.
 */
export interface WalkLoad {
  recording: Recording;
  hooks: EditorMachineHostHooks;
  /** The timeline's length, as the loadRecording actor reports it. */
  duration: number;
  /** The editor the host has when the recording loads, or null for none. */
  editor: monaco.editor.IStandaloneCodeEditor | null;
  /**
   * Where a replay action reports a damaged track, from the load's own apply on. A
   * test's tracks are whole, so by default the report is thrown; a check of real
   * recordings counts it instead.
   */
  onError?: (error: Error) => void;
}

const throwReport = (error: Error) => {
  throw error;
};

/** loading's onDone: setRecording, then playback's entry and ready's. */
export function load({
  recording,
  hooks,
  duration,
  editor,
  onError = throwReport,
}: WalkLoad): PlaybackMachine {
  const initial = createInitialContext({ editorRef: { current: editor }, ...hooks, onError });
  const loaded = { recording, duration };
  const machine: PlaybackMachine = {
    // setRecording is loading's onDone as an inline assign, so it is called by name.
    context: { ...initial, ...setRecording({ context: initial }, loaded) },
    state: "ready",
  };
  // The loadRecording invoke's done event. The replay actions read only its type,
  // which is neither TICK nor SEEK.
  const done = { type: "xstate.done.actor.0.editor.loading", output: loaded };
  run(machine, done as unknown as EditorMachineEvent, [
    ...playback.entry,
    ...withInitialChild(playback.states.ready, "entry"),
  ]);
  return machine;
}

/**
 * Streams `records` in: pushed into the loaded arrays in place (APPEND_RECORDING_DELTA),
 * or as a longer copy of the recording (`extend`, EXTEND_RECORDING). The delta puts each
 * track's records where the machine reads them (STREAM_DELTA_KEY).
 */
export function grow(
  machine: PlaybackMachine,
  records: Partial<RecordingTracks>,
  extend: boolean,
): void {
  const recording = machine.context.recording!;
  if (extend) {
    const longer: Recording = { ...recording };
    const tracks = longer as Partial<Record<keyof RecordingTracks, unknown[]>>;
    for (const name of RECORDING_TRACK_NAMES) {
      const added = records[name];
      if (added?.length) tracks[name] = [...(recording[name] ?? []), ...added];
    }
    send(machine, { type: "EXTEND_RECORDING", recording: longer });
    return;
  }
  const delta = {
    cursor: machine.context.recordingStreamCursor + 1,
    recordingId: recording.id,
    duration: recording.duration,
    streamFinalized: false,
  } as RecordingStreamDelta;
  const fields = delta as unknown as Record<string, unknown[]>;
  for (const name of RECORDING_TRACK_NAMES) {
    fields[STREAM_DELTA_KEY[name]] = records[name] ?? [];
  }
  send(machine, { type: "APPEND_RECORDING_DELTA", delta });
}
