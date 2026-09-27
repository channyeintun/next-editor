import { useEffect } from "react";
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
 * Hydrates the machine from the persisted player-level speed/volume. Keyed on
 * currentRecording because SET_SPEED/SET_VOLUME are only handled inside the
 * machine's playback state (earlier sends are dropped), and setRecording
 * assigns a fresh recording object exactly when playback is (re)entered.
 * MediaControls writes user changes to both the machine and the settings
 * store, so after this first push the two stay equal and the effect no-ops.
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
  useEffect(() => {
    if (!currentRecording) {
      return;
    }
    if (playbackSpeed !== persistedSpeed) {
      setPlaybackSpeed(persistedSpeed);
    }
    if (volume !== persistedVolume) {
      setVolume(persistedVolume);
    }
  }, [
    currentRecording,
    playbackSpeed,
    persistedSpeed,
    volume,
    persistedVolume,
    setPlaybackSpeed,
    setVolume,
  ]);
}
