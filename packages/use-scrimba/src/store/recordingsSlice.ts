import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { Recording } from '../types';

export interface RecordingsState {
  recordings: Recording[];
}

const initialState: RecordingsState = {
  recordings: [],
};

export const recordingsSlice = createSlice({
  name: 'recordings',
  initialState,
  reducers: {
    addRecording: (state, action: PayloadAction<Recording>) => {
      state.recordings.push(action.payload);
    },
    deleteRecording: (state, action: PayloadAction<string>) => {
      state.recordings = state.recordings.filter(r => r.id !== action.payload);
    },
    clearRecordings: (state) => {
      state.recordings = [];
    },
    setRecordings: (state, action: PayloadAction<Recording[]>) => {
      state.recordings = action.payload;
    },
  },
});

export const { 
  addRecording, 
  deleteRecording, 
  clearRecordings,
  setRecordings,
} = recordingsSlice.actions;

export default recordingsSlice.reducer;