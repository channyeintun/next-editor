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

/** The live region a screen reader listens to. It is always there; only its text changes. */
const liveRegion = () => document.querySelector('[aria-live="polite"]')!;
const announced = () => liveRegion().textContent;
/** The spinner the sighted viewer sees. */
const spinner = (container: HTMLElement) => container.querySelector(".animate-spin");

describe("PlaybackBufferingIndicator", () => {
  it("shows and says nothing while the lesson is not held", () => {
    const { container } = render(<PlaybackBufferingIndicator />);
    wait(5_000);

    expect(announced()).toBe("");
    expect(spinner(container)).toBeNull();
  });

  it("says the narration is loading once a hold has lasted", () => {
    playback.buffering = true;
    const { container } = render(<PlaybackBufferingIndicator />);

    // A seek holds the lesson for a few milliseconds: no blink for that.
    wait(499);
    expect(announced()).toBe("");
    expect(spinner(container)).toBeNull();

    wait(1);
    expect(announced()).toBe("Loading narration");
    expect(spinner(container)).not.toBeNull();
  });

  // A live region that is inserted already filled is often not announced at all, so
  // the region is there from the start and the hold only changes its text.
  it("announces through a live region that was there before the hold", () => {
    const { rerender } = render(<PlaybackBufferingIndicator />);
    const region = liveRegion();
    expect(region.textContent).toBe("");

    playback.buffering = true;
    rerender(<PlaybackBufferingIndicator />);
    wait(500);

    expect(liveRegion()).toBe(region);
    expect(region.textContent).toBe("Loading narration");
    // The spinner is decoration: one announcement, and no status region beside the
    // one the editor keeps for a lesson that is loading.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("goes away when the hold ends, and counts the next hold from its start", () => {
    playback.buffering = true;
    const { container, rerender } = render(<PlaybackBufferingIndicator />);
    wait(500);
    expect(spinner(container)).not.toBeNull();

    playback.buffering = false;
    rerender(<PlaybackBufferingIndicator />);
    expect(announced()).toBe("");
    expect(spinner(container)).toBeNull();

    playback.buffering = true;
    rerender(<PlaybackBufferingIndicator />);
    wait(499);
    expect(announced()).toBe("");
    expect(spinner(container)).toBeNull();
    wait(1);
    expect(announced()).toBe("Loading narration");
    expect(spinner(container)).not.toBeNull();
  });
});
