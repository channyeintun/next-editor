import { createStore } from "@xstate/store-react";

const ENABLED_KEY = "caption-enabled";
const LANGUAGE_KEY = "caption-language";

export interface CaptionStoreContext {
  enabled: boolean;
  language: string | null;
}

function readInitialContext(): CaptionStoreContext {
  if (typeof window === "undefined") return { enabled: false, language: null };
  return {
    enabled: window.localStorage.getItem(ENABLED_KEY) === "true",
    language: window.localStorage.getItem(LANGUAGE_KEY),
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
    window.localStorage.setItem(ENABLED_KEY, String(enabled));
    if (language) {
      window.localStorage.setItem(LANGUAGE_KEY, language);
    } else {
      window.localStorage.removeItem(LANGUAGE_KEY);
    }
  });

  return store;
}

export type CaptionStoreInstance = ReturnType<typeof createCaptionStore>;

export const selectCaptionsEnabled = (context: CaptionStoreContext): boolean => context.enabled;
export const selectCaptionLanguage = (context: CaptionStoreContext): string | null =>
  context.language;
