import { describe, expect, it } from "vite-plus/test";
import { shouldUsePlaybackPreview } from "./usePreviewController";

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
