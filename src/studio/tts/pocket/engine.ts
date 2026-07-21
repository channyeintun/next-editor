import * as ort from "onnxruntime-web";
// Filesystem-relative on purpose: onnxruntime-web's `exports` map doesn't
// expose dist/, and the studio self-hosts the threaded-wasm loader pair (no
// CDN). `?url` keeps them as served assets, outside vite-plugin-wasm's path.
import ortWasmThreadedMjs from "../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url";
import ortWasmThreadedWasm from "../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url";
import {
  fetchBundleAsset,
  fetchBundleMetadata,
  type PocketBundleMetadata,
  type StateManifestEntry,
} from "./bundleAssets";
import { createSeededGaussian } from "./noise";
import { prepareTextPrompt, splitIntoBestSentences, type PocketTokenizer } from "./textPrep";
import {
  parseNpyFloat32,
  parseVoiceStatesBin,
  type VoiceRecord,
  type VoiceTensor,
} from "./voicesBin";

/**
 * Pocket-tts inference over ONNX Runtime Web — a typed, batch-mode port of the
 * pocket-tts-web demo's streaming worker (Apache-2.0,
 * KevinAHM/pocket-tts-web@d0c0c79; model weights under Kyutai's pocket-tts
 * terms). Differences from upstream are deliberate and small: the mimi voice
 * encoder is skipped (built-in voices ship precomputed flow-LM states in
 * voices.bin), audio is collected instead of streamed to a player, and the
 * flow-matching noise comes from a seeded gaussian so a dialog's audio is
 * reproducible from (text, profile, seed).
 */

const MAX_FRAMES = 500;
const LSD_STEPS = 1;
const CHUNK_GAP_SEC = 0.25;
const FADE_SAMPLES = 480;
const EOS_LOGIT_THRESHOLD = -4.0;
const TEMPERATURE = 0.7;

type OrtState = Record<string, ort.Tensor>;

function makeFilledArray(
  shape: number[],
  dtype: StateManifestEntry["dtype"],
  fill: StateManifestEntry["fill"],
): Float32Array | BigInt64Array | Uint8Array {
  const size = shape.reduce((a, b) => a * b, 1);
  if (dtype === "int64") {
    return new BigInt64Array(size);
  }
  if (dtype === "bool") {
    return new Uint8Array(size);
  }
  const data = new Float32Array(size);
  if (fill === "nan") {
    data.fill(NaN);
  } else if (fill === "ones") {
    data.fill(1);
  }
  return data;
}

function initStateFromManifest(manifest: StateManifestEntry[]): OrtState {
  const state: OrtState = {};
  for (const entry of manifest) {
    state[entry.input_name] = new ort.Tensor(
      entry.dtype,
      makeFilledArray(entry.shape, entry.dtype, entry.fill),
      entry.shape,
    );
  }
  return state;
}

function updateStateFromManifestOutputs(
  state: OrtState,
  result: Record<string, ort.Tensor>,
  manifest: StateManifestEntry[],
): void {
  for (const entry of manifest) {
    state[entry.input_name] = result[entry.output_name];
  }
}

function groupVoiceRecordByModule(
  record: VoiceRecord,
): Record<string, Record<string, VoiceTensor>> {
  const grouped: Record<string, Record<string, VoiceTensor>> = {};
  for (const [key, value] of Object.entries(record)) {
    const slash = key.indexOf("/");
    if (slash === -1) continue;
    const moduleName = key.slice(0, slash);
    const tensorKey = key.slice(slash + 1);
    (grouped[moduleName] ??= {})[tensorKey] = value;
  }
  return grouped;
}

