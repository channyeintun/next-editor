import { configureStore } from '@reduxjs/toolkit';
import recordingReducer from './recordingSlice';
import playbackReducer from './playbackSlice';
import recordingsReducer from './recordingsSlice';

export const createScrimbaStore = () => {
  return configureStore({
    reducer: {
      recording: recordingReducer,
      playback: playbackReducer,
      recordings: recordingsReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        serializableCheck: {
          // Ignore blob serialization warnings
          ignoredActions: [
            'recording/stopRecording',
            'recordings/addRecording',
          ],
          ignoredPaths: [
            'recording.currentRecording.audioBlob',
            'recordings.recordings',
          ],
        },
      }),
  });
};

export type ScrimbaStore = ReturnType<typeof createScrimbaStore>;
export type RootState = ReturnType<ScrimbaStore['getState']>;
export type AppDispatch = ScrimbaStore['dispatch'];

// Re-export actions
export * from './recordingSlice';
export * from './playbackSlice';
export * from './recordingsSlice';