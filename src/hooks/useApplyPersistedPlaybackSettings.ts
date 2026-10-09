import { useEffect, useEffectEvent } from "react";
import type { Recording } from "../core/src";

interface ApplyPersistedPlaybackSettingsOptions {
  currentRecording: Recording | null;
  /** The machine's current speed and volume. */
  playbackSpeed: number;
  volume: number;
  /** The player-level speed and volume the viewer last chose (playbackSettingsStore). */
  persistedSpeed: number;
  persistedVolume: number;
  setPlaybackSpeed: (speed: number) => void;
  setVolume: (volume: number) => void;
}

/**
 * Hydrates the machine from the persisted player-level speed/volume. Pushed when
 * a recording is (re)loaded and whenever a persisted value changes. Keyed on
 * currentRecording because SET_SPEED/SET_VOLUME are only handled inside the
 * machine's playback state (earlier sends are dropped), and setRecording
 * assigns a fresh recording object exactly when playback is (re)entered.
 * MediaControls writes user changes to both the machine and the settings
 * store, so after this first push the two stay equal and the push no-ops.
 * A machine-only change, such as RecordingEditPanel silencing a pending mute,
 * is deliberately not reverted: the machine's values are read, not watched.
 */
export function useApplyPersistedPlaybackSettings({
  currentRecording,
  playbackSpeed,
  volume,
  persistedSpeed,
  persistedVolume,
  setPlaybackSpeed,
  setVolume,
}: ApplyPersistedPlaybackSettingsOptions): void {
  const pushPersisted = useEffectEvent(() => {
    if (playbackSpeed !== persistedSpeed) {
      setPlaybackSpeed(persistedSpeed);
    }
    if (volume !== persistedVolume) {
      setVolume(persistedVolume);
    }
  });

  useEffect(() => {
    if (!currentRecording) {
      return;
    }
    pushPersisted();
  }, [currentRecording, persistedSpeed, persistedVolume]);
}
