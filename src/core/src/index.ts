// The recording model's types, and nothing else. Values are imported from their
// own modules, so importing this barrel never adds CodeEditor (and the Monaco chunk)
// to a route's eager graph.

// Recording type exports
export type {
  CaptionWord,
  CaptionCue,
  CaptionTrack,
  RecordingTrackKind,
  RecordingTrackMeta,
  RecordingClusterMeta,
  RecordingChapter,
  CursorTargetRect,
  CursorTargetSnapshot,
  MouseCursorPosition,
  CursorRecordingEvent,
  EditorFrame,
  Recording,
  RecordingStreamDelta,
  RecordingAudioSource,
  RecordingCameraSource,
  EditorState,
  EditorSelection,
  PreviewPatchReplayInput,
} from "./types";

// Machine type exports
export type { EditorActorRef } from "./useNextEditor";
export type { EditorMachineContext, EditorMachineEvent, EditorMachineInput } from "./machine/types";

// Slide type exports
export type { Slide, SlidePreviewState, SlideEvent } from "./slides";

// Preview type exports
export type {
  PreviewSize,
  PreviewPanelMode,
  PreviewState,
  PreviewEvent,
  PreviewDomPatchBatch,
  PreviewInitialDocument,
  PreviewRecordedEvent,
} from "./preview";

// Whiteboard type exports
export type {
  WhiteboardElementJSON,
  WhiteboardView,
  WhiteboardEvent,
  WhiteboardSceneState,
} from "./whiteboard";
