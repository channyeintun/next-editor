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
        lessonType: "node.js",
        usesPlaybackModel: true,
      }),
    ).toBe(true);

    expect(
      shouldUsePlaybackPreview({
        currentRecording,
        isPlaying: false,
        isRecording: false,
        lessonType: "node.js",
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
        lessonType: "node.js",
        usesPlaybackModel: false,
      }),
    ).toBe(false);

    expect(
      shouldUsePlaybackPreview({
        currentRecording: { id: "recording-1" },
        isPlaying: true,
        isRecording: true,
        lessonType: "html-css",
        usesPlaybackModel: true,
      }),
    ).toBe(false);
  });
});
