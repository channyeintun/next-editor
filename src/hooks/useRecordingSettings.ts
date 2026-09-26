import { useSelector } from "@xstate/store-react";
import {
  recordingSettingsStore,
  selectMicrophoneDeviceId,
  selectScreenRecordingEnabled,
  type RecordingSettingsContext,
} from "../stores/recordingSettingsStore";

export function useRecordingSettings(): RecordingSettingsContext {
  const screenRecordingEnabled = useSelector(recordingSettingsStore, (s) =>
    selectScreenRecordingEnabled(s.context),
  );
  const microphoneDeviceId = useSelector(recordingSettingsStore, (s) =>
    selectMicrophoneDeviceId(s.context),
  );
  return { screenRecordingEnabled, microphoneDeviceId };
}

export function useRecordingSettingsTrigger() {
  return recordingSettingsStore.trigger;
}
