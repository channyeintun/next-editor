import { configureStore } from '@reduxjs/toolkit';
import recordingReducer from './slices/recordingSlice';
import replayReducer from './slices/replaySlice';

export const store = configureStore({
  reducer: {
    recording: recordingReducer,
    replay: replayReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;