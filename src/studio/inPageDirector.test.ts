import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ParsedDeck } from "../googleSlides/types";
import { sha256HexOfJson } from "./hash";
import { LEXICON_V1 } from "./script/lexicon";
import { parseLessonScript } from "./script/schema";
import { measureIntegratedLoudness, NARRATION_LOUDNESS_TARGET_LUFS } from "./tts/loudness";
import { athanLabProfileOf, ttsRequestHash, VOICE_PROFILES } from "./tts/profiles";
import { decodeWavPcm16, encodeWavPcm16, type StitchSegment } from "./tts/wav";

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
  synthesizeAthanLabWav: vi.fn<(profile: unknown, speechText: string) => Promise<Uint8Array>>(),
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

vi.mock("./tts/athanlabSynth", () => ({
  synthesizeAthanLabWav: tts.synthesizeAthanLabWav,
}));

const slides = vi.hoisted(() => ({
  fetchPublishedDeck: vi.fn<(url: string) => Promise<ParsedDeck>>(),
}));
vi.mock("../googleSlides", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../googleSlides")>()),
  fetchPublishedDeck: slides.fetchPublishedDeck,
}));

// The real stitch, watched so tests can measure each placed dialog.
const stitch = vi.hoisted(() => ({ segments: [] as StitchSegment[][] }));
vi.mock("./tts/wav", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tts/wav")>();
  return {
    ...actual,
    stitchWavSegments: (segments: StitchSegment[], totalDurationMs: number, rate: number) => {
      stitch.segments.push(segments);
      return actual.stitchWavSegments(segments, totalDurationMs, rate);
    },
  };
});

const { buildPlanFromScript } = await import("./inPageDirector");

/** A voiced (non-silent) PCM16 mono WAV of the given length: a 220 Hz tone. */
function voicedWav(durationMs: number, sampleRate: number, amplitude = 0.1): Uint8Array {
  const pcm = new Int16Array(Math.ceil((sampleRate / 1000) * durationMs));
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = Math.round(amplitude * 0x7fff * Math.sin((2 * Math.PI * 220 * i) / sampleRate));
  }
  return encodeWavPcm16(pcm, sampleRate);
}

function loudnessOfWav(wav: Uint8Array): number | null {
  const { pcm, sampleRate } = decodeWavPcm16(wav);
  return measureIntegratedLoudness(
    Float32Array.from(pcm, (sample) => sample / 0x8000),
    sampleRate,
  );
}

function loadPilot() {
  return parseLessonScript(
    YAML.parse(readFileSync(resolve(__dirname, "./script/__fixtures__/go-swap.yaml"), "utf8")),
  );
}

const DECK_URL = "https://docs.google.com/presentation/d/e/2PACX-test/pub";
const PUBLISHED_DECK: ParsedDeck = {
  sourceUrl: DECK_URL,
  width: 1600,
  height: 900,
  slides: [{ pageId: "SLIDES_API1_0", title: "Rules", svg: "<svg>rules</svg>", steps: [] }],
};

/** The pilot with one slide sourced from a published deck page. */
function loadPilotWithDeckSlide() {
  const script = loadPilot();
  script.lesson.slides.push({
    id: "rules",
    contentType: "google",
    deckUrl: DECK_URL,
    pageId: "SLIDES_API1_0",
  });
  return script;
}

