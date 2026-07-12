import { createStore } from "@xstate/store-react";
import type { CredentialStorage } from "./types";

// See plan §8 (Security): the API key is exposed to page JS by nature of running
// entirely client-side, so it stays in memory unless the user opts into
// sessionStorage/localStorage persistence via `setStorage`.
const CREDENTIAL_STORAGE_KEY = "next-editor-agent-credentials";

export interface CredentialContext {
  apiKey: string;
  storage: CredentialStorage;
}

function getBrowserStorage(storage: CredentialStorage): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  if (storage === "local") {
    return window.localStorage;
  }

  if (storage === "session") {
    return window.sessionStorage;
  }

  return null;
}

function readPersistedApiKey(storage: CredentialStorage): string {
  try {
    return getBrowserStorage(storage)?.getItem(CREDENTIAL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writePersistedApiKey(storage: CredentialStorage, apiKey: string): void {
  try {
    window.localStorage.removeItem(CREDENTIAL_STORAGE_KEY);
    window.sessionStorage.removeItem(CREDENTIAL_STORAGE_KEY);
  } catch {
    return;
  }

  const target = getBrowserStorage(storage);

  if (!target || !apiKey) {
    return;
  }

  try {
    target.setItem(CREDENTIAL_STORAGE_KEY, apiKey);
  } catch (error) {
    console.warn("Failed to persist agent API key:", error);
  }
}

function detectInitialStorage(): CredentialStorage {
  try {
    if (typeof window !== "undefined" && window.localStorage.getItem(CREDENTIAL_STORAGE_KEY)) {
      return "local";
    }

    if (typeof window !== "undefined" && window.sessionStorage.getItem(CREDENTIAL_STORAGE_KEY)) {
      return "session";
    }
  } catch {
    // Storage may be unavailable (private browsing, quota); fall back to memory-only.
  }

  return "memory";
}

function initialContext(): CredentialContext {
  const storage = detectInitialStorage();
  return { apiKey: readPersistedApiKey(storage), storage };
}

export function createCredentialStore() {
  return createStore({
    context: initialContext(),
    on: {
      setApiKey: (context, event: { apiKey: string }) => {
        writePersistedApiKey(context.storage, event.apiKey);
        return { ...context, apiKey: event.apiKey };
      },
      setStorage: (context, event: { storage: CredentialStorage }) => {
        writePersistedApiKey(event.storage, context.apiKey);
        return { ...context, storage: event.storage };
      },
      clear: (context) => {
        writePersistedApiKey(context.storage, "");
        return { ...context, apiKey: "" };
      },
    },
  });
}

export type CredentialStoreInstance = ReturnType<typeof createCredentialStore>;

export const selectApiKey = (context: CredentialContext): string => context.apiKey;
export const selectCredentialStorage = (context: CredentialContext): CredentialStorage =>
  context.storage;

let sharedCredentialStore: CredentialStoreInstance | null = null;

/** App-wide singleton — there is exactly one Anthropic key per browser, not one per panel instance. */
export function getAgentCredentialStore(): CredentialStoreInstance {
  if (!sharedCredentialStore) {
    sharedCredentialStore = createCredentialStore();
  }

  return sharedCredentialStore;
}
