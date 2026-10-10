import { describe, expect, it } from "vite-plus/test";
import { getPlaybackAudioState } from "./playbackActors";
import type { Recording } from "../types";

describe("getPlaybackAudioState", () => {
  const audioBlob = new Blob(["audio"], { type: "audio/webm" });

  function makeRecording(overrides: Partial<Recording> = {}): Recording {
    return {
      version: 4,
      id: "rec-1",
      name: "Test",
      createdAt: 0,
      duration: 5000,
      keyframeInterval: 120,
      frames: [],
      audioBlob,
      ...overrides,
    };
  }

  it("returns null when recording is null", () => {
    expect(getPlaybackAudioState(null)).toBeNull();
  });

  it("returns null when audioBlob is missing", () => {
    expect(getPlaybackAudioState(makeRecording({ audioBlob: undefined }))).toBeNull();
  });

  it("returns null when audioBlob is empty", () => {
    expect(getPlaybackAudioState(makeRecording({ audioBlob: new Blob([]) }))).toBeNull();
  });

  it("returns state with blob when only audioBlob is present (no audioUrl)", () => {
    const state = getPlaybackAudioState(makeRecording({ audioUrl: undefined }));
    // Must not return null — newly recorded audio has a blob but no URL yet
    expect(state).not.toBeNull();
    expect(state!.blob).toBe(audioBlob);
    expect(state!.audioUrl).toBeUndefined();
  });

  it("returns state with both blob and audioUrl when recording is fully uploaded", () => {
    const state = getPlaybackAudioState(
      makeRecording({ audioUrl: "https://cdn.example.com/audio.weba" }),
    );
    expect(state).not.toBeNull();
    expect(state!.blob).toBe(audioBlob);
    expect(state!.audioUrl).toBe("https://cdn.example.com/audio.weba");
  });

  it("includes startOffsetMs from recording", () => {
    const state = getPlaybackAudioState(makeRecording({ audioStartOffsetMs: 500 }));
    expect(state!.startOffsetMs).toBe(500);
  });
});
