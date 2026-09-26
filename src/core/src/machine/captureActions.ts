import type { SlideEvent, PreviewEvent } from "../slides";
import {
  createIdleAudioState,
  createIdleCameraState,
  createIdleScreenState,
  type EditorMachineContext,
  type EditorMachineEvent,
  type RecordingSession,
} from "./types";
import type { EditorFrame, MouseCursorPosition } from "../types";
import type { RuntimeRecordingEvent } from "../../../types/runtime";
import type { WhiteboardEvent } from "../whiteboard";
import {
  toSidebarWidthDeltaSnapshot,
  type WorkspaceRecordingEvent,
} from "../../../types/workspace";
import { createContentEditDelta, type CreatedContentEditDelta } from "../utils/frameDelta";
import { createFrameStreamEncoder, pushFrame } from "../utils/frameStreamEncoder";
import {
  appendChatDelta,
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
  recordingTimeAtPerf,
  resumeRecordingClock,
} from "./recordingClock";
import { withSafePoint } from "./retake";
import { totalMediaSpanLength } from "../utils/mediaSpans";
import { defaultChapterTitle } from "../utils/chapters";
import {
  appendCursorEvent,
  createFrame,
  MOUSE_FRAME_INTERVAL_MS,
  type CapturedContentRef,
  type CapturedViewStateRef,
} from "./editorMachineHelpers";
import { normalizeNonNegativeTime } from "./playbackValues";
import { assembleRecording } from "./recordingAssembly";
import type { AudioPlaybackEvent, AudioPlaybackInput } from "./audioActor";

const SCREEN_RECORDER_ID_PREFIX = "screenRecorder-";

// ============================================================================
// Recording-capture action bodies
//
// Plain functions with the exact shape XState's `assign`/`enqueueActions`
// callbacks expect, specific to the recording/capture side (frame/cursor/
// audio/camera capture, session lifecycle, session finalize). editorMachine.ts
// wires each of these into `actions: {}` via `assign(fn)` / `enqueueActions(fn)`
// — kept there (rather than wrapped here) so XState's `setup()` can still infer
// the machine's exact context/event/actor types for the wrapped action, which
// isn't independently nameable outside `setup()`. Extracted purely so the
// machine file reads as wiring; zero behavior change.
// ============================================================================

/**
 * A selected narration file rides in on START_RECORDING. An empty file counts as none, so
 * that take records from the microphone (or silently) like a start without one.
 */
export const getExternalAudioBlob = (event: EditorMachineEvent): Blob | null =>
  event.type === "START_RECORDING" && event.audioBlob instanceof Blob && event.audioBlob.size > 0
    ? event.audioBlob
    : null;

// Capture reads the live editor: fall back to the input ref getter so a
// SET_EDITOR_REF event lost to a stopped-actor window (StrictMode/Suspense
// rehydration) cannot silently disable frame/cursor capture.
const getCaptureEditor = (context: EditorMachineContext) =>
  context.editorRefs.editor ?? context.getEditorInstance();

/**
 * The last captured content string paired with the model identity it was read at, for
 * `createFrame` to reuse by reference. `lastCapturedViewStateRef` holds that identity: it
 * comes from the same `createFrame` call that produced `currentFrame`.
 */
const getPreviousCapturedContent = (
  session: RecordingSession,
  currentFrame: EditorFrame | null,
): CapturedContentRef | undefined => {
  const viewStateRef = session.lastCapturedViewStateRef;
  return currentFrame && viewStateRef
    ? {
        value: currentFrame.state.content,
        versionId: viewStateRef.versionId,
        modelUri: viewStateRef.modelUri,
      }
    : undefined;
};

/** Encode a captured frame into the session (in place) and keep its view state for reuse. */
const commitCapturedFrame = (
  session: RecordingSession,
  frame: EditorFrame,
  viewStateRef: CapturedViewStateRef | undefined,
  contentEditDelta?: CreatedContentEditDelta,
): void => {
  const { state: encoder, emitted } = pushFrame(session.encoder, frame, contentEditDelta);
  if (emitted) {
    session.frames.push(emitted);
  }
  session.encoder = encoder;
  session.lastCapturedViewStateRef = viewStateRef;
};

/** The take's microphone, per take like the camera: a start that names none uses the default. */
export const setMicrophoneDevice = ({
  event,
}: {
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "START_RECORDING") return {};
  return { microphoneDeviceId: event.microphoneDeviceId ?? null };
};

