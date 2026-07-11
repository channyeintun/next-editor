import type * as monaco from "monaco-editor";
import type {
  PreviewDomPatchBatch,
  PreviewEvent,
  PreviewInitialDocument,
  PreviewState,
  Slide,
  SlideEvent,
  SlidePreviewState,
} from "../slides";
import type {
  CaptionTrack,
  MouseCursorPosition,
  CursorRecordingEvent,
  EditorFrame,
  Recording,
  EditorSelection,
  EditorPosition,
  RecordingAudioSource,
  RecordingCameraSource,
  RecordingClusterMeta,
  RecordingMediaFragment,
  RecordingTrackMeta,
  PreviewPatchReplayInput,
  ScreenRecordingReadyPayload,
} from "../types";
import type { DeltaFrame } from "../utils/deltaTypes";
import type { FrameStreamEncoderState } from "../utils/frameStreamEncoder";
import type { RuntimeRecordingEvent, RuntimeRecordingSnapshot } from "../../../types/runtime";
import type { WorkspaceRecordingEvent, WorkspaceRecordingSnapshot } from "../../../types/workspace";
import type { WhiteboardEvent, WhiteboardSceneState } from "../whiteboard";
import type { CapturedViewStateRef } from "./editorMachineHelpers";

// ============================================================================
// Machine Status Types
// ============================================================================

/**
 * All possible states the editor machine can be in
 */
export type EditorMachineStatus =
  | "idle"
  | "recording"
  | "loading"
  | "playback"
  | "playback.ready"
  | "playback.playing"
  | "playback.paused"
  | "playback.ended"
  | "stoppingRecording";

// ============================================================================
// Machine Context
// ============================================================================

/**
 * Timeline state for playback synchronization
 */
export interface TimelineState {
  /** Current playback position in milliseconds */
  currentTime: number;
  /** Total duration in milliseconds */
  duration: number;
  /** Playback speed multiplier (1.0 = normal) */
  speed: number;
  /** Volume level (0.0 - 1.0) */
  volume: number;
  /** Time when playback started (performance.now()) */
  startedAt: number;
  /** Accumulated paused duration in milliseconds */
  pausedDuration: number;
  /** Time when paused (performance.now()), 0 if not paused */
  pausedAt: number;
}

/**
 * Timeline-aware media fragment captured during recording. The blob is retained only
 * until the recording is finalized or streamed to a sink.
 */
export interface RecordingSessionMediaFragment {
  trackId: string;
  startTimeMs: number;
  endTimeMs: number;
  blob: Blob;
  mimeType: string;
}

/**
 * Recording session state.
 *
 * This is a mutable capture buffer: its object identity — and the identity of every
 * array field below — stays stable for the whole recording. Appenders push in place
 * rather than spreading into a new array/object, so capture cost is O(1) instead of
 * O(session-so-far) per sample. Arrays are append-only during a session; only indices
 * `<= length` observed at read time are stable, so incremental readers (e.g. the
 * live stream sink) must track their own read cursor rather than diffing snapshots.
 * `EditorMachineContext.sessionRevision` is bumped on every mutation so reference-
 * equality selectors can still detect a change.
 */
