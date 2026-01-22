import { createContext, type RefObject } from 'react';
import type { Recording, MouseCursorPosition, TimelineActorRef } from '../core/src';
import type { SlidePreviewState, PreviewState, Slide, SlideEvent, PreviewEvent } from '../types/slides';
import type * as monaco from 'monaco-editor';

export type { TimelineActorRef };

// 1. Actions Context: Stable functions, refs, and storage methods
export interface NextEditorActions {
  editorRef: RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  startRecording: () => void;
  stopRecording: () => void;
  play: () => void;
  pause: () => void;
  stop: () => void;
  seekTo: (time: number) => void;
  setPlaybackSpeed: (speed: number) => void;
  setVolume: (volume: number) => void;
  loadRecording: (recording: Recording) => void;
  clearRecording: () => void;
  handleEditorChange: () => void;
  handleSlideEvent: (event: SlideEvent) => void;
  handlePreviewEvent: (event: PreviewEvent) => void;
  exportAsFile: (recording: Recording, filename?: string) => Promise<void>;
  exportAllAsFile: (filename?: string) => Promise<void>;
  importFromFile: () => Promise<Recording[]>;
  clearStorage: () => Promise<void>;
  getStorageStats: () => Promise<{ count: number; totalSize: string }>;
  loadRecordingsFromStorage: () => Promise<Recording[]>;
  deleteFromStorage: (id: string) => Promise<void>;
  registerSlideStateGetter: (getter: () => { previewState: SlidePreviewState; currentSlideIndex: number } | null) => void;
  registerSlideStateApplier: (applier: (slideState: SlidePreviewState, currentSlideIndex: number) => void) => void;
  registerSlidesGetter: (getter: () => Slide[]) => void;
  registerSlidesApplier: (applier: (slides: Slide[]) => void) => void;
  registerPreviewStateGetter: (getter: () => PreviewState | null) => void;
  registerPreviewStateApplier: (applier: (previewState: PreviewState) => void) => void;
  registerSlideNavigator: (navigator: (indexh: number, indexv: number) => void) => void;
  navigateSlidesDirect?: (indexh: number, indexv: number) => void;
}

export const NextEditorActionsContext = createContext<NextEditorActions | null>(null);

// 2. Metadata Context: Relatively stable state (flags)
export interface NextEditorMetadata {
  isRecording: boolean;
  isRecordingAudio: boolean;
  isPlaying: boolean;
  isPaused: boolean;
  hasEnded: boolean;
  currentRecording: Recording | null;
  recordingStartTime: number | null;
}

export const NextEditorMetadataContext = createContext<NextEditorMetadata | null>(null);

// 3. Playback Context: High-frequency state (ticks)
export interface NextEditorPlayback {
  currentTime: number;
  timelineActor: TimelineActorRef | undefined;
  playbackSpeed: number;
  volume: number;
  duration: number; // actualDuration
  currentCursor: MouseCursorPosition | null;
}

export const NextEditorPlaybackContext = createContext<NextEditorPlayback | null>(null);