export const setCameraRecordingEnabled = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "START_RECORDING") return {};
  // The choice is per take. Falling back to the previous take's value let one manual
  // camera take turn the camera on for every later start that does not say, such as a
  // studio render on the same page.
  return {
    enableCameraRecording: event.enableCamera ?? context.defaultEnableCameraRecording,
  };
};

export const prepareExternalAudioRecording = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  const audioBlob = getExternalAudioBlob(event);
  if (!audioBlob) return {};

  return {
    audio: {
      ...context.audio,
      blob: audioBlob,
      isRecording: true,
      mediaRecorder: null,
      mimeType: audioBlob.type || "audio/webm",
      source: "external" as const,
      externalDurationMs: null,
    },
  };
};

export interface RecordingAudioPlayerEnqueue {
  spawnChild: (
    src: "audioPlayback",
    options: { id: "recordingAudioPlayer"; input: AudioPlaybackInput },
  ) => void;
  sendTo: (actor: "recordingAudioPlayer", event: AudioPlaybackEvent) => void;
}

export const startExternalAudioPlayback = ({
  context,
  event,
  enqueue,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
  enqueue: RecordingAudioPlayerEnqueue;
}): void => {
  const audioBlob = getExternalAudioBlob(event);
  if (!audioBlob) return;

  enqueue.spawnChild("audioPlayback", {
    id: "recordingAudioPlayer",
    input: {
      blob: audioBlob,
      volume: context.timeline.volume,
      playbackRate: 1,
      startPositionMs: 0,
    },
  });
  enqueue.sendTo("recordingAudioPlayer", { type: "PLAY" });
};

export const storeExternalAudioDuration = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "AUDIO_PLAYBACK_READY" || context.audio.source !== "external") {
    return {};
  }

  // A zero or unknown length says nothing about the narration. Storing it would let it
  // overwrite a real length reported earlier, and finalize would measure the take by it.
  const externalDurationMs =
    Number.isFinite(event.duration) && event.duration > 0 ? event.duration : null;
  if (externalDurationMs === null) return {};

  return {
    audio: {
      ...context.audio,
      externalDurationMs,
    },
  };
};

export const stopExternalAudioRecording = ({
  context,
}: {
  context: EditorMachineContext;
}): Partial<EditorMachineContext> => {
  if (context.audio.source !== "external") return {};
  return {
    audio: {
      ...context.audio,
      isRecording: false,
    },
  };
};

export const resetAudioAfterRecorderStop = ({
  context,
}: {
  context: EditorMachineContext;
}): Partial<EditorMachineContext> => ({
  audio: {
    ...context.audio,
    isRecording: false,
    mediaRecorder: null,
    source: null,
    startOffsetMs: 0,
  },
});

export const initRecordingSession = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
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
    sessionRevision: 0,
  };
};

export const captureInitialFrame = ({
  context,
}: {
  context: EditorMachineContext;
}): Partial<EditorMachineContext> => {
  const session = context.session;
  if (!session) return {};

  const lastMousePosition = session.lastMousePosition;

  // Use createFrame for the initial frame to ensure it has all metadata
  const editor = getCaptureEditor(context);
  let initialFrame: EditorFrame;
  let viewStateRef: CapturedViewStateRef | undefined;

  if (editor) {
    ({ frame: initialFrame, viewStateRef } = createFrame(
      editor,
      0,
      lastMousePosition,
      context.getSlideState,
      context.getPreviewState,
    ));
  } else {
    initialFrame = {
      timestamp: 0,
      state: {
        content: "",
        selection: {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 1,
          selectionStartLineNumber: 1,
          selectionStartColumn: 1,
          positionLineNumber: 1,
          positionColumn: 1,
        },
        position: { lineNumber: 1, column: 1 },
        viewState: null,
        mouseCursor: lastMousePosition,
      },
    };
  }

  commitCapturedFrame(session, initialFrame, viewStateRef);

  return {
    session,
    sessionRevision: context.sessionRevision + 1,
    currentFrame: initialFrame,
  };
};

