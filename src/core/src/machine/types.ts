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
  RecordingChapter,
  MouseCursorPosition,
  CursorRecordingEvent,
  EditorFrame,
  Recording,
  RecordingStreamDelta,
  EditorPosition,
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
import type { RecordingClock } from "./recordingClock";
import type { MediaSpan } from "../utils/mediaSpans";
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

/** Content string plus the model identity it was read at, for reuse across captures. */
export interface CapturedContentRef {
  value: string;
  versionId: number;
  /** `model.uri.toString()` — version ids are per-model counters, so identity requires both. */
  modelUri: string;
}

/**
 * `saveViewState()` result plus the cheap scalars that fully determine whether
 * it would come out identical if recomputed, for reuse across captures.
 */
export interface CapturedViewStateRef {
  value: monaco.editor.ICodeEditorViewState | null;
  versionId: number;
  modelUri: string;
  scrollTop: number;
  scrollLeft: number;
  selection: EditorSelection;
  position: EditorPosition;
}

/**
 * Recording session state.
 *
 * This is a mutable capture buffer: its object identity stays stable for the whole
 * recording. Appenders push into its track arrays in place rather than spreading into
 * a new array/object, so capture cost is O(1) instead of O(session-so-far) per sample.
 * Each track array is append-only until a retake, which replaces every track array
 * with a shorter copy (see retake.ts). So code that reads a session while it records
 * must keep its own read cursor per track: the array it read and the length it saw
 * (see RecordingDraftTrackWriter). A new array means the track was cut back and must
 * be read again from the start. Snapshots share these arrays and cannot be diffed.
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
  /**
   * Pauses the recorded time skips over (see recordingClock.ts). Replaced, never mutated,
   * so a selector sees a pause or resume. Read in-session timestamps through
   * `getRecordingTimestamp`, not `performance.now() - startedAtPerf`.
   */
  clock: RecordingClock;
  /**
   * Where a retake can rewind to, oldest first (see RecordingSafePoint). Replaced, never
   * mutated, so a selector sees a new one.
   */
  safePoints: readonly RecordingSafePoint[];
  /**
   * What retakes discarded from the recorders' files, in media time. The microphone and
   * camera keep recording across a retake (paused), so these spans are cut from the
   * narration when the take loads and mapped around in the camera video.
   */
  mediaCuts: readonly MediaSpan[];
  /** Chapters marked while recording, in order. Replaced, never mutated. */
  chapters: readonly RecordingChapter[];
  /**
   * Set by a retake until the preview recorder answers with a fresh full snapshot. The
   * patch batches in between describe a document the take no longer holds, so they are
   * dropped.
   */
  previewAwaitingCheckpoint?: boolean;
  /**
   * The raw wall stamp of that snapshot. Patch events stamped before it were queued
   * before the snapshot was taken, so they are dropped too.
   */
  previewCheckpointWall?: number;
  /**
   * Already-compressed frames built incrementally during capture. Append-only, except
   * that a retake replaces it (and every other track) with a shorter copy.
   */
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
   * `CapturedViewStateRef` above.
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
  /** The running camera MediaRecorder, for hosts that journal its chunks. */
  mediaRecorder: MediaRecorder | null;
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

/** The slide deck's state as a recording frame stores it. */
export interface SlideStateSnapshot {
  previewState: SlidePreviewState;
  currentSlideIndex: number;
}

/**
 * How the machine reads and drives the app around the editor. They arrive as machine
 * input and stay on the context as given; NextEditorProvider builds them from the app's
 * stores. Each is optional: without one, that part of the app is neither recorded nor
 * replayed.
 */
export interface EditorMachineHostHooks {
  // Reading the app.
  /** The slide deck's state, for each frame and the take's opening slide event. */
  getSlideState?: () => SlideStateSnapshot | null;
  /** The slides, stored with the finished recording. */
  getSlides?: () => Slide[];
  /** The preview panel's state. */
  getPreviewState?: () => PreviewState | null;
  /** The workspace: files, active file, sidebar. */
  getWorkspaceSnapshot?: () => WorkspaceRecordingSnapshot | null;
  /** The runtime: its status, output, terminals and preview. */
  getRuntimeSnapshot?: () => RuntimeRecordingSnapshot | null;
  /** The whiteboard scene. */
  getWhiteboardState?: () => WhiteboardSceneState | null;
  /** The live coding-agent conversation, recorded whole after a retake. */
  getChatCheckpoint?: () => ChatCheckpoint | null;
  /**
   * Asks the live preview for a fresh full snapshot: a retake discarded the part of the
   * preview stream the next patches would build on.
   */
  requestPreviewCheckpoint?: () => void;

