import { describe, expect, it } from "vite-plus/test";
import type { Recording } from "../core/src";
import { attachCompanionAudio } from "./recordingImport";

function createRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    version: 4,
    id: "recording-1",
    name: "Import test recording",
    createdAt: 1_700_000_000_000,
    duration: 1000,
    keyframeInterval: 120,
    frames: [],
    ...overrides,
  };
}

describe("attachCompanionAudio", () => {
  it("matches a companion audio file by .ne basename when external audio is declared without a filename", () => {
    // Older exports wrote `audioSource: "external"` without persisting `audioFile` — a
    // basename-matching companion picked alongside the `.ne` must still attach.
    const recording = createRecording({ audioSource: "external" });
    const audio = new File([new Uint8Array([1, 2, 3]) as BlobPart], "introduction.weba", {
      type: "audio/webm",
    });

    const attached = attachCompanionAudio(recording, [audio], "introduction.ne");

    expect(attached.audioBlob).toBe(audio);
  });

  it("does not attach audio to a recording that declares no audio at all", () => {
    const recording = createRecording();
    const audio = new File([new Uint8Array([1]) as BlobPart], "introduction.weba", {
      type: "audio/webm",
    });

    const attached = attachCompanionAudio(recording, [audio], "introduction.ne");

    expect(attached.audioBlob).toBeUndefined();
  });
});