export interface RecordingSession {
  /**
   * Wall-clock time recording started (`Date.now()`). Metadata only (e.g. the live
   * elapsed-time display) — never subtracted from another wall-clock read to derive an
   * in-session timestamp, since `Date.now()` is not monotonic. Use `startedAtPerf` for that.
   */
  startedAt: number;
  /** When recording started (`performance.now()`), monotonic origin for all in-session timestamps */
  startedAtPerf: number;
  /** Already-compressed frames built incrementally during capture (append-only) */
  frames: DeltaFrame[];
  /** Incremental encoder state (input count, last stored frame, last full frame) */
  encoder: FrameStreamEncoderState;
  /** Collected slide events during recording */
  slideEvents: SlideEvent[];
  /** Collected preview events during recording */
  previewEvents: PreviewEvent[];
  /** Collected initial preview documents during recording */
  previewInitialDocuments: PreviewInitialDocument[];
  /** Collected preview DOM patch batches during recording */
  previewPatchBatches: PreviewDomPatchBatch[];
  /** Collected workspace events during recording */
  workspaceEvents: WorkspaceRecordingEvent[];
  /** Collected runtime events during recording */
  runtimeEvents: RuntimeRecordingEvent[];
  /** High-cadence fake cursor samples during recording */
  cursorEvents: CursorRecordingEvent[];
  /** Collected whiteboard change events during recording */
  whiteboardEvents: WhiteboardEvent[];
  /**
   * Timeline-aware audio fragments captured during recording. For microphone recordings these are
   * `MediaRecorder` timeslice fragments; for a selected audio file it is the single file blob.
   */
  audioFragments: RecordingSessionMediaFragment[];
  /** Last known mouse position */
  lastMousePosition: MouseCursorPosition;
  /**
   * Model `getVersionId()` at the last captured frame, paired with that frame's
   * `state.content` (see `currentFrame` on the machine context). When a new
   * capture's version id AND model URI both match, the content string is reused
   * by reference instead of re-reading `editor.getValue()`. Version ids are a
   * per-model counter, so the URI must match too — otherwise a file switch
   * between captures (same numeric version id, different model) would silently
   * reuse the previous file's content.
   */
  lastCapturedContentVersionId?: number;
  /** Model URI paired with `lastCapturedContentVersionId`, see above. */
  lastCapturedContentModelUri?: string;
  /**
   * `saveViewState()` result from the last captured frame plus the scalars it was
   * derived from (content version, model, scroll, selection, position). When a
   * new capture's scalars all match, `createFrame` reuses the `viewState` object
   * by reference instead of calling `editor.saveViewState()` again — see
   * `CapturedViewStateRef` in `editorMachineHelpers.ts`.
   */
  lastCapturedViewStateRef?: CapturedViewStateRef;
}

/**
 * Audio state for recording and playback
 */
export interface AudioState {
  /** External audio url if provided */
  url: string | null;
  /** Audio blob from recording */
  blob: Blob | null;
  /** Audio element for playback */
  element: HTMLAudioElement | null;
  /** Whether audio recording is active */
  isRecording: boolean;
  /** MediaRecorder instance */
  mediaRecorder: MediaRecorder | null;
  /** Accumulated audio chunks */
  chunks: Blob[];
  /** Detected MIME type */
  mimeType: string;
  /** Source used for the active or finalized recording audio */
  source: RecordingAudioSource | null;
  /** Offset between the recording origin and the first audio sample on the editor timeline. */
  startOffsetMs: number;
  /** Known duration for external audio, in milliseconds */
  externalDurationMs: number | null;
}

/**
 * Camera state for instructor-face recording
 */
export interface CameraState {
  /** Camera blob from recording */
  blob: Blob | null;
  /** Whether camera recording is active */
  isRecording: boolean;
  /** Detected MIME type */
  mimeType: string;
  /** Source used for the active or finalized camera video */
  source: RecordingCameraSource | null;
  /**
   * Milliseconds between the recording-session origin (`session.startedAt`) and the moment the
   * camera actually started capturing. The camera spawns after `getUserMedia` resolves, so its
   * first frame lags the timeline origin by this warmup; playback subtracts it to stay in sync.
   */
  startOffsetMs: number;
}

/**
 * Local screen-recording state (opt-in, captured in parallel with the session).
 *
 * Deliberately minimal and fully separate from `CameraState`: the screen video is a
 * keep-forever local artifact and must never be folded into the `Recording`. There is no
 * `blob`/`source` field here — the blob exits the machine directly via `onScreenRecordingReady`
 * and is never retained on context. See the publish-safety guardrails in docs/video-plan.md.
 */