describe("buildPlanFromScript narration", () => {
  beforeEach(() => {
    stitch.segments = [];
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
    tts.synthesizeAthanLabWav.mockReset().mockImplementation(async (_, speechText) => {
      return voicedWav(400 + speechText.split(/\s+/).length * 320, 48_000);
    });
    slides.fetchPublishedDeck.mockReset().mockResolvedValue(PUBLISHED_DECK);
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

  it("dispatches an AthanLab profile with a fixed seed, so a new script seed keeps every take", async () => {
    const profile = athanLabProfileOf("voice_01");
    const script = loadPilot();
    script.lesson.locale = "my-MM";
    const result = await buildPlanFromScript(script, { voiceProfile: profile });

    expect(tts.preloadPocket).not.toHaveBeenCalled();
    expect(tts.synthesizePocketDialog).not.toHaveBeenCalled();
    expect(tts.synthesizeModalVoxCpm2Wav).not.toHaveBeenCalled();
    expect(tts.synthesizeAthanLabWav).toHaveBeenCalledTimes(result.dialogCount);
    expect(tts.synthesizeAthanLabWav.mock.calls.every(([called]) => called === profile)).toBe(true);
    expect(tts.getCachedDialogWav.mock.calls[0][0]).toBe(
      await ttsRequestHash({
        profile,
        speechText: tts.synthesizeAthanLabWav.mock.calls[0][1],
        lexiconVersion: LEXICON_V1.version,
        seed: 0,
      }),
    );
    expect(result.plan.lesson.locale).toBe("my-MM");
    expect(result.plan.narration.mimeType).toBe("audio/wav");

    const requestHashes = tts.getCachedDialogWav.mock.calls.map(([requestHash]) => requestHash);
    tts.getCachedDialogWav.mockClear();
    const reseeded = loadPilot();
    reseeded.lesson.locale = "my-MM";
    reseeded.build.seed += 1;
    await buildPlanFromScript(reseeded, { voiceProfile: profile });

    expect(tts.getCachedDialogWav.mock.calls.map(([requestHash]) => requestHash)).toEqual(
      requestHashes,
    );
  });

  it("never loads the Pocket engine when every dialog is cached", async () => {
    tts.getCachedDialogWav.mockResolvedValue({ wav: voicedWav(1_200, 24_000), hitFrameCap: false });
    const phases: string[] = [];

    const result = await buildPlanFromScript(loadPilot(), { onPhase: (p) => phases.push(p) });

    expect(result.synthesizedCount).toBe(0);
    expect(tts.preloadPocket).not.toHaveBeenCalled();
    expect(phases).not.toContain("tts-model");
  });

  it("loads the Pocket engine once, at the first cache miss, then resumes that dialog's phase", async () => {
    // Dialog 1 is cached; every later one misses.
    tts.getCachedDialogWav.mockResolvedValueOnce({
      wav: voicedWav(1_200, 24_000),
      hitFrameCap: false,
    });
    const phases: string[] = [];
    tts.preloadPocket.mockImplementation(async (_profile, onPhase) => {
      (onPhase as (phase: string) => void)("tts-bundle");
    });

    const result = await buildPlanFromScript(loadPilot(), { onPhase: (p) => phases.push(p) });

    expect(tts.preloadPocket).toHaveBeenCalledOnce();
    expect(result.synthesizedCount).toBe(result.dialogCount - 1);
    const count = result.dialogCount;
    expect(phases.slice(0, 5)).toEqual([
      `synthesize 1/${count}`,
      `synthesize 2/${count}`,
      "tts-model",
      "tts-bundle",
      `synthesize 2/${count}`,
    ]);
    expect(tts.preloadPocket.mock.invocationCallOrder[0]).toBeLessThan(
      tts.synthesizePocketDialog.mock.invocationCallOrder[0],
    );
  });

  it("fetches the published deck while the narration synthesizes", async () => {
    // The deck answers only once the first dialog is synthesized and cached, so
    // a Director that awaited the slides before the narration would hang here.
    let firstTakeCached!: () => void;
    const firstTake = new Promise<void>((resolve) => {
      firstTakeCached = resolve;
    });
    tts.putCachedDialogWav.mockImplementation(async () => firstTakeCached());
    slides.fetchPublishedDeck.mockImplementation(async () => {
      await firstTake;
      return PUBLISHED_DECK;
    });

    const result = await buildPlanFromScript(loadPilotWithDeckSlide());

    expect(slides.fetchPublishedDeck).toHaveBeenCalledExactlyOnceWith(DECK_URL);
    // ...and it was requested before the narration, not after it.
    expect(slides.fetchPublishedDeck.mock.invocationCallOrder[0]).toBeLessThan(
      tts.synthesizePocketDialog.mock.invocationCallOrder[0],
    );
    expect(result.plan.slides).toContainEqual(
      expect.objectContaining({
        id: "rules",
        contentType: "google-svg",
        content: "<svg>rules</svg>",
      }),
    );
  });

  it("fails on an unreachable deck only after the narration, and a narration failure wins", async () => {
    slides.fetchPublishedDeck.mockRejectedValue(new Error("deck offline"));
    const phases: string[] = [];

    await expect(
      buildPlanFromScript(loadPilotWithDeckSlide(), { onPhase: (p) => phases.push(p) }),
    ).rejects.toThrow("deck offline");
    expect(phases.at(-1)).toBe("slides");
    expect(tts.putCachedDialogWav).toHaveBeenCalled();

    tts.synthesizePocketDialog.mockRejectedValueOnce(new Error("engine exploded"));
    await expect(buildPlanFromScript(loadPilotWithDeckSlide())).rejects.toThrow(
      /^Narration dialog 1\/\d+ .*: engine exploded$/,
    );
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

  // The render path builds from `source.load()`, which parses: a typo in a
  // mark name used to surface from the compiler after every dialog had been
  // synthesized (paid takes included); now it never reaches synthesis.
  it("rejects an unknown mark before any narration is synthesized", async () => {
    const raw = YAML.parse(
      readFileSync(resolve(__dirname, "./script/__fixtures__/go-swap.yaml"), "utf8"),
    );
    raw.scenes[0].actions[0].at = { mark: "type-swpa" };

    await expect(async () => buildPlanFromScript(parseLessonScript(raw))).rejects.toThrow(
      /Unknown marker "type-swpa"/,
    );
    expect(tts.preloadPocket).not.toHaveBeenCalled();
    expect(tts.synthesizePocketDialog).not.toHaveBeenCalled();
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

  it("levels every dialog to one loudness, and caches the raw take", async () => {
    // Every other take comes out of the model 9 dB quieter.
    let calls = 0;
    tts.synthesizePocketDialog.mockImplementation(async (_, speechText) => ({
      wav: voicedWav(400 + speechText.split(/\s+/).length * 320, 24_000, calls++ % 2 ? 0.07 : 0.2),
      cappedChunkCount: 0,
    }));

    const result = await buildPlanFromScript(loadPilot());

    const placed = stitch.segments[0];
    expect(placed.length).toBe(result.dialogCount);
    expect(placed.length).toBeGreaterThan(2);
    for (const segment of placed) {
      const loudness = loudnessOfWav(segment.bytes);
      expect(Math.abs(loudness! - NARRATION_LOUDNESS_TARGET_LUFS)).toBeLessThan(0.2);
    }
    // Leveling changes the volume only: each placed dialog keeps its take's length.
    const cached = tts.putCachedDialogWav.mock.calls.map(
      ([, take]) => (take as { wav: Uint8Array }).wav,
    );
    expect(placed.map((segment) => segment.bytes.length)).toEqual(cached.map((wav) => wav.length));
    // The cache holds the take as synthesized, quiet ones still quiet.
    expect(loudnessOfWav(cached[1])! - loudnessOfWav(cached[0])!).toBeCloseTo(-9, 0);
    expect(result.warnings.filter((warning) => warning.includes("leveling"))).toEqual([]);
  });

  it("brings a narration that is quiet as a whole to one loudness", async () => {
    // Takes around −31 and −34 LUFS: the 12 dB gain limit holds every one
    // short of the target, so they meet lower instead of keeping their step.
    let calls = 0;
    tts.synthesizePocketDialog.mockImplementation(async (_, speechText) => ({
      wav: voicedWav(
        400 + speechText.split(/\s+/).length * 320,
        24_000,
        calls++ % 2 ? 0.028 : 0.04,
      ),
      cappedChunkCount: 0,
    }));

    const result = await buildPlanFromScript(loadPilot());

    const levels = stitch.segments[0].map((segment) => loudnessOfWav(segment.bytes)!);
    expect(levels.length).toBeGreaterThan(2);
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(0.2);
    expect(Math.max(...levels)).toBeLessThan(NARRATION_LOUDNESS_TARGET_LUFS - 3);
    expect(result.warnings.filter((warning) => warning.includes("leveling"))).toEqual([]);
  });

  it("warns about a dialog that stays off the shared loudness", async () => {
    // So quiet that the 12 dB gain limit cannot bring it up to the others.
    tts.synthesizePocketDialog.mockImplementationOnce(async () => ({
      wav: voicedWav(1_600, 24_000, 0.006),
      cappedChunkCount: 0,
    }));

    const result = await buildPlanFromScript(loadPilot());

    expect(result.warnings.filter((warning) => warning.includes("leveling"))).toEqual([
      expect.stringMatching(
        /^Dialog 1\/\d+ "[^"]+" \("Go functions can return two values…"\) stays \d+\.\d dB quieter than the rest of the narration after leveling/,
      ),
    ]);
  });
});
