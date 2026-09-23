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
  RecordingStreamDelta,
  EditorSelection,
  RecordingAudioSource,
  RecordingCameraSource,
  PreviewPatchReplayInput,
  ScreenRecordingReadyPayload,
} from "../types";
import type { DeltaFrame } from "../utils/deltaTypes";
import type { FrameStreamEncoderState } from "../utils/frameStreamEncoder";
import type { RuntimeRecordingEvent, RuntimeRecordingSnapshot } from "../../../types/runtime";
import type { WorkspaceRecordingEvent, WorkspaceRecordingSnapshot } from "../../../types/workspace";
import type { WhiteboardEvent, WhiteboardSceneState } from "../whiteboard";
import type { RuntimeCheckpointProgress } from "../runtimeTrack";
import type { ChatCheckpoint, ChatRecordingEvent } from "../../../types/chat";
import type { TextEditEvent } from "../../../types/textEdit";
import type { CapturedViewStateRef } from "./editorMachineHelpers";
import type { AudioPlaybackEmit, AudioRecordingEmit } from "./audioActor";
import type { CameraRecordingEmit } from "./cameraActor";
import type { ScreenRecordingEmit } from "./screenActor";
import { normalizePlaybackSpeed } from "./playbackValues";

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
}

/**
 * Recording session state.
 *
 * This is a mutable capture buffer: its object identity — and the identity of every
 * array field below — stays stable for the whole recording. Appenders push in place
 * rather than spreading into a new array/object, so capture cost is O(1) instead of
 * O(session-so-far) per sample. Arrays are append-only during a session; only indices
 * `<= length` observed at read time are stable, so code that reads a session while it
 * records must keep its own read cursor; snapshots share these arrays and cannot be diffed.
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
  /** Collected runtime events during recording (checkpoints + terminal-output deltas) */
  runtimeEvents: RuntimeRecordingEvent[];
  /**
   * Resolved state of the last runtime event, so the next one can be diffed and
   * deduped without folding the track. Absent when the session began with no
   * runtime snapshot; `appendRuntimeRecordingEvent` then resolves it from the track.
   */
  lastRuntimeSnapshot?: RuntimeRecordingSnapshot;
  /** Where the runtime track stands against its next checkpoint (see runtimeTrack.ts). */
  runtimeCheckpointProgress?: RuntimeCheckpointProgress;
  /** High-cadence fake cursor samples during recording */
  cursorEvents: CursorRecordingEvent[];
  /** Collected whiteboard change events during recording */
  whiteboardEvents: WhiteboardEvent[];
  /** Collected coding-agent chat deltas + sparse checkpoints during recording */
  chatEvents: ChatRecordingEvent[];
  /** Last known mouse position */
  lastMousePosition: MouseCursorPosition;
  /**
   * `saveViewState()` result from the last captured frame plus the scalars it was
   * derived from (content version, model, scroll, selection, position). When a
   * new capture's scalars all match, `createFrame` reuses the `viewState` object
   * by reference instead of calling `editor.saveViewState()` again — see
   * `CapturedViewStateRef` in `editorMachineHelpers.ts`.
   *
   * Its `versionId` and `modelUri` also identify the model that last captured frame's
   * `state.content` was read from (see `currentFrame` on the machine context). When a
   * new capture's version id AND model URI both match, the content string is reused
   * by reference instead of re-reading `editor.getValue()`. Version ids are a
   * per-model counter, so the URI must match too — otherwise a file switch
   * between captures (same numeric version id, different model) would silently
   * reuse the previous file's content.
   */
  lastCapturedViewStateRef?: CapturedViewStateRef;
}

/**
 * Audio state for recording and playback
 */
