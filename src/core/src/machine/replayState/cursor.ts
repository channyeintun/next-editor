// ============================================================================
// Replay cursor core.
//
// Shared, track-agnostic helpers for turning "what time are we at?" into "which
// event index applies now". Each per-track replay module (preview/workspace/
// runtime/slide/whiteboard/chat) builds on these. The index lookup itself lives
// in utils/timedIndex, which editor frames share.
// ============================================================================

import { findTimedEventIndexAtOrBefore, type TimedReplayEvent } from "../../utils/timedIndex";

export { findTimedEventIndexAtOrBefore };

export type ReplayTriggerEvent = {
  type: string;
  currentTime?: number;
  time?: number;
};

export function resolveReplayTime(event: ReplayTriggerEvent, fallbackTime: number): number {
  if (event.type === "TICK") {
    return event.currentTime ?? fallbackTime;
  }

  if (event.type === "SEEK") {
    return event.time ?? fallbackTime;
  }

  return fallbackTime;
}

function isSeekReplayEvent(event: ReplayTriggerEvent): boolean {
  return event.type === "SEEK";
}

/**
 * Whether an apply must re-assert a track's absolute state at the target time
 * instead of advancing from the track's cursor. Only a playback TICK advances. A
 * SEEK always resyncs, and any other apply (PLAY after a pause or seek, STOP, the
 * load, a streamed delta, an editor re-sync) resyncs once the cursor has been
 * invalidated. Advancing from an invalidated cursor replays every event from index
 * 0, which re-fires stale transient interactions (clicks, focus, slide hops) as
 * if they were live. Tracks with a baseline (a closed deck, an empty transcript)
 * also apply it on a resync that lands before their first event. The tracks that
 * replay crossed events (preview, slide) treat a TICK whose time is behind their
 * cursor as a resync too (see {@link isCursorAheadOf}).
 */
export function isReplayResync(event: ReplayTriggerEvent, lastAppliedIndex: number): boolean {
  return isSeekReplayEvent(event) || (event.type !== "TICK" && lastAppliedIndex < 0);
}

/**
 * The clock moved behind the event the cursor last applied without a SEEK:
 * re-derive the track at `currentTime` instead of replaying from index 0.
 */
export function isCursorAheadOf(
  events: TimedReplayEvent[],
  lastAppliedIndex: number,
  currentTime: number,
): boolean {
  return (
    lastAppliedIndex >= 0 &&
    lastAppliedIndex < events.length &&
    events[lastAppliedIndex].timestamp > currentTime
  );
}
