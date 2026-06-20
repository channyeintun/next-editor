import type { RuntimeRecordingEvent, RuntimeRecordingSnapshot } from "../../../../types/runtime";
import { advanceReplayCursor } from "./cursor";

// ============================================================================
// Runtime track replay.
//
// Each runtime event carries a full snapshot, so replay is simply: find the
// latest event at or before the current time and apply its snapshot.
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
      snapshotToApply: replayCursor.latestEvent.snapshot,
    };
  }

  return {
    nextIndex: replayCursor.nextIndex,
  };
}
