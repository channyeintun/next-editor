import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// Reading `window.localStorage` throws where the browser denies the document
// storage: site data blocked, or third-party storage blocked for an embedded
// lesson (kite-lang.dev embeds /learn/kite-crash-course).
function blockStorage(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("Access is denied for this document.", "SecurityError");
    },
  });
  return () => {
    if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
  };
}

let unblockStorage: (() => void) | null = null;

afterEach(() => {
  unblockStorage?.();
  unblockStorage = null;
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("preference stores without usable storage", () => {
  it("import with their defaults and keep working when storage is blocked", async () => {
    unblockStorage = blockStorage();
    vi.resetModules();

    // Both are module-level singletons, created while the module is evaluated.
    const { playbackSettingsStore } = await import("./playbackSettingsStore");
    const { recordingSettingsStore } = await import("./recordingSettingsStore");
    const { createCaptionStore } = await import("./captionStore");
    const captionStore = createCaptionStore();

    expect(playbackSettingsStore.getSnapshot().context).toEqual({
      autoplay: false,
      continueToNext: false,
      speed: 1,
      volume: 1,
    });
    expect(recordingSettingsStore.getSnapshot().context.screenRecordingEnabled).toBe(false);
    expect(captionStore.getSnapshot().context).toEqual({ enabled: false, language: null });

    playbackSettingsStore.trigger.setVolume({ volume: 0.5 });
    recordingSettingsStore.trigger.setScreenRecordingEnabled({ enabled: true });
    captionStore.trigger.setLanguage({ language: "en" });
    expect(playbackSettingsStore.getSnapshot().context.volume).toBe(0.5);
    expect(recordingSettingsStore.getSnapshot().context.screenRecordingEnabled).toBe(true);
    expect(captionStore.getSnapshot().context.language).toBe("en");
  });

  it("keep a change when the origin's storage is full", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    const { createPlaybackSettingsStore } = await import("./playbackSettingsStore");
    const store = createPlaybackSettingsStore();

    expect(() => store.trigger.setSpeed({ speed: 1.5 })).not.toThrow();
    expect(store.getSnapshot().context.speed).toBe(1.5);
  });
});
