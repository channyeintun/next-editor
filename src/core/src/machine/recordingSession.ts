import type {
  PreviewDomPatchBatch,
  PreviewEvent,
  PreviewInitialDocument,
  SlideEvent,
} from "../slides";
import type { RuntimeRecordingSnapshot } from "../../../types/runtime";
import {
  areWorkspaceSnapshotsEqual,
  toWorkspaceDeltaSnapshot,
  type WorkspaceRecordingSnapshot,
  type WorkspaceWidthDeltas,
} from "../../../types/workspace";
import { areRuntimeRecordingSnapshotsEqual } from "../../../utils/equality";
import type { RecordingSession } from "./types";

function getRecordingTimestamp(session: RecordingSession): number {
  return performance.now() - session.startedAtPerf;
}

/**
 * All appenders below mutate `session`'s arrays in place and return the same session
 * reference — see the invariant documented on {@link RecordingSession}. Callers bump
 * `sessionRevision` themselves so the mutation is still visible to reference-equality
 * selectors.
 */

export function appendSlideRecordingEvent(
  session: RecordingSession,
  event: SlideEvent,
): RecordingSession {
  session.slideEvents.push({
    ...event,
    timestamp: getRecordingTimestamp(session),
  });
  return session;
}

export function appendPreviewRecordingEvent(
  session: RecordingSession,
  event: PreviewEvent,
): RecordingSession {
  session.previewEvents.push({
    ...event,
    timestamp: getRecordingTimestamp(session),
  });
  return session;
}

export function appendPreviewInitialDocument(
  session: RecordingSession,
  document: PreviewInitialDocument,
): RecordingSession {
  session.previewInitialDocuments.push({
    ...document,
    time: getRecordingTimestamp(session),
  });
  return session;
}

export function appendPreviewPatchBatch(
  session: RecordingSession,
  batch: PreviewDomPatchBatch,
): RecordingSession {
  session.previewPatchBatches.push({
    ...batch,
    time: getRecordingTimestamp(session),
  });
  return session;
}

/**
 * Returns `false` when the snapshot deduplicates against the last recorded event (no
 * push happened) so callers know whether to bump `sessionRevision`. `session` itself
 * is always the same reference — array identity never changes.
 */
export function appendWorkspaceRecordingEvent(
  session: RecordingSession,
  snapshot: WorkspaceRecordingSnapshot,
  deltas?: WorkspaceWidthDeltas,
): boolean {
  const recordingSnapshot = deltas ? toWorkspaceDeltaSnapshot(snapshot, deltas) : snapshot;
  const previousEvent = session.workspaceEvents[session.workspaceEvents.length - 1];

  if (previousEvent && areWorkspaceSnapshotsEqual(previousEvent.snapshot, recordingSnapshot)) {
    return false;
  }

  session.workspaceEvents.push({
    timestamp: getRecordingTimestamp(session),
    snapshot: recordingSnapshot,
  });
  return true;
}

/**
 * Returns `false` when the snapshot deduplicates against the last recorded event (no
 * push happened) so callers know whether to bump `sessionRevision`.
 */
export function appendRuntimeRecordingEvent(
  session: RecordingSession,
  snapshot: RuntimeRecordingSnapshot,
): boolean {
  const previousEvent = session.runtimeEvents[session.runtimeEvents.length - 1];

  if (previousEvent && areRuntimeRecordingSnapshotsEqual(previousEvent.snapshot, snapshot)) {
    return false;
  }

  session.runtimeEvents.push({
    timestamp: getRecordingTimestamp(session),
    snapshot,
  });
  return true;
}
