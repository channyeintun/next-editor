import type {
  PreviewDomPatchBatch,
  PreviewEvent,
  PreviewInitialDocument,
  SlideEvent,
} from "../slides";
import type { RuntimeRecordingSnapshot } from "../../../types/runtime";
import {
  areWorkspaceSnapshotsEqual,
  toSidebarWidthDeltaSnapshot,
  type WorkspaceRecordingSnapshot,
} from "../../../types/workspace";
import { areRuntimeRecordingSnapshotsEqual } from "../../../utils/equality";
import type { RecordingSession } from "./types";

function getRecordingTimestamp(session: RecordingSession): number {
  return Date.now() - session.startedAt;
}

export function appendSlideRecordingEvent(
  session: RecordingSession,
  event: SlideEvent,
): RecordingSession {
  return {
    ...session,
    slideEvents: [
      ...session.slideEvents,
      {
        ...event,
        timestamp: getRecordingTimestamp(session),
      },
    ],
  };
}

export function appendPreviewRecordingEvent(
  session: RecordingSession,
  event: PreviewEvent,
): RecordingSession {
  return {
    ...session,
    previewEvents: [
      ...session.previewEvents,
      {
        ...event,
        timestamp: getRecordingTimestamp(session),
      },
    ],
  };
}

export function appendPreviewInitialDocument(
  session: RecordingSession,
  document: PreviewInitialDocument,
): RecordingSession {
  return {
    ...session,
    previewInitialDocuments: [
      ...session.previewInitialDocuments,
      {
        ...document,
        time: getRecordingTimestamp(session),
      },
    ],
  };
}

export function appendPreviewPatchBatch(
  session: RecordingSession,
  batch: PreviewDomPatchBatch,
): RecordingSession {
  return {
    ...session,
    previewPatchBatches: [
      ...session.previewPatchBatches,
      {
        ...batch,
        time: getRecordingTimestamp(session),
      },
    ],
  };
}

export function appendWorkspaceRecordingEvent(
  session: RecordingSession,
  snapshot: WorkspaceRecordingSnapshot,
  sidebarWidthDelta?: number,
): RecordingSession {
  const recordingSnapshot = toSidebarWidthDeltaSnapshot(snapshot, sidebarWidthDelta);
  const previousEvent = session.workspaceEvents[session.workspaceEvents.length - 1];

  if (previousEvent && areWorkspaceSnapshotsEqual(previousEvent.snapshot, recordingSnapshot)) {
    return session;
  }

  return {
    ...session,
    workspaceEvents: [
      ...session.workspaceEvents,
      {
        timestamp: getRecordingTimestamp(session),
        snapshot: recordingSnapshot,
      },
    ],
  };
}

export function appendRuntimeRecordingEvent(
  session: RecordingSession,
  snapshot: RuntimeRecordingSnapshot,
): RecordingSession {
  const previousEvent = session.runtimeEvents[session.runtimeEvents.length - 1];

  if (previousEvent && areRuntimeRecordingSnapshotsEqual(previousEvent.snapshot, snapshot)) {
    return session;
  }

  return {
    ...session,
    runtimeEvents: [
      ...session.runtimeEvents,
      {
        timestamp: getRecordingTimestamp(session),
        snapshot,
      },
    ],
  };
}
