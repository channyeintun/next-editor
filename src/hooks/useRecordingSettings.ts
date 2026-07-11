import { useSelector } from "@xstate/store-react";
import {
  recordingSettingsStore,
  selectScreenRecordingEnabled,
  type RecordingSettingsContext,
} from "../stores/recordingSettingsStore";

export function useRecordingSettings(): RecordingSettingsContext {
  const screenRecordingEnabled = useSelector(recordingSettingsStore, (s) =>
    selectScreenRecordingEnabled(s.context),
  );
  return { screenRecordingEnabled };
}

export function useRecordingSettingsTrigger() {
  return recordingSettingsStore.trigger;
}