function adaptTypedArray(
  source: VoiceTensor,
  entry: StateManifestEntry,
): Float32Array | BigInt64Array | Uint8Array {
  const targetShape = entry.shape;
  const targetSize = targetShape.reduce((a, b) => a * b, 1);
  const target = makeFilledArray(targetShape, entry.dtype, entry.fill);

  const castSource = (): Float32Array | BigInt64Array | Uint8Array => {
    if (entry.dtype === "int64") {
      return source.data instanceof BigInt64Array
        ? new BigInt64Array(source.data)
        : BigInt64Array.from(Array.from(source.data as ArrayLike<number>, (v) => BigInt(v)));
    }
    if (entry.dtype === "bool") {
      return new Uint8Array(source.data as ArrayLike<number>);
    }
    return new Float32Array(source.data as ArrayLike<number>);
  };

  if (source.shape.length === targetShape.length) {
    const exactShape = source.shape.every((dim, idx) => dim === targetShape[idx]);
    if (exactShape) {
      return castSource();
    }
  }
  if (source.data.length === targetSize) {
    return castSource();
  }
  if (source.shape.length !== targetShape.length) {
    return target;
  }

  // Copy the overlapping region of a smaller/larger source into the target
  // shape (upstream pads voice caches this way).
  const strides: number[] = [];
  let stride = 1;
  for (let i = source.shape.length - 1; i >= 0; i--) {
    strides[i] = stride;
    stride *= source.shape[i];
  }

  const indices = Array.from({ length: source.shape.length }, () => 0);
  const maxIndices = source.shape.map((dim, idx) => Math.min(dim, targetShape[idx]));

  const targetIndex = (coords: number[]): number => {
    let idx = 0;
    let tStride = 1;
    for (let i = targetShape.length - 1; i >= 0; i--) {
      idx += coords[i] * tStride;
      tStride *= targetShape[i];
    }
    return idx;
  };

  let done = false;
  while (!done) {
    let sourceIdx = 0;
    for (let i = 0; i < indices.length; i++) {
      sourceIdx += indices[i] * strides[i];
    }
    (target as Float32Array)[targetIndex(indices)] = Number(
      (source.data as ArrayLike<number>)[sourceIdx],
    );

    let dim = indices.length - 1;
    for (; dim >= 0; dim--) {
      indices[dim] += 1;
      if (indices[dim] < maxIndices[dim]) {
        break;
      }
      indices[dim] = 0;
      if (dim === 0) {
        done = true;
      }
    }
  }

  return target;
}

function deriveStep(moduleState: Record<string, VoiceTensor>): VoiceTensor {
  if (moduleState.step) {
    return {
      data: BigInt64Array.from([BigInt(Number(moduleState.step.data[0]))]),
      shape: [1],
      dtype: "int64",
    };
  }
  if (moduleState.offset && !moduleState.end_offset) {
    return {
      data: BigInt64Array.from([BigInt(Number(moduleState.offset.data[0]))]),
      shape: [1],
      dtype: "int64",
    };
  }
  if (moduleState.current_end) {
    return {
      data: BigInt64Array.from([BigInt(moduleState.current_end.shape[0])]),
      shape: [1],
      dtype: "int64",
    };
  }
  return { data: BigInt64Array.from([0n]), shape: [1], dtype: "int64" };
}

export interface PocketEngineConfig {
  /** Immutable base URL of the exported bundle (pinned revision). */
  bundleBaseUrl: string;
  voice: string;
  /**
   * Voice cloning: a 24 kHz mono reference sample. When set, the voice state
   * is derived from this audio through the bundle's mimi encoder plus one
   * flow-LM conditioning pass (the demo's custom-voice path) instead of the
   * precomputed voices.bin record named by `voice`.
   */
  customVoiceSamples?: Float32Array;
}

export interface PocketSynthesisResult {
  samples: Float32Array;
  sampleRate: number;
}

export class PocketTtsEngine {
  private metadata!: PocketBundleMetadata;
  private tokenizer!: PocketTokenizer;
  private textConditioner!: ort.InferenceSession;
  private flowLmMain!: ort.InferenceSession;
  private flowLmFlow!: ort.InferenceSession;
  private mimiDecoder!: ort.InferenceSession;
  private voiceState!: OrtState;

  private constructor() {}

