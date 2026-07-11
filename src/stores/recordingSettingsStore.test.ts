import { describe, expect, it, beforeEach } from "vite-plus/test";
import {
  createRecordingSettingsStore,
  selectScreenRecordingEnabled,
} from "./recordingSettingsStore";

function ctx(store: ReturnType<typeof createRecordingSettingsStore>) {
  return store.getSnapshot().context;
}

describe("recordingSettingsStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults screenRecordingEnabled to false", () => {
    const store = createRecordingSettingsStore();
    const c = ctx(store);

    expect(selectScreenRecordingEnabled(c)).toBe(false);
  });

  it("setScreenRecordingEnabled updates screenRecordingEnabled", () => {
    const store = createRecordingSettingsStore();
    store.trigger.setScreenRecordingEnabled({ enabled: true });

    expect(selectScreenRecordingEnabled(ctx(store))).toBe(true);
  });

  it("persists settings to localStorage and rehydrates a new store instance", () => {
    const store = createRecordingSettingsStore();
    store.trigger.setScreenRecordingEnabled({ enabled: true });

    expect(window.localStorage.getItem("recording-screen-capture")).toBe("true");

    const rehydrated = createRecordingSettingsStore();
    expect(selectScreenRecordingEnabled(ctx(rehydrated))).toBe(true);
  });

  it("returns identity-stable context when setting the same value twice", () => {
    const store = createRecordingSettingsStore();
    const snapshot1 = store.getSnapshot().context;
    store.trigger.setScreenRecordingEnabled({ enabled: false });
    const snapshot2 = store.getSnapshot().context;

    expect(snapshot1).toBe(snapshot2);
  });

  it("changes context when setting a different value", () => {
    const store = createRecordingSettingsStore();
    const snapshot1 = store.getSnapshot().context;
    store.trigger.setScreenRecordingEnabled({ enabled: true });
    const snapshot2 = store.getSnapshot().context;

    expect(snapshot1).not.toBe(snapshot2);
    expect(selectScreenRecordingEnabled(snapshot2)).toBe(true);
  });
});
