import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createPlaybackSettingsStore,
  selectAutoplay,
  selectCharacterShortcuts,
  selectContinueToNext,
  selectSpeed,
  selectVolume,
} from "./playbackSettingsStore";

function ctx(store: ReturnType<typeof createPlaybackSettingsStore>) {
  return store.getSnapshot().context;
}

describe("playbackSettingsStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults toggles to off and speed/volume to 1", () => {
    const store = createPlaybackSettingsStore();
    const c = ctx(store);

    expect(selectAutoplay(c)).toBe(false);
    expect(selectContinueToNext(c)).toBe(false);
    expect(selectSpeed(c)).toBe(1);
    expect(selectVolume(c)).toBe(1);
  });

  it("defaults single-key shortcuts to on", () => {
    expect(selectCharacterShortcuts(ctx(createPlaybackSettingsStore()))).toBe(true);
  });

  it("persists single-key shortcuts turned off, and on again", () => {
    const store = createPlaybackSettingsStore();
    store.trigger.setCharacterShortcuts({ enabled: false });

    expect(selectCharacterShortcuts(ctx(store))).toBe(false);
    expect(window.localStorage.getItem("playback-character-shortcuts")).toBe("false");
    expect(selectCharacterShortcuts(ctx(createPlaybackSettingsStore()))).toBe(false);

    store.trigger.setCharacterShortcuts({ enabled: true });
    expect(window.localStorage.getItem("playback-character-shortcuts")).toBe("true");
    expect(selectCharacterShortcuts(ctx(createPlaybackSettingsStore()))).toBe(true);
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
    store.trigger.setSpeed({ speed: 1.5 });
    store.trigger.setVolume({ volume: 0.4 });

    expect(window.localStorage.getItem("playback-autoplay")).toBe("true");
    expect(window.localStorage.getItem("playback-continue-to-next")).toBe("true");
    expect(window.localStorage.getItem("playback-speed")).toBe("1.5");
    expect(window.localStorage.getItem("playback-volume")).toBe("0.4");

    const rehydrated = createPlaybackSettingsStore();
    expect(selectAutoplay(ctx(rehydrated))).toBe(true);
    expect(selectContinueToNext(ctx(rehydrated))).toBe(true);
    expect(selectSpeed(ctx(rehydrated))).toBe(1.5);
    expect(selectVolume(ctx(rehydrated))).toBe(0.4);
  });

  it("writes only the key that changed", () => {
    const store = createPlaybackSettingsStore();
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    store.trigger.setVolume({ volume: 0.5 });
    store.trigger.setVolume({ volume: 0.25 });

    expect(setItem.mock.calls).toEqual([
      ["playback-volume", "0.5"],
      ["playback-volume", "0.25"],
    ]);
  });

  it("leaves another tab's newer value alone for a key it did not change", () => {
    const store = createPlaybackSettingsStore();
    window.localStorage.setItem("playback-speed", "1.5");

    store.trigger.setVolume({ volume: 0.5 });

    expect(window.localStorage.getItem("playback-speed")).toBe("1.5");
    expect(window.localStorage.getItem("playback-volume")).toBe("0.5");
  });

  it("clamps speed/volume to the slider ranges on set", () => {
    const store = createPlaybackSettingsStore();

    store.trigger.setSpeed({ speed: 99 });
    store.trigger.setVolume({ volume: -0.5 });
    expect(selectSpeed(ctx(store))).toBe(2);
    expect(selectVolume(ctx(store))).toBe(0);

    store.trigger.setSpeed({ speed: 0.1 });
    store.trigger.setVolume({ volume: 3 });
    expect(selectSpeed(ctx(store))).toBe(0.5);
    expect(selectVolume(ctx(store))).toBe(1);
  });

  it("ignores non-finite values and sanitizes junk localStorage on rehydrate", () => {
    const store = createPlaybackSettingsStore();
    store.trigger.setSpeed({ speed: Number.NaN });
    store.trigger.setVolume({ volume: Number.POSITIVE_INFINITY });
    expect(selectSpeed(ctx(store))).toBe(1);
    expect(selectVolume(ctx(store))).toBe(1);

    window.localStorage.setItem("playback-speed", "abc");
    window.localStorage.setItem("playback-volume", "42");
    const rehydrated = createPlaybackSettingsStore();
    expect(selectSpeed(ctx(rehydrated))).toBe(1);
    expect(selectVolume(ctx(rehydrated))).toBe(1);
  });
});
