import { createStore } from "@xstate/store-react";
import { persistPreferences, readStoredPreference } from "./preferenceStorage";

const SCREEN_RECORDING_KEY = "recording-screen-capture";
const MICROPHONE_KEY = "recording-microphone-device";

export interface RecordingSettingsContext {
  /** Also screen-record the browser while recording, saved locally only
   *  (workflow preference, unlike the per-take camera toggle). */
  screenRecordingEnabled: boolean;
  /** The microphone takes narrate with (a `deviceId`, which is per browser profile); null
   *  for the system default. */
  microphoneDeviceId: string | null;
}

function readInitialContext(): RecordingSettingsContext {
  return {
    screenRecordingEnabled: readStoredPreference(SCREEN_RECORDING_KEY) === "true",
    microphoneDeviceId: readStoredPreference(MICROPHONE_KEY) || null,
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
      setMicrophoneDeviceId: (context, event: { deviceId: string | null }) => {
        const microphoneDeviceId = event.deviceId || null;
        return microphoneDeviceId === context.microphoneDeviceId
          ? context
          : { ...context, microphoneDeviceId };
      },
    },
  });

  persistPreferences(store, {
    [SCREEN_RECORDING_KEY]: (context) => String(context.screenRecordingEnabled),
    [MICROPHONE_KEY]: (context) => context.microphoneDeviceId,
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

export const selectMicrophoneDeviceId = (context: RecordingSettingsContext): string | null =>
  context.microphoneDeviceId;
