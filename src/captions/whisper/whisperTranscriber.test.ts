import { describe, expect, it } from "vite-plus/test";
import type * as Ort from "onnxruntime-web/wasm";
import { WHISPER_SAMPLE_RATE } from "./melSpectrogram";
import { WhisperTokenizer } from "./whisperTokenizer";
import { transcribeWithWhisper, type WhisperAssets } from "./whisperTranscriber";

// ============================================================================
// The transcription loop over a scripted model: each window's decoder emits
// the tokens its script lists, so the test controls what Whisper "hears" and
// checks what the loop makes of it (prompts, segments, seeking, silence).
// ============================================================================

// Byte tokens 0–255, then the special tokens, then 1501 timestamps (0.00–30.00 s).
const EOT = 256;
const SOT = 257;
const EN = 258;
const FR = 259;
const TRANSCRIBE = 260;
const START_OF_PREVIOUS = 261;
const NO_TIMESTAMPS = 262;
const NO_SPEECH = 263;
const TS = 264;
const VOCAB_SIZE = TS + 1501;
const ts = (seconds: number) => TS + Math.round(seconds / 0.02);

function byteCharacters(): string[] {
  const printable = [
    ...Array.from({ length: 94 }, (_, index) => 33 + index),
    ...Array.from({ length: 12 }, (_, index) => 161 + index),
    ...Array.from({ length: 82 }, (_, index) => 174 + index),
  ];
  let extra = 0;
  return Array.from({ length: 256 }, (_, byte) =>
    String.fromCodePoint(printable.includes(byte) ? byte : 256 + extra++),
  );
}

const TOKENIZER_JSON = {
  model: {
    vocab: Object.fromEntries(byteCharacters().map((character, byte) => [character, byte])),
    merges: [],
  },
  added_tokens: [
    [EOT, "<|endoftext|>"],
    [SOT, "<|startoftranscript|>"],
    [EN, "<|en|>"],
    [FR, "<|fr|>"],
    [TRANSCRIBE, "<|transcribe|>"],
    [START_OF_PREVIOUS, "<|startofprev|>"],
    [NO_TIMESTAMPS, "<|notimestamps|>"],
    [NO_SPEECH, "<|nocaptions|>"],
    [TS, "<|0.00|>"],
  ].map(([id, content]) => ({ id: id as number, content: content as string, special: true })),
};
const tokenizer = new WhisperTokenizer(TOKENIZER_JSON);
const text = (value: string) => tokenizer.encode(value);

interface WindowScript {
  /** What the decoder emits, in order; the end of text after the last. */
  tokens: number[];
  /** A window the model finds no speech in, and decodes without confidence. */
  silent?: boolean;
}

class FakeTensor {
  readonly type: string;
  readonly data: unknown;
  readonly dims: readonly number[];
  constructor(type: string, data: unknown, dims: readonly number[]) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
}

/** ONNX Runtime with an encoder that counts windows and a decoder that follows scripts. */
function scriptedOrt(scripts: WindowScript[]) {
  const prompts: number[][] = [];
  let languageDetections = 0;
  let window = -1;
  let step = 0;

  /** Text and specials neutral, timestamps unlikely, `target` favored. */
  const row = (target: number | null, strength: number) => {
    const logits = new Float32Array(VOCAB_SIZE);
    logits.fill(-10, TS);
    if (target !== null) logits[target] = strength;
    return logits;
  };
  const scripted = () => {
    const script = scripts[window];
    return row(script.tokens[step] ?? EOT, script.silent ? 0.5 : 10);
  };

  const encoder = {
    run: async () => {
      window++;
      return { last_hidden_state: new FakeTensor("float32", new Float32Array(1), [1, 1, 1]) };
    },
  };
  const decoder = {
    run: async (feeds: Record<string, FakeTensor>) => {
      const input = Array.from(feeds.input_ids.data as BigInt64Array, Number);
      const cached = (feeds.use_cache_branch.data as boolean[])[0];
      let rows: Float32Array[];
      if (cached) {
        step++;
        rows = [scripted()];
      } else if (input.length === 1) {
        languageDetections++;
        rows = [row(EN, 10)];
      } else {
        prompts.push(input);
        step = 0;
        rows = input.map((token, position) =>
          position === input.length - 1
            ? scripted()
            : token === SOT
              ? row(NO_SPEECH, scripts[window].silent ? 10 : -10)
              : row(null, 0),
        );
      }
      const logits = new Float32Array(rows.length * VOCAB_SIZE);
      rows.forEach((values, index) => logits.set(values, index * VOCAB_SIZE));
      const empty = new FakeTensor("float32", new Float32Array(0), [1, 1, 0, 2]);
      return {
        logits: new FakeTensor("float32", logits, [1, rows.length, VOCAB_SIZE]),
        "present.0.decoder.key": empty,
        "present.0.decoder.value": empty,
        "present.0.encoder.key": empty,
        "present.0.encoder.value": empty,
      };
    },
  };

  const ort = {
    Tensor: FakeTensor,
    InferenceSession: {
      create: async (bytes: Uint8Array) => (bytes[0] === 1 ? encoder : decoder),
    },
  } as unknown as typeof Ort;
  return {
    ort,
    prompts,
    get languageDetections() {
      return languageDetections;
    },
  };
}

