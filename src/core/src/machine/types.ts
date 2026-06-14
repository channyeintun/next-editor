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
  MouseCursorPosition,
  CursorRecordingEvent,
  EditorFrame,
  Recording,
  EditorSelection,
  EditorPosition,
  RecordingAudioSource,
  PreviewPatchReplayInput,
} from "../types";
import type { RuntimeRecordingEvent, RuntimeRecordingSnapshot } from "../../../types/runtime";
import type { WorkspaceRecordingEvent, WorkspaceRecordingSnapshot } from "../../../types/workspace";

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
 * Recording session state
 */
export interface RecordingSession {
  /** When recording started (performance.now()) */
  startedAt: number;
  /** Collected frames during recording */
  frames: EditorFrame[];
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
  /** Last known mouse position */
  lastMousePosition: MouseCursorPosition;
}

/**
 * Audio state for recording and playback
 */
export interface AudioState {
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
  /** Known duration for external audio, in milliseconds */
  externalDurationMs: number | null;
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
  /** Loaded recording data */
  recording: Recording | null;
  /** Current frame being displayed */
  currentFrame: EditorFrame | null;
  /** Audio state */
  audio: AudioState;
  /** Editor references */
  editorRefs: EditorRefs;
  /** Getter for the live Monaco editor instance */
  getEditorInstance: () => monaco.editor.IStandaloneCodeEditor | null;
  /** Whether audio recording is enabled */
  enableAudioRecording: boolean;
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
}

// ============================================================================
// Machine Events
// ============================================================================

/** Start recording event */
export type StartRecordingEvent = { type: "START_RECORDING"; audioBlob?: Blob };

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
};

/** Runtime event occurred */
export type RuntimeEventOccurred = {
  type: "RUNTIME_EVENT";
};

/** Audio chunk received */
export type AudioChunkEvent = {
  type: "CHUNK";
  chunk: Blob;
};

/**
 * Union of all machine events
 */
export type EditorMachineEvent =
  | StartRecordingEvent
  | StopRecordingEvent
  | CaptureFrameEvent
  | LoadRecordingEvent
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
  | AudioChunkEvent
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
  recording: null,
  currentFrame: null,
  audio: {
    blob: null,
    element: null,
    isRecording: false,
    mediaRecorder: null,
    chunks: [],
    mimeType: "",
    source: null,
    externalDurationMs: null,
  },
  editorRefs: {
    editor: input.editorRef.current,
    cursorDecorationsCollection: null,
  },
  getEditorInstance: () => input.editorRef.current,
  enableAudioRecording: input.enableAudioRecording ?? false,
  pauseOnUserInteraction: input.pauseOnUserInteraction ?? true,
  animationFrameId: null,
  error: null,
  hasManualWorkspaceOverride: false,
  pendingPlaybackEditorSync: false,
  lastCallbackFrameTimestamp: undefined,
  lastAppliedFrameIndex: -1,
  lastAppliedPreviewEventIndex: -1,
  lastAppliedPreviewPatchBatchIndex: -1,
  lastAppliedSlideEventIndex: -1,
  lastAppliedWorkspaceEventIndex: -1,
  lastAppliedRuntimeEventIndex: -1,
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
});
