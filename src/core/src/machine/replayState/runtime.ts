import type { RuntimeRecordingEvent, RuntimeRecordingSnapshot } from "../../../../types/runtime";
import { resolveRuntimeSnapshotAt } from "../../runtimeTrack";
import { findTimedEventIndexAtOrBefore } from "./cursor";

// ============================================================================
// Runtime track replay.
//
// Find the latest event at or before the current time and apply the state it
// resolves to. Terminal output is stored as deltas between sparse checkpoints,
// so the state comes from resolveRuntimeSnapshotAt, which folds forward from
// the last resolved index during playback and from a checkpoint on a seek.
// ============================================================================

export interface RuntimeReplayResult {
  nextIndex: number;
  snapshotToApply?: RuntimeRecordingSnapshot;
}

export function getRuntimeReplayResult({
  runtimeEvents,
  currentTime,
  lastAppliedIndex,
}: {
  runtimeEvents: RuntimeRecordingEvent[];
  currentTime: number;
  lastAppliedIndex: number;
}): RuntimeReplayResult {
  const nextIndex = findTimedEventIndexAtOrBefore(runtimeEvents, currentTime, lastAppliedIndex);

  if (nextIndex >= 0 && nextIndex !== lastAppliedIndex) {
    return {
      nextIndex,
      snapshotToApply: resolveRuntimeSnapshotAt(runtimeEvents, nextIndex) ?? undefined,
    };
  }

  return {
    nextIndex,
  };
}