const ASSETS: WhisperAssets = {
  encoder: new Uint8Array([1]).buffer,
  decoder: new Uint8Array([2]).buffer,
  config: { decoder_layers: 1, decoder_attention_heads: 1, d_model: 2, vocab_size: VOCAB_SIZE },
  generationConfig: {
    suppress_tokens: [],
    begin_suppress_tokens: [EOT],
    max_initial_timestamp_index: 50,
    lang_to_id: { "<|en|>": EN, "<|fr|>": FR },
  },
  tokenizer: TOKENIZER_JSON,
};

const seconds = (value: number) => new Float32Array(Math.round(value * WHISPER_SAMPLE_RATE));
const rounded = (segments: Array<{ start: number; end: number; text: string }>) =>
  segments.map((segment) => ({
    start: Math.round(segment.start * 100) / 100,
    end: Math.round(segment.end * 100) / 100,
    text: segment.text,
  }));

describe("transcribeWithWhisper", () => {
  it("decodes window by window, resuming where the last closed segment ended", async () => {
    const scripted = scriptedOrt([
      // Speech runs on past the second pair: the next window starts at 3 s to hear it whole.
      { tokens: [ts(0), ...text(" Hello."), ts(3), ts(3), ...text(" This runs")] },
      // A closed segment: the window is done.
      { tokens: [ts(0), ...text(" This runs on."), ts(5)] },
      // Silence at the end.
      { tokens: [ts(0), ...text(" um"), ts(2)], silent: true },
    ]);
    const progress: number[] = [];

    const transcript = await transcribeWithWhisper(scripted.ort, ASSETS, seconds(40), {
      prompt: "A lesson about React.",
      onProgress: (done) => progress.push(Math.round(done * 100) / 100),
    });

    expect(transcript.language).toBe("en");
    expect(rounded(transcript.segments)).toEqual([
      { start: 0, end: 3, text: "Hello." },
      { start: 3, end: 8, text: "This runs on." },
    ]);
    expect(progress).toEqual([3, 33, 40]);
    expect(scripted.languageDetections).toBe(1);
    // Every window gets the lesson's vocabulary, never the text before it.
    const prompt = [START_OF_PREVIOUS, ...text(" A lesson about React."), SOT, EN, TRANSCRIBE];
    expect(scripted.prompts).toEqual([prompt, prompt, prompt]);
  });

  it("uses a given language without detecting one, and prompts nothing without a prompt", async () => {
    const scripted = scriptedOrt([{ tokens: [ts(0), ...text(" Bonjour."), ts(1.5)] }]);

    const transcript = await transcribeWithWhisper(scripted.ort, ASSETS, seconds(4), {
      language: "fr",
    });

    expect(transcript.language).toBe("fr");
    expect(rounded(transcript.segments)).toEqual([{ start: 0, end: 1.5, text: "Bonjour." }]);
    expect(scripted.languageDetections).toBe(0);
    expect(scripted.prompts).toEqual([[SOT, FR, TRANSCRIBE]]);
  });

  it("stops when aborted", async () => {
    const { ort } = scriptedOrt([{ tokens: [ts(0), ...text(" Hi."), ts(1)] }]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      transcribeWithWhisper(ort, ASSETS, seconds(4), { signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
  });
});
