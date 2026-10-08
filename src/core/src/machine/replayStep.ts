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
// frameReplay.ts both resolve the playhead and report a skipped record the same
// way. This leaf holds those pieces so neither module imports the other for them.
// ============================================================================

/**
 * Hand a machine failure to the host's `onError`, or to the console when the host supplies none
 * (the app's own provider does not). Without the fallback a denied microphone, a failed load or
 * a damaged frame skipped during replay left no trace at all. Pass the Error itself so the stack
 * and class (ContentEditBaseMismatchError, DmpBaseMismatchError) survive into the log.
 */
export const reportMachineError = (
  context: Pick<EditorMachineContext, "onError">,
  error: Error,
): void => {
  if (context.onError) {
    context.onError(error);
    return;
  }
  console.error("[editorMachine]", error);
};

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
