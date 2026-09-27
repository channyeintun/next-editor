import { createContext, type RefObject } from "react";
import type { Recording } from "../core/src/types";
import type { EditorActorRef, NextEditorActorActions } from "../core/src/useNextEditor";
import type * as monaco from "monaco-editor";

// 1. Actions Context: Stable functions, refs, and storage methods. The machine's senders
// (useNextEditorActorActions), plus what the provider adds or wraps.
export interface NextEditorActions extends NextEditorActorActions {
  editorRef: RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  /**
   * Lets the preview flush its last batch into the take, then stops it. Every caller
   * shares the one stop in flight.
   */
  stopRecording: () => Promise<void>;
  exportAsFile: (recording: Recording, filename?: string) => Promise<void>;
  importFromFile: () => Promise<Recording[]>;
}

export const NextEditorActionsContext = createContext<NextEditorActions | null>(null);

// 2. Metadata Context: Relatively stable state (flags)
export interface NextEditorMetadata {
  isRecording: boolean;
  /** A take is running but paused: its clock and recorders are stopped. */
  isRecordingPaused: boolean;
  isPlaying: boolean;
  hasEnded: boolean;
  usesPlaybackModel: boolean;
  currentRecording: Recording | null;
}

// 3. Playback settings: change on user action or as a stream grows, not on ticks
export interface NextEditorPlayback {
  editorActor: EditorActorRef;
  playbackSpeed: number;
  volume: number;
  /** The timeline's length in ms (it grows as a streamed recording arrives). */
  durationMs: number;
}
