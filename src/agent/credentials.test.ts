import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore, selectApiKey, selectCredentialStorage } from "./credentials";

function ctx(store: ReturnType<typeof createCredentialStore>) {
  return store.getSnapshot().context;
}

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

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

  it("clear() removes the key from state and from whichever storage was active", () => {
    const store = createCredentialStore();
    store.trigger.setStorage({ storage: "local" });
    store.trigger.setApiKey({ apiKey: "sk-ant-test" });

    store.trigger.clear();

    expect(selectApiKey(ctx(store))).toBe("");
    expect(window.localStorage.getItem("next-editor-agent-credentials")).toBeNull();
  });
});
