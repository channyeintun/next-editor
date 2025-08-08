import { configureStore } from '@reduxjs/toolkit';
import recordingReducer from './recordingSlice';
import playbackReducer from './playbackSlice';

export const createScrimbaStore = () => {
  return configureStore({
    reducer: {
      recording: recordingReducer,
      playback: playbackReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        serializableCheck: false,
      }),
  });
};

export type ScrimbaStore = ReturnType<typeof createScrimbaStore>;
export type RootState = ReturnType<ScrimbaStore['getState']>;
export type AppDispatch = ScrimbaStore['dispatch'];

// Re-export actions
export * from './recordingSlice';
export * from './playbackSlice';