export interface ScreenState {
  /** Whether a screen recording is active (its actor has been spawned and started). */
  isRecording: boolean;
  /** Detected MIME type of the screen recording container. */
  mimeType: string;
  /**
   * Milliseconds between the recording-session origin (`session.startedAtPerf`) and the moment
   * the screen MediaRecorder actually started. Reported alongside the blob so a consumer could
   * later align the local video against the session timeline.
   */
  startOffsetMs: number;
}

/**
 * Editor references and decorations
 */
export interface EditorRefs {
  /** Monaco editor instance */
  editor: monaco.editor.IStandaloneCodeEditor | null;
  /** Current cursor decorations collection */
  cursorDecorationsCollection: monaco.editor.IEditorDecorationsCollection | null;
}

/**
 * Complete machine context
 */
export interface EditorMachineContext {
  /** Timeline state for playback */
  timeline: TimelineState;
  /** Current recording session (during recording) */
  session: RecordingSession | null;
  /**
   * Bumped whenever `session`'s arrays are mutated in place (append-only capture
   * buffer — see {@link RecordingSession}). `session` keeps a stable object identity
   * for the whole recording, so this is the only signal a reference-equality selector
   * can use to detect a capture-buffer change.
   */
  sessionRevision: number;
  /** Loaded recording data */
  recording: Recording | null;
  /** Stream-oriented track metadata for the finalized recording facade. */
  tracks?: RecordingTrackMeta[];
  /** Stream-oriented cluster metadata for the finalized recording facade. */
  clusters?: RecordingClusterMeta[];
  /** Stream-oriented media fragment metadata for the finalized recording facade. */
  mediaFragments?: RecordingMediaFragment[];
  /** Current frame being displayed */
  currentFrame: EditorFrame | null;
  /** Audio state */
  audio: AudioState;
  /** Camera state */
  camera: CameraState;
  /** Local screen-recording state (opt-in; blob never persisted to context). */
  screen: ScreenState;
  /**
   * Display capture stream acquired at record-button click time (transient-activation
   * constraint), carried on the START_RECORDING event. Owned by the screen actor once spawned;
   * held here only across the arming gap so abort paths can release it. Null when screen
   * recording is off or after the actor has taken ownership/finished.
   */
  screenStream: MediaStream | null;
  /** Editor references */
  editorRefs: EditorRefs;
  /** Getter for the live Monaco editor instance */
  getEditorInstance: () => monaco.editor.IStandaloneCodeEditor | null;
  /** Whether audio recording is enabled */
  enableAudioRecording: boolean;
  /** Whether camera recording is enabled */
  enableCameraRecording: boolean;
  /** Whether to pause on user interaction */
  pauseOnUserInteraction: boolean;
  /** Animation frame ID for playback loop */
  animationFrameId: number | null;
  /** Error message if any */
  error: string | null;
  /** Callback to apply slide state during playback */
  applySlideState?: (slideState: SlidePreviewState, currentSlideIndex: number) => void;
  /** Callback to apply slides data during playback */
  applySlides?: (slides: Slide[]) => void;
  /** Callback to apply preview state during playback */
  applyPreviewState?: (previewState: PreviewState) => void;
  /** Callback to apply preview DOM patches during playback */
  applyPreviewPatchReplay?: (input: PreviewPatchReplayInput) => number;
  /** Callback to get slide state during recording */
  getSlideState?: () => {
    previewState: SlidePreviewState;
    currentSlideIndex: number;
  } | null;
  /** Callback to get slides data during recording */
  getSlides?: () => Slide[];
  /** Callback to get preview state during recording */
  getPreviewState?: () => PreviewState | null;
  /** Callback to get workspace snapshot during recording */
  getWorkspaceSnapshot?: () => WorkspaceRecordingSnapshot | null;
  /** Callback to apply workspace snapshot when loading a recording */
  applyWorkspaceSnapshot?: (snapshot: WorkspaceRecordingSnapshot) => void;
  /** Callback to get runtime snapshot during recording */
  getRuntimeSnapshot?: () => RuntimeRecordingSnapshot | null;
  /** Callback to apply runtime snapshot during playback */
  applyRuntimeSnapshot?: (snapshot: RuntimeRecordingSnapshot) => void;
  /** Callback to get whiteboard scene state during recording */
  getWhiteboardState?: () => WhiteboardSceneState | null;
  /** Callback to apply whiteboard scene state during playback */
  applyWhiteboardState?: (state: WhiteboardSceneState) => void;
  /** Index of the last applied frame during playback */
  lastAppliedFrameIndex: number;
  /** Index of the last applied preview event during playback */
  lastAppliedPreviewEventIndex: number;
  /** Index of the last applied preview patch batch during playback */
  lastAppliedPreviewPatchBatchIndex: number;
  /** Index of the last applied slide event during playback */
  lastAppliedSlideEventIndex: number;
  /** Index of the last applied workspace event during playback */
  lastAppliedWorkspaceEventIndex: number;
  /** Index of the last applied runtime event during playback */
  lastAppliedRuntimeEventIndex: number;
  /** Index of the last applied whiteboard event during playback */
  lastAppliedWhiteboardEventIndex: number;
  /** Last applied preview state to avoid redundant updates */
  lastAppliedPreviewState?: PreviewState;
  /** Last time (performance.now()) audio was synced */
  lastSyncTime?: number;
  /** Recorded frame state at the moment of pause - used to restore on resume */
  recordedFrameAtPause?: EditorFrame | null;
  /** Whether manual workspace changes should suppress recorded workspace replay */
  hasManualWorkspaceOverride: boolean;
  /** Whether the next editor mount should resync playback state */
  pendingPlaybackEditorSync: boolean;
  /** Whether the playback audio element has been spawned for the loaded recording */
  playbackAudioSpawned: boolean;
  /** Last frame timestamp sent to granular callbacks */
  lastCallbackFrameTimestamp?: number;
  /** Callback invoked after recording starts */
  onRecordingStart?: () => void;
  /** Callback invoked after recording stops */
  onRecordingStop?: (recording: Recording) => void;
  /** Callback invoked after playback starts */
  onPlaybackStart?: () => void;
  /** Callback invoked after playback pauses */
  onPlaybackPause?: () => void;
  /** Callback invoked after playback ends */
  onPlaybackEnd?: () => void;
  /** Callback invoked after seeking */
  onSeek?: (time: number) => void;
  /** Callback invoked after machine errors */
  onError?: (error: Error) => void;
  /** Callback invoked after a frame is captured */
  onFrame?: (frame: EditorFrame) => void;
  /** Callback invoked after editor state changes */
  onStateChange?: (state: EditorFrame["state"]) => void;
  /** Callback invoked after playback time/frame updates */
  onPlaybackUpdate?: (currentTime: number, frame: EditorFrame | null) => void;
  /** Callback invoked once a local screen recording finishes assembling (local-save only). */
  onScreenRecordingReady?: (payload: ScreenRecordingReadyPayload) => void;
}

