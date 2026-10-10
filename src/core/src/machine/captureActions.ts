import type { PreviewEvent } from "../preview";
import type { SlideEvent } from "../slides";
import type {
  EditorActionArgs,
  EditorContextUpdate,
  EditorMachineContext,
  RecordingSession,
} from "./types";
import { createIdleAudioState } from "./audioCaptureActions";
import { createIdleCameraState } from "./cameraCaptureActions";
import type { MouseCursorPosition } from "../types";
import type { RuntimeRecordingEvent } from "../runtime";
import type { WhiteboardEvent } from "../whiteboard";
import { toSidebarWidthDeltaSnapshot, type WorkspaceRecordingEvent } from "../workspace";
import { createFrameStreamEncoder } from "../utils/frameStreamEncoder";
import {
  appendChatDelta,
  appendCursorEvent,
  appendPreviewInitialDocument,
  appendPreviewPatchBatch,
  appendPreviewRecordingEvent,
  appendRuntimeRecordingEvent,
  appendSlideRecordingEvent,
  appendWhiteboardRecordingEvent,
  appendWorkspaceRecordingEvent,
  getRecordingTimestamp,
} from "./recordingSession";
import {
  createRecordingClock,
  isRecordingClockPaused,
  pauseRecordingClock,
  resumeRecordingClock,
} from "./recordingClock";
import { addSafePoint } from "./retake";
import { chapterTitle } from "../utils/chapters";
import { markFramesNormalized } from "../utils/editorState";
import { assembleRecording } from "./recordingAssembly";
import { getRunningRecorders } from "./runningRecorders";

// ============================================================================
// Recording-capture action bodies
//
// Plain functions with the exact shape XState's `assign`/`enqueueActions`
// callbacks expect, specific to the recording/capture side (the
// recording-state tracks, session lifecycle, session finalize). Editor frame
// and cursor capture live in frameCapture.ts, the microphone and narration
// file in audioCaptureActions.ts, the camera in cameraCaptureActions.ts, and
// the local screen recorder in screenCaptureActions.ts. editorMachine.ts wires each of these
// into `actions: {}` via `assign(fn)` / `enqueueActions(fn)` — kept there
// (rather than wrapped here) so XState's `setup()` can still infer the
// machine's exact context/event/actor types for the wrapped action, which
// isn't independently nameable outside `setup()`. The bodies that return
// void only mutate the session in place and are registered as plain actions.
// ============================================================================

export const initRecordingSession = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  const startedAt =
    event.type === "AUDIO_RECORDING_STARTED" && Number.isFinite(event.startedAtMs)
      ? event.startedAtMs
      : Date.now();
  const startedAtPerf =
    event.type === "AUDIO_RECORDING_STARTED" && Number.isFinite(event.startedAtPerf)
      ? event.startedAtPerf
      : performance.now();
  const slideEvents: SlideEvent[] = [];
  const previewEvents: PreviewEvent[] = [];
  const workspaceEvents: WorkspaceRecordingEvent[] = [];
  const runtimeEvents: RuntimeRecordingEvent[] = [];
  const whiteboardEvents: WhiteboardEvent[] = [];
  const initialMousePosition: MouseCursorPosition = { x: 0, y: 0, visible: false };

  // Capture initial slide state if open
  const initialSlideState = context.getSlideState?.();
  if (initialSlideState?.previewState?.isOpen) {
    slideEvents.push({
      type: "slide_open",
      timestamp: 0,
      slideId: initialSlideState.previewState.currentSlideId || undefined,
      isMaximized: initialSlideState.previewState.isMaximized,
      indexv: initialSlideState.previewState.indexv,
    });
  }

  // Capture initial preview state
  const initialPreviewState = context.getPreviewState?.();
  if (initialPreviewState) {
    previewEvents.push({
      type: "preview_open",
      timestamp: 0,
      size: initialPreviewState.size,
      isOpen: initialPreviewState.isOpen,
      mode: initialPreviewState.mode,
      content: initialPreviewState.content,
      route: initialPreviewState.route,
      scrollTop: initialPreviewState.scrollTop,
      scrollLeft: initialPreviewState.scrollLeft,
    });
  }

  const initialWorkspaceSnapshot = context.getWorkspaceSnapshot?.();
  if (initialWorkspaceSnapshot) {
    workspaceEvents.push({
      timestamp: 0,
      snapshot: toSidebarWidthDeltaSnapshot(initialWorkspaceSnapshot, 0),
    });
  }

  const initialRuntimeSnapshot = context.getRuntimeSnapshot?.();
  if (initialRuntimeSnapshot) {
    runtimeEvents.push({
      timestamp: 0,
      snapshot: initialRuntimeSnapshot,
    });
  }

  // Capture initial whiteboard state if the board already has content (the presenter
  // opened the panel and started drawing before hitting record).
  const initialWhiteboardState = context.getWhiteboardState?.();
  if (initialWhiteboardState?.isOpen || initialWhiteboardState?.elements.length) {
    whiteboardEvents.push({
      timestamp: 0,
      upserts: initialWhiteboardState.elements,
      view: initialWhiteboardState.view,
      isOpen: initialWhiteboardState.isOpen,
      isMaximized: initialWhiteboardState.isMaximized,
    });
  }

  return {
    session: {
      startedAt,
      startedAtPerf,
      clock: createRecordingClock(),
      // The take's start is the first moment a retake can rewind to.
      safePoints: [{ recordingTime: 0, perf: startedAtPerf, wall: startedAt, mediaTime: 0 }],
      mediaCuts: [],
      chapters: [],
      frames: [],
      encoder: createFrameStreamEncoder(),
      slideEvents,
      previewEvents,
      previewInitialDocuments: [],
      previewPatchBatches: [],
      workspaceEvents,
      runtimeEvents,
      lastRuntimeSnapshot: initialRuntimeSnapshot ?? undefined,
      whiteboardEvents,
      chatEvents: [],
      cursorEvents: [{ timestamp: 0, ...initialMousePosition }],
      lastMousePosition: initialMousePosition,
    },
  };
};