  static async load(
    config: PocketEngineConfig,
    onPhase?: (phase: string) => void,
  ): Promise<PocketTtsEngine> {
    const engine = new PocketTtsEngine();

    ort.env.wasm.wasmPaths = {
      mjs: ortWasmThreadedMjs,
      wasm: ortWasmThreadedWasm,
    };
    ort.env.wasm.simd = true;
    ort.env.wasm.numThreads =
      typeof crossOriginIsolated !== "undefined" && crossOriginIsolated
        ? Math.min(navigator.hardwareConcurrency || 4, 8)
        : 1;

    onPhase?.("tts-bundle");
    const base = config.bundleBaseUrl;
    engine.metadata = await fetchBundleMetadata(base);

    const sessionOptions: ort.InferenceSession.SessionOptions = {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    };
    const [textCond, flowMain, flowFlow, decoder] = await Promise.all([
      fetchBundleAsset(base, "text_conditioner_int8.onnx").then((bytes) =>
        ort.InferenceSession.create(new Uint8Array(bytes), sessionOptions),
      ),
      fetchBundleAsset(base, "flow_lm_main_int8.onnx").then((bytes) =>
        ort.InferenceSession.create(new Uint8Array(bytes), sessionOptions),
      ),
      fetchBundleAsset(base, "flow_lm_flow_int8.onnx").then((bytes) =>
        ort.InferenceSession.create(new Uint8Array(bytes), sessionOptions),
      ),
      fetchBundleAsset(base, "mimi_decoder_int8.onnx").then((bytes) =>
        ort.InferenceSession.create(new Uint8Array(bytes), sessionOptions),
      ),
    ]);
    engine.textConditioner = textCond;
    engine.flowLmMain = flowMain;
    engine.flowLmFlow = flowFlow;
    engine.mimiDecoder = decoder;

    onPhase?.("tts-tokenizer");
    const tokenizerBytes = new Uint8Array(
      await fetchBundleAsset(base, engine.metadata.tokenizer_file),
    );
    let tokenizerB64 = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < tokenizerBytes.length; i += chunkSize) {
      tokenizerB64 += String.fromCharCode(...tokenizerBytes.subarray(i, i + chunkSize));
    }
    const spModule = await import("./vendor/sentencepiece.js");
    const processor = new spModule.SentencePieceProcessor();
    await processor.loadFromB64StringModel(btoa(tokenizerB64));
    engine.tokenizer = processor;

    onPhase?.("tts-voice");
    if (config.customVoiceSamples) {
      engine.voiceState = await engine.cloneVoiceState(
        base,
        config.customVoiceSamples,
        sessionOptions,
        onPhase,
      );
      return engine;
    }

    const voices = parseVoiceStatesBin(await fetchBundleAsset(base, "voices.bin"));
    const record = voices[config.voice];
    if (!record) {
      throw new Error(
        `Voice "${config.voice}" not in bundle — available: ${Object.keys(voices).join(", ")}`,
      );
    }
    // bos_before_voice is folded into voice records for built-in voices; parse
    // it only to fail fast if the bundle layout changes underneath us.
    if (engine.metadata.insert_bos_before_voice && engine.metadata.bos_before_voice_file) {
      parseNpyFloat32(await fetchBundleAsset(base, engine.metadata.bos_before_voice_file));
    }
    engine.voiceState = engine.stateFromVoiceRecord(record);

