import { createStore } from "@xstate/store-react";
import { readStoredPreference, writeStoredPreference } from "./preferenceStorage";

const ENABLED_KEY = "caption-enabled";
const TRACK_KEY = "caption-track";
// Written before tracks were picked by id; still read, so a viewer's language carries over.
const LANGUAGE_KEY = "caption-language";

export interface CaptionStoreContext {
  enabled: boolean;
  /** The track the viewer picked. Two tracks can share a language, so this decides. */
  trackId: string | null;
  /** That track's language, for a lesson that does not have the track itself. */
  language: string | null;
}

function readInitialContext(): CaptionStoreContext {
  return {
    enabled: readStoredPreference(ENABLED_KEY) === "true",
    trackId: readStoredPreference(TRACK_KEY),
    language: readStoredPreference(LANGUAGE_KEY),
  };
}

export function createCaptionStore() {
  const store = createStore({
    context: readInitialContext(),
    on: {
      setEnabled: (context, event: { enabled: boolean }) =>
        event.enabled === context.enabled ? context : { ...context, enabled: event.enabled },
      toggleEnabled: (context) => ({ ...context, enabled: !context.enabled }),
      selectTrack: (context, event: { trackId: string; language: string }) =>
        event.trackId === context.trackId && event.language === context.language
          ? context
          : { ...context, trackId: event.trackId, language: event.language },
    },
  });

  store.subscribe((snapshot) => {
    const { enabled, trackId, language } = snapshot.context;
    writeStoredPreference(ENABLED_KEY, String(enabled));
    writeStoredPreference(TRACK_KEY, trackId || null);
    writeStoredPreference(LANGUAGE_KEY, language || null);
  });

  return store;
}

export type CaptionStoreInstance = ReturnType<typeof createCaptionStore>;

export const selectCaptionsEnabled = (context: CaptionStoreContext): boolean => context.enabled;
export const selectCaptionTrackId = (context: CaptionStoreContext): string | null =>
  context.trackId;
export const selectCaptionLanguage = (context: CaptionStoreContext): string | null =>
  context.language;