export const captureFrame = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  const editor = getCaptureEditor(context);
  if (!context.session) return {};

  const timestamp = getRecordingTimestamp(context.session);

  const mousePosition =
    event.type === "CAPTURE_FRAME" && event.mousePosition
      ? event.mousePosition
      : context.session.lastMousePosition;

  // While paused the pointer is followed but not recorded: every sample would land on
  // the pause's single instant. Resuming records where it ended up.
  if (
    event.type === "CAPTURE_FRAME" &&
    event.isMouseMovement &&
    isRecordingClockPaused(context.session.clock)
  ) {
    context.session.lastMousePosition = mousePosition;
    return {};
  }
  const cursorAppended =
    event.type === "CAPTURE_FRAME" && event.isMouseMovement
      ? appendCursorEvent(context.session.cursorEvents, timestamp, mousePosition)
      : false;

  // The cursor track has no dependency on Monaco — `mousePosition` arrives from
  // mouseTrackingActor fully resolved and lives in its own track. Bailing on a
  // null editor before this point dropped every cursor sample for as long as the
  // active file was a binary asset (CodeEditor nulls both refs then), so the
  // replayed pointer froze while the presenter talked over an image and then
  // teleported when a code file reopened.
  if (!editor) {
    context.session.lastMousePosition = mousePosition;
    return {
      session: context.session,
      sessionRevision: cursorAppended ? context.sessionRevision + 1 : context.sessionRevision,
    };
  }

  if (event.type === "CAPTURE_FRAME" && event.isMouseMovement) {
    const lastFrame = context.session.encoder.lastFullFrame;
    const lastMousePosition = context.session.lastMousePosition;
    const visibilityChanged = lastMousePosition?.visible !== mousePosition?.visible;

    if (
      lastFrame &&
      timestamp - lastFrame.timestamp < MOUSE_FRAME_INTERVAL_MS &&
      !visibilityChanged
    ) {
      context.session.lastMousePosition = mousePosition;
      return {
        session: context.session,
        sessionRevision: cursorAppended ? context.sessionRevision + 1 : context.sessionRevision,
      };
    }
  }

  const previousContent = getPreviousCapturedContent(context.session, context.currentFrame);

  let capturedContent = previousContent;
  let contentEditDelta: CreatedContentEditDelta | undefined;
  const textEdit = event.type === "CAPTURE_FRAME" ? event.textEdit : undefined;
  const model = editor.getModel();
  const currentModelUri = model?.uri.toString() ?? "";
  const currentVersionId = model?.getVersionId() ?? -1;
  if (
    textEdit &&
    previousContent &&
    previousContent.modelUri === currentModelUri &&
    previousContent.versionId === textEdit.beforeVersion &&
    currentVersionId === textEdit.afterVersion
  ) {
    const created = createContentEditDelta(previousContent.value, textEdit);
    if (created) {
      capturedContent = {
        value: created.content,
        versionId: currentVersionId,
        modelUri: currentModelUri,
      };
      contentEditDelta = created;
    }
  }

  const { frame, viewStateRef } = createFrame(
    editor,
    timestamp,
    mousePosition,
    context.getSlideState,
    context.getPreviewState,
    capturedContent,
    context.session.lastCapturedViewStateRef,
    event.type === "CAPTURE_FRAME" ? event.selection : undefined,
  );

  // The cursor track above already holds every pointer sample, and replay
  // reads frame pointers only for recordings that have no cursor track. A
  // pointer capture therefore gives the encoder the last stored pointer, so
  // it stores a frame only when the capture also sampled something the frame
  // track owns (scroll, preview). currentFrame and lastMousePosition keep the
  // live pointer, which the next capture that is not a pointer move stores.
  const lastStoredFrame = context.session.encoder.lastStoredFrame;
  const encoderFrame =
    event.type === "CAPTURE_FRAME" && event.isMouseMovement && lastStoredFrame
      ? { ...frame, state: { ...frame.state, mouseCursor: lastStoredFrame.state.mouseCursor } }
      : frame;
  commitCapturedFrame(context.session, encoderFrame, viewStateRef, contentEditDelta);
  context.session.lastMousePosition = mousePosition;

  return {
    session: context.session,
    sessionRevision: context.sessionRevision + 1,
    currentFrame: frame,
  };
};

