import type * as monaco from 'monaco-editor';
import type { SlideEvent, SlidePreviewState, PreviewEvent, PreviewState } from './slides';

/**
 * Audio storage placeholder for serialization
 */
export interface AudioPlaceholder {
  __audio_offset: number;
  __audio_size: number;
  __audio_type: string;
}

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
    activeFile: string;
    files: Record<string, string>;
    content: string;
    selection: monaco.Selection;
    position: monaco.Position; // Text caret position
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
  slides?: Array<{ id: string; imageUrl: string; name?: string; order: number }>;
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
  getSlides?: () => Array<{ id: string; imageUrl: string; name?: string; order: number }>;
  applySlides?: (slides: Array<{ id: string; imageUrl: string; name?: string; order: number }>) => void;
}

/**
 * Editor state for external manipulation
 */
export interface EditorState {
  activeFile: string;
  files: Record<string, string>;
  content: string;
  selection: monaco.Selection;
  position: monaco.Position;
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
  playbackSpeed: number;
  volume: number;

  // Data
  currentRecording: Recording | null;
  currentCursor: MouseCursorPosition | null;
  actualDuration: number;
  activeFile: string;
  files: Record<string, string>;

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
  switchFile: (path: string) => void;
  addFile: (path: string, content: string) => void;
  deleteFile: (path: string) => void;
  renameFile: (oldPath: string, newPath: string) => void;

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

}