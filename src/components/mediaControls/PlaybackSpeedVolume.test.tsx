import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import PlaybackSpeedVolume from "./PlaybackSpeedVolume";
import { playbackSettingsStore } from "../../stores/playbackSettingsStore";

const calls = vi.hoisted(() => [] as string[]);
const actions = vi.hoisted(() => ({
  setPlaybackSpeed: vi.fn<(speed: number) => void>((speed) => {
    calls.push(`machine speed ${speed}`);
  }),
  setVolume: vi.fn<(volume: number) => void>((volume) => {
    calls.push(`machine volume ${volume}`);
  }),
}));

vi.mock("../../hooks/useNextEditorContext", () => ({
  useNextEditorActions: () => actions,
  useNextEditorPlayback: () => ({ playbackSpeed: 1.25, volume: 0.6 }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  calls.length = 0;
  playbackSettingsStore.trigger.setSpeed({ speed: 1 });
  playbackSettingsStore.trigger.setVolume({ volume: 1 });
  window.localStorage.clear();
});

describe("PlaybackSpeedVolume", () => {
  it("shows the player's speed and volume on sliders over the player's ranges", () => {
    render(<PlaybackSpeedVolume />);
    // Named by their visible labels, and read out with their units.
    const speed = screen.getByRole("slider", { name: "Speed" });
    const volume = screen.getByRole("slider", { name: "Volume" });

    expect(screen.getByText("1.25x")).toBeInTheDocument();
    expect(speed).toHaveAttribute("min", "0.5");
    expect(speed).toHaveAttribute("max", "2");
    expect(speed).toHaveAttribute("step", "0.25");
    expect(speed).toHaveValue("1.25");
    expect(speed).toHaveAttribute("aria-valuetext", "1.25×");

    expect(screen.getByText("60")).toBeInTheDocument();
    expect(volume).toHaveAttribute("min", "0");
    expect(volume).toHaveAttribute("max", "1");
    expect(volume).toHaveAttribute("step", "0.1");
    expect(volume).toHaveValue("0.6");
    expect(volume).toHaveAttribute("aria-valuetext", "60%");
  });

  it("applies a change to this playback first, then keeps it as the player's setting", () => {
    vi.spyOn(playbackSettingsStore.trigger, "setSpeed").mockImplementation(({ speed }) => {
      calls.push(`setting speed ${speed}`);
    });
    vi.spyOn(playbackSettingsStore.trigger, "setVolume").mockImplementation(({ volume }) => {
      calls.push(`setting volume ${volume}`);
    });
    render(<PlaybackSpeedVolume />);
    const speed = screen.getByRole("slider", { name: "Speed" });
    const volume = screen.getByRole("slider", { name: "Volume" });

    fireEvent.change(speed, { target: { value: "1.5" } });
    fireEvent.change(volume, { target: { value: "0.3" } });

    expect(calls).toEqual([
      "machine speed 1.5",
      "setting speed 1.5",
      "machine volume 0.3",
      "setting volume 0.3",
    ]);
  });

  it("remembers a change for the next lesson", () => {
    render(<PlaybackSpeedVolume />);

    fireEvent.change(screen.getByRole("slider", { name: "Speed" }), { target: { value: "1.75" } });
    expect(window.localStorage.getItem("playback-speed")).toBe("1.75");
  });
});
