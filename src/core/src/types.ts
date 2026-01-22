import type * as monaco from 'monaco-editor';
import type { SlideEvent, SlidePreviewState, PreviewEvent, PreviewState, Slide } from './slides';
import type { TimelineActorRef } from './machine/timelineMachine';
import type { EditorActorRef } from './useNextEditor';

/**
 * Audio storage placeholder for serialization
 */
export interface AudioPlaceholder {
  __audio_offset: number;
  __audio_size: number;
  __audio_type: string;
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
 * Mouse cursor position relative to editor container
 */
export interface MouseCursorPosition {
  x: number;
  y: number;
  visible: boolean; // Whether cursor is within editor bounds
}


/**
 * Editor frame containing the complete state at a specific timestamp
 */
export interface EditorFrame {
  timestamp: number;
  state: {
    content: string;
    selection: EditorSelection;
    position: EditorPosition; // Text caret position
    viewState: monaco.editor.ICodeEditorViewState | null;
    mouseCursor?: MouseCursorPosition; // Mouse cursor position
    slideState?: SlidePreviewState; // Slide preview state
    currentSlideIndex?: number; // Current slide index
    previewState?: PreviewState; // Code preview panel state
  };
}

/**
 * Complete recording with metadata
 * Version 2: uses frames array with keyframe + delta compression
 */
export interface Recording {
  /** Format version: Strictly 2 for delta compressed recordings */
  version: 2;
  id: string;
  name: string;
  /** Delta compressed frames (keyframes + deltas) */
  frames: import('./utils/deltaTypes').DeltaFrame[];
  /** Keyframe interval for reconstruction */
  keyframeInterval: number;
  slideEvents?: SlideEvent[];
  previewEvents?: PreviewEvent[];
  slides?: Slide[];
  audioBlob?: Blob | AudioPlaceholder;
  duration: number;
  createdAt: number;
}



/**
 * Configuration options for useNextEditor hook
 */
export interface UseNextEditorConfig {
  // Required
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>;

  // Recording Options
  enableAudioRecording?: boolean;

  // Playback Options
  pauseOnUserInteraction?: boolean;
  defaultPlaybackSpeed?: number;

  // Callbacks
  onRecordingStart?: () => void;
  onRecordingStop?: (recording: Recording) => void;
  onPlaybackStart?: () => void;
  onPlaybackPause?: () => void;
  onPlaybackEnd?: () => void;
  onSeek?: (time: number) => void;
  onError?: (error: Error) => void;

  // Granular callbacks
  onFrame?: (frame: EditorFrame) => void;
  onStateChange?: (state: EditorState) => void;
  onPlaybackUpdate?: (currentTime: number, frame: EditorFrame | null) => void;
  onSlideEvent?: (event: SlideEvent) => void;
  getSlideState?: () => { previewState: SlidePreviewState; currentSlideIndex: number } | null;
  applySlideState?: (slideState: SlidePreviewState, currentSlideIndex: number) => void;

  // Preview state callbacks
  onPreviewEvent?: (event: PreviewEvent) => void;
  getPreviewState?: () => PreviewState | null;
  applyPreviewState?: (previewState: PreviewState) => void;

  // Slides data callbacks
  getSlides?: () => Slide[];
  applySlides?: (slides: Slide[]) => void;
}

/**
 * Editor state for external manipulation
 */
export interface EditorState {
  content: string;
  selection: EditorSelection;
  position: EditorPosition;
  viewState: monaco.editor.ICodeEditorViewState | null;
  mouseCursor?: MouseCursorPosition;
  slideState?: SlidePreviewState;
  currentSlideIndex?: number;
  previewState?: PreviewState;
}


/**
 * Return type of useNextEditor hook
 */
export interface UseNextEditorReturn {
  // Recording State
  isRecording: boolean;
  isRecordingAudio: boolean;
  recordingStartTime: number | null;

  // Playback State
  isPlaying: boolean;
  isPaused: boolean;
  hasEnded: boolean;
  currentTime: number;
  timelineActor: TimelineActorRef | undefined;
  editorActor: EditorActorRef;
  playbackSpeed: number;
  volume: number;

  // Data
  currentRecording: Recording | null;
  currentCursor: MouseCursorPosition | null;
  actualDuration: number;

  // Recording Controls
  startRecording: () => void;
  stopRecording: () => void;

  // Playback Controls
  play: () => void;
  pause: () => void;
  stop: () => void;
  seekTo: (time: number) => void;
  setPlaybackSpeed: (speed: number) => void;
  setVolume: (volume: number) => void;

  // Recording Management
  loadRecording: (recording: Recording) => void;
  clearRecording: () => void;

  // Monaco Editor Integration
  handleEditorChange: () => void;
  handleSlideEvent: (event: SlideEvent) => void;
  handlePreviewEvent: (event: PreviewEvent) => void;

  // Helper functions
  getEditorState: () => EditorState | null;
  getFrame: (timestamp?: number) => EditorFrame | null;

  // Registration helpers
  registerSlideNavigator?: (navigator: (indexh: number, indexv: number) => void) => void;
  navigateSlidesDirect?: (indexh: number, indexv: number) => void;

  registerSlideStateGetter?: (getter: () => { previewState: SlidePreviewState; currentSlideIndex: number } | null) => void;
  registerSlideStateApplier?: (applier: (slideState: SlidePreviewState, currentSlideIndex: number) => void) => void;
  registerSlidesGetter?: (getter: () => Slide[]) => void;
  registerSlidesApplier?: (applier: (slides: Slide[]) => void) => void;
  registerPreviewStateGetter?: (getter: () => PreviewState | null) => void;
  registerPreviewStateApplier?: (applier: (previewState: PreviewState) => void) => void;
}