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
import type { RuntimeRecordingEvent, RuntimeRecordingSnapshot } from "../../types/runtime";
import type {
  WorkspaceRecordingAsset,
  WorkspaceRecordingEvent,
  WorkspaceRecordingSnapshot,
} from "../../types/workspace";
import type { WhiteboardEvent } from "./whiteboard";
import type { ChatRecordingEvent } from "../../types/chat";
import type { EditorMachineInput } from "./machine/types";

export type RecordingAudioSource = "microphone" | "external";
export type RecordingCameraSource = "camera";

export interface CaptionWord {
  start: number;
  end: number;
  text: string;
}

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
  words?: CaptionWord[];
}

export interface CaptionTrack {
  id: string;
  language: string;
  label?: string;
  cues: CaptionCue[];
  default?: boolean;
}

export type RecordingTrackKind =
  | "editor"
  | "audio"
  | "camera"
  | "cursor"
  | "preview"
  | "workspace"
  | "runtime"
  | "slide"
  | "whiteboard"
  | "chat";

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
  state: EditorState;
}

/**
 * Complete recording with metadata
 * Version 4: keyframe + delta compressed frames (verified exact-edit deltas for
 * ordinary Monaco changes and verified DMP deltas for other content changes)
 * plus workspace and runtime snapshots for multi-file mode. Older schema
 * versions are not supported.
 */
export interface Recording {
  /** Recording schema version. Older versions are not decodable (no legacy support). */
  version: 4;
  id: string;
  name: string;
  /** Delta compressed frames (keyframes + deltas) */
  frames: import("./utils/deltaTypes").DeltaFrame[];
  /**
   * Keyframe cadence the recorder used, carried as header metadata. Reconstruction
   * does not read it: it finds keyframes by scanning (`findNearestKeyframeIndex`).
   */
  keyframeInterval: number;
  slideEvents?: SlideEvent[];
  previewEvents?: PreviewEvent[];
  previewInitialDocuments?: PreviewInitialDocument[];
  previewPatchBatches?: PreviewDomPatchBatch[];
  workspaceEvents?: WorkspaceRecordingEvent[];
  /** Transient raw assets decoded from SCR3 before they are moved into asset storage. */
  workspaceAssets?: WorkspaceRecordingAsset[];
  runtimeEvents?: RuntimeRecordingEvent[];
  cursorEvents?: CursorRecordingEvent[];
  whiteboardEvents?: WhiteboardEvent[];
  chatEvents?: ChatRecordingEvent[];
  captions?: CaptionTrack[];
  slides?: Slide[];
  tracks?: RecordingTrackMeta[];
  clusters?: RecordingClusterMeta[];
  mediaFragments?: RecordingMediaFragment[];
  audioBlob?: Blob;
  audioSource?: RecordingAudioSource;
  /** Audio start offset (ms) between the recording origin and the first decodable audio byte. */
  audioStartOffsetMs?: number;
  /**
   * Sibling audio filename for audio stored outside the `.ne` (e.g. `recording-xyz.weba`).
   * The stream never carries audio bytes; this names the file that holds them.
   */
  audioFile?: string;
  /**
   * Resolved URL for the external audio — a hosted sibling URL or an object URL created from an
   * imported file. Playback fetches the audio from here when no `audioBlob` is attached.
   */
  audioUrl?: string;
  cameraBlob?: Blob;
  cameraSource?: RecordingCameraSource;
  /** Camera warmup offset (ms) between the recording origin and the first camera frame. */
  cameraStartOffsetMs?: number;
  /**
   * Sibling video filename for camera stored outside the `.ne` (e.g. `recording-xyz.webm`).
   * When set, the stream carries no inline `cameraChunk` segments; the video lives in its own file.
   */
  cameraFile?: string;
  captionFiles?: string[];
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
 * Append-only records decoded from a growing SCR3 stream. A monotonic cursor
 * lets the playback machine reject duplicate deliveries without rebuilding or
 * comparing the complete recording arrays.
 */
export interface RecordingStreamDelta {
  cursor: number;
  recordingId: string;
  duration: number;
  streamFinalized: boolean;
  newFrames: import("./utils/deltaTypes").DeltaFrame[];
  newSlideEvents: SlideEvent[];
  newPreviewEvents: PreviewEvent[];
  newPreviewInitialDocuments: PreviewInitialDocument[];
  newPreviewPatchBatches: PreviewDomPatchBatch[];
  newWorkspaceEvents: WorkspaceRecordingEvent[];
  /** Raw asset segments decoded since the previous delivery. */
  newWorkspaceAssets?: WorkspaceRecordingAsset[];
  newRuntimeEvents: RuntimeRecordingEvent[];
  newCursorEvents: CursorRecordingEvent[];
  newWhiteboardEvents: WhiteboardEvent[];
  newChatEvents: ChatRecordingEvent[];
}

/**
 * Sink for the live SCR3 recording byte stream (WebSocket / fetch ReadableStream /
 * callback). Receives append-only chunks as they are recorded and is closed when the
 * recording ends. The bytes form a valid SCR3 stream replayable via `decodeRecordingStream`.
 */
export interface RecordingStreamSink {
  write(bytes: Uint8Array): void | Promise<void>;
  close(): void | Promise<void>;
  /** Called once when encoding or delivery fails before the sink is closed. */
  onError?(error: unknown): void | Promise<void>;
}

/**
 * What NextEditorProvider configures the editor with: the machine's input, which it
 * passes as the actor's `input`, plus the options the provider handles itself.
 */
export interface UseNextEditorConfig extends EditorMachineInput {
  /**
   * Optional sink for live, stream-compatible recording. When provided, the SCR3 byte
   * stream produced while recording is forwarded here as it is captured, so a remote
   * consumer can tail and replay it with `decodeRecordingStream`. Inert when omitted.
   */
  recordingStreamSink?: RecordingStreamSink;
}

/**
 * Payload handed to `onScreenRecordingReady` when a local screen recording finalizes.
 * The video bytes are local-only by construction; this is their sole exit from the machine.
 */
export interface ScreenRecordingReadyPayload {
  blob: Blob;
  mimeType: string;
  /**
   * Whether the video carries an audio track. False means a silent recording — the browser
   * returned no display/tab audio and no microphone was mixed in. Consumers must not claim
   * narration is included when this is false.
   */
  hasAudio: boolean;
  /** Milliseconds between the recording-session origin and the first captured screen frame. */
  startOffsetMs: number;
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
 * Everything an editor frame records at one moment, and what replay restores.
 */
export interface EditorState {
  content: string;
  selection: EditorSelection;
  position: EditorPosition; // Text caret position
  viewState: monaco.editor.ICodeEditorViewState | null;
  mouseCursor?: MouseCursorPosition; // Mouse cursor position
  slideState?: SlidePreviewState; // Slide preview state
  currentSlideIndex?: number; // Current slide index
  previewState?: PreviewState; // Code preview panel state
}
