import type * as Ort from "onnxruntime-web/wasm";
import { WHISPER_N_FRAMES, WHISPER_N_MELS } from "./melSpectrogram";

type OrtModule = typeof Ort;

/** The model's shape, from its config.json. */
export interface WhisperModelConfig {
  decoder_layers: number;
  decoder_attention_heads: number;
  d_model: number;
  vocab_size: number;
}

/** A decoder mid-sequence: the attention caches its next step builds on. */
export interface WhisperDecoderState {
  encoderHidden: Ort.Tensor;
  /** `past_key_values.{layer}.encoder.{key,value}`: fixed after the first step. */
  encoderCache: Map<string, Ort.Tensor>;
  /** `past_key_values.{layer}.decoder.{key,value}`: grows by one position per step. */
  decoderCache: Map<string, Ort.Tensor>;
}

export interface DecoderStepResult {
  /** Scores for the token after the last input position. */
  logits: Float32Array;
  /** Scores for the token after `<|startoftranscript|>` (`sotIndex` in the prompt). */
  sotLogits: Float32Array;
}

/**
 * Whisper over ONNX Runtime Web: the encoder, and the merged decoder that runs the
 * first step without caches and every later one with them (`use_cache_branch`).
 */
export class WhisperModel {
  private readonly ort: OrtModule;
  private readonly encoder: Ort.InferenceSession;
  private readonly decoder: Ort.InferenceSession;
  private readonly config: WhisperModelConfig;

  private constructor(
    ort: OrtModule,
    encoder: Ort.InferenceSession,
    decoder: Ort.InferenceSession,
    config: WhisperModelConfig,
  ) {
    this.ort = ort;
    this.encoder = encoder;
    this.decoder = decoder;
    this.config = config;
  }

  static async create(
    ort: OrtModule,
    encoderBytes: ArrayBuffer,
    decoderBytes: ArrayBuffer,
    config: WhisperModelConfig,
  ): Promise<WhisperModel> {
    const options: Ort.InferenceSession.SessionOptions = {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    };
    const [encoder, decoder] = await Promise.all([
      ort.InferenceSession.create(new Uint8Array(encoderBytes), options),
      ort.InferenceSession.create(new Uint8Array(decoderBytes), options),
    ]);
    return new WhisperModel(ort, encoder, decoder, config);
  }

  get vocabSize(): number {
    return this.config.vocab_size;
  }

  /** The encoder's view of one window's log-mel features. */
  async encode(features: Float32Array): Promise<Ort.Tensor> {
    const input = new this.ort.Tensor("float32", features, [1, WHISPER_N_MELS, WHISPER_N_FRAMES]);
    const output = await this.encoder.run({ input_features: input });
    return output.last_hidden_state;
  }

  private emptyCache(): Ort.Tensor {
    const heads = this.config.decoder_attention_heads;
    const headSize = this.config.d_model / heads;
    return new this.ort.Tensor("float32", new Float32Array(0), [1, heads, 0, headSize]);
  }

  private cacheNames(kind: "decoder" | "encoder"): string[] {
    const names: string[] = [];
    for (let layer = 0; layer < this.config.decoder_layers; layer++) {
      names.push(`${layer}.${kind}.key`, `${layer}.${kind}.value`);
    }
    return names;
  }

  /** Runs the prompt through the decoder, returning the state its next step continues. */
  async start(
    encoderHidden: Ort.Tensor,
    prompt: readonly number[],
    sotIndex = 0,
  ): Promise<{ state: WhisperDecoderState } & DecoderStepResult> {
    const feeds: Record<string, Ort.Tensor> = {
      input_ids: this.tokens(prompt),
      encoder_hidden_states: encoderHidden,
      use_cache_branch: new this.ort.Tensor("bool", [false], [1]),
    };
    for (const name of [...this.cacheNames("decoder"), ...this.cacheNames("encoder")]) {
      feeds[`past_key_values.${name}`] = this.emptyCache();
    }
    const output = await this.decoder.run(feeds);
    const state: WhisperDecoderState = {
      encoderHidden,
      encoderCache: new Map(
        this.cacheNames("encoder").map((name) => [name, output[`present.${name}`]]),
      ),
      decoderCache: new Map(
        this.cacheNames("decoder").map((name) => [name, output[`present.${name}`]]),
      ),
    };
    const data = output.logits.data as Float32Array;
    const vocab = data.length / prompt.length;
    return {
      state,
      logits: data.slice((prompt.length - 1) * vocab, prompt.length * vocab),
      sotLogits: data.slice(sotIndex * vocab, (sotIndex + 1) * vocab),
    };
  }

  /** One more token through the decoder, updating `state`'s caches in place. */
  async next(state: WhisperDecoderState, token: number): Promise<Float32Array> {
    const feeds: Record<string, Ort.Tensor> = {
      input_ids: this.tokens([token]),
      encoder_hidden_states: state.encoderHidden,
      use_cache_branch: new this.ort.Tensor("bool", [true], [1]),
    };
    for (const [name, tensor] of state.decoderCache) feeds[`past_key_values.${name}`] = tensor;
    for (const [name, tensor] of state.encoderCache) feeds[`past_key_values.${name}`] = tensor;
    const output = await this.decoder.run(feeds);
    for (const name of this.cacheNames("decoder")) {
      state.decoderCache.set(name, output[`present.${name}`]);
    }
    return (output.logits.data as Float32Array).slice();
  }

  private tokens(ids: readonly number[]): Ort.Tensor {
    return new this.ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]);
  }
}
