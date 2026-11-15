import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import PlaybackBufferingIndicator from "./PlaybackBufferingIndicator";

const playback = vi.hoisted(() => ({ buffering: false }));

vi.mock("../hooks/useNextEditorContext", () => ({
  useIsBuffering: () => playback.buffering,
}));

beforeEach(() => {
  vi.useFakeTimers();
  playback.buffering = false;
});

afterEach(() => {
  vi.useRealTimers();
});

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("PlaybackBufferingIndicator", () => {
  it("shows nothing while the lesson is not held", () => {
    render(<PlaybackBufferingIndicator />);
    wait(5_000);

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says the narration is loading once a hold has lasted", () => {
    playback.buffering = true;
    render(<PlaybackBufferingIndicator />);

    // A seek holds the lesson for a few milliseconds: no blink for that.
    wait(499);
    expect(screen.queryByRole("status")).toBeNull();

    wait(1);
    expect(screen.getByRole("status").textContent).toBe("Loading narration");
  });

  it("goes away when the hold ends, and counts the next hold from its start", () => {
    playback.buffering = true;
    const { rerender } = render(<PlaybackBufferingIndicator />);
    wait(500);
    expect(screen.queryByRole("status")).not.toBeNull();

    playback.buffering = false;
    rerender(<PlaybackBufferingIndicator />);
    expect(screen.queryByRole("status")).toBeNull();

    playback.buffering = true;
    rerender(<PlaybackBufferingIndicator />);
    wait(499);
    expect(screen.queryByRole("status")).toBeNull();
    wait(1);
    expect(screen.queryByRole("status")).not.toBeNull();
  });
});
