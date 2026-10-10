import { describe, expect, it, vi } from "vite-plus/test";
import { narrationNoiseSeed } from "./pocket/noise";
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

const { pocketSynthProvider, synthesizePocketDialog, synthesizePocketWav } =
  await import("./pocketSynth");

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

describe("pocketSynthProvider", () => {
  it("shares one noise seed across dialogs, loads the engine on preload, and flags capped takes", async () => {
    const take = { samples: new Float32Array(2_400).fill(0.5), sampleRate: 24_000 };
    synthesize
      .mockReset()
      .mockResolvedValueOnce({ ...take, cappedChunkCount: 1 })
      .mockResolvedValueOnce({ ...take, cappedChunkCount: 0 });
    const buildSeed = 2 ** 32 + 7;

    const provider = pocketSynthProvider(PROFILE, buildSeed);

    expect(provider).toMatchObject({
      sampleRate: PROFILE.sampleRate,
      mimeType: PROFILE.mimeType,
      seed: narrationNoiseSeed(buildSeed),
    });
    expect(await provider.preload()).toEqual({ synthesize });
    const capped = await provider.synthesize("Hello there.");
    expect(capped.hitFrameCap).toBe(true);
    // The take was trimmed while synthesizing, so the Director gets it as is.
    expect(provider.prepareTake(capped.wav)).toBe(capped.wav);
    expect((await provider.synthesize("General Kenobi.")).hitFrameCap).toBe(false);
    expect(synthesize.mock.calls.map(([, seed]) => seed)).toEqual([
      narrationNoiseSeed(buildSeed),
      narrationNoiseSeed(buildSeed),
    ]);
  });
});
