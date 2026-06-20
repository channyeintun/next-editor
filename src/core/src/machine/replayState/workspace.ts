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
// time. The sidebar width is stored as per-event deltas, so the net delta between
// the last-applied event and the target is summed (forward) or reversed (seeking
// backward) and folded into the snapshot.
// ============================================================================

export interface WorkspaceReplayResult {
  nextIndex: number;
  snapshotToApply?: WorkspaceRecordingSnapshot;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function getWorkspaceSidebarWidthDelta(
  workspaceEvents: WorkspaceRecordingEvent[],
  nextIndex: number,
  lastAppliedIndex: number,
): { delta: number; hasDelta: boolean } {
  if (nextIndex === lastAppliedIndex) {
    return { delta: 0, hasDelta: false };
  }

  let delta = 0;
  let hasDelta = false;

  if (nextIndex > lastAppliedIndex) {
    const startIndex = Math.max(0, lastAppliedIndex + 1);

    for (let index = startIndex; index <= nextIndex; index++) {
      const eventDelta = workspaceEvents[index]?.snapshot.sidebarWidthDelta;

      if (isFiniteNumber(eventDelta)) {
        delta += eventDelta;
        hasDelta = true;
      }
    }

    return { delta, hasDelta };
  }

  const endIndex = Math.min(workspaceEvents.length - 1, lastAppliedIndex);

  for (let index = nextIndex + 1; index <= endIndex; index++) {
    const eventDelta = workspaceEvents[index]?.snapshot.sidebarWidthDelta;

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
  const sidebarWidthDelta = getWorkspaceSidebarWidthDelta(
    workspaceEvents,
    nextIndex,
    lastAppliedIndex,
  );

  if (!sidebarWidthDelta.hasDelta) {
    return snapshot;
  }

  const { sidebarWidthDelta: _sidebarWidthDelta, ...snapshotWithoutSidebarDelta } = snapshot;

  return {
    ...snapshotWithoutSidebarDelta,
    sidebarWidthDelta: sidebarWidthDelta.delta,
  };
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