// ============================================================================
// Machine Events
// ============================================================================

/** Start recording event */
export type StartRecordingEvent = {
  type: "START_RECORDING";
  audioUrl?: string;
  enableCamera?: boolean;
  /** Pre-acquired display capture stream (opt-in screen recording); undefined when off. */
  screenStream?: MediaStream;
};

/** Stop recording event */
export type StopRecordingEvent = { type: "STOP_RECORDING" };

/** Capture a frame during recording */
export type CaptureFrameEvent = {
  type: "CAPTURE_FRAME";
  isMouseMovement?: boolean;
  mousePosition?: MouseCursorPosition;
};

/** Load a recording for playback */
export type LoadRecordingEvent = {
  type: "LOAD_RECORDING";
  recording: Recording;
};

/**
 * Replace the loaded recording in place with a longer prefix of the same stream (streaming
 * playback). The new recording must be an append-only superset of the current one, so already
 * applied playback indices stay valid; the current time, timeline, and applied state are kept.
 */
export type ExtendRecordingEvent = {
  type: "EXTEND_RECORDING";
  recording: Recording;
};

/** Recording loaded successfully */
export type RecordingLoadedEvent = {
  type: "RECORDING_LOADED";
  recording: Recording;
  duration: number;
};

/** Recording load failed */
export type LoadFailedEvent = {
  type: "LOAD_FAILED";
  error: string;
};

