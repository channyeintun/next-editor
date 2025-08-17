import type * as monaco from 'monaco-editor';
import type { SlideEvent, SlidePreviewState } from './slides';

/**
 * Mouse cursor position relative to editor container
 */
export interface MouseCursorPosition {
  x: number;
  y: number;
  visible: boolean; // Whether cursor is within editor bounds
}

/**
 * Editor snapshot containing the complete state at a specific timestamp
 */
export interface EditorSnapshot {
  timestamp: number;
  state: {
    content: string;
    selection: monaco.Selection;
    position: monaco.Position; // Text caret position
    viewState: monaco.editor.ICodeEditorViewState | null;
    mouseCursor?: MouseCursorPosition; // Mouse cursor position
    slideState?: SlidePreviewState; // Slide preview state
    currentSlideIndex?: number; // Current slide index
  };
}

/**
 * Complete recording with metadata
 */
export interface Recording {
  id: string;
  name: string;
  snapshots: EditorSnapshot[];
  slideEvents?: SlideEvent[];
  slides?: Array<{id: string; imageUrl: string; name?: string; order: number}>;
  audioBlob?: Blob;
  duration: number;
  createdAt: number;
}


/**
 * Configuration options for useScrimba hook
 */
export interface UseScrimbaConfig {
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
  
  // New granular callbacks
  onSnapshot?: (snapshot: EditorSnapshot) => void;
  onStateChange?: (state: EditorState) => void;
  onPlaybackUpdate?: (currentTime: number, snapshot: EditorSnapshot | null) => void;
  onSlideEvent?: (event: SlideEvent) => void;
  getSlideState?: () => { previewState: SlidePreviewState; currentSlideIndex: number } | null;
  applySlideState?: (slideState: SlidePreviewState, currentSlideIndex: number) => void;
  getSlides?: () => Array<{id: string; imageUrl: string; name?: string; order: number}> | null;
  applySlides?: (slides: Array<{id: string; imageUrl: string; name?: string; order: number}>) => void;
}

/**
 * Editor state for external manipulation
 */
export interface EditorState {
  content: string;
  selection: monaco.Selection;
  position: monaco.Position;
  viewState: monaco.editor.ICodeEditorViewState | null;
  mouseCursor?: MouseCursorPosition;
  slideState?: SlidePreviewState;
  currentSlideIndex?: number;
}


/**
 * Return type of useScrimba hook
 */
export interface UseScrimbaReturn {
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
  
  // Monaco Editor Integration
  handleEditorChange: () => void;
  handleSlideEvent: (event: SlideEvent) => void;
  
  // Helper functions
  getEditorState: () => EditorState | null;
  getSnapshot: (timestamp?: number) => EditorSnapshot | null;
  
}