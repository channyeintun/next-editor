import { createContext, type RefObject } from "react";
import type { Recording } from "../core/src/types";
import type { EditorActorRef, NextEditorActorActions } from "../core/src/useNextEditor";
import type * as monaco from "monaco-editor";

// What components read about the editor comes in three parts, split for render cost.
//
// 1. Actions: a React context whose one value NextEditorProvider keeps stable, so a
// component using it does not re-render on machine transitions. The machine's senders
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

// 2. Metadata: relatively stable flags. Not a React context: useNextEditorMetadata
// selects them from the editor actor (NextEditorActorContext).
export interface NextEditorMetadata {
  isRecording: boolean;
  /** A take is running but paused: its clock and recorders are stopped. */
  isRecordingPaused: boolean;
  isPlaying: boolean;
  hasEnded: boolean;
  usesPlaybackModel: boolean;
  /**
   * A loaded recording is playing, paused or at its end. Unlike usesPlaybackModel it stays
   * true while paused or ended, where the workspace is handed to the viewer.
   */
  isInPlaybackSession: boolean;
  currentRecording: Recording | null;
}

// 3. Playback settings: they change on user action or as a stream grows, not on ticks.
// Selected from the editor actor by useNextEditorPlayback, like the metadata.
export interface NextEditorPlayback {
  editorActor: EditorActorRef;
  playbackSpeed: number;
  volume: number;
  /** The timeline's length in ms (it grows as a streamed recording arrives). */
  durationMs: number;
}
