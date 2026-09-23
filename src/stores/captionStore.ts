import { createStore } from "@xstate/store-react";
import { readStoredPreference, writeStoredPreference } from "./preferenceStorage";

const ENABLED_KEY = "caption-enabled";
const LANGUAGE_KEY = "caption-language";

export interface CaptionStoreContext {
  enabled: boolean;
  language: string | null;
}

function readInitialContext(): CaptionStoreContext {
  return {
    enabled: readStoredPreference(ENABLED_KEY) === "true",
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
      setLanguage: (context, event: { language: string | null }) =>
        event.language === context.language ? context : { ...context, language: event.language },
    },
  });

  store.subscribe((snapshot) => {
    const { enabled, language } = snapshot.context;
    writeStoredPreference(ENABLED_KEY, String(enabled));
    writeStoredPreference(LANGUAGE_KEY, language || null);
  });

  return store;
}

export type CaptionStoreInstance = ReturnType<typeof createCaptionStore>;

export const selectCaptionsEnabled = (context: CaptionStoreContext): boolean => context.enabled;
export const selectCaptionLanguage = (context: CaptionStoreContext): string | null =>
  context.language;
