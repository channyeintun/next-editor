import type {
  EditorActionArgs,
  EditorContextUpdate,
  EditorMachineContext,
  EditorMachineEvent,
} from "./types";
import { resolveReplayTime } from "./replayState";
import { normalizeTimelineTime } from "./playbackValues";

// ============================================================================
// What the replay steps share
//
// The track replays in replayActions.ts and the editor frame replay in
// frameReplay.ts both resolve the playhead the same way and are typed as one
// kind of step. This leaf holds those pieces so neither module imports the other
// for them. A skipped record is reported through machineError.ts.
// ============================================================================

/** The time a replay step brings its track to: the event's time, clamped to the recording. */
export const resolveBoundedReplayTime = (
  context: EditorMachineContext,
  event: EditorMachineEvent,
): number =>
  normalizeTimelineTime(
    resolveReplayTime(event, context.timeline.currentTime),
    context.timeline.duration,
    context.timeline.currentTime,
  );

/** One track's replay step: an `assign` body, or a plain action that only calls host hooks. */
export type ReplayStep = (args: EditorActionArgs) => EditorContextUpdate | void;