export interface AudioState {
  /** Audio blob from recording */
  blob: Blob | null;
  /** Whether audio recording is active */
  isRecording: boolean;
  /** MediaRecorder instance */
  mediaRecorder: MediaRecorder | null;
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
  /** Unique XState child id for this capture; late events use it to retire only their origin. */
  actorId: string | null;
  /** Whether a screen recording is active (its actor has been spawned and started). */
  isRecording: boolean;
  /** Detected MIME type of the screen recording container. */
  mimeType: string;
  /**
   * Whether the capture mixed any audio track. False means a silent video: the browser returned
   * no display/tab audio and no microphone track was supplied (e.g. a screen/window share, or a
   * tab shared with "share tab audio" off). Consumers surface this so a "narration included"
   * promise is not made for a file that has none.
   */
  hasAudio: boolean;
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
  /** Last append-only SCR delta cursor accepted for the loaded recording. */
  recordingStreamCursor: number;
  /** Current frame being displayed */
  currentFrame: EditorFrame | null;
  /** Audio state */
  audio: AudioState;
  /** Camera state */
  camera: CameraState;
  /** Local screen-recording state (opt-in; blob never persisted to context). */
  screen: ScreenState;
  /** Per-machine sequence used to allocate collision-free screen-recorder child ids. */
  screenRecorderGeneration: number;
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
  /**
   * Configured camera default (machine input). A START_RECORDING without `enableCamera` falls
   * back to this, never to a previous take's choice.
   */
  defaultEnableCameraRecording: boolean;
  /** Whether to pause on user interaction */
  pauseOnUserInteraction: boolean;
  /** Error message if any */
  error: string | null;
  /** Callback to apply slide state during playback */
  applySlideState?: (slideState: SlidePreviewState, currentSlideIndex: number) => void;
  /** Callback to apply slides data during playback */
  applySlides?: (slides: Slide[]) => void;
  /** Callback to apply preview state during playback */
  applyPreviewState?: (previewState: PreviewState) => void;
  /** Callback to apply preview DOM patches during playback */
  applyPreviewPatchReplay?: (input: PreviewPatchReplayInput) => void;
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
  /** Callback to apply the folded chat transcript during playback (replayState/chat.ts) */
  applyChatSnapshot?: (snapshot: ChatCheckpoint) => void;
  /** Callback to get whiteboard scene state during recording */
  getWhiteboardState?: () => WhiteboardSceneState | null;
  /** Callback to apply whiteboard scene state during playback */
  applyWhiteboardState?: (state: WhiteboardSceneState) => void;
  /** Index of the last applied frame during playback */
  lastAppliedFrameIndex: number;
  /** Index of the last applied preview event during playback */
  lastAppliedPreviewEventIndex: number;
  /** Index of the last applied slide event during playback */
  lastAppliedSlideEventIndex: number;
  /** Index of the last applied workspace event during playback */
  lastAppliedWorkspaceEventIndex: number;
  /** Index of the last applied runtime event during playback */
  lastAppliedRuntimeEventIndex: number;
  /** Index of the last applied whiteboard event during playback */
  lastAppliedWhiteboardEventIndex: number;
  /** Index of the last applied chat event during playback */
  lastAppliedChatEventIndex: number;
  /** Last applied preview state to avoid redundant updates */
  lastAppliedPreviewState?: PreviewState;
  /** Last time (performance.now()) audio was synced */
  lastSyncTime?: number;
  /** Whether manual workspace changes should suppress recorded workspace replay */
  hasManualWorkspaceOverride: boolean;
  /** Whether the next editor mount should resync playback state */
  pendingPlaybackEditorSync: boolean;
  /** Whether the playback audio element has been spawned for the loaded recording */
  playbackAudioSpawned: boolean;
  /** Callback invoked after recording starts */
  onRecordingStart?: () => void;
  /** Callback invoked after recording stops */
  onRecordingStop?: (recording: Recording) => void;
  /** Callback invoked after seeking */
  onSeek?: (time: number) => void;
  /** Callback invoked after machine errors */
  onError?: (error: Error) => void;
  /** Callback invoked once a local screen recording finishes assembling (local-save only). */
  onScreenRecordingReady?: (payload: ScreenRecordingReadyPayload) => void;
}

// ============================================================================
// Machine Events
// ============================================================================

