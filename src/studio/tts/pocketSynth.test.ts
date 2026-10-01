import { describe, expect, it, vi } from "vite-plus/test";
import { requireVoiceProfile, type PocketVoiceProfile } from "./profiles";
import { decodeWavPcm16 } from "./wav";

const synthesize = vi.hoisted(() =>
  vi.fn<
    (
      text: string,
      seed: number,
    ) => Promise<{ samples: Float32Array; sampleRate: number; cappedChunkCount: number }>
  >(),
);

vi.mock("./pocket/engine", () => ({
  PocketTtsEngine: { load: async () => ({ synthesize }) },
}));

vi.mock("./customVoices", () => ({ getCustomVoice: async () => null }));

const { synthesizePocketDialog, synthesizePocketWav } = await import("./pocketSynth");

const PROFILE = requireVoiceProfile("pocket-alba-v1") as PocketVoiceProfile;

describe("synthesizePocketDialog", () => {
  it("passes through how many chunks hit the engine's frame cap", async () => {
    synthesize.mockResolvedValue({
      samples: new Float32Array(2_400).fill(0.5),
      sampleRate: 24_000,
      cappedChunkCount: 1,
    });

    const dialog = await synthesizePocketDialog(PROFILE, "Hello there.", 7);

    expect(dialog.cappedChunkCount).toBe(1);
    expect(decodeWavPcm16(dialog.wav).sampleRate).toBe(24_000);
    expect(await synthesizePocketWav(PROFILE, "Hello there.", 7)).toEqual(dialog.wav);
  });
});