    return engine;
  }

  /**
   * Voice cloning (ported from the demo's encode_voice path): mimi-encode the
   * reference audio to embeddings, prepend the learned BOS-before-voice
   * embedding, and run one flow-LM pass over an empty sequence — the updated
   * flow-LM state IS the voice. The encoder session is released afterwards.
   */
  private async cloneVoiceState(
    base: string,
    samples: Float32Array,
    sessionOptions: ort.InferenceSession.SessionOptions,
    onPhase?: (phase: string) => void,
  ): Promise<OrtState> {
    onPhase?.("tts-voice-clone");
    const encoder = await ort.InferenceSession.create(
      new Uint8Array(await fetchBundleAsset(base, "mimi_encoder_int8.onnx")),
      sessionOptions,
    );
    try {
      const outputs = await encoder.run({
        audio: new ort.Tensor("float32", samples, [1, 1, samples.length]),
      });
      const embeddings = outputs[encoder.outputNames[0]];

      let dims = embeddings.dims.slice();
      let data = new Float32Array(embeddings.data as Float32Array);
      while (dims.length > 3 && dims[0] === 1) {
        dims = dims.slice(1);
      }
      if (dims.length < 3) {
        dims = [1, dims[0], dims[1]];
      }

      if (this.metadata.insert_bos_before_voice && this.metadata.bos_before_voice_file) {
        const bos = parseNpyFloat32(
          await fetchBundleAsset(base, this.metadata.bos_before_voice_file),
        );
        const combined = new Float32Array(bos.data.length + data.length);
        combined.set(bos.data, 0);
        combined.set(data, bos.data.length);
        data = combined;
        dims = [1, dims[1] + bos.shape[1], dims[2]];
      }

      const state = initStateFromManifest(this.metadata.flow_lm_state_manifest);
      const result = await this.flowLmMain.run({
        sequence: new ort.Tensor("float32", new Float32Array(0), [1, 0, this.metadata.latent_dim]),
        text_embeddings: new ort.Tensor("float32", data, dims),
        ...state,
      });
      updateStateFromManifestOutputs(state, result, this.metadata.flow_lm_state_manifest);
      return state;
    } finally {
      await encoder.release();
    }
  }

  private stateFromVoiceRecord(record: VoiceRecord): OrtState {
    const grouped = groupVoiceRecordByModule(record);
    const state = initStateFromManifest(this.metadata.flow_lm_state_manifest);

    for (const entry of this.metadata.flow_lm_state_manifest) {
      const moduleState = grouped[entry.module] || {};
      let source = moduleState[entry.key];
      if (!source && entry.key === "step") {
        source = deriveStep(moduleState);
      }
      if (!source) {
        continue;
      }
      state[entry.input_name] = new ort.Tensor(
        entry.dtype,
        adaptTypedArray(source, entry),
        entry.shape,
      );
    }

    return state;
  }

  get sampleRate(): number {
    return this.metadata.sample_rate;
  }

  /** Synthesize one dialog; deterministic for a given (text, seed). */
  async synthesize(
    text: string,
    seed: number,
    onProgress?: (frames: number) => void,
  ): Promise<PocketSynthesisResult> {
    const meta = this.metadata;
    const prepOptions = {
      removeSemicolons: meta.remove_semicolons,
      padWithSpacesForShortInputs: meta.pad_with_spaces_for_short_inputs,
      recommendedFramesAfterEos: meta.model_recommended_frames_after_eos,
      maxTokenPerChunk: meta.max_token_per_chunk,
    };
    const { chunks, framesAfterEos } = splitIntoBestSentences(text, this.tokenizer, prepOptions);
    if (chunks.length === 0) {
      throw new Error(
        `Nothing to synthesize for ${JSON.stringify(prepareTextPrompt(text, prepOptions))}`,
      );
    }

    const gaussian = createSeededGaussian(seed);
    const std = Math.sqrt(TEMPERATURE);
    const latentDim = meta.latent_dim;
    const emptySeq = new ort.Tensor("float32", new Float32Array(0), [1, 0, latentDim]);
    const emptyTextEmb = new ort.Tensor("float32", new Float32Array(0), [
      1,
      0,
      meta.conditioning_dim,
    ]);
    const stTensors = Array.from({ length: LSD_STEPS }, (_, step) => {
      const s = step / LSD_STEPS;
      return {
        s: new ort.Tensor("float32", new Float32Array([s]), [1, 1]),
        t: new ort.Tensor("float32", new Float32Array([s + 1 / LSD_STEPS]), [1, 1]),
      };
    });

    const audioParts: Float32Array[] = [];
    let totalFrames = 0;

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      // Fresh per text chunk, as upstream configures for this export.
      const flowLmState = { ...this.voiceState };
      const mimiState = initStateFromManifest(meta.mimi_state_manifest);
      const chunkAudioParts: Float32Array[] = [];

      const tokenIds = this.tokenizer.encodeIds(chunks[chunkIdx]);
      const textInput = new ort.Tensor(
        "int64",
        BigInt64Array.from(tokenIds.map((token) => BigInt(token))),
        [1, tokenIds.length],
      );

      let textEmb = (await this.textConditioner.run({ token_ids: textInput }))[
        this.textConditioner.outputNames[0]
      ];
      if (textEmb.dims.length === 2) {
        textEmb = new ort.Tensor("float32", new Float32Array(textEmb.data as Float32Array), [
          1,
          textEmb.dims[0],
          textEmb.dims[1],
        ]);
      }

      const condResult = await this.flowLmMain.run({
        sequence: emptySeq,
        text_embeddings: textEmb,
        ...flowLmState,
      });
      updateStateFromManifestOutputs(flowLmState, condResult, meta.flow_lm_state_manifest);

      const chunkLatents: Float32Array[] = [];
      let chunkDecodedFrames = 0;
      let currentLatent = new ort.Tensor("float32", new Float32Array(latentDim).fill(NaN), [
        1,
        1,
        latentDim,
      ]);
      let eosStep: number | null = null;

      for (let step = 0; step < MAX_FRAMES; step++) {
        // Yield periodically so the page stays responsive during synthesis.
        if (step > 0 && step % 4 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        const arResult = await this.flowLmMain.run({
          sequence: currentLatent,
          text_embeddings: emptyTextEmb,
          ...flowLmState,
        });
        const conditioning = arResult.conditioning;
        const eosLogit = (arResult.eos_logit.data as Float32Array)[0];
        if (eosLogit > EOS_LOGIT_THRESHOLD && eosStep === null) {
          eosStep = step;
        }
        const shouldStop = eosStep !== null && step >= eosStep + framesAfterEos;

        const latentData = new Float32Array(latentDim);
        for (let i = 0; i < latentDim; i++) {
          latentData[i] = gaussian.next() * std;
        }

        const dt = 1.0 / LSD_STEPS;
        for (let lsdIndex = 0; lsdIndex < LSD_STEPS; lsdIndex++) {
          const flowResult = await this.flowLmFlow.run({
            c: conditioning,
            s: stTensors[lsdIndex].s,
            t: stTensors[lsdIndex].t,
            x: new ort.Tensor("float32", latentData, [1, latentDim]),
          });
          const flowDir = flowResult.flow_dir.data as Float32Array;
          for (let i = 0; i < latentDim; i++) {
            latentData[i] += flowDir[i] * dt;
          }
        }

        chunkLatents.push(new Float32Array(latentData));
        currentLatent = new ort.Tensor("float32", latentData, [1, 1, latentDim]);
        updateStateFromManifestOutputs(flowLmState, arResult, meta.flow_lm_state_manifest);
        totalFrames += 1;
        onProgress?.(totalFrames);

        const pending = chunkLatents.length - chunkDecodedFrames;
        // Batch-mode: decode only when the chunk completes (no streaming
        // latency concerns), keeping mimi state transitions identical.
        if (shouldStop || pending >= 48) {
          const decodeSize = pending;
          const decodeLatents = new Float32Array(decodeSize * latentDim);
          for (let frame = 0; frame < decodeSize; frame++) {
            decodeLatents.set(chunkLatents[chunkDecodedFrames + frame], frame * latentDim);
          }
          const decodeResult = await this.mimiDecoder.run({
            latent: new ort.Tensor("float32", decodeLatents, [1, decodeSize, latentDim]),
            ...mimiState,
          });
          updateStateFromManifestOutputs(mimiState, decodeResult, meta.mimi_state_manifest);
          chunkDecodedFrames += decodeSize;
          chunkAudioParts.push(
            new Float32Array(decodeResult[this.mimiDecoder.outputNames[0]].data as Float32Array),
          );
        }

        if (shouldStop) {
          break;
        }
      }

      // Edge fades against clicks at chunk boundaries, as upstream applies.
      if (chunkAudioParts.length > 0) {
        const first = chunkAudioParts[0];
        const fadeIn = Math.min(FADE_SAMPLES, first.length);
        for (let i = 0; i < fadeIn; i++) {
          first[i] *= i / fadeIn;
        }
        const last = chunkAudioParts[chunkAudioParts.length - 1];
        const fadeOut = Math.min(FADE_SAMPLES, last.length);
        for (let i = 0; i < fadeOut; i++) {
          last[last.length - fadeOut + i] *= 1 - i / fadeOut;
        }
      }
      audioParts.push(...chunkAudioParts);

      if (chunkIdx < chunks.length - 1) {
        audioParts.push(new Float32Array(Math.floor(CHUNK_GAP_SEC * meta.sample_rate)));
      }
    }

    const totalSamples = audioParts.reduce((sum, part) => sum + part.length, 0);
    const samples = new Float32Array(totalSamples);
    let offset = 0;
    for (const part of audioParts) {
      samples.set(part, offset);
      offset += part.length;
    }

    return { samples, sampleRate: meta.sample_rate };
  }
}
