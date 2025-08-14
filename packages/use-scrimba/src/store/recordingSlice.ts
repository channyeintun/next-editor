import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { EditorSnapshot } from '../types';

export interface RecordingState {
  isRecording: boolean;
  recordingStartTime: number | null;
  currentRecording: {
    snapshots: EditorSnapshot[];
    duration: number;
    audioBlob?: Blob;
  } | null;
}

const initialState: RecordingState = {
  isRecording: false,
  recordingStartTime: null,
  currentRecording: null,
};

export const recordingSlice = createSlice({
  name: 'recording',
  initialState,
  reducers: {
    startRecording: {
      reducer: (state, action: PayloadAction<{ masterStartTime: number }>) => {
        state.isRecording = true;
        state.recordingStartTime = action.payload.masterStartTime;
        state.currentRecording = {
          snapshots: [],
          duration: 0,
        };
      },
      prepare: (masterStartTime?: number) => ({
        payload: { masterStartTime: masterStartTime || Date.now() }
      })
    },
    stopRecording: (state, action: PayloadAction<{ audioBlob?: Blob }>) => {
      state.isRecording = false;
      if (state.currentRecording) {
        state.currentRecording.audioBlob = action.payload.audioBlob;
        if (state.recordingStartTime) {
          state.currentRecording.duration = Date.now() - state.recordingStartTime;
        }
      }
    },
    addSnapshot: (state, action: PayloadAction<EditorSnapshot>) => {
      if (state.currentRecording) {
        state.currentRecording.snapshots.push(action.payload);
      }
    },
    clearCurrentRecording: (state) => {
      state.currentRecording = null;
      state.recordingStartTime = null;
    },
  },
});

export const { 
  startRecording, 
  stopRecording, 
  addSnapshot, 
  clearCurrentRecording 
} = recordingSlice.actions;

export default recordingSlice.reducer;