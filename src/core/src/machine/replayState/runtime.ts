import type { RuntimeRecordingEvent, RuntimeRecordingSnapshot } from "../../runtime";
import { resolveRuntimeSnapshotAt } from "../../runtimeTrack";
import { findTimedEventIndexAtOrBefore } from "../../utils/timedIndex";
import { createViewChangeResolver } from "./viewChanges";

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

/**
 * The latest runtime event at or before `index` that collapsed or expanded the dock, or -1.
 * Every record, checkpoint or delta, stores the dock's state whole, so no fold is needed; a
 * record without it (an older take) shows the dock expanded, as the dock does. An entry with
 * neither a snapshot nor a delta changes nothing, as in resolveRuntimeSnapshotAt.
 */
export const getRuntimeDockViewChangeIndex = createViewChangeResolver<
  RuntimeRecordingEvent,
  boolean
>({
  initial: false,
  next: (isCollapsed, event) => {
    const record = event.snapshot ?? event.delta;
    return record ? (record.isCollapsed ?? false) : isCollapsed;
  },
  isSameView: (left, right) => left === right,
});

/** A recorded runtime state with the dock collapsed or expanded as the viewer has it. */
export function withRuntimeDockView(
  snapshot: RuntimeRecordingSnapshot,
  isCollapsed: boolean,
): RuntimeRecordingSnapshot {
  return (snapshot.isCollapsed ?? false) === isCollapsed ? snapshot : { ...snapshot, isCollapsed };
}
