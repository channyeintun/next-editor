import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type * as monaco from 'monaco-editor';
import type { Recording, EditorSnapshot, EditorState } from '../types';

export interface PlaybackState {
  isPlaying: boolean;
  isPaused: boolean;
  hasEnded: boolean;
  currentTime: number;
  playbackSpeed: number;
  loadedRecording: Recording | null;
  currentSnapshot: EditorSnapshot | null;
  editorState: EditorState;
}

const initialEditorState: EditorState = {
  content: '',
  selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } as monaco.Selection,
  position: { lineNumber: 1, column: 1 } as monaco.Position,
  viewState: null,
  mouseCursor: undefined,
};

const initialState: PlaybackState = {
  isPlaying: false,
  isPaused: false,
  hasEnded: false,
  currentTime: 0,
  playbackSpeed: 1,
  loadedRecording: null,
  currentSnapshot: null,
  editorState: initialEditorState,
};

export const playbackSlice = createSlice({
  name: 'playback',
  initialState,
  reducers: {
    play: (state) => {
      state.isPlaying = true;
      state.isPaused = false;
      state.hasEnded = false;
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
      state.currentSnapshot = null;
      state.editorState = initialEditorState;
    },
    end: (state) => {
      state.isPlaying = false;
      state.hasEnded = true;
      if (state.loadedRecording) {
        state.currentTime = state.loadedRecording.duration;
      }
    },
    updateCurrentTime: (state, action: PayloadAction<number>) => {
      state.currentTime = action.payload;
    },
    seekTo: (state, action: PayloadAction<number>) => {
      const targetTime = action.payload;
      state.currentTime = targetTime;
      // Reset hasEnded when seeking to any position
      state.hasEnded = false;
      if (state.isPlaying) {
        state.isPlaying = false;
        state.isPaused = true;
      }
    },
    setPlaybackSpeed: (state, action: PayloadAction<number>) => {
      const speed = action.payload;
      if (typeof speed === 'number' && isFinite(speed) && speed > 0) {
        state.playbackSpeed = Math.min(Math.max(speed, 0.1), 10);
      }
    },
    loadRecording: (state, action: PayloadAction<Recording>) => {
      state.loadedRecording = action.payload;
      state.currentTime = 0;
      state.isPlaying = false;
      state.isPaused = false;
      state.hasEnded = false;
      state.currentSnapshot = null;
      state.editorState = initialEditorState;
    },
    updateCurrentSnapshot: (state, action: PayloadAction<EditorSnapshot | null>) => {
      state.currentSnapshot = action.payload;
    },
    updateEditorState: (state, action: PayloadAction<EditorState>) => {
      state.editorState = action.payload;
    },
  },
});

export const { 
  play, 
  pause, 
  stop, 
  end,
  updateCurrentTime,
  seekTo, 
  setPlaybackSpeed, 
  loadRecording,
  updateCurrentSnapshot,
  updateEditorState,
} = playbackSlice.actions;

export default playbackSlice.reducer;