import type { SlideEvent, PreviewEvent } from "../slides";
import type {
  EditorMachineContext,
  EditorMachineEvent,
  RecordingSession,
  RecordingSessionMediaFragment,
} from "./types";
import type { EditorFrame, MouseCursorPosition, Recording } from "../types";
import type { RuntimeRecordingEvent } from "../../../types/runtime";
import {
  toSidebarWidthDeltaSnapshot,
  type WorkspaceRecordingEvent,
} from "../../../types/workspace";
import { createFrameStreamEncoder, pushFrame } from "../utils/frameStreamEncoder";
import {
  appendPreviewInitialDocument,
  appendPreviewPatchBatch,
  appendPreviewRecordingEvent,
  appendRuntimeRecordingEvent,
  appendSlideRecordingEvent,
  appendWorkspaceRecordingEvent,
} from "./recordingSession";
import {
  appendCursorEvent,
  AUDIO_TRACK_ID,
  buildMediaFragmentMetadata,
  buildRecordingClusters,
  buildTrackMetadata,
  createFrame,
  MOUSE_FRAME_INTERVAL_MS,
  type CapturedViewStateRef,
} from "./editorMachineHelpers";

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

export const setCameraRecordingEnabled = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "START_RECORDING") return {};
  return {
    enableCameraRecording: event.enableCamera ?? context.enableCameraRecording,
  };
};

export const prepareExternalAudioRecording = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "START_RECORDING" || !(event.audioBlob instanceof Blob)) {
    return {};
  }

  return {
    audio: {
      ...context.audio,
      blob: event.audioBlob,
      element: null,
      isRecording: true,
      mediaRecorder: null,
      chunks: [],
      mimeType: event.audioBlob.type,
      source: "external" as const,
      externalDurationMs: null,
    },
  };
};

export interface RecordingAudioPlayerEnqueue {
  spawnChild: (
    src: "audioPlayback",
    options: {
      id: "recordingAudioPlayer";
      input: {
        blob: Blob;
        volume: number;
        playbackRate: number;
        startPositionMs: number;
      };
    },
  ) => void;
  sendTo: (actor: "recordingAudioPlayer", event: { type: "PLAY" }) => void;
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
  if (event.type !== "START_RECORDING" || !(event.audioBlob instanceof Blob)) {
    return;
  }

