import type { EditorFrame } from "../types";
import type { WorkspaceRecordingSnapshot } from "../../../types/workspace";
import {
  applyWhiteboardEvent,
  EMPTY_WHITEBOARD_SCENE,
  type WhiteboardSceneState,
} from "../whiteboard";
import { isKeyframe, reconstructFrameAtIndex } from "../utils/frameDelta";
import { addMediaCut, totalMediaSpanLength } from "../utils/mediaSpans";
import { RUNTIME_CHECKPOINT_MAX_EVENTS, resolveLatestRuntimeSnapshot } from "../runtimeTrack";
import { getRecordingTimestamp } from "./recordingSession";
import { rewindRecordingClock } from "./recordingClock";
import type { RecordingTracks } from "./recordingAssembly";
import type { RecordingSafePoint, RecordingSession } from "./types";

// ============================================================================
// Retakes: rewinding a take to its last safe point.
//
// Only the take's tail is ever discarded, so nothing recorded before the safe
// point depends on anything that goes: every track is cut back to the entries
// recorded at or before it, and the take carries on from there. What cannot be
// cut back in place is handled around the cut: the recorders keep their files
// (the discarded stretch is recorded in `mediaCuts`), the live editor is put
// back from the kept tracks, and the preview's rrweb stream is re-based on a
// fresh full snapshot.
// ============================================================================

/**
 * Where a retake from now would rewind to: the last safe point before now. Retaking
 * again from there goes one safe point further back.
 */
export function findRetakeTarget(
  safePoints: readonly RecordingSafePoint[],
  recordingTime: number,
): RecordingSafePoint | null {
  for (let index = safePoints.length - 1; index >= 0; index--) {
    if (safePoints[index].recordingTime < recordingTime) return safePoints[index];
  }
  return null;
}

/**
 * Adds a safe point. One at the same recorded time as the last replaces it: after a
 * retake the take resumes at the moment it rewound to, and the resumed anchor (its
 * clock readings, its media time past the discarded stretch) is the one to rewind to.
 */
export function withSafePoint(
  safePoints: readonly RecordingSafePoint[],
  point: RecordingSafePoint,
): RecordingSafePoint[] {
  const last = safePoints[safePoints.length - 1];
  return last && last.recordingTime === point.recordingTime
    ? [...safePoints.slice(0, -1), point]
    : [...safePoints, point];
}

/** The entries recorded at or before `time`: a new array, since tracks are append-only. */
function keptUntil<T>(entries: readonly T[], time: number, timeOf: (entry: T) => number): T[] {
  let end = entries.length;
  while (end > 0 && timeOf(entries[end - 1]) > time) end--;
  return entries.slice(0, end);
}

const byTimestamp = (entry: { timestamp: number }) => entry.timestamp;
const byTime = (entry: { time: number }) => entry.time;

/** Deltas stored after the last keyframe: the encoder's keyframe cadence picks up from there. */
function framesSinceLastKeyframe(frames: RecordingSession["frames"]): number {
  let count = 0;
  for (let index = frames.length - 1; index >= 0; index--) {
    if (isKeyframe(frames[index])) return count;
    count++;
  }
  return count;
}

/** What the live editor has to be put back to after a rewind. */
export interface RetakeRestore {
  /** The editor state at the safe point: the last kept frame. */
  frame: EditorFrame | null;
  /**
   * The workspace at the safe point, when the discarded stretch changed it. Its panel
   * offsets undo the resizes that were discarded, the way a backward seek does.
   */
  workspace?: WorkspaceRecordingSnapshot;
  /** The whiteboard at the safe point, when the discarded stretch changed it. */
  whiteboard?: WhiteboardSceneState;
  /** The discarded stretch recorded runtime output the live terminal still shows. */
  runtimeChanged: boolean;
  /** The discarded stretch recorded coding-agent chat the live conversation still holds. */
  chatChanged: boolean;
  /** The take records a live preview, whose stream must be re-based on a fresh snapshot. */
  previewStreamed: boolean;
}

/**
 * Rewinds `session` in place to `target`: its tracks are cut back to the entries
 * recorded at or before it, its clock is put back there and held paused, and the
 * stretch the recorders captured since is added to `mediaCuts`.
 */
