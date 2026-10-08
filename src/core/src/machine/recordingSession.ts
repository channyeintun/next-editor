import type {
  PreviewDomPatchBatch,
  PreviewEvent,
  PreviewInitialDocument,
  SlideEvent,
} from "../slides";
import type { WhiteboardEvent } from "../whiteboard";
import type { RuntimeRecordingSnapshot } from "../runtime";
import type { ChatRecordingEvent } from "../../../types/chat";
import {
  areWorkspaceSnapshotsEqual,
  toWorkspaceDeltaSnapshot,
  type WorkspaceRecordingSnapshot,
  type WorkspaceWidthDeltas,
} from "../../../types/workspace";
import {
  areRuntimeRecordingSnapshotsEqual,
  createRuntimeRecordingEvent,
  resolveLatestRuntimeSnapshot,
  RUNTIME_CHECKPOINT_RESET,
} from "../runtimeTrack";
import type { PreviewRecordedEvent } from "../slides";
import type { RecordingSession } from "./types";
import {
  hasRecordingClockExclusions,
  readRecordingClock,
  recordingTimeAtPerf,
  toRecordingWallTime,
} from "./recordingClock";

/** Recorded time now: the take's clock, which stands still while it is paused. */
export function getRecordingTimestamp(session: RecordingSession): number {
  return readRecordingClock(session.clock, session.startedAtPerf);
}

/**
 * Where on the take's recorded time a recorder that began at `startedAtPerf` started, or
 * 0 outside a take. A recorder that started during a pause starts where the take resumes.
 */
export function getRecorderStartOffsetMs(
  session: RecordingSession | null,
  startedAtPerf: number,
): number {
  return session ? recordingTimeAtPerf(session.clock, session.startedAtPerf, startedAtPerf) : 0;
}

/**
 * rrweb stamps preview events with the page's `Date.now()`, and replay places
 * them by one constant offset from those stamps. Taking the pauses out of the
 * stamps here keeps that offset constant across a pause; without it everything
 * recorded before the pause would replay early by the pause's length.
 */
function withRecordingWallEvents<T extends { events?: PreviewRecordedEvent[] }>(
  session: RecordingSession,
  segment: T,
): T {
  const events = segment.events;
  if (!events?.length || !hasRecordingClockExclusions(session.clock)) return segment;
  return {
    ...segment,
    events: events.map((event) => ({
      ...event,
      timestamp: toRecordingWallTime(session.clock, event.timestamp),
    })),
  };
}

/**
 * All appenders below mutate `session`'s arrays in place — see the invariant documented
 * on {@link RecordingSession} — and return whether they appended anything. Callers bump
 * `sessionRevision` only then, so the mutation is still visible to reference-equality
 * selectors. The appenders without a dedupe always append and always return `true`.
 */

export function appendSlideRecordingEvent(session: RecordingSession, event: SlideEvent): boolean {
  session.slideEvents.push({
    ...event,
    timestamp: getRecordingTimestamp(session),
  });
  return true;
}

export function appendWhiteboardRecordingEvent(
  session: RecordingSession,
  event: WhiteboardEvent,
): boolean {
  session.whiteboardEvents.push({
    ...event,
    timestamp: getRecordingTimestamp(session),
  });
  return true;
}

export function appendPreviewRecordingEvent(
  session: RecordingSession,
  event: PreviewEvent,
): boolean {
  session.previewEvents.push({
    ...event,
    timestamp: getRecordingTimestamp(session),
  });
  return true;
}

/** The oldest raw stamp among a segment's events. */
function earliestEventStamp(events: PreviewRecordedEvent[] | undefined): number | undefined {
  if (!events?.length) return undefined;
  let earliest = events[0].timestamp;
  for (const event of events) earliest = Math.min(earliest, event.timestamp);
  return earliest;
}

/**
 * Re-bases the preview stream after a retake: patch batches are dropped until the
 * preview's next full snapshot arrives.
 */
export function restartPreviewStream(session: RecordingSession): void {
  session.previewAwaitingCheckpoint = true;
  session.previewCheckpointWall = undefined;
}

export function appendPreviewInitialDocument(
  session: RecordingSession,
  document: PreviewInitialDocument,
): boolean {
  // After a retake, the first full document re-bases the preview stream.
  if (session.previewAwaitingCheckpoint) {
    session.previewAwaitingCheckpoint = false;
    session.previewCheckpointWall = earliestEventStamp(document.events);
  }
  session.previewInitialDocuments.push({
    ...withRecordingWallEvents(session, document),
    time: getRecordingTimestamp(session),
  });
  return true;
}