  enqueue.spawnChild("audioPlayback", {
    id: "recordingAudioPlayer",
    input: {
      blob: event.audioBlob,
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
  if (event.type !== "READY" || context.audio.source !== "external") {
    return {};
  }

  const externalDurationMs = Number.isFinite(event.duration) ? event.duration : null;

  if (context.session && externalDurationMs !== null && context.session.audioFragments.length > 0) {
    // In-place update of a constant-size element (index 0 always exists here), not a
    // spread-append — consistent with the mutable-session invariant.
    context.session.audioFragments[0] = {
      ...context.session.audioFragments[0],
      endTimeMs: context.audio.startOffsetMs + externalDurationMs,
    };
  }

  return {
    session: context.session,
    sessionRevision: context.session ? context.sessionRevision + 1 : context.sessionRevision,
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
    event.type === "STARTED" && Number.isFinite(event.startedAtMs) ? event.startedAtMs : Date.now();
  const startedAtPerf =
    event.type === "STARTED" && Number.isFinite(event.startedAtPerf)
      ? event.startedAtPerf
      : performance.now();
  const slideEvents: SlideEvent[] = [];
  const previewEvents: PreviewEvent[] = [];
  const workspaceEvents: WorkspaceRecordingEvent[] = [];
  const runtimeEvents: RuntimeRecordingEvent[] = [];
  const initialMousePosition: MouseCursorPosition = { x: 0, y: 0, visible: false };
  const externalAudioFragment =
    context.audio.source === "external" && context.audio.blob
      ? [
          {
            trackId: AUDIO_TRACK_ID,
            startTimeMs: context.audio.startOffsetMs,
            endTimeMs:
              typeof context.audio.externalDurationMs === "number" &&
              Number.isFinite(context.audio.externalDurationMs)
                ? context.audio.startOffsetMs + context.audio.externalDurationMs
                : context.audio.startOffsetMs,
            blob: context.audio.blob,
            mimeType: context.audio.mimeType || context.audio.blob.type || "audio/webm",
          },
        ]
      : [];

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

  return {
    session: {
      startedAt,
      startedAtPerf,
      frames: [],
      encoder: createFrameStreamEncoder(),
      slideEvents,
      previewEvents,
      previewInitialDocuments: [],
      previewPatchBatches: [],
      workspaceEvents,
      runtimeEvents,
      cursorEvents: [{ timestamp: 0, ...initialMousePosition }],
      // External (selected file) audio is fully known at start, so seed it as the single
      // audio fragment. Microphone audio is appended as timeslice events. Camera video is
      // never streamed inline — its blob is captured whole when the camera recorder stops.
      audioFragments: externalAudioFragment,
      lastMousePosition: initialMousePosition,
    },
    sessionRevision: 0,
    lastCallbackFrameTimestamp: undefined,
  };
};

export const captureInitialFrame = ({
  context,
}: {
  context: EditorMachineContext;
}): Partial<EditorMachineContext> => {
  const session = context.session;
  if (!session) return {};

  const lastMousePosition = session.lastMousePosition || {
    x: 0,
    y: 0,
    visible: false,
  };

  // Use createFrame for the initial frame to ensure it has all metadata
  // Capture reads the live editor: fall back to the input ref getter so a
  // SET_EDITOR_REF event lost to a stopped-actor window (StrictMode/Suspense
  // rehydration) cannot silently disable frame/cursor capture.
  const editor = context.editorRefs.editor ?? context.getEditorInstance();
  let initialFrame: EditorFrame;
  let contentVersionId: number | undefined;
  let modelUri: string | undefined;
  let viewStateRef: CapturedViewStateRef | undefined;

  if (editor) {
    ({
      frame: initialFrame,
      contentVersionId,
      modelUri,
      viewStateRef,
    } = createFrame(editor, 0, lastMousePosition, context.getSlideState, context.getPreviewState));
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

  const { state: encoder, emitted } = pushFrame(session.encoder, initialFrame);

  if (emitted) {
    session.frames.push(emitted);
  }
  session.encoder = encoder;
  session.lastCapturedContentVersionId = contentVersionId;
  session.lastCapturedContentModelUri = modelUri;
  session.lastCapturedViewStateRef = viewStateRef;

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
  // Capture reads the live editor: fall back to the input ref getter so a
  // SET_EDITOR_REF event lost to a stopped-actor window (StrictMode/Suspense
  // rehydration) cannot silently disable frame/cursor capture.
  const editor = context.editorRefs.editor ?? context.getEditorInstance();
  if (!editor || !context.session) return {};

  const timestamp = performance.now() - context.session.startedAtPerf;

  const mousePosition =
    event.type === "CAPTURE_FRAME" && event.mousePosition
      ? event.mousePosition
      : context.session.lastMousePosition;
  const cursorAppended =
    event.type === "CAPTURE_FRAME" && event.isMouseMovement
      ? appendCursorEvent(context.session.cursorEvents, timestamp, mousePosition)
      : false;

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

  const previousContent =
    context.currentFrame &&
    context.session.lastCapturedContentVersionId !== undefined &&
    context.session.lastCapturedContentModelUri !== undefined
      ? {
          value: context.currentFrame.state.content,
          versionId: context.session.lastCapturedContentVersionId,
          modelUri: context.session.lastCapturedContentModelUri,
        }
      : undefined;

  const { frame, contentVersionId, modelUri, viewStateRef } = createFrame(
    editor,
    timestamp,
    mousePosition,
    context.getSlideState,
    context.getPreviewState,
    previousContent,
    context.session.lastCapturedViewStateRef,
  );

  const { state: encoder, emitted } = pushFrame(context.session.encoder, frame);

  if (emitted) {
    context.session.frames.push(emitted);
  }
  context.session.encoder = encoder;
  context.session.lastMousePosition = mousePosition;
  context.session.lastCapturedContentVersionId = contentVersionId;
  context.session.lastCapturedContentModelUri = modelUri;
  context.session.lastCapturedViewStateRef = viewStateRef;

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

  // Capture reads the live editor: fall back to the input ref getter so a
  // SET_EDITOR_REF event lost to a stopped-actor window (StrictMode/Suspense
  // rehydration) cannot silently disable frame/cursor capture.
  const editor = context.editorRefs.editor ?? context.getEditorInstance();
  if (!editor || !context.session) {
    return {};
  }

  const timestamp = performance.now() - context.session.startedAtPerf;
  const previousContent =
    context.currentFrame &&
    context.session.lastCapturedContentVersionId !== undefined &&
    context.session.lastCapturedContentModelUri !== undefined
      ? {
          value: context.currentFrame.state.content,
          versionId: context.session.lastCapturedContentVersionId,
          modelUri: context.session.lastCapturedContentModelUri,
        }
      : undefined;

  const { frame, contentVersionId, modelUri, viewStateRef } = createFrame(
    editor,
    timestamp,
    context.session.lastMousePosition,
    context.getSlideState,
    context.getPreviewState,
    previousContent,
    context.session.lastCapturedViewStateRef,
  );

  if (frame.state.previewState) {
    frame.state.previewState = {
      ...frame.state.previewState,
      content: event.event.content ?? frame.state.previewState.content,
    };
  }

  const { state: encoder, emitted } = pushFrame(context.session.encoder, frame);

  if (emitted) {
    context.session.frames.push(emitted);
  }
  context.session.encoder = encoder;
  context.session.lastCapturedContentVersionId = contentVersionId;
  context.session.lastCapturedContentModelUri = modelUri;
  context.session.lastCapturedViewStateRef = viewStateRef;

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
  return appendToSession(context, (session) => {
    appendSlideRecordingEvent(session, event.event);
    return true;
  });
};

export const capturePreviewEvent = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "PREVIEW_EVENT") return {};
  return appendToSession(context, (session) => {
    appendPreviewRecordingEvent(session, event.event);
    return true;
  });
};

export const capturePreviewInitialDocument = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "PREVIEW_INITIAL_DOCUMENT") return {};
  return appendToSession(context, (session) => {
    appendPreviewInitialDocument(session, event.document);
    return true;
  });
};

export const capturePreviewPatchBatch = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "PREVIEW_PATCH_BATCH") return {};
  return appendToSession(context, (session) => {
    appendPreviewPatchBatch(session, event.batch);
    return true;
  });
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

