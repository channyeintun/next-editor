import type * as monaco from "monaco-editor";
import type {
  PreviewDomPatchBatch,
  PreviewEvent,
  PreviewInitialDocument,
  PreviewState,
  Slide,
  SlideEvent,
  SlidePreviewState,
} from "./slides";
import type { TimelineActorRef } from "./machine/timelineMachine";
import type { EditorActorRef } from "./useNextEditor";
import type { RuntimeRecordingEvent, RuntimeRecordingSnapshot } from "../../types/runtime";
import type { WorkspaceRecordingEvent, WorkspaceRecordingSnapshot } from "../../types/workspace";

/**
 * Audio storage placeholder for serialization
 */
export interface AudioPlaceholder {
  __audio_offset: number;
  __audio_size: number;
  __audio_type: string;
}

export type RecordingAudioSource = "microphone" | "external";
export type RecordingCameraSource = "camera";

export type RecordingTrackKind =
  | "editor"
  | "audio"
  | "camera"
  | "cursor"
  | "preview"
  | "workspace"
  | "runtime"
  | "slide";

export interface RecordingTrackMeta {
  id: string;
  kind: RecordingTrackKind;
  mimeType?: string;
  codec?: string;
  source?: RecordingAudioSource | RecordingCameraSource;
  startOffsetMs?: number;
  durationMs?: number;
}

export interface RecordingClusterMeta {
  index: number;
  startTimeMs: number;
  endTimeMs: number;
  containsKeyframe: boolean;
}

export interface RecordingMediaFragment {
  trackId: string;
  clusterIndex: number;
  startTimeMs: number;
  endTimeMs: number;
  bytes?: Uint8Array;
  byteLength?: number;
  isInit?: boolean;
  isKeyframe?: boolean;
}

export interface CameraPlaceholder {
  __camera_offset: number;
  __camera_size: number;
  __camera_type: string;
}

/**
 * Data-only type for monaco.Selection that includes both selection and range info.
 * This is compatible with monaco.ISelection and monaco.IRange.
 */
export type EditorSelection = monaco.ISelection & monaco.IRange;

/**
 * Data-only type for monaco.IPosition.
 */
export type EditorPosition = monaco.IPosition;

/**
 * Bounding box for the UI region that a cursor sample was recorded against.
 */
export interface CursorTargetRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Cursor coordinates relative to a stable UI region. Playback can use this
 * to remap a recorded position onto the current layout.
 */
export interface CursorTargetSnapshot {
  id: string;
  rect: CursorTargetRect;
  x: number;
  y: number;
}

export type CursorCoordinateSpace = "viewport" | "root";

export interface CursorTweenEndpoint {
  x: number;
  y: number;
  visible: boolean;
  coordinateSpace?: CursorCoordinateSpace;
  target?: CursorTargetSnapshot;
}

export interface CursorTweenSnapshot {
  from: CursorTweenEndpoint;
  to: CursorTweenEndpoint;
  progress: number;
}

/**
 * Mouse cursor position. New recordings use root-relative pixels; older
 * recordings omit coordinateSpace and remain viewport-relative.
 */
export interface MouseCursorPosition {
  x: number;
  y: number;
  visible: boolean; // Whether cursor is within editor bounds
  coordinateSpace?: CursorCoordinateSpace;
  flags?: number;
  hover?: string | null;
  angle?: number;
  pressure?: number;
  target?: CursorTargetSnapshot;
  tween?: CursorTweenSnapshot;
}

/**
 * Lightweight cursor sample used for smooth fake-cursor playback.
 */
export interface CursorRecordingEvent extends MouseCursorPosition {
  timestamp: number;
}

/**
 * Editor frame containing the complete state at a specific timestamp
 */
export interface EditorFrame {
  timestamp: number;
  state: {
    content: string;
    selection: EditorSelection;
    position: EditorPosition; // Text caret position
    viewState: monaco.editor.ICodeEditorViewState | null;
    mouseCursor?: MouseCursorPosition; // Mouse cursor position
    slideState?: SlidePreviewState; // Slide preview state
    currentSlideIndex?: number; // Current slide index
    previewState?: PreviewState; // Code preview panel state
  };
}

/**
 * Complete recording with metadata
 * Version 3: uses frames array with keyframe + delta compression plus
 * workspace and runtime snapshots for multi-file mode.
 */
export interface Recording {
  /** Recording schema version. Version 2 recordings remain supported on import. */
  version: 2 | 3;
  id: string;
  name: string;
  /** Delta compressed frames (keyframes + deltas) */
  frames: import("./utils/deltaTypes").DeltaFrame[];
  /** Keyframe interval for reconstruction */
  keyframeInterval: number;
  slideEvents?: SlideEvent[];
  previewEvents?: PreviewEvent[];
  previewInitialDocuments?: PreviewInitialDocument[];
  previewPatchBatches?: PreviewDomPatchBatch[];
  workspaceEvents?: WorkspaceRecordingEvent[];
  runtimeEvents?: RuntimeRecordingEvent[];
  cursorEvents?: CursorRecordingEvent[];
  slides?: Slide[];
  tracks?: RecordingTrackMeta[];
  clusters?: RecordingClusterMeta[];
  mediaFragments?: RecordingMediaFragment[];
  audioBlob?: Blob | AudioPlaceholder;
  audioSource?: RecordingAudioSource;
  /** Audio start offset (ms) between the recording origin and the first decodable audio byte. */
  audioStartOffsetMs?: number;
  cameraBlob?: Blob | CameraPlaceholder;
  cameraSource?: RecordingCameraSource;
  /** Camera warmup offset (ms) between the recording origin and the first camera frame. */
  cameraStartOffsetMs?: number;
  /**
   * Sibling video filename for camera stored outside the `.ne` (e.g. `recording-xyz.webm`).
   * When set, the stream carries no inline `cameraChunk` segments; the video lives in its own file.
   */
  cameraFile?: string;
  /**
   * Resolved URL for the external camera video — a hosted sibling URL or an object URL created
   * from an imported file. Preferred by playback so the browser range-streams the video directly.
   */
  cameraUrl?: string;
  /** True when a decoded SCR3 stream included its footer; false for a still-growing prefix. */
  streamFinalized?: boolean;
  workspaceSnapshot?: WorkspaceRecordingSnapshot;
  runtimeSnapshot?: RuntimeRecordingSnapshot;
  duration: number;
  createdAt: number;
}

