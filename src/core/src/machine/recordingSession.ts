import type { PreviewEvent, SlideEvent } from "../slides";
import type { RuntimeRecordingSnapshot } from "../../../types/runtime";
import {
  areWorkspaceSnapshotsEqual,
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

export function appendWorkspaceRecordingEvent(
  session: RecordingSession,
  snapshot: WorkspaceRecordingSnapshot,
): RecordingSession {
  const previousEvent = session.workspaceEvents[session.workspaceEvents.length - 1];

  if (previousEvent && areWorkspaceSnapshotsEqual(previousEvent.snapshot, snapshot)) {
    return session;
  }

  return {
    ...session,
    workspaceEvents: [
      ...session.workspaceEvents,
      {
        timestamp: getRecordingTimestamp(session),
        snapshot,
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
