import type { EditorFrame } from "../types";
import type { WorkspaceRecordingSnapshot } from "../workspace";
import {
  applyWhiteboardEvent,
  EMPTY_WHITEBOARD_SCENE,
  type WhiteboardSceneState,
} from "../whiteboard";
import { reconstructFrameAtIndex } from "../utils/frameDelta";
import { resumeFrameStreamEncoder } from "../utils/frameStreamEncoder";
import { addMediaCut, totalMediaSpanLength } from "../utils/mediaSpans";
import { RUNTIME_CHECKPOINT_DUE, resolveLatestRuntimeSnapshot } from "../runtimeTrack";
import {
  appendChatDelta,
  appendRuntimeRecordingEvent,
  getRecordingTimestamp,
  restartPreviewStream,
} from "./recordingSession";
import { rewindRecordingClock } from "./recordingClock";
import { resolveWorkspaceSnapshotBetween } from "./replayState";
import { RECORDING_TRACK_TIME, type RecordingTracks } from "./recordingAssembly";
import {
  getRunningRecorders,
  PAUSE_RECORDER_SENDS,
  sendToRunningRecorders,
  type RecorderSendEnqueue,
} from "./runningRecorders";
import type { EditorActionArgs, EditorMachineContext, RecordingSession } from "./types";

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
 * A moment a take can be rewound to: its start, and each resume. `perf` and `wall` are
 * the clock readings there, so rewinding can put the take's clock back; `mediaTime` is
 * where the recorders' own files were then (recorded time plus what earlier retakes
 * discarded).
 */
export interface RecordingSafePoint {
  recordingTime: number;
  perf: number;
  wall: number;
  mediaTime: number;
}

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

/** Where a retake of `session` would rewind to at this moment of its recording. */
export function findRetakeTargetNow(session: RecordingSession): RecordingSafePoint | null {
  return findRetakeTarget(session.safePoints, getRecordingTimestamp(session));
}

/**
 * Adds a safe point. One at the same recorded time as the last replaces it: after a
 * retake the take resumes at the moment it rewound to, and the resumed anchor (its
 * clock readings, its media time past the discarded stretch) is the one to rewind to.
 */
function withSafePoint(
  safePoints: readonly RecordingSafePoint[],
  point: RecordingSafePoint,
): RecordingSafePoint[] {
  const last = safePoints[safePoints.length - 1];
  return last && last.recordingTime === point.recordingTime
    ? [...safePoints.slice(0, -1), point]
    : [...safePoints, point];
}

/**
 * Where the recorders' files stand at recorded time `recordingTime`: past every stretch
 * retakes discarded.
 */
function mediaTimeAt(session: RecordingSession, recordingTime: number): number {
  return recordingTime + totalMediaSpanLength(session.mediaCuts);
}

/** Marks `recordingTime`, read at clock readings `at`, as a moment a retake can rewind to. */
export function addSafePoint(
  session: RecordingSession,
  recordingTime: number,
  at: { perf: number; wall: number },
): void {
  session.safePoints = withSafePoint(session.safePoints, {
    recordingTime,
    perf: at.perf,
    wall: at.wall,
    mediaTime: mediaTimeAt(session, recordingTime),
  });
}