/** Start recording event */
export type StartRecordingEvent = {
  type: "START_RECORDING";
  /** User-selected audio file to play while recording and retain for immediate playback/export. */
  audioBlob?: Blob;
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
  /** Exact local Monaco edits when this capture immediately follows them. */
  textEdit?: TextEditEvent;
  /**
   * Records another collaborator's caret/selection without moving the local
   * Monaco editor. The recording still captures the local editor's current
   * content and viewport.
   */
  selection?: EditorSelection;
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

/** Append only the newly decoded records from a growing SCR stream. */
export type AppendRecordingDeltaEvent = {
  type: "APPEND_RECORDING_DELTA";
  delta: RecordingStreamDelta;
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
  currentTime: number;
};

/** Playback reached the end */
export type FinishedEvent = { type: "FINISHED" };

/** User interaction during playback */
export type UserInteractionEvent = { type: "USER_INTERACTION" };

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

/** Coding-agent chat delta or checkpoint occurred */
export type ChatEventOccurred = {
  type: "CHAT_EVENT";
  event: ChatRecordingEvent["event"];
};

/**
 * Add or replace a caption track on the recording `recordingId`; dropped when another
 * recording is loaded
 */
export type AddCaptionTrackEvent = {
  type: "ADD_CAPTION_TRACK";
  recordingId: string;
  track: CaptionTrack;
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
  | AppendRecordingDeltaEvent
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
  | ChatEventOccurred
  | AddCaptionTrackEvent
  // What the child actors send back. Each actor owns its union, and fromTypedCallback
  // checks its sendBack calls against it.
  | AudioRecordingEmit
  | AudioPlaybackEmit
  | CameraRecordingEmit
  | ScreenRecordingEmit;

// ============================================================================
// Machine Input (Configuration)
// ============================================================================

/**
 * Input provided when creating the machine. NextEditorProvider builds it from the app's
 * stores and passes it as the editor actor's `input`.
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
  onSeek?: (time: number) => void;
  onError?: (error: Error) => void;
  /**
   * Invoked once a local screen recording (opt-in, captured in parallel with the session)
   * finishes assembling. The blob is saved to the user's disk only and never enters the
   * `Recording`, `.ne` codec, storage, or any upload path — see `saveScreenRecordingLocally`.
   */
  onScreenRecordingReady?: (payload: ScreenRecordingReadyPayload) => void;
  getSlideState?: () => {
    previewState: SlidePreviewState;
    currentSlideIndex: number;
  } | null;
  applySlideState?: (slideState: SlidePreviewState, currentSlideIndex: number) => void;
  getSlides?: () => Slide[];
  applySlides?: (slides: Slide[]) => void;
  getPreviewState?: () => PreviewState | null;
  applyPreviewState?: (previewState: PreviewState) => void;
  applyPreviewPatchReplay?: (input: PreviewPatchReplayInput) => void;
  getWorkspaceSnapshot?: () => WorkspaceRecordingSnapshot | null;
  applyWorkspaceSnapshot?: (snapshot: WorkspaceRecordingSnapshot) => void;
  getRuntimeSnapshot?: () => RuntimeRecordingSnapshot | null;
  applyRuntimeSnapshot?: (snapshot: RuntimeRecordingSnapshot) => void;
  /**
   * Chat (coding-agent) replay: folded from the nearest checkpoint, not a "latest
   * snapshot" like runtime/workspace; see replayState/chat.ts.
   */
  applyChatSnapshot?: (snapshot: ChatCheckpoint) => void;
  getWhiteboardState?: () => WhiteboardSceneState | null;
  applyWhiteboardState?: (state: WhiteboardSceneState) => void;
}

// ============================================================================
// Context Factories
// ============================================================================

// Idle media slices. Factories rather than shared constants: each call returns a new
// object, so no two contexts or takes alias one slice.

export const createIdleAudioState = (): AudioState => ({
  blob: null,
  isRecording: false,
  mediaRecorder: null,
  mimeType: "",
  source: null,
  startOffsetMs: 0,
  externalDurationMs: null,
});

export const createIdleCameraState = (): CameraState => ({
  blob: null,
  isRecording: false,
  mimeType: "",
  source: null,
  startOffsetMs: 0,
});

export const createIdleScreenState = (): ScreenState => ({
  actorId: null,
  isRecording: false,
  mimeType: "",
  hasAudio: false,
  startOffsetMs: 0,
});

/**
 * Initial context factory
 */
export const createInitialContext = (input: EditorMachineInput): EditorMachineContext => ({
  timeline: {
    currentTime: 0,
    duration: 0,
    speed: normalizePlaybackSpeed(input.defaultPlaybackSpeed ?? 1),
    volume: 1,
  },
  session: null,
  sessionRevision: 0,
  recording: null,
  recordingStreamCursor: 0,
  currentFrame: null,
  audio: createIdleAudioState(),
  camera: createIdleCameraState(),
  screen: createIdleScreenState(),
  screenRecorderGeneration: 0,
  screenStream: null,
  editorRefs: {
    editor: input.editorRef.current,
    cursorDecorationsCollection: null,
  },
  getEditorInstance: () => input.editorRef.current,
  enableAudioRecording: input.enableAudioRecording ?? false,
  enableCameraRecording: input.enableCameraRecording ?? false,
  defaultEnableCameraRecording: input.enableCameraRecording ?? false,
  pauseOnUserInteraction: input.pauseOnUserInteraction ?? true,
  error: null,
  hasManualWorkspaceOverride: false,
  pendingPlaybackEditorSync: false,
  playbackAudioSpawned: false,
  lastAppliedFrameIndex: -1,
  lastAppliedPreviewEventIndex: -1,
  lastAppliedSlideEventIndex: -1,
  lastAppliedWorkspaceEventIndex: -1,
  lastAppliedRuntimeEventIndex: -1,
  lastAppliedWhiteboardEventIndex: -1,
  lastAppliedChatEventIndex: -1,
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
  applyChatSnapshot: input.applyChatSnapshot,
  getWhiteboardState: input.getWhiteboardState,
  applyWhiteboardState: input.applyWhiteboardState,
  onRecordingStart: input.onRecordingStart,
  onRecordingStop: input.onRecordingStop,
  onSeek: input.onSeek,
  onError: input.onError,
  onScreenRecordingReady: input.onScreenRecordingReady,
});
