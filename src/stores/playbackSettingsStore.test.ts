import { describe, expect, it, beforeEach } from "vite-plus/test";
import {
  createPlaybackSettingsStore,
  selectAutoplay,
  selectContinueToNext,
} from "./playbackSettingsStore";

function ctx(store: ReturnType<typeof createPlaybackSettingsStore>) {
  return store.getSnapshot().context;
}

describe("playbackSettingsStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults both settings to off", () => {
    const store = createPlaybackSettingsStore();
    const c = ctx(store);

    expect(selectAutoplay(c)).toBe(false);
    expect(selectContinueToNext(c)).toBe(false);
  });

  it("setAutoplay updates autoplay independently of continueToNext", () => {
    const store = createPlaybackSettingsStore();
    store.trigger.setAutoplay({ autoplay: true });

    expect(selectAutoplay(ctx(store))).toBe(true);
    expect(selectContinueToNext(ctx(store))).toBe(false);
  });

  it("setContinueToNext updates continueToNext independently of autoplay", () => {
    const store = createPlaybackSettingsStore();
    store.trigger.setContinueToNext({ continueToNext: true });

    expect(selectContinueToNext(ctx(store))).toBe(true);
    expect(selectAutoplay(ctx(store))).toBe(false);
  });

  it("persists settings to localStorage and rehydrates a new store instance", () => {
    const store = createPlaybackSettingsStore();
    store.trigger.setAutoplay({ autoplay: true });
    store.trigger.setContinueToNext({ continueToNext: true });

    expect(window.localStorage.getItem("playback-autoplay")).toBe("true");
    expect(window.localStorage.getItem("playback-continue-to-next")).toBe("true");

    const rehydrated = createPlaybackSettingsStore();
    expect(selectAutoplay(ctx(rehydrated))).toBe(true);
    expect(selectContinueToNext(ctx(rehydrated))).toBe(true);
  });
});
