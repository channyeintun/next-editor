import { createContext, type RefObject } from "react";
import type {
  CaptionTrack,
  EditorSelection,
  Recording,
  RecordingStreamDelta,
} from "../core/src/types";
import type { TimelineActorRef } from "../core/src/machine/timelineMachine";
import type { EditorActorRef } from "../core/src/useNextEditor";
import type { StoredRecordingMetadata } from "../storage/IndexedDBRecordingStore";
import type {
  PreviewDomPatchBatch,
  PreviewEvent,
  PreviewInitialDocument,
  SlideEvent,
} from "../types/slides";
import type { WhiteboardEvent } from "../core/src/whiteboard";
import type { ChatCheckpoint, ChatDelta } from "../types/chat";
import type * as monaco from "monaco-editor";

export type { TimelineActorRef, EditorActorRef };

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
  handleEditorChange: (selection?: EditorSelection) => void;
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
  handleChatEvent: (event: ChatDelta | { k: "checkpoint"; state: ChatCheckpoint }) => void;
  exportAsFile: (recording: Recording, filename?: string) => Promise<void>;
  importFromFile: () => Promise<Recording[]>;
  clearStorage: () => Promise<void>;
  getStorageStats: () => Promise<{ count: number; totalSize: string }>;
  /** Metadata only (no stream/media decode) — the source for library list UIs. */
  listStoredRecordings: () => Promise<StoredRecordingMetadata[]>;
  /** Decodes one recording's full payload; call only when the user opens/selects it. */
  loadStoredRecordingById: (id: string) => Promise<Recording | null>;
  deleteFromStorage: (id: string) => Promise<void>;
}

export const NextEditorActionsContext = createContext<NextEditorActions | null>(null);

// 2. Metadata Context: Relatively stable state (flags)
export interface NextEditorMetadata {
  isRecording: boolean;
  isRecordingAudio: boolean;
  isPlaying: boolean;
  isPaused: boolean;
  hasEnded: boolean;
  usesPlaybackModel: boolean;
  currentRecording: Recording | null;
  recordingStartTime: number | null;
}

// 3. Playback Context: High-frequency state (ticks)
export interface NextEditorPlayback {
  timelineActor: TimelineActorRef | undefined;
  editorActor: EditorActorRef | undefined;
  playbackSpeed: number;
  volume: number;
  duration: number; // actualDuration
}