export function rewindSessionToSafePoint(
  session: RecordingSession,
  target: RecordingSafePoint,
): RetakeRestore {
  const time = target.recordingTime;

  // The recorders ran (paused or not) the whole time, so their files hold the
  // discarded stretch: from where they were at the safe point to where they are now.
  const mediaNow = getRecordingTimestamp(session) + totalMediaSpanLength(session.mediaCuts);
  session.mediaCuts = addMediaCut(session.mediaCuts, { start: target.mediaTime, end: mediaNow });
  session.clock = rewindRecordingClock(session.clock, target.perf, target.wall);
  session.safePoints = session.safePoints.filter((point) => point.recordingTime <= time);
  session.chapters = session.chapters.filter((chapter) => chapter.time <= time);

  const droppedWorkspace = session.workspaceEvents.slice(
    keptUntil(session.workspaceEvents, time, byTimestamp).length,
  );
  const whiteboardChanged = session.whiteboardEvents.some((event) => event.timestamp > time);
  const runtimeChanged = session.runtimeEvents.some((event) => event.timestamp > time);
  const chatChanged = session.chatEvents.some((event) => event.timestamp > time);
  const previewStreamed =
    session.previewInitialDocuments.length > 0 || session.previewPatchBatches.length > 0;

  // Typed as every track, so a track left out here fails the typecheck instead of
  // keeping what was recorded after the safe point.
  const kept: RecordingTracks = {
    frames: keptUntil(session.frames, time, byTimestamp),
    slideEvents: keptUntil(session.slideEvents, time, byTimestamp),
    previewEvents: keptUntil(session.previewEvents, time, byTimestamp),
    previewInitialDocuments: keptUntil(session.previewInitialDocuments, time, byTime),
    previewPatchBatches: keptUntil(session.previewPatchBatches, time, byTime),
    workspaceEvents: keptUntil(session.workspaceEvents, time, byTimestamp),
    runtimeEvents: keptUntil(session.runtimeEvents, time, byTimestamp),
    cursorEvents: keptUntil(session.cursorEvents, time, byTimestamp),
    whiteboardEvents: keptUntil(session.whiteboardEvents, time, byTimestamp),
    chatEvents: keptUntil(session.chatEvents, time, byTimestamp),
  };
  Object.assign(session, kept);

  // The next frame is diffed against the last kept one, as if nothing came after it.
  const frame =
    session.frames.length > 0
      ? reconstructFrameAtIndex(session.frames, session.frames.length - 1)
      : null;
  session.encoder = {
    framesSinceKeyframe: framesSinceLastKeyframe(session.frames),
    lastStoredFrame: frame,
    lastFullFrame: frame,
  };
  // Nothing captured since the safe point may be reused for the next frame.
  session.lastCapturedViewStateRef = undefined;

  // The live terminal cannot be rewound, so its next state is recorded whole: a
  // checkpoint, not a delta against output the take no longer has.
  session.lastRuntimeSnapshot = resolveLatestRuntimeSnapshot(session.runtimeEvents) ?? undefined;
  session.runtimeCheckpointProgress = {
    events: RUNTIME_CHECKPOINT_MAX_EVENTS - 1,
    appendedChars: 0,
  };

  if (previewStreamed) {
    session.previewAwaitingCheckpoint = true;
    session.previewCheckpointWall = undefined;
  }

  return {
    frame,
    workspace:
      droppedWorkspace.length > 0 ? restoredWorkspace(session, droppedWorkspace) : undefined,
    whiteboard: whiteboardChanged
      ? session.whiteboardEvents.reduce(applyWhiteboardEvent, EMPTY_WHITEBOARD_SCENE)
      : undefined,
    runtimeChanged,
    chatChanged,
    previewStreamed,
  };
}

function restoredWorkspace(
  session: RecordingSession,
  dropped: RecordingSession["workspaceEvents"],
): WorkspaceRecordingSnapshot | undefined {
  const last = session.workspaceEvents[session.workspaceEvents.length - 1];
  if (!last) return undefined;

  // Panel widths are recorded as moves, so the discarded moves are undone.
  let sidebar = 0;
  let dock = 0;
  for (const event of dropped) {
    sidebar += event.snapshot.sidebarWidthDelta ?? 0;
    dock += event.snapshot.previewDockWidthDelta ?? 0;
  }
  const {
    sidebarWidthDelta: _sidebarWidthDelta,
    previewDockWidthDelta: _previewDockWidthDelta,
    ...snapshot
  } = last.snapshot;
  return {
    ...snapshot,
    ...(sidebar !== 0 ? { sidebarWidthDelta: -sidebar } : {}),
    ...(dock !== 0 ? { previewDockWidthDelta: -dock } : {}),
  };
}