export const capturePreviewRefreshFrame = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "PREVIEW_EVENT" || event.event.type !== "preview_refresh") {
    return {};
  }

  const editor = getCaptureEditor(context);
  if (!editor || !context.session) {
    return {};
  }

  const timestamp = getRecordingTimestamp(context.session);
  const { frame, viewStateRef } = createFrame(
    editor,
    timestamp,
    context.session.lastMousePosition,
    context.getSlideState,
    context.getPreviewState,
    getPreviousCapturedContent(context.session, context.currentFrame),
    context.session.lastCapturedViewStateRef,
  );

  if (frame.state.previewState) {
    frame.state.previewState = {
      ...frame.state.previewState,
      content: event.event.content ?? frame.state.previewState.content,
    };
  }

  commitCapturedFrame(context.session, frame, viewStateRef);

  return {
    session: context.session,
    sessionRevision: context.sessionRevision + 1,
    currentFrame: frame,
  };
};

/**
 * Shared "append to session + bump revision" shape for the recording-state event
 * handlers below. `append` mutates `session`'s arrays in place by design (see the
 * invariant on {@link RecordingSession}) and returns `false` when nothing was
 * appended (deduplicated event), in which case the revision must not bump.
 */
export const appendToSession = (
  context: EditorMachineContext,
  append: (session: RecordingSession) => boolean,
): Partial<EditorMachineContext> =>
  !context.session || !append(context.session)
    ? {}
    : { session: context.session, sessionRevision: context.sessionRevision + 1 };

export const captureSlideEvent = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "SLIDE_EVENT") return {};
  return appendToSession(context, (session) => appendSlideRecordingEvent(session, event.event));
};

export const capturePreviewEvent = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "PREVIEW_EVENT") return {};
  return appendToSession(context, (session) => appendPreviewRecordingEvent(session, event.event));
};

export const capturePreviewInitialDocument = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "PREVIEW_INITIAL_DOCUMENT") return {};
  return appendToSession(context, (session) =>
    appendPreviewInitialDocument(session, event.document),
  );
};

export const capturePreviewPatchBatch = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "PREVIEW_PATCH_BATCH") return {};
  return appendToSession(context, (session) => appendPreviewPatchBatch(session, event.batch));
};

export const captureWorkspaceEvent = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "WORKSPACE_EVENT") return {};
  const snapshot = context.getWorkspaceSnapshot?.();
  if (!snapshot) return {};
  return appendToSession(context, (session) =>
    appendWorkspaceRecordingEvent(session, snapshot, {
      sidebarWidthDelta: event.sidebarWidthDelta,
      previewDockWidthDelta: event.previewDockWidthDelta,
    }),
  );
};

export const captureRuntimeEvent = ({
  context,
}: {
  context: EditorMachineContext;
}): Partial<EditorMachineContext> => {
  const snapshot = context.getRuntimeSnapshot?.();
  if (!snapshot) return {};
  return appendToSession(context, (session) => appendRuntimeRecordingEvent(session, snapshot));
};

export const captureChatEvent = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "CHAT_EVENT") return {};
  return appendToSession(context, (session) => appendChatDelta(session, event.event));
};

export const captureWhiteboardEvent = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "WHITEBOARD_EVENT") return {};
  return appendToSession(context, (session) =>
    appendWhiteboardRecordingEvent(session, event.event),
  );
};

/** Stops the take's clock. Its recorders are paused by the machine alongside. */
export const pauseRecordingSession = ({
  context,
}: {
  context: EditorMachineContext;
}): Partial<EditorMachineContext> => {
  const session = context.session;
  if (!session || isRecordingClockPaused(session.clock)) return {};
  session.clock = pauseRecordingClock(session.clock, performance.now(), Date.now());
  return { session, sessionRevision: context.sessionRevision + 1 };
};

/**
 * Runs the take's clock again. The pointer was followed but not recorded while paused,
 * so the resumed stretch starts with a sample of where it is now. The moment it resumes
 * is where a later retake can rewind to.
 */
export const resumeRecordingSession = ({
  context,
}: {
  context: EditorMachineContext;
}): Partial<EditorMachineContext> => {
  const session = context.session;
  if (!session || !isRecordingClockPaused(session.clock)) return {};
  const perf = performance.now();
  const wall = Date.now();
  session.clock = resumeRecordingClock(session.clock, perf, wall);
  const recordingTime = getRecordingTimestamp(session);
  session.safePoints = withSafePoint(session.safePoints, {
    recordingTime,
    perf,
    wall,
    mediaTime: recordingTime + totalMediaSpanLength(session.mediaCuts),
  });
  appendCursorEvent(session.cursorEvents, recordingTime, session.lastMousePosition);
  return { session, sessionRevision: context.sessionRevision + 1 };
};

