import { useSelector } from "@xstate/store-react";
import {
  playbackSettingsStore,
  selectAutoplay,
  selectCharacterShortcuts,
  selectContinueToNext,
  selectSpeed,
  selectVolume,
  type PlaybackSettingsContext,
} from "../stores/playbackSettingsStore";
import { useNextEditorActions } from "./useNextEditorContext";

export function usePlaybackSettings(): PlaybackSettingsContext {
  const autoplay = useSelector(playbackSettingsStore, (s) => selectAutoplay(s.context));
  const continueToNext = useSelector(playbackSettingsStore, (s) => selectContinueToNext(s.context));
  const speed = useSelector(playbackSettingsStore, (s) => selectSpeed(s.context));
  const volume = useSelector(playbackSettingsStore, (s) => selectVolume(s.context));
  const characterShortcuts = useSelector(playbackSettingsStore, (s) =>
    selectCharacterShortcuts(s.context),
  );
  return { autoplay, continueToNext, speed, volume, characterShortcuts };
}

/**
 * One playback setting, for a component that renders from it alone: it re-renders only
 * when that setting changes, not on every drag of the speed or volume control.
 */
export function usePlaybackSetting<K extends keyof PlaybackSettingsContext>(
  key: K,
): PlaybackSettingsContext[K] {
  return useSelector(playbackSettingsStore, (s) => s.context[key]);
}

/**
 * Changes the player's speed or volume for the viewer. Each goes to the machine (drives this
 * playback immediately) AND the settings store (persists it as a player-level setting — Editor
 * re-applies it when a fresh machine instance loads a recording), in that order.
 */
export function useApplySpeedAndVolume() {
  const { setPlaybackSpeed, setVolume } = useNextEditorActions();
  return {
    applySpeed: (speed: number) => {
      setPlaybackSpeed(speed);
      playbackSettingsStore.trigger.setSpeed({ speed });
    },
    applyVolume: (volume: number) => {
      setVolume(volume);
      playbackSettingsStore.trigger.setVolume({ volume });
    },
  };
}