  // Driving the app: during replay, and by a retake while recording.
  applySlideState?: (slideState: SlidePreviewState, currentSlideIndex: number) => void;
  /** The recording's own slides, applied when it loads. */
  applySlides?: (slides: Slide[]) => void;
  applyPreviewState?: (previewState: PreviewState) => void;
  /** Replays the preview's recorded DOM (rrweb) at a moment. */
  applyPreviewPatchReplay?: (input: PreviewPatchReplayInput) => void;
  applyWorkspaceSnapshot?: (snapshot: WorkspaceRecordingSnapshot) => void;
  applyRuntimeSnapshot?: (snapshot: RuntimeRecordingSnapshot) => void;
  /**
   * The chat (coding-agent) transcript, folded from the nearest checkpoint rather than
   * taken as a latest snapshot like runtime and workspace; see replayState/chat.ts.
   */
  applyChatSnapshot?: (snapshot: ChatCheckpoint) => void;
  applyWhiteboardState?: (state: WhiteboardSceneState) => void;

  // Notifications.
  onRecordingStart?: () => void;
  /** The finalized take, before it loads for playback. */
  onRecordingStop?: (recording: Recording) => void;
  /** Where a seek actually landed (clamped to the recording). */
  onSeek?: (time: number) => void;
  /**
   * Invoked with the viewer's own edits just before the recording replaces them, so
   * the app can keep them (see LearnerWorkspaceSave).
   */
  onLearnerWorkspaceSaved?: (save: LearnerWorkspaceSave) => void;
  /** Machine failures; without this hook they go to the console (reportMachineError). */
  onError?: (error: Error) => void;
  /**
   * Invoked once a local screen recording (opt-in, captured in parallel with the session)
   * finishes assembling. The blob is saved to the user's disk only and never enters the
   * `Recording`, `.ne` codec, storage, or any upload path — see `saveScreenRecordingLocally`.
   */
  onScreenRecordingReady?: (payload: ScreenRecordingReadyPayload) => void;
}

/**
 * Complete machine context
 */
export interface EditorMachineContext extends EditorMachineHostHooks {
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
  /** The microphone this take narrates with, from its START_RECORDING; null for the default. */
  microphoneDeviceId: string | null;
  /** Whether to pause on user interaction */
  pauseOnUserInteraction: boolean;
  /** Error message if any */
  error: string | null;
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
  /**
   * The recorded workspace as it was handed to the viewer — on load, on pause, at the
   * end — or as they had it when their edits were last saved. Anything the viewer
   * changes after that is theirs, and is saved through `onLearnerWorkspaceSaved`
   * before the recording takes the workspace back. Null while the recording owns it.
   */
  learnerWorkspaceBaseline: WorkspaceRecordingSnapshot | null;
  /** Whether the next editor mount should resync playback state */
  pendingPlaybackEditorSync: boolean;
  /** Whether the playback audio element has been spawned for the loaded recording */
  playbackAudioSpawned: boolean;
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
  /** The microphone to narrate with (a `deviceId`); the default one when absent. */
  microphoneDeviceId?: string;
};

/** Stop recording event */
type StopRecordingEvent = { type: "STOP_RECORDING" };

/**
 * Stop the take's clock and its recorders without ending it. Edits made while paused
 * are still captured, at the moment of the pause, so the take stays consistent.
 */
type PauseRecordingEvent = { type: "PAUSE_RECORDING" };

/** Run a paused take's clock and recorders again. */
type ResumeRecordingEvent = { type: "RESUME_RECORDING" };

/**
 * Discard everything recorded since the last safe point before now, put the editor back
 * the way it was there, and leave the take paused at that point.
 */
type RetakeRecordingEvent = { type: "RETAKE_RECORDING" };

