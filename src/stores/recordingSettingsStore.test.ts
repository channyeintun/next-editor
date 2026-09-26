import { describe, expect, it, beforeEach } from "vite-plus/test";
import {
  createRecordingSettingsStore,
  selectMicrophoneDeviceId,
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

  it("defaults to the system microphone", () => {
    expect(selectMicrophoneDeviceId(ctx(createRecordingSettingsStore()))).toBeNull();
  });

  it("remembers the picked microphone, and forgets it for the default", () => {
    const store = createRecordingSettingsStore();
    store.trigger.setMicrophoneDeviceId({ deviceId: "usb-mic" });

    expect(window.localStorage.getItem("recording-microphone-device")).toBe("usb-mic");
    expect(selectMicrophoneDeviceId(ctx(createRecordingSettingsStore()))).toBe("usb-mic");

    store.trigger.setMicrophoneDeviceId({ deviceId: "" });
    expect(selectMicrophoneDeviceId(ctx(store))).toBeNull();
    expect(window.localStorage.getItem("recording-microphone-device")).toBeNull();
  });
});