export const finalizeRecording = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (!context.session) return { recording: null };

  // Base duration from session timing
  const duration =
    event.type === "FINISHED" &&
    context.audio.source === "external" &&
    typeof context.audio.externalDurationMs === "number" &&
    Number.isFinite(context.audio.externalDurationMs)
      ? Math.max(context.audio.externalDurationMs, 1)
      : Math.max(performance.now() - context.session.startedAtPerf, 1);
  const slides = context.getSlides?.();
  const currentWorkspaceSnapshot = context.getWorkspaceSnapshot?.() || undefined;
  const workspaceSnapshot = currentWorkspaceSnapshot
    ? toSidebarWidthDeltaSnapshot(currentWorkspaceSnapshot, 0)
    : undefined;
  const runtimeSnapshot = context.getRuntimeSnapshot?.() || undefined;

  // Frames were compressed incrementally during capture.
  const frames = context.session.frames;
  const clusters = buildRecordingClusters(frames, duration);
  const tracks = buildTrackMetadata({
    durationMs: duration,
    hasSlideEvents: context.session.slideEvents.length > 0,
    hasPreviewEvents:
      context.session.previewEvents.length > 0 ||
      context.session.previewInitialDocuments.length > 0 ||
      context.session.previewPatchBatches.length > 0,
    hasWorkspaceEvents: context.session.workspaceEvents.length > 0,
    hasRuntimeEvents: context.session.runtimeEvents.length > 0,
    hasCursorEvents: context.session.cursorEvents.length > 0,
    audioMimeType: context.audio.mimeType || context.audio.blob?.type,
    audioSource: context.audio.source || undefined,
    audioStartOffsetMs: context.audio.startOffsetMs,
    hasAudio: context.session.audioFragments.length > 0 || Boolean(context.audio.blob),
    cameraMimeType: context.camera.mimeType || context.camera.blob?.type,
    cameraSource: context.camera.source || undefined,
    cameraStartOffsetMs: context.camera.startOffsetMs,
    hasCamera: Boolean(context.camera.blob),
  });
  const mediaFragments = buildMediaFragmentMetadata(
    context.session.audioFragments,
    clusters,
    context.audio.source === "external" ? duration : undefined,
  );

  const recording: Recording = {
    version: 4,
    id: Date.now().toString(),
    name: `Recording ${Date.now()}`,
    createdAt: Date.now(),
    frames,
    keyframeInterval: 120,
    slideEvents: context.session.slideEvents,
    previewEvents: context.session.previewEvents,
    previewInitialDocuments: context.session.previewInitialDocuments,
    previewPatchBatches: context.session.previewPatchBatches,
    workspaceEvents: context.session.workspaceEvents,
    runtimeEvents: context.session.runtimeEvents,
    cursorEvents: context.session.cursorEvents,
    slides: slides,
    tracks,
    clusters: clusters.length > 0 ? clusters : undefined,
    mediaFragments: mediaFragments.length > 0 ? mediaFragments : undefined,
    duration,
    audioBlob: context.audio.blob || undefined,
    audioSource: context.audio.source || undefined,
    audioStartOffsetMs: context.audio.blob ? context.audio.startOffsetMs : undefined,
    cameraBlob: context.camera.blob || undefined,
    cameraSource: context.camera.source || undefined,
    cameraStartOffsetMs: context.camera.blob ? context.camera.startOffsetMs : undefined,
    streamFinalized: true,
    workspaceSnapshot,
    runtimeSnapshot,
  };

  return {
    recording,
    session: null,
    sessionRevision: 0,
    audio: {
      ...context.audio,
      isRecording: false,
      mediaRecorder: null,
      source: null,
      startOffsetMs: 0,
      externalDurationMs: null,
    },
    camera: {
      blob: null,
      isRecording: false,
      mimeType: "",
      source: null,
      startOffsetMs: 0,
    },
    timeline: {
      ...context.timeline,
      duration,
    },
    lastAppliedFrameIndex: -1,
    lastAppliedPreviewEventIndex: -1,
    lastAppliedPreviewPatchBatchIndex: -1,
    lastAppliedSlideEventIndex: -1,
    lastAppliedWorkspaceEventIndex: -1,
    lastAppliedRuntimeEventIndex: -1,
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
  if (event.type !== "STOPPED") return {};
  return {
    audio: {
      blob: event.blob,
      element: null,
      isRecording: false,
      mediaRecorder: null,
      chunks: [],
      mimeType: event.blob.type,
      source: "microphone" as const,
      startOffsetMs: 0,
      externalDurationMs: null,
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
  if (event.type !== "STARTED") return {};
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
      mimeType: event.blob.type,
      source: "camera" as const,
    },
  };
};