/** Unload current recording */
export type UnloadEvent = { type: "UNLOAD" };

/** Start playback */
export type PlayEvent = { type: "PLAY" };

/** Pause playback */
export type PauseEvent = { type: "PAUSE" };

/** Stop playback and reset */
export type StopEvent = { type: "STOP" };

/** Seek to specific time */
export type SeekEvent = {
  type: "SEEK";
  time: number;
};

/** Set playback speed */
export type SetSpeedEvent = {
  type: "SET_SPEED";
  speed: number;
};

/** Set volume */
export type SetVolumeEvent = {
  type: "SET_VOLUME";
  volume: number;
};

/** Playback tick event (from animation frame) */
export type TickEvent = {
  type: "TICK";
  timestamp: number;
  currentTime: number;
};

/** Playback reached the end */
export type FinishedEvent = { type: "FINISHED" };

/** Audio actor stopped event */
export type AudioActorStoppedEvent = {
  type: "STOPPED";
  blob: Blob;
};

/** Audio playback actor loaded metadata */
export type AudioPlaybackReadyEvent = {
  type: "READY";
  duration: number;
};

/** Audio actor started event */
export type AudioActorStartedEvent = {
  type: "STARTED";
  mediaRecorder: MediaRecorder;
  mimeType: string;
  startedAtMs: number;
  startedAtPerf: number;
};

/** Audio actor error event */
export type AudioActorErrorEvent = {
  type: "ERROR";
  error: string;
};

/** User interaction during playback */
export type UserInteractionEvent = { type: "USER_INTERACTION" };

/** Start signal for actors */
export type StartEvent = { type: "START" };

/** Stop signal for actors */
export type StopEventSignal = { type: "STOP" };

/** Update editor reference */
export type SetEditorRefEvent = {
  type: "SET_EDITOR_REF";
  editor: monaco.editor.IStandaloneCodeEditor | null;
};

/** Slide event occurred */
export type SlideEventOccurred = {
  type: "SLIDE_EVENT";
  event: SlideEvent;
};

/** Preview event occurred */
export type PreviewEventOccurred = {
  type: "PREVIEW_EVENT";
  event: PreviewEvent;
};

/** Initial preview document recorded */
export type PreviewInitialDocumentOccurred = {
  type: "PREVIEW_INITIAL_DOCUMENT";
  document: PreviewInitialDocument;
};

/** Preview DOM patch batch recorded */
export type PreviewPatchBatchOccurred = {
  type: "PREVIEW_PATCH_BATCH";
  batch: PreviewDomPatchBatch;
};

/** Workspace event occurred */
export type WorkspaceEventOccurred = {
  type: "WORKSPACE_EVENT";
  sidebarWidthDelta?: number;
  previewDockWidthDelta?: number;
};

/** Runtime event occurred */
export type RuntimeEventOccurred = {
  type: "RUNTIME_EVENT";
};

/** Whiteboard event occurred */
export type WhiteboardEventOccurred = {
  type: "WHITEBOARD_EVENT";
  event: WhiteboardEvent;
};

/** Audio chunk received */
export type AudioChunkEvent = {
  type: "CHUNK";
  chunk: Blob;
  startTimeMs: number;
  endTimeMs: number;
};

/** Camera actor started event */
export type CameraActorStartedEvent = {
  type: "CAMERA_STARTED";
  mimeType: string;
  startedAtMs: number;
  startedAtPerf: number;
};

/** Camera chunk received */
export type CameraChunkEvent = {
  type: "CAMERA_CHUNK";
  chunk: Blob;
  startTimeMs: number;
  endTimeMs: number;
};

