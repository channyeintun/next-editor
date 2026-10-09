import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { FakeIndexedDB } from "../../test/fakeIndexedDB";
import {
  clampVoiceSamples,
  deleteCustomVoice,
  isVoxCpm2ReferenceReady,
  listCustomVoices,
  MAX_SAMPLE_SECONDS,
  MIN_SAMPLE_SECONDS,
  saveCustomVoice,
  VOICE_SAMPLE_RATE,
  voxCpm2ReferenceTooShort,
} from "./customVoices";

describe("clampVoiceSamples", () => {
  it("rejects samples shorter than the minimum", () => {
    const tooShort = new Float32Array(VOICE_SAMPLE_RATE * MIN_SAMPLE_SECONDS - 1);
    expect(() => clampVoiceSamples(tooShort, VOICE_SAMPLE_RATE)).toThrow(/too short/);
  });

  it("passes in-range samples through untouched", () => {
    const fiveSeconds = new Float32Array(VOICE_SAMPLE_RATE * 5);
    expect(clampVoiceSamples(fiveSeconds, VOICE_SAMPLE_RATE)).toBe(fiveSeconds);
  });

  it("trims anything past the maximum to the cap", () => {
    const long = new Float32Array(VOICE_SAMPLE_RATE * (MAX_SAMPLE_SECONDS + 30));
    expect(clampVoiceSamples(long, VOICE_SAMPLE_RATE)).toHaveLength(
      VOICE_SAMPLE_RATE * MAX_SAMPLE_SECONDS,
    );
  });
});

describe("VoxCPM2 reference length", () => {
  const seconds = (duration: number) => new Float32Array(Math.round(VOICE_SAMPLE_RATE * duration));
  const reference = (duration: number) => ({
    samples: seconds(duration),
    sampleRate: VOICE_SAMPLE_RATE,
  });

  it("accepts 5–20 s of reference speech, inclusive", () => {
    expect(isVoxCpm2ReferenceReady(reference(4.9))).toBe(false);
    expect(isVoxCpm2ReferenceReady(reference(5))).toBe(true);
    expect(isVoxCpm2ReferenceReady(reference(20))).toBe(true);
    expect(isVoxCpm2ReferenceReady(reference(20.1))).toBe(false);
  });

  it("calls a prepared sample under 5 s too short", () => {
    expect(voxCpm2ReferenceTooShort(seconds(4.9))).toBe(true);
    expect(voxCpm2ReferenceTooShort(seconds(5))).toBe(false);
  });
});

describe("custom voice store", () => {
  let fake: FakeIndexedDB;
  const samples = () => new Float32Array(VOICE_SAMPLE_RATE * MIN_SAMPLE_SECONDS);

  beforeEach(() => {
    fake = new FakeIndexedDB();
    vi.stubGlobal("indexedDB", fake.indexedDB);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves, lists and deletes a voice", async () => {
    const voice = await saveCustomVoice("  Narrator  ", samples());
    expect(voice.name).toBe("Narrator");
    await expect(listCustomVoices()).resolves.toEqual([
      expect.objectContaining({ id: voice.id, name: "Narrator" }),
    ]);

    await deleteCustomVoice(voice.id);
    await expect(listCustomVoices()).resolves.toEqual([]);
  });

  // A commit that runs over quota fires only `abort`, never `error`: waiting for
  // `error` left the save pending forever.
  it("rejects when the save aborts at commit", async () => {
    const quota = new DOMException("The quota has been exceeded", "QuotaExceededError");
    fake.failNextCommit(quota);

    await expect(saveCustomVoice("Narrator", samples())).rejects.toBe(quota);
  });

  it("rejects when the delete aborts at commit", async () => {
    const voice = await saveCustomVoice("Narrator", samples());
    const quota = new DOMException("The quota has been exceeded", "QuotaExceededError");
    fake.failNextCommit(quota);

    await expect(deleteCustomVoice(voice.id)).rejects.toBe(quota);
  });
});