/** The entries recorded at or before `time`: a new array, since tracks are append-only. */
function keptUntil<T>(entries: readonly T[], time: number, timeOf: (entry: T) => number): T[] {
  let end = entries.length;
  while (end > 0 && timeOf(entries[end - 1]) > time) end--;
  return entries.slice(0, end);
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
  const mediaNow = mediaTimeAt(session, getRecordingTimestamp(session));
  session.mediaCuts = addMediaCut(session.mediaCuts, { start: target.mediaTime, end: mediaNow });
  session.clock = rewindRecordingClock(session.clock, target.perf, target.wall);
  session.safePoints = session.safePoints.filter((point) => point.recordingTime <= time);
  session.chapters = session.chapters.filter((chapter) => chapter.time <= time);

  const originalWorkspace = session.workspaceEvents;
  const whiteboardChanged = session.whiteboardEvents.some((event) => event.timestamp > time);
  const runtimeChanged = session.runtimeEvents.some((event) => event.timestamp > time);
  const chatChanged = session.chatEvents.some((event) => event.timestamp > time);
  const previewStreamed =
    session.previewInitialDocuments.length > 0 || session.previewPatchBatches.length > 0;

  // RecordingSession declares its tracks through RecordingTracks, so a track left out
  // here fails the typecheck instead of keeping what was recorded after the safe point.
  const trackTime = RECORDING_TRACK_TIME;
  const kept: RecordingTracks = {
    frames: keptUntil(session.frames, time, trackTime.frames),
    slideEvents: keptUntil(session.slideEvents, time, trackTime.slideEvents),
    previewEvents: keptUntil(session.previewEvents, time, trackTime.previewEvents),
    previewInitialDocuments: keptUntil(
      session.previewInitialDocuments,
      time,
      trackTime.previewInitialDocuments,
    ),
    previewPatchBatches: keptUntil(
      session.previewPatchBatches,
      time,
      trackTime.previewPatchBatches,
    ),
    workspaceEvents: keptUntil(session.workspaceEvents, time, trackTime.workspaceEvents),
    runtimeEvents: keptUntil(session.runtimeEvents, time, trackTime.runtimeEvents),
    cursorEvents: keptUntil(session.cursorEvents, time, trackTime.cursorEvents),
    whiteboardEvents: keptUntil(session.whiteboardEvents, time, trackTime.whiteboardEvents),
    chatEvents: keptUntil(session.chatEvents, time, trackTime.chatEvents),
  };
  Object.assign(session, kept);

  // The workspace at the safe point, read off the uncut track: the discarded resizes are
  // undone the way a backward seek undoes them.
  const keptWorkspaceCount = kept.workspaceEvents.length;
  const workspace =
    keptWorkspaceCount > 0 && keptWorkspaceCount < originalWorkspace.length
      ? resolveWorkspaceSnapshotBetween(
          originalWorkspace,
          keptWorkspaceCount - 1,
          originalWorkspace.length - 1,
        )
      : undefined;

  // The next frame is diffed against the last kept one, as if nothing came after it.
  const frame =
    session.frames.length > 0
      ? reconstructFrameAtIndex(session.frames, session.frames.length - 1)
      : null;
  session.encoder = resumeFrameStreamEncoder(session.frames, frame);
  // Nothing captured since the safe point may be reused for the next frame.
  session.lastCapturedViewStateRef = undefined;
  session.lastCapturedContent = undefined;

  // The live terminal cannot be rewound, so its next state is recorded whole: a
  // checkpoint, not a delta against output the take no longer has.
  session.lastRuntimeSnapshot = resolveLatestRuntimeSnapshot(session.runtimeEvents) ?? undefined;
  session.runtimeCheckpointProgress = RUNTIME_CHECKPOINT_DUE;

  if (previewStreamed) restartPreviewStream(session);

  return {
    frame,
    workspace,
    whiteboard: whiteboardChanged
      ? session.whiteboardEvents.reduce(applyWhiteboardEvent, EMPTY_WHITEBOARD_SCENE)
      : undefined,
    runtimeChanged,
    chatChanged,
    previewStreamed,
  };
}

/**
 * The subset of xstate's `enqueue` object a retake uses: the recorder sends, the assign
 * that publishes the rewound session, and a plain action that restores the editor. Kept
 * structural, like RecorderSendEnqueue, so the body doesn't need to thread the
 * machine's full setup() type parameters.
 */
export interface RetakeEnqueue extends RecorderSendEnqueue {
  (action: () => void): void;
  assign: (updater: Partial<EditorMachineContext>) => void;
}

/**
 * The RETAKE_RECORDING action: rewinds the take to its last safe point, holds the
 * recorders still there, records what cannot be rewound whole, and puts the editor back.
 * editorMachine.ts wraps it as `enqueueActions(retakeRecording)`.
 */
export const retakeRecording = ({
  context,
  enqueue,
}: EditorActionArgs & { enqueue: RetakeEnqueue }): void => {
  const session = context.session;
  if (!session) return;
  const target = findRetakeTargetNow(session);
  if (!target) return;
  const restore = rewindSessionToSafePoint(session, target);

  // The recorders hold still until the take resumes; the stretch they recorded since
  // the safe point is in the session's media cuts. A selected narration file is an
  // input, so it is rewound to be performed over again.
  sendToRunningRecorders(getRunningRecorders(context), enqueue, {
    ...PAUSE_RECORDER_SENDS,
    externalAudio: [{ type: "PAUSE" }, { type: "SEEK", timeMs: target.recordingTime }],
  });

  // The live terminal and agent conversation cannot be rewound. What they show now is
  // recorded whole at the safe point, so what follows is recorded against it.
  if (restore.runtimeChanged) {
    const runtime = context.getRuntimeSnapshot?.();
    if (runtime) appendRuntimeRecordingEvent(session, runtime);
  }
  if (restore.chatChanged) {
    const checkpoint = context.getChatCheckpoint?.();
    if (checkpoint) appendChatDelta(session, { k: "checkpoint", state: checkpoint });
  }

  // The session changed in place. A retake from `paused` lands in `paused` again, a
  // transition that changes no state, so this assign is what publishes a new snapshot
  // for the selectors that read the rewound clock, safe points and chapters.
  enqueue.assign({ session });

  // Put the editor back the way it was at the safe point. These write to the app's
  // stores, whose own capture records any remaining difference at that moment.
  enqueue(() => {
    if (restore.workspace) context.applyWorkspaceSnapshot?.(restore.workspace);
    if (restore.whiteboard) context.applyWhiteboardState?.(restore.whiteboard);
    const state = restore.frame?.state;
    if (state?.slideState) {
      context.applySlideState?.(state.slideState, state.currentSlideIndex ?? 0);
    }
    if (state?.previewState) context.applyPreviewState?.(state.previewState);
    if (restore.previewStreamed) context.requestPreviewCheckpoint?.();
  });
};
