import { createStore } from "@xstate/store-react";

const AUTOPLAY_KEY = "playback-autoplay";
const CONTINUE_TO_NEXT_KEY = "playback-continue-to-next";
const SPEED_KEY = "playback-speed";
const VOLUME_KEY = "playback-volume";

// Match the MediaControls slider ranges — clamping (rather than rejecting)
// keeps a hand-edited or stale localStorage value usable instead of silently
// falling back to defaults.
const SPEED_MIN = 0.5;
const SPEED_MAX = 2;
const VOLUME_MIN = 0;
const VOLUME_MAX = 1;

export interface PlaybackSettingsContext {
  autoplay: boolean;
  continueToNext: boolean;
  /** Playback speed, persisted across recordings and sessions (player-level
   *  setting, like YouTube — not per-recording state). */
  speed: number;
  /** Playback volume 0..1, persisted alongside speed. */
  volume: number;
}

const clampSpeed = (speed: number): number => Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));
const clampVolume = (volume: number): number => Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, volume));

function readStoredNumber(key: string, fallback: number, clamp: (value: number) => number): number {
  const raw = window.localStorage.getItem(key);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clamp(parsed) : fallback;
}

function readInitialContext(): PlaybackSettingsContext {
  if (typeof window === "undefined") {
    return { autoplay: false, continueToNext: false, speed: 1, volume: 1 };
  }
  return {
    autoplay: window.localStorage.getItem(AUTOPLAY_KEY) === "true",
    continueToNext: window.localStorage.getItem(CONTINUE_TO_NEXT_KEY) === "true",
    speed: readStoredNumber(SPEED_KEY, 1, clampSpeed),
    volume: readStoredNumber(VOLUME_KEY, 1, clampVolume),
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
        const speed = Number.isFinite(event.speed) ? clampSpeed(event.speed) : context.speed;
        return speed === context.speed ? context : { ...context, speed };
      },
      setVolume: (context, event: { volume: number }) => {
        const volume = Number.isFinite(event.volume) ? clampVolume(event.volume) : context.volume;
        return volume === context.volume ? context : { ...context, volume };
      },
    },
  });

  store.subscribe((snapshot) => {
    const { autoplay, continueToNext, speed, volume } = snapshot.context;
    window.localStorage.setItem(AUTOPLAY_KEY, String(autoplay));
    window.localStorage.setItem(CONTINUE_TO_NEXT_KEY, String(continueToNext));
    window.localStorage.setItem(SPEED_KEY, String(speed));
    window.localStorage.setItem(VOLUME_KEY, String(volume));
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
