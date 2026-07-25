import { describe, expect, it } from "vite-plus/test";
import { shouldAllowSameOriginPreview, shouldUsePlaybackPreview } from "./usePreviewController";

describe("shouldUsePlaybackPreview", () => {
  it("only lets a loaded recording own the runtime iframe while playback is active", () => {
    const currentRecording = { id: "recording-1" };

    expect(
      shouldUsePlaybackPreview({
        currentRecording,
        isPlaying: true,
        isRecording: false,
        usesPlaybackModel: true,
      }),
    ).toBe(true);

    expect(
      shouldUsePlaybackPreview({
        currentRecording,
        isPlaying: false,
        isRecording: false,
        usesPlaybackModel: true,
      }),
    ).toBe(false);

    // No loaded recording: the live runtime preview keeps the iframe.
    expect(
      shouldUsePlaybackPreview({
        currentRecording: null,
        isPlaying: true,
        isRecording: false,
        usesPlaybackModel: true,
      }),
    ).toBe(false);
  });

  it("does not use playback preview without an active playback model", () => {
    expect(
      shouldUsePlaybackPreview({
        currentRecording: { id: "recording-1" },
        isPlaying: true,
        isRecording: false,
        usesPlaybackModel: false,
      }),
    ).toBe(false);

    expect(
      shouldUsePlaybackPreview({
        currentRecording: { id: "recording-1" },
        isPlaying: true,
        isRecording: true,
        usesPlaybackModel: true,
      }),
    ).toBe(false);
  });
});

describe("shouldAllowSameOriginPreview", () => {
  const base = {
    hasRecording: true,
    isPlaybackPreviewActive: false,
    runsInWebContainer: true,
    hasRuntimePreviewUrl: true,
  };

  it("keeps the flag while the live WebContainer URL is showing", () => {
    // Required, not merely harmless: that document is cross-origin, and without
    // the flag its service worker cannot register — WebContainer then replaces
    // the app with its "enable storage partitioning" placeholder.
    expect(shouldAllowSameOriginPreview(base)).toBe(true);
  });

  it("keeps the flag when no recording is loaded", () => {
    expect(shouldAllowSameOriginPreview({ ...base, hasRecording: false })).toBe(true);
    expect(
      shouldAllowSameOriginPreview({
        ...base,
        hasRecording: false,
        hasRuntimePreviewUrl: false,
        runsInWebContainer: false,
      }),
    ).toBe(true);
  });

  it("drops the flag on every srcdoc path once a recording is open", () => {
    // Playback: recorded HTML is written to srcdoc, which inherits this origin.
    expect(shouldAllowSameOriginPreview({ ...base, isPlaybackPreviewActive: true })).toBe(false);
    // Runtime not up yet, so the frame shows srcdoc, not the cross-origin URL.
    expect(shouldAllowSameOriginPreview({ ...base, hasRuntimePreviewUrl: false })).toBe(false);
    // Non-WebContainer lesson: never points at a cross-origin runtime URL.
    expect(shouldAllowSameOriginPreview({ ...base, runsInWebContainer: false })).toBe(false);
  });
});