/**
 * Runs `append` on the take's session, if there is one. Appenders mutate the session's
 * arrays in place by design (see the invariant on {@link RecordingSession}), so the
 * recording-state event handlers below are plain actions: nothing in the context is
 * replaced.
 */
const withSession = (
  context: EditorMachineContext,
  append: (session: RecordingSession) => void,
): void => {
  if (context.session) append(context.session);
};

export const captureSlideEvent = ({ context, event }: EditorActionArgs): void => {
  if (event.type !== "SLIDE_EVENT") return;
  withSession(context, (session) => appendSlideRecordingEvent(session, event.event));
};

export const capturePreviewEvent = ({ context, event }: EditorActionArgs): void => {
  if (event.type !== "PREVIEW_EVENT") return;
  withSession(context, (session) => appendPreviewRecordingEvent(session, event.event));
};

export const capturePreviewInitialDocument = ({ context, event }: EditorActionArgs): void => {
  if (event.type !== "PREVIEW_INITIAL_DOCUMENT") return;
  withSession(context, (session) => appendPreviewInitialDocument(session, event.document));
};

export const capturePreviewPatchBatch = ({ context, event }: EditorActionArgs): void => {
  if (event.type !== "PREVIEW_PATCH_BATCH") return;
  withSession(context, (session) => appendPreviewPatchBatch(session, event.batch));
};

export const captureWorkspaceEvent = ({ context, event }: EditorActionArgs): void => {
  if (event.type !== "WORKSPACE_EVENT") return;
  const snapshot = context.getWorkspaceSnapshot?.();
  if (!snapshot) return;
  withSession(context, (session) =>
    appendWorkspaceRecordingEvent(session, snapshot, {
      sidebarWidthDelta: event.sidebarWidthDelta,
      previewDockWidthDelta: event.previewDockWidthDelta,
    }),
  );
};

export const captureRuntimeEvent = ({ context }: EditorActionArgs): void => {
  const snapshot = context.getRuntimeSnapshot?.();
  if (!snapshot) return;
  withSession(context, (session) => appendRuntimeRecordingEvent(session, snapshot));
};

export const captureChatEvent = ({ context, event }: EditorActionArgs): void => {
  if (event.type !== "CHAT_EVENT") return;
  withSession(context, (session) => appendChatDelta(session, event.event));
};

export const captureWhiteboardEvent = ({ context, event }: EditorActionArgs): void => {
  if (event.type !== "WHITEBOARD_EVENT") return;
  withSession(context, (session) => appendWhiteboardRecordingEvent(session, event.event));
};

/**
 * Stops the take's clock. Its recorders are paused by the machine alongside. A plain
 * action: the transition into `paused` publishes the snapshot that carries the new clock.
 */
export const pauseRecordingSession = ({ context }: EditorActionArgs): void => {
  const session = context.session;
  if (!session || isRecordingClockPaused(session.clock)) return;
  session.clock = pauseRecordingClock(session.clock, performance.now(), Date.now());
};

/**
 * Runs the take's clock again. The pointer was followed but not recorded while paused,
 * so the resumed stretch starts with a sample of where it is now. The moment it resumes
 * is where a later retake can rewind to. A plain action, like pauseRecordingSession: the
 * transition into `running` publishes the new snapshot.
 */
export const resumeRecordingSession = ({ context }: EditorActionArgs): void => {
  const session = context.session;
  if (!session || !isRecordingClockPaused(session.clock)) return;
  const perf = performance.now();
  const wall = Date.now();
  session.clock = resumeRecordingClock(session.clock, perf, wall);
  const recordingTime = getRecordingTimestamp(session);
  addSafePoint(session, recordingTime, { perf, wall });
  appendCursorEvent(session.cursorEvents, recordingTime, session.lastMousePosition);
};

