import type * as monaco from 'monaco-editor';

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
  };
}

/**
 * Complete recording with metadata
 */
export interface Recording {
  id: string;
  name: string;
  snapshots: EditorSnapshot[];
  audioBlob?: Blob;
  duration: number;
  createdAt: number;
}

/**
 * Configuration for event capturing during recording
 */
export interface CaptureEvents {
  content?: boolean;
  cursorPosition?: boolean;
  selection?: boolean;
  scroll?: boolean;
  mouseCursor?: boolean;
}


/**
 * Configuration options for useScrimba hook
 */
export interface UseScrimbaConfig {
  // Required
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  
  // Optional Audio Sync
  audioRef?: React.RefObject<HTMLAudioElement | null>;
  
  // Recording Options
  captureEvents?: CaptureEvents;
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
}

/**
 * Available Redux actions for the useScrimba store
 * Derived from the actual slice actions to maintain single source of truth
 */
export type ScrimbaAction = 
  | ReturnType<typeof import('./store/recordingSlice').recordingSlice.actions.startRecording>
  | ReturnType<typeof import('./store/recordingSlice').recordingSlice.actions.stopRecording>
  | ReturnType<typeof import('./store/recordingSlice').recordingSlice.actions.addSnapshot>
  | ReturnType<typeof import('./store/recordingSlice').recordingSlice.actions.clearCurrentRecording>
  | ReturnType<typeof import('./store/playbackSlice').playbackSlice.actions.play>
  | ReturnType<typeof import('./store/playbackSlice').playbackSlice.actions.pause>
  | ReturnType<typeof import('./store/playbackSlice').playbackSlice.actions.stop>
  | ReturnType<typeof import('./store/playbackSlice').playbackSlice.actions.end>
  | ReturnType<typeof import('./store/playbackSlice').playbackSlice.actions.updateCurrentTime>
  | ReturnType<typeof import('./store/playbackSlice').playbackSlice.actions.seekTo>
  | ReturnType<typeof import('./store/playbackSlice').playbackSlice.actions.setPlaybackSpeed>
  | ReturnType<typeof import('./store/playbackSlice').playbackSlice.actions.loadRecording>
  | ReturnType<typeof import('./store/playbackSlice').playbackSlice.actions.updateCurrentSnapshot>
  | ReturnType<typeof import('./store/playbackSlice').playbackSlice.actions.updateEditorState>;

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
  
  // Data
  currentRecording: Recording | null;
  currentCursor: MouseCursorPosition | null;
  
  // Recording Controls
  startRecording: () => void;
  stopRecording: (options?: { audioBlob?: Blob; masterDuration?: number }) => void;
  
  // Playback Controls
  play: () => void;
  pause: () => void;
  stop: () => void;
  seekTo: (time: number) => void;
  setPlaybackSpeed: (speed: number) => void;
  
  // Recording Management
  loadRecording: (recording: Recording) => void;
  
  // Monaco Editor Integration
  handleEditorChange: () => void;
  
  // Advanced
  getEditorState: () => EditorState | null;
  applyEditorState: (state: EditorState) => void;
  
  // New granular controls
  getSnapshot: (timestamp?: number) => EditorSnapshot | null;
  getCurrentState: () => { 
    recording: {
      isRecording: boolean;
      recordingStartTime: number | null;
      currentRecording: { snapshots: EditorSnapshot[]; duration: number; audioBlob?: Blob } | null;
    };
    playback: {
      isPlaying: boolean;
      isPaused: boolean;
      hasEnded: boolean;
      currentTime: number;
      playbackSpeed: number;
      loadedRecording: Recording | null;
      currentSnapshot: EditorSnapshot | null;
      editorState: EditorState;
    };
  };
  dispatch: (action: ScrimbaAction) => void;
  subscribe: (callback: () => void) => () => void;
  
}