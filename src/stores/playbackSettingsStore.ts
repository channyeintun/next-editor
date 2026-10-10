import { createStore } from "@xstate/store-react";
import { persistPreferences, readStoredPreference } from "./preferenceStorage";
import {
  DEFAULT_PLAYBACK_SPEED,
  DEFAULT_PLAYBACK_VOLUME,
  normalizePlaybackSpeed,
  normalizePlaybackVolume,
} from "../core/src/machine/playbackValues";

const AUTOPLAY_KEY = "playback-autoplay";
const CONTINUE_TO_NEXT_KEY = "playback-continue-to-next";
const SPEED_KEY = "playback-speed";
const VOLUME_KEY = "playback-volume";
const CHARACTER_SHORTCUTS_KEY = "playback-character-shortcuts";

export interface PlaybackSettingsContext {
  autoplay: boolean;
  continueToNext: boolean;
  /** Playback speed, persisted across recordings and sessions (player-level
   *  setting, like YouTube — not per-recording state). */
  speed: number;
  /** Playback volume 0..1, persisted alongside speed. */
  volume: number;
  /** Whether the player takes its letter, number and punctuation keys (M, C, 0–9, "?" …).
   *  On by default; a viewer can turn them off (WCAG 2.1.4). Space, the arrows, Home and End
   *  are not character keys and keep working either way. */
  characterShortcuts: boolean;
}

/**
 * A stored speed or volume through the player's own normalizer: clamping
 * (rather than rejecting) keeps a hand-edited or stale value usable, and a
 * missing or non-numeric one falls back to the default.
 */
function readStoredNumber(
  key: string,
  fallback: number,
  normalize: (value: number, fallback: number) => number,
): number {
  const raw = readStoredPreference(key);
  if (raw === null) return fallback;
  return normalize(Number(raw), fallback);
}

function readInitialContext(): PlaybackSettingsContext {
  return {
    autoplay: readStoredPreference(AUTOPLAY_KEY) === "true",
    continueToNext: readStoredPreference(CONTINUE_TO_NEXT_KEY) === "true",
    speed: readStoredNumber(SPEED_KEY, DEFAULT_PLAYBACK_SPEED, normalizePlaybackSpeed),
    volume: readStoredNumber(VOLUME_KEY, DEFAULT_PLAYBACK_VOLUME, normalizePlaybackVolume),
    characterShortcuts: readStoredPreference(CHARACTER_SHORTCUTS_KEY) !== "false",
  };
}

export function createPlaybackSettingsStore() {
  const store = createStore({
    context: readInitialContext(),
    on: {
      setAutoplay: (context, event: { autoplay: boolean }) =>
        event.autoplay === context.autoplay ? context : { ...context, autoplay: event.autoplay },
      setContinueToNext: (context, event: { continueToNext: boolean }) =>
        event.continueToNext === context.continueToNext
          ? context
          : { ...context, continueToNext: event.continueToNext },
      setSpeed: (context, event: { speed: number }) => {
        const speed = normalizePlaybackSpeed(event.speed, context.speed);
        return speed === context.speed ? context : { ...context, speed };
      },
      setVolume: (context, event: { volume: number }) => {
        const volume = normalizePlaybackVolume(event.volume, context.volume);
        return volume === context.volume ? context : { ...context, volume };
      },
      setCharacterShortcuts: (context, event: { enabled: boolean }) =>
        event.enabled === context.characterShortcuts
          ? context
          : { ...context, characterShortcuts: event.enabled },
    },
  });

  persistPreferences(store, {
    [AUTOPLAY_KEY]: (context) => String(context.autoplay),
    [CONTINUE_TO_NEXT_KEY]: (context) => String(context.continueToNext),
    [SPEED_KEY]: (context) => String(context.speed),
    [VOLUME_KEY]: (context) => String(context.volume),
    [CHARACTER_SHORTCUTS_KEY]: (context) => String(context.characterShortcuts),
  });

  return store;
}

export type PlaybackSettingsStoreInstance = ReturnType<typeof createPlaybackSettingsStore>;

// Module-level singleton — unlike captionStore, this needs to be readable from both
// MediaControls (inside the Editor's provider tree) and tube's LessonDetail (the parent
// that renders <Editor/> from outside that tree), so a React Context provider scoped to
// one of those trees can't bridge the two. A plain shared instance can.
export const playbackSettingsStore = createPlaybackSettingsStore();

export const selectAutoplay = (context: PlaybackSettingsContext): boolean => context.autoplay;
export const selectContinueToNext = (context: PlaybackSettingsContext): boolean =>
  context.continueToNext;
export const selectSpeed = (context: PlaybackSettingsContext): number => context.speed;
export const selectVolume = (context: PlaybackSettingsContext): number => context.volume;
export const selectCharacterShortcuts = (context: PlaybackSettingsContext): boolean =>
  context.characterShortcuts;
