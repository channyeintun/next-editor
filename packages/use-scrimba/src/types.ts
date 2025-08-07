import type * as monaco from 'monaco-editor';

/**
 * Editor snapshot containing the complete state at a specific timestamp
 */
export interface EditorSnapshot {
  timestamp: number;
  state: {
    content: string;
    selection: monaco.Selection;
    position: monaco.Position;
    viewState: monaco.editor.ICodeEditorViewState | null;
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
}

/**
 * Storage interface for persistence
 */
export interface StorageProvider {
  save?: (recording: Recording) => Promise<void>;
  load?: () => Promise<Recording[]>;
  delete?: (id: string) => Promise<void>;
}

/**
 * Configuration options for useScrimba hook
 */
export interface UseScrimbaConfig {
  // Required
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  
  // Recording Options
  captureEvents?: CaptureEvents;
  
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
  
  // Storage
  storage?: StorageProvider;
}

/**
 * Editor state for external manipulation
 */
export interface EditorState {
  content: string;
  selection: monaco.Selection;
  position: monaco.Position;
  viewState: monaco.editor.ICodeEditorViewState | null;
}

/**
 * Return type of useScrimba hook
 */
export interface UseScrimbaReturn {
  // Recording State
  isRecording: boolean;
  recordingStartTime: number | null;
  
  // Playback State
  isPlaying: boolean;
  isPaused: boolean;
  hasEnded: boolean;
  currentTime: number;
  playbackSpeed: number;
  
  // Data
  recordings: Recording[];
  currentRecording: Recording | null;
  currentSnapshot: EditorSnapshot | null;
  
  // Recording Controls
  startRecording: () => void;
  stopRecording: (options?: { audioBlob?: Blob }) => void;
  
  // Playback Controls
  play: () => void;
  pause: () => void;
  stop: () => void;
  seekTo: (time: number) => void;
  setPlaybackSpeed: (speed: number) => void;
  
  // Recording Management
  loadRecording: (recording: Recording) => void;
  deleteRecording: (id: string) => void;
  clearRecordings: () => void;
  
  // Monaco Editor Integration
  handleEditorMount: (editor: monaco.editor.IStandaloneCodeEditor) => void;
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
    recordings: {
      recordings: Recording[];
    };
  };
  dispatch: (action: any) => void;
  subscribe: (callback: () => void) => () => void;
  
  // Batch operations
  loadMultipleRecordings: (recordings: Recording[]) => void;
  exportRecording: (id: string, format?: 'json' | 'compressed') => string | null;
  importRecording: (data: string, format?: 'json' | 'compressed') => Recording | null;
}