/**
 * Marks a chapter at the take's current moment. A chapter is where the author is happy
 * with the take so far, so it is also a safe point a retake can rewind to.
 *
 * It stays an assign: ADD_CHAPTER_MARKER changes no state, so only a new context makes
 * a new snapshot, and the selectors that read `chapters` and `safePoints` (memoized on
 * the snapshot object) would otherwise not see the new chapter.
 */
export const addChapterMarker = ({ context, event }: EditorActionArgs): EditorContextUpdate => {
  const session = context.session;
  if (!session || event.type !== "ADD_CHAPTER_MARKER") return {};
  const recordingTime = getRecordingTimestamp(session);
  const last = session.chapters[session.chapters.length - 1];
  // One chapter per moment: a second press where the take stands still adds nothing.
  if (last && last.time === recordingTime) return {};

  session.chapters = [
    ...session.chapters,
    { time: recordingTime, title: chapterTitle(event.title, session.chapters.length) },
  ];
  // While paused, the clock stands at the moment the pause began: that is the anchor.
  const at = session.clock.pausedAt ?? { perf: performance.now(), wall: Date.now() };
  addSafePoint(session, recordingTime, at);
  return { session };
};

export const finalizeRecording = ({ context }: EditorActionArgs): EditorContextUpdate => {
  if (!context.session) return { recording: null };

  // Recorded time, so a take stopped while paused ends where it paused.
  const elapsedMs = Math.max(getRecordingTimestamp(context.session), 1);
  const externalDurationMs = context.audio.externalDurationMs;
  // A selected-file take never outlives its narration: AUDIO_PLAYBACK_FINISHED ends it,
  // directly or through stoppingRecording when the camera is on. On that second path the
  // finalizing event is CAMERA_STOPPED, CAMERA_ERROR or the 2s watchdog, so clamp to the
  // narration length whatever event lands here. Otherwise camera-stop latency becomes a
  // silent tail that `loadRecording` never trims, because it does not re-measure external
  // audio. An unknown length (none reported yet) leaves the wall clock in charge.
  const duration =
    context.audio.source === "external" &&
    typeof externalDurationMs === "number" &&
    Number.isFinite(externalDurationMs) &&
    externalDurationMs > 0
      ? Math.max(Math.min(elapsedMs, externalDurationMs), 1)
      : elapsedMs;
  const currentWorkspaceSnapshot = context.getWorkspaceSnapshot?.() || undefined;
  // Captured keyframes went through createKeyframe and every view state through createFrame,
  // so the take's frames are normalized already and loading it needs no second pass.
  markFramesNormalized(context.session.frames);
  const recording = assembleRecording({
    tracks: context.session,
    duration,
    slides: context.getSlides?.(),
    workspaceSnapshot: currentWorkspaceSnapshot
      ? toSidebarWidthDeltaSnapshot(currentWorkspaceSnapshot, 0)
      : undefined,
    runtimeSnapshot: context.getRuntimeSnapshot?.() || undefined,
    audio: {
      blob: context.audio.blob || undefined,
      source: context.audio.source || undefined,
      mimeType: context.audio.mimeType,
      startOffsetMs: context.audio.startOffsetMs,
      // A microphone take's blob can still be on its way when the watchdog finalizes
      // (attachLateAudioBlob splices it in), so a running microphone recorder counts.
      pending: getRunningRecorders(context).microphone,
    },
    camera: {
      blob: context.camera.blob || undefined,
      source: context.camera.source || undefined,
      mimeType: context.camera.mimeType,
      startOffsetMs: context.camera.startOffsetMs,
    },
    mediaCuts: context.session.mediaCuts,
    chapters: context.session.chapters,
  });

  return {
    recording,
    session: null,
    // The recording above already holds everything it needs from the audio slice. Keeping
    // the blob here would pin the narration after UNLOAD and hand it to the next take that
    // records without audio. A mic blob that arrives after this point is re-added by
    // `attachLateAudioBlob`.
    audio: createIdleAudioState(),
    camera: createIdleCameraState(),
    timeline: {
      ...context.timeline,
      duration,
    },
    // Replay cursors are deliberately not reset here. Every path out of this
    // action targets `loading`, whose `setRecording` establishes all of them
    // (including the chat cursor, which this action never reset) against the
    // recording that is actually loaded. Resetting a subset here read as an
    // exhaustive list while being neither exhaustive nor load-bearing.
  };
};

export const notifyRecordingStart = ({ context }: EditorActionArgs): void => {
  context.onRecordingStart?.();
};

export const notifyRecordingStop = ({ context }: EditorActionArgs): void => {
  if (context.recording) {
    context.onRecordingStop?.(context.recording);
  }
};