// Append a live microphone timeslice fragment to the session's append-only audio stream so
// an optional live recording sink can forward it. The finalized blob (STOPPED) is unchanged.
export const captureAudioChunk = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "CHUNK" || !context.session) return {};
  const fragment: RecordingSessionMediaFragment = {
    trackId: AUDIO_TRACK_ID,
    startTimeMs: context.audio.startOffsetMs + event.startTimeMs,
    endTimeMs: context.audio.startOffsetMs + event.endTimeMs,
    blob: event.chunk,
    mimeType: event.chunk.type || context.audio.mimeType || "audio/webm",
  };
  context.session.audioFragments.push(fragment);
  return {
    session: context.session,
    sessionRevision: context.sessionRevision + 1,
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
  // ahead of audio. Both sides must be the same (monotonic) clock — see P7.
  const startOffsetMs = context.session
    ? Math.max(0, event.startedAtPerf - context.session.startedAtPerf)
    : 0;
  return {
    camera: {
      ...context.camera,
      mimeType: event.mimeType,
      startOffsetMs,
    },
  };
};

export const handleCameraError = ({
  context,
  event,
}: {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}): Partial<EditorMachineContext> => {
  if (event.type !== "CAMERA_ERROR") return {};
  console.warn("Camera recording disabled:", event.error);
  return {
    camera: {
      ...context.camera,
      isRecording: false,
      mimeType: "",
      source: null,
      startOffsetMs: 0,
    },
  };
};
