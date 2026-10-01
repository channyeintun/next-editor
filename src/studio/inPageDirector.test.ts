import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { sha256HexOfJson } from "./hash";
import { LEXICON_V1 } from "./script/lexicon";
import { parseLessonScript } from "./script/schema";
import { ttsRequestHash, VOICE_PROFILES } from "./tts/profiles";
import { encodeWavPcm16 } from "./tts/wav";

const tts = vi.hoisted(() => ({
  getCachedDialogWav:
    vi.fn<(requestHash: string) => Promise<{ wav: Uint8Array; hitFrameCap: boolean } | null>>(),
  deleteCachedDialogWav: vi.fn<(requestHash: string) => Promise<void>>(),
  preloadPocket: vi.fn<(...args: unknown[]) => Promise<void>>(),
  putCachedDialogWav: vi.fn<(...args: unknown[]) => Promise<void>>(),
  synthesizePocketDialog:
    vi.fn<
      (
        profile: unknown,
        speechText: string,
        noiseSeed: number,
      ) => Promise<{ wav: Uint8Array; cappedChunkCount: number }>
    >(),
  synthesizeModalVoxCpm2Wav:
    vi.fn<(profile: unknown, speechText: string, seed: number) => Promise<Uint8Array>>(),
}));

vi.mock("./tts/dialogCache", () => ({
  getCachedDialogWav: tts.getCachedDialogWav,
  deleteCachedDialogWav: tts.deleteCachedDialogWav,
  putCachedDialogWav: tts.putCachedDialogWav,
}));

vi.mock("./tts/pocketSynth", () => ({
  preloadPocket: tts.preloadPocket,
  synthesizePocketDialog: tts.synthesizePocketDialog,
}));

vi.mock("./tts/modalVoxCpm2Synth", () => ({
  synthesizeModalVoxCpm2Wav: tts.synthesizeModalVoxCpm2Wav,
}));

const { buildPlanFromScript } = await import("./inPageDirector");

/** A voiced (non-silent) PCM16 mono WAV of the given length. */
function voicedWav(durationMs: number, sampleRate: number): Uint8Array {
  return encodeWavPcm16(
    new Int16Array(Math.ceil((sampleRate / 1000) * durationMs)).fill(1_000),
    sampleRate,
  );
}

function loadPilot() {
  return parseLessonScript(
    YAML.parse(readFileSync(resolve(__dirname, "./script/__fixtures__/go-swap.yaml"), "utf8")),
  );
}

