import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "../core/src";
import { useApplyPersistedPlaybackSettings } from "./useApplyPersistedPlaybackSettings";

const recording = (id: string) => ({ id, duration: 60_000, frames: [] }) as unknown as Recording;

type Options = Parameters<typeof useApplyPersistedPlaybackSettings>[0];

function render(overrides: Partial<Options> = {}) {
  const setPlaybackSpeed = vi.fn<(speed: number) => void>();
  const setVolume = vi.fn<(volume: number) => void>();
  const initialProps: Options = {
    currentRecording: recording("lesson"),
    playbackSpeed: 1,
    volume: 1,
    persistedSpeed: 1.5,
    persistedVolume: 0.4,
    setPlaybackSpeed,
    setVolume,
    ...overrides,
  };
  const hook = renderHook((props: Options) => useApplyPersistedPlaybackSettings(props), {
    initialProps,
  });
  return { setPlaybackSpeed, setVolume, initialProps, ...hook };
}

describe("useApplyPersistedPlaybackSettings", () => {
  it("pushes the persisted speed and volume once a recording is loaded", () => {
    const { setPlaybackSpeed, setVolume } = render();

    expect(setPlaybackSpeed).toHaveBeenCalledTimes(1);
    expect(setPlaybackSpeed).toHaveBeenCalledWith(1.5);
    expect(setVolume).toHaveBeenCalledTimes(1);
    expect(setVolume).toHaveBeenCalledWith(0.4);
  });

  it("does not push values the machine already has", () => {
    const { setPlaybackSpeed, setVolume } = render({ playbackSpeed: 1.5, volume: 0.4 });

    expect(setPlaybackSpeed).not.toHaveBeenCalled();
    expect(setVolume).not.toHaveBeenCalled();
  });

  // RecordingEditPanel silences a pending mute through the machine alone; the
  // persisted volume must not be pushed back over it.
  it("leaves a machine-only volume change alone", () => {
    const { setVolume, rerender, initialProps } = render({ volume: 1, persistedVolume: 1 });
    expect(setVolume).not.toHaveBeenCalled();

    rerender({ ...initialProps, volume: 0 });

    expect(setVolume).not.toHaveBeenCalled();
  });

  it("pushes a changed persisted value", () => {
    const { setVolume, rerender, initialProps } = render({ volume: 0.4, persistedVolume: 0.4 });

    rerender({ ...initialProps, persistedVolume: 0.7 });

    expect(setVolume).toHaveBeenCalledTimes(1);
    expect(setVolume).toHaveBeenCalledWith(0.7);
  });

  it("pushes again when a recording is reloaded", () => {
    const { setPlaybackSpeed, setVolume, rerender, initialProps } = render();
    // The machine took the first push.
    rerender({ ...initialProps, playbackSpeed: 1.5, volume: 0.4 });
    expect(setVolume).toHaveBeenCalledTimes(1);

    // Re-entering playback assigns a fresh recording to a machine back at its defaults.
    rerender({ ...initialProps, currentRecording: recording("lesson") });

    expect(setPlaybackSpeed).toHaveBeenCalledTimes(2);
    expect(setVolume).toHaveBeenCalledTimes(2);
    expect(setVolume).toHaveBeenLastCalledWith(0.4);
  });

  it("never pushes without a recording", () => {
    const { setPlaybackSpeed, setVolume, rerender, initialProps } = render({
      currentRecording: null,
    });

    rerender({ ...initialProps, persistedVolume: 0.9 });

    expect(setPlaybackSpeed).not.toHaveBeenCalled();
    expect(setVolume).not.toHaveBeenCalled();
  });
});
