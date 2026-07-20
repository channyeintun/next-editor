import { describe, expect, it } from "vite-plus/test";
import { createSeededGaussian, deriveNoiseSeed } from "./noise";
import { prepareTextPrompt, splitIntoBestSentences, type PocketTokenizer } from "./textPrep";
import { parseNpyFloat32, parseVoiceStatesBin } from "./voicesBin";

const PREP_OPTIONS = {
  removeSemicolons: false,
  padWithSpacesForShortInputs: false,
  recommendedFramesAfterEos: null,
  maxTokenPerChunk: 8,
};

/** Fake tokenizer: one token per whitespace word (decode joins them back). */
const wordTokenizer: PocketTokenizer = {
  encodeIds: (text) =>
    text
      .split(/\s+/)
      .filter(Boolean)
      .map((_, index) => index),
  decodeIds: (ids) => ids.map(() => "w").join(" "),
};

describe("seeded gaussian noise", () => {
  it("reproduces the same stream for the same seed", () => {
    const first = createSeededGaussian(1234);
    const second = createSeededGaussian(1234);
    for (let i = 0; i < 64; i++) {
      expect(second.next()).toBe(first.next());
    }
  });

  it("diverges for different seeds and derives stable text seeds", () => {
    expect(createSeededGaussian(1).next()).not.toBe(createSeededGaussian(2).next());
    expect(deriveNoiseSeed(7, "hello")).toBe(deriveNoiseSeed(7, "hello"));
    expect(deriveNoiseSeed(7, "hello")).not.toBe(deriveNoiseSeed(8, "hello"));
    expect(deriveNoiseSeed(7, "hello")).not.toBe(deriveNoiseSeed(7, "world"));
  });
});

describe("prepareTextPrompt", () => {
  it("normalizes whitespace, capitalization, and trailing punctuation", () => {
    const prepared = prepareTextPrompt("  go functions\nreturn two values ", PREP_OPTIONS);
    expect(prepared.text).toBe("Go functions return two values.");
    expect(prepared.framesAfterEos).toBe(1);
  });

  it("gives short prompts extra frames after EOS", () => {
    expect(prepareTextPrompt("Run it now", PREP_OPTIONS).framesAfterEos).toBe(3);
  });

  it("honors bundle overrides", () => {
    const prepared = prepareTextPrompt("a; b; c and more words here", {
      ...PREP_OPTIONS,
      removeSemicolons: true,
      recommendedFramesAfterEos: 2,
    });
    expect(prepared.text).not.toContain(";");
    expect(prepared.framesAfterEos).toBe(2);
  });
});

describe("splitIntoBestSentences", () => {
  it("keeps short sentences together within the token budget", () => {
    const { chunks } = splitIntoBestSentences("One two. Three four.", wordTokenizer, PREP_OPTIONS);
    expect(chunks).toHaveLength(1);
  });

  it("splits when the combined sentence exceeds the budget", () => {
    const { chunks } = splitIntoBestSentences(
      "One two three four five six. Seven eight nine ten eleven twelve.",
      wordTokenizer,
      PREP_OPTIONS,
    );
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe("parseVoiceStatesBin", () => {
  function buildVoicesBin(): ArrayBuffer {
    const encoder = new TextEncoder();
    const name = encoder.encode("alba");
    const key = encoder.encode("transformer.layers.0.self_attn/cache");
    const tensorData = new Float32Array([1.5, -2.5, 3.25]);

    const parts: number[] = [];
    const pushU16 = (value: number) => parts.push(value & 0xff, (value >> 8) & 0xff);
    const pushU32 = (value: number) =>
      parts.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);

    parts.push(...encoder.encode("PTVB1"));
    pushU32(1); // one voice
    pushU16(name.length);
    parts.push(...name);
    pushU16(1); // one tensor
    pushU16(key.length);
    parts.push(...key);
    parts.push(0); // dtype float32
    parts.push(2); // rank 2
    pushU32(1);
    pushU32(3);
    pushU32(tensorData.byteLength);
    parts.push(...new Uint8Array(tensorData.buffer));

    return new Uint8Array(parts).buffer;
  }

  it("parses voices, tensor shapes, and float32 payloads", () => {
    const voices = parseVoiceStatesBin(buildVoicesBin());
    const tensor = voices.alba["transformer.layers.0.self_attn/cache"];
    expect(tensor.dtype).toBe("float32");
    expect(tensor.shape).toEqual([1, 3]);
    expect(Array.from(tensor.data as Float32Array)).toEqual([1.5, -2.5, 3.25]);
  });

  it("rejects a bad magic header", () => {
    expect(() => parseVoiceStatesBin(new TextEncoder().encode("NOPE!123").buffer)).toThrow(
      /voices.bin header/,
    );
  });
});

describe("parseNpyFloat32", () => {
  function buildNpy(values: number[], shape: number[]): ArrayBuffer {
    const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape.join(", ")}${shape.length === 1 ? "," : ""}), }`;
    const padded = header + " ".repeat((64 - ((10 + header.length) % 64)) % 64) + "\n";
    const bytes = new Uint8Array(10 + padded.length + values.length * 4);
    bytes.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]);
    new DataView(bytes.buffer).setUint16(8, padded.length, true);
    bytes.set(new TextEncoder().encode(padded), 10);
    bytes.set(new Uint8Array(new Float32Array(values).buffer), 10 + padded.length);
    return bytes.buffer;
  }

  it("parses shape and float32 data", () => {
    const parsed = parseNpyFloat32(buildNpy([0.5, 1.5, 2.5, 3.5], [2, 2]));
    expect(parsed.shape).toEqual([2, 2]);
    expect(Array.from(parsed.data)).toEqual([0.5, 1.5, 2.5, 3.5]);
  });

  it("rejects non-NPY input", () => {
    expect(() => parseNpyFloat32(new Uint8Array(16).buffer)).toThrow(/Invalid NPY/);
  });
});