/**
 * Returns `false` when the batch was dropped. After a retake, patches describe the
 * document the take discarded until the preview's fresh full snapshot arrives, and
 * events queued before that snapshot trail in after it; both are dropped.
 */
export function appendPreviewPatchBatch(
  session: RecordingSession,
  batch: PreviewDomPatchBatch,
): boolean {
  if (session.previewAwaitingCheckpoint) return false;

  let segment = batch;
  const checkpointWall = session.previewCheckpointWall;
  if (checkpointWall !== undefined && batch.events?.length) {
    const events = batch.events.filter((event) => event.timestamp >= checkpointWall);
    if (events.length === 0) return false;
    if (events.length !== batch.events.length) segment = { ...batch, events };
  }

  session.previewPatchBatches.push({
    ...withRecordingWallEvents(session, segment),
    time: getRecordingTimestamp(session),
  });
  return true;
}

function isNonZeroWidthDelta(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value !== 0;
}

/**
 * Returns `false` when the snapshot deduplicates against the last recorded event (no
 * push happened) so callers know whether to bump `sessionRevision`. A snapshot that
 * carries a non-zero panel width delta is always recorded. It pushes in place, so
 * `session` and its `workspaceEvents` array keep their identity (only a retake replaces
 * the array, see {@link RecordingSession}).
 */
export function appendWorkspaceRecordingEvent(
  session: RecordingSession,
  snapshot: WorkspaceRecordingSnapshot,
  deltas?: WorkspaceWidthDeltas,
): boolean {
  const recordingSnapshot = deltas ? toWorkspaceDeltaSnapshot(snapshot, deltas) : snapshot;
  const previousEvent = session.workspaceEvents[session.workspaceEvents.length - 1];
  // Width fields are relative offsets that replay sums, so two equal consecutive
  // resizes (a steady drag, repeated keyboard steps) are two real moves, not a
  // duplicate. Only delta-free repeats dedupe.
  const carriesWidthDelta =
    isNonZeroWidthDelta(recordingSnapshot.sidebarWidthDelta) ||
    isNonZeroWidthDelta(recordingSnapshot.previewDockWidthDelta);

  if (
    !carriesWidthDelta &&
    previousEvent &&
    areWorkspaceSnapshotsEqual(previousEvent.snapshot, recordingSnapshot)
  ) {
    return false;
  }

  session.workspaceEvents.push({
    timestamp: getRecordingTimestamp(session),
    snapshot: recordingSnapshot,
  });
  return true;
}

/**
 * Records terminal output as a delta against the previous event (see runtimeTrack.ts).
 * Returns `false` when the snapshot deduplicates against the last recorded state (no
 * push happened) so callers know whether to bump `sessionRevision`.
 */
export function appendRuntimeRecordingEvent(
  session: RecordingSession,
  snapshot: RuntimeRecordingSnapshot,
): boolean {
  const previousSnapshot =
    session.lastRuntimeSnapshot ?? resolveLatestRuntimeSnapshot(session.runtimeEvents);

  if (previousSnapshot && areRuntimeRecordingSnapshotsEqual(previousSnapshot, snapshot)) {
    return false;
  }

  const { event, progress } = createRuntimeRecordingEvent(
    getRecordingTimestamp(session),
    previousSnapshot,
    snapshot,
    session.runtimeCheckpointProgress ?? RUNTIME_CHECKPOINT_RESET,
  );
  session.runtimeEvents.push(event);
  session.lastRuntimeSnapshot = snapshot;
  session.runtimeCheckpointProgress = progress;
  return true;
}

/**
 * Unlike the runtime/workspace appenders, chat deltas are each a real change and
 * are never deduplicated — except idempotent repeats of `status` and `draft`.
 * The latter can happen around component lifecycle boundaries.
 */
export function appendChatDelta(
  session: RecordingSession,
  event: ChatRecordingEvent["event"],
): boolean {
  const previousEvent = session.chatEvents[session.chatEvents.length - 1]?.event;

  if (
    previousEvent &&
    ((previousEvent.k === "status" &&
      event.k === "status" &&
      previousEvent.status === event.status) ||
      (previousEvent.k === "draft" && event.k === "draft" && previousEvent.text === event.text))
  ) {
    return false;
  }

  session.chatEvents.push({
    timestamp: getRecordingTimestamp(session),
    event,
  });
  return true;
}
