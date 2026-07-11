import { createStore } from "@xstate/store-react";

const SCREEN_RECORDING_KEY = "recording-screen-capture";

export interface RecordingSettingsContext {
  /** Also screen-record the browser while recording, saved locally only
   *  (workflow preference, unlike the per-take camera toggle). */
  screenRecordingEnabled: boolean;
}

function readInitialContext(): RecordingSettingsContext {
  if (typeof window === "undefined") {
    return { screenRecordingEnabled: false };
  }
  return {
    screenRecordingEnabled: window.localStorage.getItem(SCREEN_RECORDING_KEY) === "true",
  };
}

export function createRecordingSettingsStore() {
  const store = createStore({
    context: readInitialContext(),
    on: {
      setScreenRecordingEnabled: (context, event: { enabled: boolean }) =>
        event.enabled === context.screenRecordingEnabled
          ? context
          : { ...context, screenRecordingEnabled: event.enabled },
    },
  });

  store.subscribe((snapshot) => {
    const { screenRecordingEnabled } = snapshot.context;
    window.localStorage.setItem(SCREEN_RECORDING_KEY, String(screenRecordingEnabled));
  });

  return store;
}

export type RecordingSettingsStoreInstance = ReturnType<typeof createRecordingSettingsStore>;

// Module-level singleton — readable from multiple parts of the app (recording UI,
// settings panels) without coupling to a specific React Context provider tree.
// A shared instance allows cross-tree access like playbackSettingsStore.
export const recordingSettingsStore = createRecordingSettingsStore();

export const selectScreenRecordingEnabled = (context: RecordingSettingsContext): boolean =>
  context.screenRecordingEnabled;