/**
 * Marks a chapter at the take's current moment. A chapter is where the author is happy
 * with the take so far, so it is also a safe point a retake can rewind to.
 */
export const addChapterMarker = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  const session = context.session;
  if (!session || event.type !== "ADD_CHAPTER_MARKER") return {};
  const recordingTime = getRecordingTimestamp(session);
  const last = session.chapters[session.chapters.length - 1];
  // One chapter per moment: a second press where the take stands still adds nothing.
  if (last && last.time === recordingTime) return {};

  session.chapters = [
    ...session.chapters,
    {
      time: recordingTime,
      title: event.title?.trim() || defaultChapterTitle(session.chapters.length),
    },
  ];
  // While paused, the clock stands at the moment the pause began: that is the anchor.
  const at = session.clock.pausedAt ?? { perf: performance.now(), wall: Date.now() };
  session.safePoints = withSafePoint(session.safePoints, {
    recordingTime,
    perf: at.perf,
    wall: at.wall,
    mediaTime: recordingTime + totalMediaSpanLength(session.mediaCuts),
  });
  return { session, sessionRevision: context.sessionRevision + 1 };
};

export const finalizeRecording = ({
  context,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
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
      pending: context.audio.isRecording && context.audio.source === "microphone",
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
    sessionRevision: 0,
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

export const notifyRecordingStart = ({ context }: { context: EditorMachineContext }): void => {
  context.onRecordingStart?.();
};

export const notifyRecordingStop = ({ context }: { context: EditorMachineContext }): void => {
  if (context.recording) {
    context.onRecordingStop?.(context.recording);
  }
};

export const storeAudioBlob = ({
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "AUDIO_RECORDING_STOPPED") return {};
  return {
    audio: {
      ...createIdleAudioState(),
      blob: event.blob,
      mimeType: event.blob.type,
      source: "microphone" as const,
    },
  };
};

/**
 * Accept a microphone blob that arrives after the session has already finalized.
 *
 * `stoppingRecording` gives `MediaRecorder.stop()` 2s before a watchdog finalizes
 * anyway; a slower stop then delivers `AUDIO_RECORDING_STOPPED` in `loading` or
 * `playback`, where the capture-side handlers no longer exist. The blob is the
 * entire narration, so dropping it produced a silently silent lesson — the track
 * metadata still advertised audio (the microphone recorder was running at finalize)
 * while `Recording.audioBlob` was undefined, so playback and export found none.
 *
 * Splice it into the finalized recording instead. An already-attached blob wins:
 * the normal path has run and this is a duplicate.
 */
export const attachLateAudioBlob = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "AUDIO_RECORDING_STOPPED") return {};

  const audio = {
    ...context.audio,
    blob: event.blob,
    isRecording: false,
    mediaRecorder: null,
    mimeType: event.blob.type,
    source: "microphone" as const,
  };

  if (!context.recording || context.recording.audioBlob) {
    return { audio };
  }

  return {
    audio,
    recording: {
      ...context.recording,
      audioBlob: event.blob,
      audioSource: "microphone" as const,
      audioStartOffsetMs: context.recording.audioStartOffsetMs ?? 0,
    },
  };
};

export const storeAudioStarted = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "AUDIO_RECORDING_STARTED") return {};
  return {
    audio: {
      ...context.audio,
      mediaRecorder: event.mediaRecorder,
      mimeType: event.mimeType,
      startOffsetMs: 0,
    },
  };
};

export const storeCameraBlob = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "CAMERA_STOPPED") return {};
  return {
    camera: {
      ...context.camera,
      blob: event.blob,
      isRecording: false,
      mediaRecorder: null,
      mimeType: event.blob.type,
      source: "camera" as const,
    },
  };
};

export const storeCameraStarted = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "CAMERA_STARTED") return {};
  // The camera MediaRecorder only starts after getUserMedia resolves, which lags the
  // recording-session origin (session.startedAtPerf) by the camera warmup. Capture that
  // offset so playback can shift the video back into sync; otherwise the face video runs
  // ahead of audio. Both sides must be the same (monotonic) clock — see P7. Read through
  // the take's clock: a camera that finished warming up during a pause starts recording
  // when the take resumes, which is the moment the pause holds.
  const startOffsetMs = context.session
    ? recordingTimeAtPerf(context.session.clock, context.session.startedAtPerf, event.startedAtPerf)
    : 0;
  return {
    camera: {
      ...context.camera,
      mimeType: event.mimeType,
      mediaRecorder: event.mediaRecorder ?? null,
      startOffsetMs,
    },
  };
};

