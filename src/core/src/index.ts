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
  CursorTargetRect,
  CursorTargetSnapshot,
  MouseCursorPosition,
  CursorRecordingEvent,
  EditorFrame,
  Recording,
  RecordingStreamDelta,
  RecordingCameraSource,
  EditorState,
} from "./types";

// Machine type exports
export type { EditorActorRef } from "./useNextEditor";
export type { TimelineActorRef } from "./machine/timelineMachine";
export type { EditorMachineContext, EditorMachineEvent, EditorMachineInput } from "./machine/types";

// Slide type exports
export type {
  Slide,
  SlidePreviewState,
  SlideEvent,
  PreviewSize,
  PreviewPanelMode,
  PreviewState,
  PreviewEvent,
  PreviewDomPatchBatch,
  PreviewInitialDocument,
  PreviewRecordedEvent,
} from "./slides";

// Whiteboard type exports
export type {
  WhiteboardElementJSON,
  WhiteboardView,
  WhiteboardEvent,
  WhiteboardSceneState,
} from "./whiteboard";