/** Camera actor stopped event */
export type CameraActorStoppedEvent = { type: "CAMERA_STOPPED"; blob: Blob };

/** Camera actor error event */
export type CameraActorErrorEvent = { type: "CAMERA_ERROR"; error: string };

/** Screen actor started event */
export type ScreenActorStartedEvent = {
  type: "SCREEN_STARTED";
  mimeType: string;
  startedAtMs: number;
  startedAtPerf: number;
};

/** Screen actor stopped event (blob exits via onScreenRecordingReady, never persisted). */
export type ScreenActorStoppedEvent = { type: "SCREEN_STOPPED"; blob: Blob };

/** Screen actor error event */
export type ScreenActorErrorEvent = { type: "SCREEN_ERROR"; error: string };

/** Add or replace a caption track on the loaded recording */
export type AddCaptionTrackEvent = {
  type: "ADD_CAPTION_TRACK";
  track: CaptionTrack;
};

/** Remove a caption track from the loaded recording */
export type RemoveCaptionTrackEvent = {
  type: "REMOVE_CAPTION_TRACK";
  trackId: string;
};

/**
 * Union of all machine events
 */
export type EditorMachineEvent =
  | StartRecordingEvent
  | StopRecordingEvent
  | CaptureFrameEvent
  | LoadRecordingEvent
  | ExtendRecordingEvent
  | RecordingLoadedEvent
  | LoadFailedEvent
  | UnloadEvent
  | PlayEvent
  | PauseEvent
  | StopEvent
  | SeekEvent
  | SetSpeedEvent
  | SetVolumeEvent
  | TickEvent
  | FinishedEvent
  | UserInteractionEvent
  | SetEditorRefEvent
  | SlideEventOccurred
  | PreviewEventOccurred
  | PreviewInitialDocumentOccurred
  | PreviewPatchBatchOccurred
  | WorkspaceEventOccurred
  | RuntimeEventOccurred
  | WhiteboardEventOccurred
  | AudioChunkEvent
  | CameraActorStartedEvent
  | CameraChunkEvent
  | CameraActorStoppedEvent
  | CameraActorErrorEvent
  | ScreenActorStartedEvent
  | ScreenActorStoppedEvent
  | ScreenActorErrorEvent
  | AddCaptionTrackEvent
  | RemoveCaptionTrackEvent
  | AudioPlaybackReadyEvent
  | AudioActorStoppedEvent
  | AudioActorStartedEvent
  | AudioActorErrorEvent
  | StartEvent
  | StopEventSignal;

// ============================================================================
// Machine Input (Configuration)
// ============================================================================

/**
 * Input provided when creating the machine
 */
export interface EditorMachineInput {
  /** Monaco editor ref */
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  /** Enable audio recording */
  enableAudioRecording?: boolean;
  /** Enable camera recording */
  enableCameraRecording?: boolean;
  /** Pause playback on user interaction */
  pauseOnUserInteraction?: boolean;
  /** Default playback speed */
  defaultPlaybackSpeed?: number;
  /** Callbacks */
  onRecordingStart?: () => void;
  onRecordingStop?: (recording: Recording) => void;
  onPlaybackStart?: () => void;
  onPlaybackPause?: () => void;
  onPlaybackEnd?: () => void;
  onSeek?: (time: number) => void;
  onError?: (error: Error) => void;
  onFrame?: (frame: EditorFrame) => void;
  onStateChange?: (state: EditorFrame["state"]) => void;
  onPlaybackUpdate?: (currentTime: number, frame: EditorFrame | null) => void;
  onScreenRecordingReady?: (payload: ScreenRecordingReadyPayload) => void;
  onSlideEvent?: (event: SlideEvent) => void;
  getSlideState?: () => {
    previewState: SlidePreviewState;
    currentSlideIndex: number;
  } | null;
  applySlideState?: (slideState: SlidePreviewState, currentSlideIndex: number) => void;
  getSlides?: () => Slide[];
  applySlides?: (slides: Slide[]) => void;
  onPreviewEvent?: (event: PreviewEvent) => void;
  getPreviewState?: () => PreviewState | null;
  applyPreviewState?: (previewState: PreviewState) => void;
  applyPreviewPatchReplay?: (input: PreviewPatchReplayInput) => number;
  getWorkspaceSnapshot?: () => WorkspaceRecordingSnapshot | null;
  applyWorkspaceSnapshot?: (snapshot: WorkspaceRecordingSnapshot) => void;
  getRuntimeSnapshot?: () => RuntimeRecordingSnapshot | null;
  applyRuntimeSnapshot?: (snapshot: RuntimeRecordingSnapshot) => void;
  getWhiteboardState?: () => WhiteboardSceneState | null;
  applyWhiteboardState?: (state: WhiteboardSceneState) => void;
}

