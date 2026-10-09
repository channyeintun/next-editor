import {
  areWorkspaceSnapshotsEqual,
  type WorkspaceRecordingEvent,
  type WorkspaceRecordingSnapshot,
} from "../../workspace";
import { findTimedEventIndexAtOrBefore } from "../../utils/timedIndex";

// ============================================================================
// Workspace track replay.
//
// Resolves the workspace snapshot (open files, sidebar, etc.) to apply at a given
// time. Panel widths (file sidebar and docked preview) are stored as per-event
// deltas, so the net delta between the last-applied event and the target is summed
// (forward) or reversed (seeking backward) and folded into the snapshot.
// ============================================================================

export interface WorkspaceReplayResult {
  nextIndex: number;
  snapshotToApply?: WorkspaceRecordingSnapshot;
}

type WorkspaceWidthDeltaKey = "sidebarWidthDelta" | "previewDockWidthDelta";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function getWorkspaceWidthDelta(
  workspaceEvents: WorkspaceRecordingEvent[],
  nextIndex: number,
  lastAppliedIndex: number,
  key: WorkspaceWidthDeltaKey,
): { delta: number; hasDelta: boolean } {
  if (nextIndex === lastAppliedIndex) {
    return { delta: 0, hasDelta: false };
  }

  let delta = 0;
  let hasDelta = false;

  if (nextIndex > lastAppliedIndex) {
    const startIndex = Math.max(0, lastAppliedIndex + 1);

    for (let index = startIndex; index <= nextIndex; index++) {
      const eventDelta = workspaceEvents[index]?.snapshot[key];

      if (isFiniteNumber(eventDelta)) {
        delta += eventDelta;
        hasDelta = true;
      }
    }

    return { delta, hasDelta };
  }

  const endIndex = Math.min(workspaceEvents.length - 1, lastAppliedIndex);

  for (let index = nextIndex + 1; index <= endIndex; index++) {
    const eventDelta = workspaceEvents[index]?.snapshot[key];

    if (isFiniteNumber(eventDelta)) {
      delta -= eventDelta;
      hasDelta = true;
    }
  }

  return { delta, hasDelta };
}

function resolveWorkspaceSnapshotForReplay({
  workspaceEvents,
  nextIndex,
  lastAppliedIndex,
}: {
  workspaceEvents: WorkspaceRecordingEvent[];
  nextIndex: number;
  lastAppliedIndex: number;
}): WorkspaceRecordingSnapshot {
  const snapshot = workspaceEvents[nextIndex].snapshot;
  const sidebarWidthDelta = getWorkspaceWidthDelta(
    workspaceEvents,
    nextIndex,
    lastAppliedIndex,
    "sidebarWidthDelta",
  );
  const previewDockWidthDelta = getWorkspaceWidthDelta(
    workspaceEvents,
    nextIndex,
    lastAppliedIndex,
    "previewDockWidthDelta",
  );

  // A backward move leaves the target event outside the undone range, so its own
  // width fields were applied when playback first reached it and must not be
  // handed back; the fields are always replaced by the net delta for this move.
  const carriesWidthDelta =
    snapshot.sidebarWidthDelta !== undefined || snapshot.previewDockWidthDelta !== undefined;

  if (!sidebarWidthDelta.hasDelta && !previewDockWidthDelta.hasDelta && !carriesWidthDelta) {
    return snapshot;
  }

  const {
    sidebarWidthDelta: _sidebarWidthDelta,
    previewDockWidthDelta: _previewDockWidthDelta,
    ...snapshotWithoutDeltas
  } = snapshot;

  const resolved: WorkspaceRecordingSnapshot = { ...snapshotWithoutDeltas };

  if (sidebarWidthDelta.hasDelta) {
    resolved.sidebarWidthDelta = sidebarWidthDelta.delta;
  }

  if (previewDockWidthDelta.hasDelta) {
    resolved.previewDockWidthDelta = previewDockWidthDelta.delta;
  }

  return resolved;
}

/**
 * The snapshot at `toIndex` for a workspace that shows the one at `fromIndex`: the
 * events in between are folded forward, or undone when `toIndex` is earlier, as a seek
 * does. A retake uses it to undo the stretch it discards: the panel resizes recorded
 * there are moves, so they are reversed rather than dropped.
 */
export function resolveWorkspaceSnapshotBetween(
  workspaceEvents: WorkspaceRecordingEvent[],
  toIndex: number,
  fromIndex: number,
): WorkspaceRecordingSnapshot {
  return resolveWorkspaceSnapshotForReplay({
    workspaceEvents,
    nextIndex: toIndex,
    lastAppliedIndex: fromIndex,
  });
}

export function getWorkspaceReplayResult({
  workspaceEvents,
  currentTime,
  getCurrentSnapshot,
  lastAppliedIndex,
}: {
  workspaceEvents: WorkspaceRecordingEvent[];
  currentTime: number;
  /**
   * Read lazily: the live snapshot is only needed to decide whether the resolved
   * one is worth applying, which is only when the cursor moves. Playback ticks at
   * rAF rate and the cursor is unchanged on almost all of them, so an eager read
   * would walk the whole workspace many times a second for nothing.
   */
  getCurrentSnapshot?: () => WorkspaceRecordingSnapshot | null;
  lastAppliedIndex: number;
}): WorkspaceReplayResult {
  const nextIndex = findTimedEventIndexAtOrBefore(workspaceEvents, currentTime, lastAppliedIndex);

  if (nextIndex >= 0 && nextIndex !== lastAppliedIndex) {
    const snapshot = getCurrentSnapshot?.() ?? null;
    const snapshotToApply = resolveWorkspaceSnapshotForReplay({
      workspaceEvents,
      nextIndex,
      lastAppliedIndex,
    });

    if (!snapshot || !areWorkspaceSnapshotsEqual(snapshot, snapshotToApply)) {
      return {
        nextIndex,
        snapshotToApply,
      };
    }
  }

  return {
    nextIndex,
  };
}