/** Mark a chapter at the take's current moment, which a retake can also rewind to. */
type AddChapterMarkerEvent = { type: "ADD_CHAPTER_MARKER"; title?: string };

/** Replace the chapters of the loaded recording `recordingId`; dropped for any other. */
type SetChaptersEvent = {
  type: "SET_CHAPTERS";
  recordingId: string;
  chapters: RecordingChapter[];
};

/** Capture a frame during recording */
type CaptureFrameEvent = {
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
type LoadRecordingEvent = {
  type: "LOAD_RECORDING";
  recording: Recording;
};

/**
 * Replace the loaded recording in place with a longer prefix of the same stream (streaming
 * playback). The new recording must be an append-only superset of the current one, so already
 * applied playback indices stay valid; the current time, timeline, and applied state are kept.
 */
type ExtendRecordingEvent = {
  type: "EXTEND_RECORDING";
  recording: Recording;
};

/** Append only the newly decoded records from a growing SCR stream. */
type AppendRecordingDeltaEvent = {
  type: "APPEND_RECORDING_DELTA";
  delta: RecordingStreamDelta;
};

/** Unload current recording */
type UnloadEvent = { type: "UNLOAD" };

/** Start playback */
type PlayEvent = { type: "PLAY" };

/** Pause playback */
type PauseEvent = { type: "PAUSE" };

/** Stop playback and reset */
type StopEvent = { type: "STOP" };

/** Seek to specific time */
type SeekEvent = {
  type: "SEEK";
  time: number;
};

/** Set playback speed */
type SetSpeedEvent = {
  type: "SET_SPEED";
  speed: number;
};

/** Set volume */
type SetVolumeEvent = {
  type: "SET_VOLUME";
  volume: number;
};

/** Playback tick event (from animation frame) */
type TickEvent = {
  type: "TICK";
  currentTime: number;
};

/** Playback reached the end */
type FinishedEvent = { type: "FINISHED" };

/** User interaction during playback */
type UserInteractionEvent = { type: "USER_INTERACTION" };

/**
 * The viewer's edits to a lesson, saved before the recording took the workspace back
 * (resume, seek, stop, leaving the page). `recordingTime` is where in the lesson they
 * were made.
 */
export interface LearnerWorkspaceSave {
  recordingId: string;
  recordingTime: number;
  snapshot: WorkspaceRecordingSnapshot;
}

/** Save the viewer's edits now, if they have any (e.g. the page is being hidden). */
type PreserveLearnerWorkspaceEvent = { type: "PRESERVE_LEARNER_WORKSPACE" };

/** Bring back a saved version of the viewer's edits, at the point in the lesson it was made. */
type RestoreLearnerWorkspaceEvent = {
  type: "RESTORE_LEARNER_WORKSPACE";
  recordingTime: number;
  snapshot: WorkspaceRecordingSnapshot;
};

/** Internal second step of RESTORE_LEARNER_WORKSPACE, once the paused seek has landed. */
type ApplyLearnerWorkspaceEvent = {
  type: "APPLY_LEARNER_WORKSPACE";
  snapshot: WorkspaceRecordingSnapshot;
};

/** Update editor reference */
type SetEditorRefEvent = {
  type: "SET_EDITOR_REF";
  editor: monaco.editor.IStandaloneCodeEditor | null;
};

/** Slide event occurred */
type SlideEventOccurred = {
  type: "SLIDE_EVENT";
  event: SlideEvent;
};

/** Preview event occurred */
type PreviewEventOccurred = {
  type: "PREVIEW_EVENT";
  event: PreviewEvent;
};

/** Initial preview document recorded */
type PreviewInitialDocumentOccurred = {
  type: "PREVIEW_INITIAL_DOCUMENT";
  document: PreviewInitialDocument;
};

/** Preview DOM patch batch recorded */
type PreviewPatchBatchOccurred = {
  type: "PREVIEW_PATCH_BATCH";
  batch: PreviewDomPatchBatch;
};

/** Workspace event occurred */
type WorkspaceEventOccurred = {
  type: "WORKSPACE_EVENT";
  sidebarWidthDelta?: number;
  previewDockWidthDelta?: number;
};

/** Runtime event occurred */
type RuntimeEventOccurred = {
  type: "RUNTIME_EVENT";
};

/** Whiteboard event occurred */
type WhiteboardEventOccurred = {
  type: "WHITEBOARD_EVENT";
  event: WhiteboardEvent;
};

/** Coding-agent chat delta or checkpoint occurred */
type ChatEventOccurred = {
  type: "CHAT_EVENT";
  event: ChatRecordingEvent["event"];
};

/**
 * Add or replace a caption track on the recording `recordingId`; dropped when another
 * recording is loaded
 */
type AddCaptionTrackEvent = {
  type: "ADD_CAPTION_TRACK";
  recordingId: string;
  track: CaptionTrack;
};

/** Starting, pausing, retaking and stopping a take. */
type RecordingControlEvent =
  | StartRecordingEvent
  | StopRecordingEvent
  | PauseRecordingEvent
  | ResumeRecordingEvent
  | RetakeRecordingEvent
  | AddChapterMarkerEvent;

/** What the app reports while a take records. */
type CaptureEvent =
  | CaptureFrameEvent
  | SlideEventOccurred
  | PreviewEventOccurred
  | PreviewInitialDocumentOccurred
  | PreviewPatchBatchOccurred
  | WorkspaceEventOccurred
  | RuntimeEventOccurred
  | WhiteboardEventOccurred
  | ChatEventOccurred;

/** Loading a recording, growing it as it streams in, editing what sits outside its timeline. */
type LoadedRecordingEvent =
  | LoadRecordingEvent
  | ExtendRecordingEvent
  | AppendRecordingDeltaEvent
  | AddCaptionTrackEvent
  | SetChaptersEvent
  | UnloadEvent;

/** The player's controls, and what the timeline actor reports back. */
type PlaybackEvent =
  | PlayEvent
  | PauseEvent
  | StopEvent
  | SeekEvent
  | SetSpeedEvent
  | SetVolumeEvent
  | TickEvent
  | FinishedEvent
  | UserInteractionEvent;

/** Keeping and bringing back the viewer's own edits to a lesson. */
type LearnerWorkspaceEvent =
  | PreserveLearnerWorkspaceEvent
  | RestoreLearnerWorkspaceEvent
  | ApplyLearnerWorkspaceEvent;

/**
 * What the child actors send back. Each actor owns its union, and fromTypedCallback
 * checks its sendBack calls against it.
 */
type ChildActorEvent =
  | AudioRecordingEmit
  | AudioPlaybackEmit
  | CameraRecordingEmit
  | ScreenRecordingEmit;

/**
 * Union of all machine events
 */
export type EditorMachineEvent =
  | RecordingControlEvent
  | CaptureEvent
  | LoadedRecordingEvent
  | PlaybackEvent
  | LearnerWorkspaceEvent
  | SetEditorRefEvent
  | ChildActorEvent;

// ============================================================================
// Action Bodies
// ============================================================================

/**
 * What an action body in captureActions.ts or replayActions.ts reads. Those bodies are
 * wrapped as named actions in `setup()`, so `event` is the whole union and each body
 * narrows it itself (`if (event.type !== "X") return {}`).
 */
export interface EditorActionArgs {
  context: EditorMachineContext;
  event: EditorMachineEvent;
}

/** What an `assign` body returns: only the context fields it changes. */
export type EditorContextUpdate = Partial<EditorMachineContext>;

// ============================================================================
// Machine Input (Configuration)
// ============================================================================

/**
 * Input provided when creating the machine. NextEditorProvider builds it from the app's
 * stores and passes it as the editor actor's `input`.
 */
export interface EditorMachineInput extends EditorMachineHostHooks {
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
  mediaRecorder: null,
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
  microphoneDeviceId: null,
  pauseOnUserInteraction: input.pauseOnUserInteraction ?? true,
  error: null,
  hasManualWorkspaceOverride: false,
  learnerWorkspaceBaseline: null,
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
  requestPreviewCheckpoint: input.requestPreviewCheckpoint,
  getChatCheckpoint: input.getChatCheckpoint,
  onRecordingStart: input.onRecordingStart,
  onRecordingStop: input.onRecordingStop,
  onSeek: input.onSeek,
  onLearnerWorkspaceSaved: input.onLearnerWorkspaceSaved,
  onError: input.onError,
  onScreenRecordingReady: input.onScreenRecordingReady,
});
