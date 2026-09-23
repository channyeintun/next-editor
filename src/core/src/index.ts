// Contexts
export { NextEditorProvider } from "../../contexts/NextEditorProvider";
export { NextEditorActorContext } from "../../contexts/NextEditorActorContext";
export { NextEditorActionsContext } from "../../contexts/NextEditorContext";
export { SlidesProvider } from "../../contexts/SlidesContext";

// Hooks
export {
  useNextEditorActions,
  useNextEditorMetadata,
  useNextEditorPlayback,
} from "../../hooks/useNextEditorContext";

// Components
export { default as CodeEditor } from "../../components/CodeEditor";
export { default as MediaControls } from "../../components/MediaControls";
export { default as Preview } from "../../components/Preview";
export { default as CursorComponent } from "../../components/Cursor";
export { default as SlidePanel } from "../../components/SlidePanel";

// Type exports for users
export type {
  CaptionWord,
  CaptionCue,
  CaptionTrack,
  RecordingTrackKind,
  RecordingTrackMeta,
  RecordingClusterMeta,
  RecordingMediaFragment,
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

// Machine exports
export { editorMachine } from "./machine/editorMachine";
export type { EditorActorRef } from "./useNextEditor";
export { timelineMachine } from "./machine/timelineMachine";
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
