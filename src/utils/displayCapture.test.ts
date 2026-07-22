import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireDisplayStream, isScreenCaptureSupported } from "./displayCapture";

// isMobileBrowser reads navigator; stub it so support gating is deterministic.
vi.mock("./isMobileBrowser", () => ({ isMobileBrowser: () => mockIsMobile }));
let mockIsMobile = false;

const originalNavigator = globalThis.navigator;
const originalWindow = (globalThis as { window?: unknown }).window;

function setMediaDevices(mediaDevices: unknown): void {
  Object.defineProperty(globalThis, "navigator", {
    value: mediaDevices === undefined ? {} : { mediaDevices },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  mockIsMobile = false;
  Object.defineProperty(globalThis, "navigator", {
    value: originalNavigator,
    configurable: true,
    writable: true,
  });
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("isScreenCaptureSupported", () => {
  it("is true when getDisplayMedia exists on a non-mobile browser", () => {
    setMediaDevices({ getDisplayMedia: () => {} });
    mockIsMobile = false;
    expect(isScreenCaptureSupported()).toBe(true);
  });

  it("is false when getDisplayMedia is absent", () => {
    setMediaDevices({});
    expect(isScreenCaptureSupported()).toBe(false);
  });

  it("is false on mobile even when getDisplayMedia exists", () => {
    setMediaDevices({ getDisplayMedia: () => {} });
    mockIsMobile = true;
    expect(isScreenCaptureSupported()).toBe(false);
  });
});

describe("acquireDisplayStream", () => {
  it("requests the current tab with the pinned capture options and the given audio flag", async () => {
    const stream = {} as MediaStream;
    const getDisplayMedia = vi
      .fn<(options: Record<string, unknown>) => Promise<MediaStream>>()
      .mockResolvedValue(stream);
    setMediaDevices({ getDisplayMedia });
    // No CaptureController in this environment — the helper must proceed without it.
    (globalThis as { window?: unknown }).window = {};

    const result = await acquireDisplayStream(true);

    expect(result).toBe(stream);
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    const options = getDisplayMedia.mock.calls[0][0];
    expect(options).toMatchObject({
      audio: true,
      preferCurrentTab: true,
      selfBrowserSurface: "include",
      surfaceSwitching: "include",
      systemAudio: "exclude",
    });
    expect(options.video).toMatchObject({ frameRate: { ideal: 30, max: 30 } });
  });

  it("passes audio:false through when tab audio is not requested", async () => {
    const getDisplayMedia = vi
      .fn<(options: Record<string, unknown>) => Promise<MediaStream>>()
      .mockResolvedValue({} as MediaStream);
    setMediaDevices({ getDisplayMedia });
    (globalThis as { window?: unknown }).window = {};

    await acquireDisplayStream(false);

    expect(getDisplayMedia.mock.calls[0][0]).toMatchObject({ audio: false });
  });
});