// ============================================================================
// Helper Types
// ============================================================================

export type { EditorSelection, EditorPosition };

/**
 * Initial context factory
 */
export const createInitialContext = (input: EditorMachineInput): EditorMachineContext => ({
  timeline: {
    currentTime: 0,
    duration: 0,
    speed: input.defaultPlaybackSpeed ?? 1,
    volume: 1,
    startedAt: 0,
    pausedDuration: 0,
    pausedAt: 0,
  },
  session: null,
  sessionRevision: 0,
  recording: null,
  currentFrame: null,
  audio: {
    url: null,
    blob: null,
    element: null,
    isRecording: false,
    mediaRecorder: null,
    chunks: [],
    mimeType: "",
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
  screen: {
    isRecording: false,
    mimeType: "",
    startOffsetMs: 0,
  },
  screenStream: null,
  editorRefs: {
    editor: input.editorRef.current,
    cursorDecorationsCollection: null,
  },
  getEditorInstance: () => input.editorRef.current,
  enableAudioRecording: input.enableAudioRecording ?? false,
  enableCameraRecording: input.enableCameraRecording ?? false,
  pauseOnUserInteraction: input.pauseOnUserInteraction ?? true,
  animationFrameId: null,
  error: null,
  hasManualWorkspaceOverride: false,
  pendingPlaybackEditorSync: false,
  playbackAudioSpawned: false,
  lastCallbackFrameTimestamp: undefined,
  lastAppliedFrameIndex: -1,
  lastAppliedPreviewEventIndex: -1,
  lastAppliedPreviewPatchBatchIndex: -1,
  lastAppliedSlideEventIndex: -1,
  lastAppliedWorkspaceEventIndex: -1,
  lastAppliedRuntimeEventIndex: -1,
  lastAppliedWhiteboardEventIndex: -1,
  lastAppliedPreviewState: undefined,
  applySlideState: input.applySlideState,
  applySlides: input.applySlides,
  getSlideState: input.getSlideState,
  getSlides: input.getSlides,
  applyPreviewState: input.applyPreviewState,
  applyPreviewPatchReplay: input.applyPreviewPatchReplay,
  getPreviewState: input.getPreviewState,
  getWorkspaceSnapshot: input.getWorkspaceSnapshot,
  applyWorkspaceSnapshot: input.applyWorkspaceSnapshot,
  getRuntimeSnapshot: input.getRuntimeSnapshot,
  applyRuntimeSnapshot: input.applyRuntimeSnapshot,
  getWhiteboardState: input.getWhiteboardState,
  applyWhiteboardState: input.applyWhiteboardState,
  onRecordingStart: input.onRecordingStart,
  onRecordingStop: input.onRecordingStop,
  onPlaybackStart: input.onPlaybackStart,
  onPlaybackPause: input.onPlaybackPause,
  onPlaybackEnd: input.onPlaybackEnd,
  onSeek: input.onSeek,
  onError: input.onError,
  onFrame: input.onFrame,
  onStateChange: input.onStateChange,
  onPlaybackUpdate: input.onPlaybackUpdate,
  onScreenRecordingReady: input.onScreenRecordingReady,
});