export const clearCameraRecording = (): Partial<EditorMachineContext> => ({
  camera: createIdleCameraState(),
});

export const handleCameraError = ({
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "CAMERA_ERROR") return {};
  console.warn("Camera recording disabled:", event.error);
  return clearCameraRecording();
};

export const handleAudioRecordingError = ({
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "AUDIO_RECORDING_ERROR") return {};
  return { error: event.error };
};

// ============================================================================
// Local screen-recording action bodies
//
// The screen video is a keep-forever, local-only artifact. It rides in on the
// START_RECORDING event as a pre-acquired display stream (acquired in the click
// handler to keep transient user activation) and exits via `onScreenRecordingReady`.
// It is NEVER folded into the `Recording` — see the publish-safety guardrails in
// docs/video-plan.md. Nothing here writes a `screen*` field onto the finalized recording.
// ============================================================================

export const setScreenStream = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "START_RECORDING") return {};
  const screenStream = event.screenStream ?? null;
  const screenRecorderGeneration = screenStream
    ? context.screenRecorderGeneration + 1
    : context.screenRecorderGeneration;
  return {
    screenStream,
    screenRecorderGeneration,
    screen: screenStream
      ? {
          ...createIdleScreenState(),
          actorId: `${SCREEN_RECORDER_ID_PREFIX}${screenRecorderGeneration}`,
        }
      : createIdleScreenState(),
  };
};

export const storeScreenStarted = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "SCREEN_STARTED") return {};
  // The screen MediaRecorder starts a beat after the session origin (picker + getDisplayMedia
  // ran before START_RECORDING, but MediaRecorder.start resolves at spawn). Capture the offset
  // on the same monotonic clock as the session so a consumer can realign the local video.
  const startOffsetMs = context.session
    ? recordingTimeAtPerf(context.session.clock, context.session.startedAtPerf, event.startedAtPerf)
    : 0;
  return {
    screen: {
      ...context.screen,
      mimeType: event.mimeType,
      hasAudio: event.hasAudio,
      startOffsetMs,
    },
  };
};

export const notifyScreenRecordingReady = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): void => {
  if (event.type !== "SCREEN_STOPPED") return;
  context.onScreenRecordingReady?.({
    blob: event.blob,
    mimeType: event.mimeType || event.blob.type,
    hasAudio: event.hasAudio,
    startOffsetMs: normalizeNonNegativeTime(event.startOffsetMs),
  });
};

/** Reset screen slices after the blob has exited. The actor releases tracks before emitting it. */
export const clearScreenRecording = (): Partial<EditorMachineContext> => ({
  screen: createIdleScreenState(),
  screenStream: null,
});

export const handleScreenError = ({
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "SCREEN_ERROR") return {};
  console.warn("Screen recording disabled:", event.error);
  return clearScreenRecording();
};

/**
 * Stop and drop a pre-acquired display stream that never reached the actor. Used only on the
 * arming-gap abort paths (mic AUDIO_RECORDING_ERROR / early STOP_RECORDING before the screen actor
 * spawns) —
 * once the actor owns the stream, its own teardown handles track cleanup instead.
 */
export const releaseScreenStream = ({
  context,
}: {
  context: EditorMachineContext;
}): Partial<EditorMachineContext> => {
  if (!context.screenStream) return {};
  context.screenStream.getTracks().forEach((track) => track.stop());
  return clearScreenRecording();
};

/**
 * Stop the display stream of a START_RECORDING that no state accepted: the codec refusal in idle,
 * or any state other than idle (the record button stays live while the mic prompt is open and
 * during the stop window). The host ran getDisplayMedia at click time and handed the stream over,
 * so nothing else will ever stop those tracks. Plain side effect: it must not touch the screen
 * context of a capture that is still running or finishing.
 */
export const releaseUnacceptedScreenStream = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): void => {
  if (event.type !== "START_RECORDING" || !event.screenStream) return;
  // A host re-sending the stream the machine already owns must not kill the live capture.
  if (event.screenStream === context.screenStream) return;
  event.screenStream.getTracks().forEach((track) => track.stop());
};
