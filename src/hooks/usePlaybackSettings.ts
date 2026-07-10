import { useSelector } from "@xstate/store-react";
import {
  playbackSettingsStore,
  selectAutoplay,
  selectContinueToNext,
  selectSpeed,
  selectVolume,
  type PlaybackSettingsContext,
} from "../stores/playbackSettingsStore";

export function usePlaybackSettings(): PlaybackSettingsContext {
  const autoplay = useSelector(playbackSettingsStore, (s) => selectAutoplay(s.context));
  const continueToNext = useSelector(playbackSettingsStore, (s) => selectContinueToNext(s.context));
  const speed = useSelector(playbackSettingsStore, (s) => selectSpeed(s.context));
  const volume = useSelector(playbackSettingsStore, (s) => selectVolume(s.context));
  return { autoplay, continueToNext, speed, volume };
}

export function usePlaybackSettingsTrigger() {
  return playbackSettingsStore.trigger;
}
