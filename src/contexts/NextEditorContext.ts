import { createContext, type RefObject } from "react";
import type {
  CaptionTrack,
  EditorSelection,
  Recording,
  RecordingStreamDelta,
} from "../core/src/types";
import type { EditorActorRef } from "../core/src/useNextEditor";
import type {
  PreviewDomPatchBatch,
  PreviewEvent,
  PreviewInitialDocument,
  SlideEvent,
} from "../types/slides";
import type { WhiteboardEvent } from "../core/src/whiteboard";
import type { ChatRecordingEvent } from "../types/chat";
import type { TextEditEvent } from "../types/textEdit";
import type * as monaco from "monaco-editor";

// 1. Actions Context: Stable functions, refs, and storage methods
export interface NextEditorActions {
  editorRef: RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  syncEditorRef: (editor: monaco.editor.IStandaloneCodeEditor | null) => void;
  startRecording: (options?: {
    audioBlob?: Blob;
    enableCamera?: boolean;
    screenStream?: MediaStream;
  }) => void;
  stopRecording: () => Promise<void>;
  play: () => void;
  pause: () => void;
  stop: () => void;
  seekTo: (time: number) => void;
  setPlaybackSpeed: (speed: number) => void;
  setVolume: (volume: number) => void;
  loadRecording: (recording: Recording) => void;
  extendRecording: (recording: Recording) => void;
  appendRecordingDelta: (delta: RecordingStreamDelta) => void;
  addCaptionTrack: (track: CaptionTrack) => void;
  removeCaptionTrack: (trackId: string) => void;
  clearRecording: () => void;
  handleEditorChange: (selection?: EditorSelection, textEdit?: TextEditEvent) => void;
  handleSlideEvent: (event: SlideEvent) => void;
  handlePreviewEvent: (event: PreviewEvent) => void;
  handlePreviewInitialDocument: (document: PreviewInitialDocument) => void;
  handlePreviewPatchBatch: (batch: PreviewDomPatchBatch) => void;
  handleWorkspaceEvent: (event?: {
    sidebarWidthDelta?: number;
    previewDockWidthDelta?: number;
  }) => void;
  handleRuntimeEvent: () => void;
  handleWhiteboardEvent: (event: WhiteboardEvent) => void;
  handleChatEvent: (event: ChatRecordingEvent["event"]) => void;
  exportAsFile: (recording: Recording, filename?: string) => Promise<void>;
  importFromFile: () => Promise<Recording[]>;
}

export const NextEditorActionsContext = createContext<NextEditorActions | null>(null);

// 2. Metadata Context: Relatively stable state (flags)
export interface NextEditorMetadata {
  isRecording: boolean;
  isPlaying: boolean;
  hasEnded: boolean;
  usesPlaybackModel: boolean;
  currentRecording: Recording | null;
  recordingStartTime: number | null;
}

// 3. Playback settings: change on user action or as a stream grows, not on ticks
export interface NextEditorPlayback {
  editorActor: EditorActorRef;
  playbackSpeed: number;
  volume: number;
  /** The timeline's length in ms (it grows as a streamed recording arrives). */
  durationMs: number;
}