describe("buildPlanFromScript narration", () => {
  beforeEach(() => {
    tts.getCachedDialogWav.mockReset().mockResolvedValue(null);
    tts.deleteCachedDialogWav.mockReset().mockResolvedValue();
    tts.preloadPocket.mockReset().mockResolvedValue();
    tts.putCachedDialogWav.mockReset().mockResolvedValue();
    tts.synthesizePocketDialog.mockReset().mockImplementation(async (_, speechText) => ({
      wav: voicedWav(400 + speechText.split(/\s+/).length * 320, 24_000),
      cappedChunkCount: 0,
    }));
    tts.synthesizeModalVoxCpm2Wav.mockReset().mockImplementation(async (_, speechText) => {
      return voicedWav(400 + speechText.split(/\s+/).length * 320, 48_000);
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
    const calls = tts.synthesizePocketDialog.mock.calls;

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
    expect(tts.synthesizePocketDialog).not.toHaveBeenCalled();
    expect(tts.synthesizeModalVoxCpm2Wav).toHaveBeenCalled();
    expect(tts.synthesizeModalVoxCpm2Wav.mock.calls.map(([, , seed]) => seed)).toEqual(
      Array.from({ length: result.dialogCount }, () => script.build.seed),
    );
    expect(result.plan.lesson.locale).toBe("my-MM");
    expect(result.plan.narration.mimeType).toBe("audio/wav");
  });

  it("respells English narration only", async () => {
    const english = loadPilot();
    english.scenes[0].narration = english.scenes[0].narration.replace("Go functions", "A struct");
    await buildPlanFromScript(english);
    expect(tts.synthesizePocketDialog.mock.calls[0][1]).toMatch(/^A struckt /);

    tts.getCachedDialogWav.mockClear();
    const burmese = loadPilot();
    burmese.lesson.locale = "my-MM";
    burmese.scenes[0].narration = burmese.scenes[0].narration.replace("Go functions", "A struct");
    await buildPlanFromScript(burmese, {
      voiceProfile: VOICE_PROFILES["modal-voxcpm2-burmese-v1"],
    });
    const speechText = tts.synthesizeModalVoxCpm2Wav.mock.calls[0][1];
    expect(speechText).toMatch(/^A struct /);

    // Untouched by the lexicon, so the request hash is the one this dialog had
    // when the English lexicon was still applied — its cached take still hits.
    expect(tts.getCachedDialogWav.mock.calls[0][0]).toBe(
      await ttsRequestHash({
        profile: VOICE_PROFILES["modal-voxcpm2-burmese-v1"],
        speechText,
        lexiconVersion: LEXICON_V1.version,
        seed: burmese.build.seed,
      }),
    );
  });

  it("refuses to cache a take that fails validation, naming the dialog", async () => {
    tts.synthesizePocketDialog.mockResolvedValueOnce({
      wav: voicedWav(800, 48_000),
      cappedChunkCount: 0,
    });
    await expect(buildPlanFromScript(loadPilot())).rejects.toThrow(
      /^Narration dialog 1\/\d+ "[^"]+" \("Go functions can return two values…"\): synthesized audio is unusable — audio is 48000Hz, expected 24000Hz$/,
    );

    tts.synthesizePocketDialog.mockResolvedValueOnce({
      wav: encodeWavPcm16(new Int16Array(24_000), 24_000),
      cappedChunkCount: 0,
    });
    await expect(buildPlanFromScript(loadPilot())).rejects.toThrow(/audio is silent$/);

    const truncated = voicedWav(800, 24_000).slice(0, 400);
    tts.synthesizePocketDialog.mockResolvedValueOnce({ wav: truncated, cappedChunkCount: 0 });
    await expect(buildPlanFromScript(loadPilot())).rejects.toThrow(/data chunk is truncated/);

    expect(tts.putCachedDialogWav).not.toHaveBeenCalled();
  });

  it("names the dialog when its synthesis request fails", async () => {
    tts.synthesizePocketDialog.mockRejectedValueOnce(new Error("engine exploded"));
    await expect(buildPlanFromScript(loadPilot())).rejects.toThrow(
      /^Narration dialog 1\/\d+ "[^"]+" \("Go functions can return two values…"\): engine exploded$/,
    );
  });

  it("evicts and re-synthesizes an invalid cached take, and reuses a valid one", async () => {
    const script = loadPilot();
    const cachedValid = voicedWav(1_200, 24_000);
    tts.getCachedDialogWav
      .mockResolvedValueOnce({ wav: voicedWav(1_200, 24_000).slice(0, 100), hitFrameCap: false })
      .mockResolvedValue({ wav: cachedValid, hitFrameCap: false });

    const result = await buildPlanFromScript(script);

    const firstHash = tts.getCachedDialogWav.mock.calls[0][0];
    expect(tts.deleteCachedDialogWav).toHaveBeenCalledExactlyOnceWith(firstHash);
    expect(tts.synthesizePocketDialog).toHaveBeenCalledOnce();
    expect(tts.putCachedDialogWav).toHaveBeenCalledOnce();
    expect(tts.putCachedDialogWav.mock.calls[0][0]).toBe(firstHash);
    expect(result.synthesizedCount).toBe(1);
    expect(result.warnings[0]).toMatch(
      /^Cached audio for dialog 1\/\d+ .* was unusable \(WAV data chunk is truncated.*\) and was synthesized again$/,
    );
  });

  it("warns about a frame-capped take, caches it with the flag, and warns again on a hit", async () => {
    tts.synthesizePocketDialog.mockImplementationOnce(async () => ({
      wav: voicedWav(40_000, 24_000),
      cappedChunkCount: 1,
    }));

    const first = await buildPlanFromScript(loadPilot());

    const capWarning =
      /^Dialog 1\/\d+ "[^"]+" \("Go functions can return two values…"\) ran to the speech engine's length limit/;
    expect(first.warnings.filter((warning) => capWarning.test(warning))).toHaveLength(1);
    expect(tts.putCachedDialogWav.mock.calls[0][1]).toMatchObject({ hitFrameCap: true });
    expect(tts.putCachedDialogWav.mock.calls[1][1]).toMatchObject({ hitFrameCap: false });

    tts.synthesizePocketDialog.mockClear();
    tts.getCachedDialogWav.mockImplementation(async (requestHash) => {
      const put = tts.putCachedDialogWav.mock.calls.find(([hash]) => hash === requestHash);
      return (put?.[1] as { wav: Uint8Array; hitFrameCap: boolean } | undefined) ?? null;
    });

    const second = await buildPlanFromScript(loadPilot());

    expect(tts.synthesizePocketDialog).not.toHaveBeenCalled();
    expect(second.warnings.filter((warning) => capWarning.test(warning))).toHaveLength(1);
  });
});
