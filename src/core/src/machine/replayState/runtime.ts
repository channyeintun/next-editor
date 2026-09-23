import type { RuntimeRecordingEvent, RuntimeRecordingSnapshot } from "../../../../types/runtime";
import { resolveRuntimeSnapshotAt } from "../../runtimeTrack";
import { advanceReplayCursor } from "./cursor";

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
  const replayCursor = advanceReplayCursor({
    events: runtimeEvents,
    currentTime,
    lastAppliedIndex,
  });

  if (replayCursor.latestEvent && replayCursor.nextIndex !== lastAppliedIndex) {
    return {
      nextIndex: replayCursor.nextIndex,
      snapshotToApply: resolveRuntimeSnapshotAt(runtimeEvents, replayCursor.nextIndex) ?? undefined,
    };
  }

  return {
    nextIndex: replayCursor.nextIndex,
  };
}
