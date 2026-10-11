import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createCredentialStore,
  selectApiKey,
  selectCredentialStorage,
  selectPersistFailed,
} from "./credentials";

function ctx(store: ReturnType<typeof createCredentialStore>) {
  return store.getSnapshot().context;
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

/** Makes the origin's storage refuse writes, as blocked site data or a full quota does. */
function blockStorageWrites() {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  });
}

describe("credentials", () => {
  it("defaults to memory-only storage with no key set", () => {
    const store = createCredentialStore();

    expect(selectCredentialStorage(ctx(store))).toBe("memory");
    expect(selectApiKey(ctx(store))).toBe("");
  });

  it("setApiKey under memory storage never touches localStorage/sessionStorage", () => {
    const store = createCredentialStore();
    store.trigger.setApiKey({ apiKey: "sk-ant-test" });

    expect(selectApiKey(ctx(store))).toBe("sk-ant-test");
    expect(window.localStorage.getItem("next-editor-agent-credentials")).toBeNull();
    expect(window.sessionStorage.getItem("next-editor-agent-credentials")).toBeNull();
  });

  it("setStorage('session') then setApiKey persists to sessionStorage only", () => {
    const store = createCredentialStore();
    store.trigger.setStorage({ storage: "session" });
    store.trigger.setApiKey({ apiKey: "sk-ant-test" });

    expect(window.sessionStorage.getItem("next-editor-agent-credentials")).toBe("sk-ant-test");
    expect(window.localStorage.getItem("next-editor-agent-credentials")).toBeNull();
  });

  it("setStorage('local') then setApiKey persists to localStorage only", () => {
    const store = createCredentialStore();
    store.trigger.setStorage({ storage: "local" });
    store.trigger.setApiKey({ apiKey: "sk-ant-test" });

    expect(window.localStorage.getItem("next-editor-agent-credentials")).toBe("sk-ant-test");
    expect(window.sessionStorage.getItem("next-editor-agent-credentials")).toBeNull();
  });

  it("a fresh store picks up a key already persisted in localStorage", () => {
    window.localStorage.setItem("next-editor-agent-credentials", "sk-ant-remembered");

    const store = createCredentialStore();

    expect(selectCredentialStorage(ctx(store))).toBe("local");
    expect(selectApiKey(ctx(store))).toBe("sk-ant-remembered");
  });

  // The key used to be kept in memory with no sign that it was not saved, so
  // it vanished on the next reload with no warning.
  it("reports a key the chosen storage refused, and keeps it in memory", () => {
    const setItem = blockStorageWrites();
    const store = createCredentialStore();
    store.trigger.setStorage({ storage: "local" });
    expect(selectPersistFailed(ctx(store))).toBe(false);

    store.trigger.setApiKey({ apiKey: "sk-ant-test" });

    expect(selectApiKey(ctx(store))).toBe("sk-ant-test");
    expect(selectPersistFailed(ctx(store))).toBe(true);

    setItem.mockRestore();
    store.trigger.setApiKey({ apiKey: "sk-ant-next" });

    expect(selectPersistFailed(ctx(store))).toBe(false);
    expect(window.localStorage.getItem("next-editor-agent-credentials")).toBe("sk-ant-next");
  });

  it("reports a refused write when switching storage, and clears the report on clear()", () => {
    blockStorageWrites();
    const store = createCredentialStore();
    store.trigger.setApiKey({ apiKey: "sk-ant-test" });
    expect(selectPersistFailed(ctx(store))).toBe(false);

    store.trigger.setStorage({ storage: "session" });
    expect(selectPersistFailed(ctx(store))).toBe(true);

    store.trigger.clear();
    expect(selectPersistFailed(ctx(store))).toBe(false);
  });

  it("never reports memory-only storage as failed", () => {
    blockStorageWrites();
    const store = createCredentialStore();
    store.trigger.setStorage({ storage: "local" });
    store.trigger.setStorage({ storage: "memory" });
    store.trigger.setApiKey({ apiKey: "sk-ant-test" });

    expect(selectPersistFailed(ctx(store))).toBe(false);
  });

  it("clear() removes the key from state and from whichever storage was active", () => {
    const store = createCredentialStore();
    store.trigger.setStorage({ storage: "local" });
    store.trigger.setApiKey({ apiKey: "sk-ant-test" });

    store.trigger.clear();

    expect(selectApiKey(ctx(store))).toBe("");
    expect(window.localStorage.getItem("next-editor-agent-credentials")).toBeNull();
  });
});
