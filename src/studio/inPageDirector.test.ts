import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { sha256HexOfJson } from "./hash";
import { LEXICON_V1 } from "./script/lexicon";
import { parseLessonScript } from "./script/schema";
import { VOICE_PROFILES } from "./tts/profiles";
import { encodeWavPcm16 } from "./tts/wav";

const tts = vi.hoisted(() => ({
  getCachedDialogWav: vi.fn<(requestHash: string) => Promise<Uint8Array | null>>(),
  preloadPocket: vi.fn<(...args: unknown[]) => Promise<void>>(),
  putCachedDialogWav: vi.fn<(...args: unknown[]) => Promise<void>>(),
  synthesizePocketWav:
    vi.fn<(profile: unknown, speechText: string, noiseSeed: number) => Promise<Uint8Array>>(),
  synthesizeModalVoxCpm2Wav:
    vi.fn<(profile: unknown, speechText: string, seed: number) => Promise<Uint8Array>>(),
}));

vi.mock("./tts/dialogCache", () => ({
  getCachedDialogWav: tts.getCachedDialogWav,
  putCachedDialogWav: tts.putCachedDialogWav,
}));

vi.mock("./tts/pocketSynth", () => ({
  preloadPocket: tts.preloadPocket,
  synthesizePocketWav: tts.synthesizePocketWav,
}));

vi.mock("./tts/modalVoxCpm2Synth", () => ({
  synthesizeModalVoxCpm2Wav: tts.synthesizeModalVoxCpm2Wav,
}));

const { buildPlanFromScript } = await import("./inPageDirector");

function loadPilot() {
  return parseLessonScript(
    YAML.parse(readFileSync(resolve(__dirname, "./script/__fixtures__/go-swap.yaml"), "utf8")),
  );
}

describe("buildPlanFromScript narration", () => {
  beforeEach(() => {
    tts.getCachedDialogWav.mockReset().mockResolvedValue(null);
    tts.preloadPocket.mockReset().mockResolvedValue();
    tts.putCachedDialogWav.mockReset().mockResolvedValue();
    tts.synthesizePocketWav.mockReset().mockImplementation(async (_, speechText) => {
      const tokenCount = speechText.split(/\s+/).length;
      const durationMs = 400 + tokenCount * 320;
      return encodeWavPcm16(new Int16Array(Math.ceil(24 * durationMs)), 24_000);
    });
    tts.synthesizeModalVoxCpm2Wav.mockReset().mockImplementation(async (_, speechText) => {
      const tokenCount = speechText.split(/\s+/).length;
      const durationMs = 400 + tokenCount * 320;
      return encodeWavPcm16(new Int16Array(Math.ceil(48 * durationMs)), 48_000);
    });
  });

  it("reuses the plan seed across dialogs and bypasses legacy cached audio", async () => {
    const script = loadPilot();
    const runAction = script.scenes
      .flatMap((scene) => scene.actions)
      .find((action) => action.type === "runtime.run");
    if (!runAction) throw new Error("Pilot is missing its runtime action");
    for (const scene of script.scenes) scene.actions = [];
    script.scenes.at(-1)!.actions = [runAction];
    const result = await buildPlanFromScript(script);
    const calls = tts.synthesizePocketWav.mock.calls;

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.map(([, , noiseSeed]) => noiseSeed)).toEqual(
      Array.from({ length: calls.length }, () => script.build.seed),
    );
    expect(result.synthesizedCount).toBe(result.dialogCount);

    const legacyHash = await sha256HexOfJson({
      profile: VOICE_PROFILES[script.build.voiceProfile],
      speechText: calls[0][1],
      lexiconVersion: LEXICON_V1.version,
      seed: script.build.seed,
      postProcessVersion: 1,
    });
    expect(tts.getCachedDialogWav.mock.calls.map(([requestHash]) => requestHash)).not.toContain(
      legacyHash,
    );
  });

  it("dispatches a Modal VoxCPM2 profile without loading Pocket-TTS", async () => {
    const script = loadPilot();
    script.lesson.locale = "my-MM";
    const result = await buildPlanFromScript(script, {
      voiceProfile: VOICE_PROFILES["modal-voxcpm2-burmese-v1"],
    });

    expect(tts.preloadPocket).not.toHaveBeenCalled();
    expect(tts.synthesizePocketWav).not.toHaveBeenCalled();
    expect(tts.synthesizeModalVoxCpm2Wav).toHaveBeenCalled();
    expect(tts.synthesizeModalVoxCpm2Wav.mock.calls.map(([, , seed]) => seed)).toEqual(
      Array.from({ length: result.dialogCount }, () => script.build.seed),
    );
    expect(result.plan.lesson.locale).toBe("my-MM");
    expect(result.plan.narration.mimeType).toBe("audio/wav");
  });
});
