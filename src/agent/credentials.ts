import { createStore } from "@xstate/store-react";
import type { CredentialStorage } from "./types";

// See plan §8 (Security): the API key is exposed to page JS by nature of running
// entirely client-side, so it stays in memory unless the user opts into
// sessionStorage/localStorage persistence via `setStorage`.
const CREDENTIAL_STORAGE_KEY = "next-editor-agent-credentials";

export interface CredentialContext {
  apiKey: string;
  storage: CredentialStorage;
  /**
   * True when the chosen browser storage refused the key (site data blocked or
   * the quota full): it is kept in memory only and is gone after a reload.
   */
  persistFailed: boolean;
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

/**
 * Stores the key in the chosen storage, removing it from the other. Returns
 * false only when a non-empty key was meant to persist and the browser refused,
 * so the caller can say it will not survive a reload.
 */
function writePersistedApiKey(storage: CredentialStorage, apiKey: string): boolean {
  const wantsPersist = storage !== "memory" && apiKey !== "";

  try {
    window.localStorage.removeItem(CREDENTIAL_STORAGE_KEY);
    window.sessionStorage.removeItem(CREDENTIAL_STORAGE_KEY);
  } catch {
    return !wantsPersist;
  }

  const target = getBrowserStorage(storage);

  if (!target || !apiKey) {
    return true;
  }

  try {
    target.setItem(CREDENTIAL_STORAGE_KEY, apiKey);
    return true;
  } catch (error) {
    console.warn("Failed to persist agent API key:", error);
    return false;
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
  return { apiKey: readPersistedApiKey(storage), storage, persistFailed: false };
}

export function createCredentialStore() {
  return createStore({
    context: initialContext(),
    on: {
      setApiKey: (context, event: { apiKey: string }) => {
        const persisted = writePersistedApiKey(context.storage, event.apiKey);
        return { ...context, apiKey: event.apiKey, persistFailed: !persisted };
      },
      setStorage: (context, event: { storage: CredentialStorage }) => {
        const persisted = writePersistedApiKey(event.storage, context.apiKey);
        return { ...context, storage: event.storage, persistFailed: !persisted };
      },
      clear: (context) => {
        writePersistedApiKey(context.storage, "");
        return { ...context, apiKey: "", persistFailed: false };
      },
    },
  });
}

export type CredentialStoreInstance = ReturnType<typeof createCredentialStore>;

export const selectApiKey = (context: CredentialContext): string => context.apiKey;
export const selectCredentialStorage = (context: CredentialContext): CredentialStorage =>
  context.storage;
export const selectPersistFailed = (context: CredentialContext): boolean => context.persistFailed;

let sharedCredentialStore: CredentialStoreInstance | null = null;

/** App-wide singleton — there is exactly one OpenRouter key per browser, not one per panel instance. */
export function getAgentCredentialStore(): CredentialStoreInstance {
  if (!sharedCredentialStore) {
    sharedCredentialStore = createCredentialStore();
  }

  return sharedCredentialStore;
}
