import {
  areWorkspaceSnapshotsEqual,
  type WorkspaceRecordingEvent,
  type WorkspaceRecordingSnapshot,
} from "../../../../types/workspace";
import { advanceReplayCursor } from "./cursor";

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

  if (!sidebarWidthDelta.hasDelta && !previewDockWidthDelta.hasDelta) {
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

export function getWorkspaceReplayResult({
  workspaceEvents,
  currentTime,
  currentSnapshot,
  getCurrentSnapshot,
  lastAppliedIndex,
}: {
  workspaceEvents: WorkspaceRecordingEvent[];
  currentTime: number;
  currentSnapshot?: WorkspaceRecordingSnapshot | null;
  getCurrentSnapshot?: () => WorkspaceRecordingSnapshot | null;
  lastAppliedIndex: number;
}): WorkspaceReplayResult {
  const replayCursor = advanceReplayCursor({
    events: workspaceEvents,
    currentTime,
    lastAppliedIndex,
  });

  if (replayCursor.latestEvent && replayCursor.nextIndex !== lastAppliedIndex) {
    const snapshot =
      currentSnapshot !== undefined ? currentSnapshot : (getCurrentSnapshot?.() ?? null);
    const snapshotToApply = resolveWorkspaceSnapshotForReplay({
      workspaceEvents,
      nextIndex: replayCursor.nextIndex,
      lastAppliedIndex,
    });

    if (!snapshot || !areWorkspaceSnapshotsEqual(snapshot, snapshotToApply)) {
      return {
        nextIndex: replayCursor.nextIndex,
        snapshotToApply,
      };
    }
  }

  return {
    nextIndex: replayCursor.nextIndex,
  };
}
