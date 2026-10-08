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
import type { RuntimeRecordingEvent, RuntimeRecordingSnapshot } from "./runtime";
import type { WorkspaceRecordingEvent, WorkspaceRecordingSnapshot } from "../../types/workspace";
import type { WhiteboardEvent } from "./whiteboard";
import type { ChatRecordingEvent } from "../../types/chat";
import type { MediaSpan } from "./utils/mediaSpans";
import type { AudioEdit } from "./utils/audioEdit";

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

/** A named point in a recording, to jump to and to show where a long lesson is. */
export interface RecordingChapter {
  /** Where it starts, in ms. */
  time: number;
  title: string;
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

/**
 * One entry of the SCR3 header's track list. Encode and decode copy each track
 * whole, so a field this build does not declare survives a decode/encode round trip.
 */
export interface RecordingTrackMeta {
  id: string;
  kind: RecordingTrackKind;
  mimeType?: string;
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
/**
 * A place in a target's text content: the written line, the character offset
 * within it, and where inside that character's cell (0–1 each way).
 */
export interface CursorCellAnchor {
  line: number;
  offset: number;
  dx: number;
  dy: number;
}

export interface CursorTargetSnapshot {
  id: string;
  rect: CursorTargetRect;
  x: number;
  y: number;
  /** Set over a terminal: replay resolves it before the pixel offset. */
  cell?: CursorCellAnchor;
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
  runtimeEvents?: RuntimeRecordingEvent[];
  cursorEvents?: CursorRecordingEvent[];
  whiteboardEvents?: WhiteboardEvent[];
  chatEvents?: ChatRecordingEvent[];
  captions?: CaptionTrack[];
  /** Named points in the recording, sorted by time (see utils/chapters.ts). */
  chapters?: RecordingChapter[];
  slides?: Slide[];
  tracks?: RecordingTrackMeta[];
  clusters?: RecordingClusterMeta[];
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
   * Camera footage the take discarded with a retake. The camera kept recording across a
   * retake, so its file still holds those stretches: spans of its media timeline (recorded
   * time with the cuts put back, which camera time trails by `cameraStartOffsetMs`) that
   * playback maps around. Sorted and non-overlapping.
   */
  cameraCuts?: MediaSpan[];
  /**
   * Narration edit still to apply when this recording loads: a retake's discarded
   * stretches, or an edit's cuts and mutes. Loading replaces `audioBlob` with the edited
   * file and drops this. Never written to a file.
   */
  pendingAudioEdit?: AudioEdit;
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
  newRuntimeEvents: RuntimeRecordingEvent[];
  newCursorEvents: CursorRecordingEvent[];
  newWhiteboardEvents: WhiteboardEvent[];
  newChatEvents: ChatRecordingEvent[];
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
  /**
   * Milliseconds from the take's start to the screen MediaRecorder starting: the screen actor's
   * raw `performance.now()` at MediaRecorder start minus `session.startedAtPerf`. It is not read
   * through the take's clock, so a pause before the recorder started is counted.
   */
  startOffsetMs: number;
}

export interface PreviewPatchReplayInput {
  recordingId: string;
  currentTime: number;
  initialDocuments: PreviewInitialDocument[];
  patchBatches: PreviewDomPatchBatch[];
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
