import { useSelector } from "@xstate/store-react";
import {
  playbackSettingsStore,
  selectAutoplay,
  selectContinueToNext,
  type PlaybackSettingsContext,
} from "../stores/playbackSettingsStore";

export function usePlaybackSettings(): PlaybackSettingsContext {
  const autoplay = useSelector(playbackSettingsStore, (s) => selectAutoplay(s.context));
  const continueToNext = useSelector(playbackSettingsStore, (s) => selectContinueToNext(s.context));
  return { autoplay, continueToNext };
}

export function usePlaybackSettingsTrigger() {
  return playbackSettingsStore.trigger;
}
