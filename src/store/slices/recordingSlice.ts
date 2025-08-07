import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type * as monaco from 'monaco-editor';

export interface EditorSnapshot {
  timestamp: number;
  state: {
    content: string;
    selection: monaco.Selection;
    position: monaco.Position;
    viewState: monaco.editor.ICodeEditorViewState | null;
  };
}

export interface Recording {
  id: string;
  name: string;
  snapshots: EditorSnapshot[];
  audioBlob?: Blob;
  duration: number;
  createdAt: number;
}

interface RecordingState {
  isRecording: boolean;
  currentRecording: Omit<Recording, 'id' | 'name' | 'createdAt'> | null;
  recordings: Recording[];
  startTime: number | null;
}

const initialState: RecordingState = {
  isRecording: false,
  currentRecording: null,
  recordings: [],
  startTime: null,
};

const recordingSlice = createSlice({
  name: 'recording',
  initialState,
  reducers: {
    startRecording: (state) => {
      state.isRecording = true;
      state.startTime = Date.now();
      state.currentRecording = {
        snapshots: [],
        duration: 0,
      };
    },
    stopRecording: (state, action: PayloadAction<{ audioBlob?: Blob }>) => {
      if (state.currentRecording && state.startTime) {
        state.isRecording = false;
        state.currentRecording.duration = Date.now() - state.startTime;
        state.currentRecording.audioBlob = action.payload.audioBlob;
        
        const newRecording: Recording = {
          id: Date.now().toString(),
          name: `Recording ${state.recordings.length + 1}`,
          createdAt: Date.now(),
          ...state.currentRecording,
        };
        
        state.recordings.push(newRecording);
        state.currentRecording = null;
        state.startTime = null;
      }
    },
    addSnapshot: (state, action: PayloadAction<Omit<EditorSnapshot, 'timestamp'>>) => {
      if (state.isRecording && state.currentRecording && state.startTime) {
        const snapshot: EditorSnapshot = {
          ...action.payload,
          timestamp: Date.now() - state.startTime,
        };
        state.currentRecording.snapshots.push(snapshot);
      }
    },
    clearRecordings: (state) => {
      state.recordings = [];
    },
    deleteRecording: (state, action: PayloadAction<string>) => {
      state.recordings = state.recordings.filter(r => r.id !== action.payload);
    },
  },
});

export const { startRecording, stopRecording, addSnapshot, clearRecordings, deleteRecording } = recordingSlice.actions;
export default recordingSlice.reducer;