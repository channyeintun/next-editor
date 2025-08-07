import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type * as monaco from 'monaco-editor';
import type { Recording, EditorSnapshot } from './recordingSlice';

interface ReplayState {
  currentRecording: Recording | null;
  isPlaying: boolean;
  isPaused: boolean;
  hasEnded: boolean; // Track if playback ended naturally
  currentTime: number;
  playbackSpeed: number;
  currentSnapshotIndex: number;
  editorState: {
    content: string;
    selection: monaco.Selection;
    position: monaco.Position;
    viewState: monaco.editor.ICodeEditorViewState | null;
  };
}

const initialState: ReplayState = {
  currentRecording: null,
  isPlaying: false,
  isPaused: false,
  hasEnded: false,
  currentTime: 0,
  playbackSpeed: 1,
  currentSnapshotIndex: 0,
  editorState: {
    content: '',
    selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } as monaco.Selection,
    position: { lineNumber: 1, column: 1 } as monaco.Position,
    viewState: null,
  },
};

const replaySlice = createSlice({
  name: 'replay',
  initialState,
  reducers: {
    loadRecording: (state, action: PayloadAction<Recording>) => {
      state.currentRecording = action.payload;
      state.currentTime = 0;
      state.currentSnapshotIndex = 0;
      state.isPlaying = false;
      state.isPaused = false;
      state.hasEnded = false;
      // Reset editor state
      state.editorState = {
        content: '',
        selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } as monaco.Selection,
        position: { lineNumber: 1, column: 1 } as monaco.Position,
        viewState: null,
      };
    },
    play: (state) => {
      if (state.currentRecording) {
        state.isPlaying = true;
        state.isPaused = false;
        state.hasEnded = false;
      }
    },
    pause: (state) => {
      state.isPlaying = false;
      state.isPaused = true;
    },
    stop: (state) => {
      state.isPlaying = false;
      state.isPaused = false;
      state.hasEnded = false;
      state.currentTime = 0;
      state.currentSnapshotIndex = 0;
      // Reset editor state
      state.editorState = {
        content: '',
        selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } as monaco.Selection,
        position: { lineNumber: 1, column: 1 } as monaco.Position,
        viewState: null,
      };
    },
    seekTo: (state, action: PayloadAction<number>) => {
      const targetTime = action.payload;
      state.currentTime = targetTime;
      
      if (state.currentRecording) {
        // Find the last snapshot before or at the target time
        let lastSnapshot: EditorSnapshot | null = null;
        let snapshotIndex = 0;
        
        for (let i = 0; i < state.currentRecording.snapshots.length; i++) {
          const snapshot = state.currentRecording.snapshots[i];
          if (snapshot.timestamp <= targetTime) {
            lastSnapshot = snapshot;
            snapshotIndex = i + 1;
          } else {
            break;
          }
        }
        
        state.currentSnapshotIndex = snapshotIndex;
        
        if (lastSnapshot) {
          state.editorState = {
            content: lastSnapshot.state.content,
            selection: lastSnapshot.state.selection,
            position: lastSnapshot.state.position,
            viewState: lastSnapshot.state.viewState,
          };
        }
      }
    },
    updateCurrentTime: (state, action: PayloadAction<number>) => {
      state.currentTime = action.payload;
    },
    setPlaybackSpeed: (state, action: PayloadAction<number>) => {
      state.playbackSpeed = action.payload;
    },
    endPlayback: (state) => {
      state.isPlaying = false;
      state.isPaused = false;
      state.hasEnded = true;
    },
    applySnapshot: (state, action: PayloadAction<EditorSnapshot>) => {
      const snapshot = action.payload;
      state.editorState = {
        content: snapshot.state.content,
        selection: snapshot.state.selection,
        position: snapshot.state.position,
        viewState: snapshot.state.viewState,
      };
    },
  },
});

export const {
  loadRecording,
  play,
  pause,
  stop,
  seekTo,
  updateCurrentTime,
  setPlaybackSpeed,
  endPlayback,
  applySnapshot,
} = replaySlice.actions;

export default replaySlice.reducer;