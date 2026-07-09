import { createStore } from "@xstate/store-react";

const AUTOPLAY_KEY = "playback-autoplay";
const CONTINUE_TO_NEXT_KEY = "playback-continue-to-next";

export interface PlaybackSettingsContext {
  autoplay: boolean;
  continueToNext: boolean;
}

function readInitialContext(): PlaybackSettingsContext {
  if (typeof window === "undefined") return { autoplay: false, continueToNext: false };
  return {
    autoplay: window.localStorage.getItem(AUTOPLAY_KEY) === "true",
    continueToNext: window.localStorage.getItem(CONTINUE_TO_NEXT_KEY) === "true",
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
    },
  });

  store.subscribe((snapshot) => {
    const { autoplay, continueToNext } = snapshot.context;
    window.localStorage.setItem(AUTOPLAY_KEY, String(autoplay));
    window.localStorage.setItem(CONTINUE_TO_NEXT_KEY, String(continueToNext));
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