/**
 * Sink for the live SCR3 recording byte stream (WebSocket / fetch ReadableStream /
 * callback). Receives append-only chunks as they are recorded and is closed when the
 * recording ends. The bytes form a valid SCR3 stream replayable via `decodeRecordingPrefix`.
 */
export interface RecordingStreamSink {
  write(bytes: Uint8Array): void | Promise<void>;
  close(): void | Promise<void>;
}

/**
 * Configuration options for useNextEditor hook
 */
export interface UseNextEditorConfig {
  // Required
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>;

  // Recording Options
  enableAudioRecording?: boolean;
  enableCameraRecording?: boolean;

  /**
   * Optional sink for live, stream-compatible recording. When provided, the SCR3 byte
   * stream produced while recording is forwarded here as it is captured, so a remote
   * consumer can tail and replay it with `decodeRecordingPrefix`. Inert when omitted.
   */
  recordingStreamSink?: RecordingStreamSink;

  // Playback Options
  pauseOnUserInteraction?: boolean;
  defaultPlaybackSpeed?: number;

  // Callbacks
  onRecordingStart?: () => void;
  onRecordingStop?: (recording: Recording) => void;
  onPlaybackStart?: () => void;
  onPlaybackPause?: () => void;
  onPlaybackEnd?: () => void;
  onSeek?: (time: number) => void;
  onError?: (error: Error) => void;

  // Granular callbacks
  onFrame?: (frame: EditorFrame) => void;
  onStateChange?: (state: EditorState) => void;
  onPlaybackUpdate?: (currentTime: number, frame: EditorFrame | null) => void;
  onSlideEvent?: (event: SlideEvent) => void;
  getSlideState?: () => {
    previewState: SlidePreviewState;
    currentSlideIndex: number;
  } | null;
  applySlideState?: (slideState: SlidePreviewState, currentSlideIndex: number) => void;

  // Preview state callbacks
  onPreviewEvent?: (event: PreviewEvent) => void;
  getPreviewState?: () => PreviewState | null;
  applyPreviewState?: (previewState: PreviewState) => void;
  applyPreviewPatchReplay?: (input: PreviewPatchReplayInput) => number;

  // Slides data callbacks
  getSlides?: () => Slide[];
  applySlides?: (slides: Slide[]) => void;

  // Workspace and runtime snapshots
  getWorkspaceSnapshot?: () => WorkspaceRecordingSnapshot | null;
  applyWorkspaceSnapshot?: (snapshot: WorkspaceRecordingSnapshot) => void;
  getRuntimeSnapshot?: () => RuntimeRecordingSnapshot | null;
  applyRuntimeSnapshot?: (snapshot: RuntimeRecordingSnapshot) => void;
}

export interface PreviewPatchReplayInput {
  recordingId: string;
  currentTime: number;
  isSeeking: boolean;
  initialDocuments: PreviewInitialDocument[];
  patchBatches: PreviewDomPatchBatch[];
  lastAppliedPatchBatchIndex: number;
}

/**
 * Editor state for external manipulation
 */
export interface EditorState {
  content: string;
  selection: EditorSelection;
  position: EditorPosition;
  viewState: monaco.editor.ICodeEditorViewState | null;
  mouseCursor?: MouseCursorPosition;
  slideState?: SlidePreviewState;
  currentSlideIndex?: number;
  previewState?: PreviewState;
}

/**
 * Return type of useNextEditor hook
 */
export interface UseNextEditorReturn {
  // Recording State
  isRecording: boolean;
  isRecordingAudio: boolean;
  recordingStartTime: number | null;

  // Playback State
  isPlaying: boolean;
  isPaused: boolean;
  hasEnded: boolean;
  timelineActor: TimelineActorRef | undefined;
  editorActor: EditorActorRef;
  playbackSpeed: number;
  volume: number;

  // Data
  currentRecording: Recording | null;
  actualDuration: number;

  // Recording Controls
  startRecording: (options?: { audioBlob?: Blob; enableCamera?: boolean }) => void;
  stopRecording: () => void;

  // Playback Controls
  play: () => void;
  pause: () => void;
  stop: () => void;
  seekTo: (time: number) => void;
  setPlaybackSpeed: (speed: number) => void;
  setVolume: (volume: number) => void;

  // Recording Management
  loadRecording: (recording: Recording) => void;
  extendRecording: (recording: Recording) => void;
  clearRecording: () => void;

  // Monaco Editor Integration
  syncEditorRef: (editor: monaco.editor.IStandaloneCodeEditor | null) => void;
  handleEditorChange: () => void;
  handleSlideEvent: (event: SlideEvent) => void;
  handlePreviewEvent: (event: PreviewEvent) => void;
  handlePreviewInitialDocument: (document: PreviewInitialDocument) => void;
  handlePreviewPatchBatch: (batch: PreviewDomPatchBatch) => void;
  handleWorkspaceEvent: (event?: { sidebarWidthDelta?: number }) => void;
  handleRuntimeEvent: () => void;

  // Helper functions
  getEditorState: () => EditorState | null;
  getFrame: (timestamp?: number) => EditorFrame | null;
}
