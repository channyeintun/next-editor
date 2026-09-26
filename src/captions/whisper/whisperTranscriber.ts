import type * as Ort from "onnxruntime-web/wasm";
import { WHISPER_CHUNK_SAMPLES, WHISPER_SAMPLE_RATE, whisperLogMel } from "./melSpectrogram";
import { WhisperModel, type WhisperModelConfig } from "./whisperModel";
import { WhisperTokenizer } from "./whisperTokenizer";
import {
  applyWhisperLogitRules,
  argmax,
  detectLanguage,
  logSoftmaxAt,
  segmentWindow,
  type WhisperVocabulary,
} from "./whisperDecoding";

/** Tokens one window may produce: half the decoder's context, as the reference uses. */
const MAX_WINDOW_TOKENS = 224;
/** The reference's no-speech thresholds: a likely-silent window decoded with low confidence. */
const NO_SPEECH_THRESHOLD = 0.6;
const LOGPROB_THRESHOLD = -1;
/** The prompt keeps at most this many tokens: half the decoder's context, less one. */
const MAX_PROMPT_TOKENS = 223;
/** A phrase this many times in one window is the model looping, not the speaker. */
const REPEATED_PHRASE_LIMIT = 4;
const REPEATED_PHRASE_TOKENS = 4;

export interface WhisperGenerationConfig {
  suppress_tokens: number[];
  begin_suppress_tokens: number[];
  max_initial_timestamp_index: number;
  lang_to_id: Record<string, number>;
}

export interface WhisperAssets {
  encoder: ArrayBuffer;
  decoder: ArrayBuffer;
  config: WhisperModelConfig;
  generationConfig: WhisperGenerationConfig;
  tokenizer: ConstructorParameters<typeof WhisperTokenizer>[0];
}

export interface TranscribedSegment {
  /** Seconds from the start of the audio. */
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  language: string;
  segments: TranscribedSegment[];
}

function vocabularyFor(
  tokenizer: WhisperTokenizer,
  generation: WhisperGenerationConfig,
  vocabSize: number,
): WhisperVocabulary {
  const id = (token: string) => {
    const value = tokenizer.idOf(token);
    if (value === undefined) throw new Error(`The Whisper vocabulary has no ${token}`);
    return value;
  };
  return {
    sot: id("<|startoftranscript|>"),
    startOfPrevious: id("<|startofprev|>"),
    eot: id("<|endoftext|>"),
    transcribe: id("<|transcribe|>"),
    noTimestamps: id("<|notimestamps|>"),
    noSpeech: tokenizer.idOf("<|nocaptions|>") ?? tokenizer.idOf("<|nospeech|>"),
    timestampBegin: id("<|0.00|>"),
    vocabSize,
    languages: Object.entries(generation.lang_to_id).map(([token, languageId]) => ({
      code: token.slice(2, -2),
      id: languageId,
    })),
    suppress: generation.suppress_tokens,
    beginSuppress: generation.begin_suppress_tokens,
    maxInitialTimestampIndex: generation.max_initial_timestamp_index,
  };
}

/** Whether the last few text tokens have already appeared too often in this window. */
function isLooping(tokens: readonly number[], timestampBegin: number): boolean {
  const text = tokens.filter((token) => token < timestampBegin);
  if (text.length < REPEATED_PHRASE_TOKENS * REPEATED_PHRASE_LIMIT) return false;
  const phrase = text.slice(-REPEATED_PHRASE_TOKENS).join(",");
  let count = 0;
  for (let index = 0; index + REPEATED_PHRASE_TOKENS <= text.length; index++) {
    if (text.slice(index, index + REPEATED_PHRASE_TOKENS).join(",") === phrase) count++;
  }
  return count >= REPEATED_PHRASE_LIMIT;
}

/**
 * Transcribes 16 kHz mono speech with Whisper: window by window, each decoded
 * greedily under the timestamp rules and moved on from its last closed segment,
 * as OpenAI's reference `transcribe` does (without its temperature fallback).
 */
export async function transcribeWithWhisper(
  ort: typeof Ort,
  assets: WhisperAssets,
  samples: Float32Array,
  options: {
    /** A language code (`en`); detected from the first window when absent. */
    language?: string;
    /**
     * Text the speech is likely to use (the lesson's libraries and names), given to every
     * window as its prompt. Windows are not conditioned on the text before them: with
     * this model that ran segments together and skipped speech.
     */
    prompt?: string;
    onProgress?: (doneSeconds: number, totalSeconds: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<Transcript> {
  const tokenizer = new WhisperTokenizer(assets.tokenizer);
  const model = await WhisperModel.create(ort, assets.encoder, assets.decoder, assets.config);
  const vocab = vocabularyFor(tokenizer, assets.generationConfig, model.vocabSize);
  const totalSeconds = samples.length / WHISPER_SAMPLE_RATE;
  const segments: TranscribedSegment[] = [];
  let language = options.language;
  let seek = 0;
  const promptTokens = options.prompt?.trim() ? tokenizer.encode(` ${options.prompt.trim()}`) : [];

  while (seek < totalSeconds - 0.1) {
    options.signal?.throwIfAborted();
    const startSample = Math.round(seek * WHISPER_SAMPLE_RATE);
    const window = samples.subarray(startSample, startSample + WHISPER_CHUNK_SAMPLES);
    const windowSeconds = window.length / WHISPER_SAMPLE_RATE;
    const hidden = await model.encode(whisperLogMel(window));

    if (!language) {
      const { sotLogits } = await model.start(hidden, [vocab.sot]);
      language = detectLanguage(sotLogits, vocab);
    }
    const languageId = vocab.languages.find((entry) => entry.code === language)?.id;
    if (languageId === undefined) throw new Error(`Whisper has no language "${language}"`);

    const previous =
      promptTokens.length > 0
        ? [vocab.startOfPrevious, ...promptTokens.slice(-MAX_PROMPT_TOKENS)]
        : [];
    const first = await model.start(
      hidden,
      [...previous, vocab.sot, languageId, vocab.transcribe],
      previous.length,
    );
    const noSpeechProbability =
      vocab.noSpeech === undefined
        ? 0
        : Math.exp(logSoftmaxAt(first.sotLogits, vocab.noSpeech, vocab.vocabSize));

    const generated: number[] = [];
    let logits = first.logits;
    let sumLogprob = 0;
    while (generated.length < MAX_WINDOW_TOKENS) {
      applyWhisperLogitRules(logits, generated, vocab);
      const token = argmax(logits, vocab.vocabSize);
      sumLogprob += logSoftmaxAt(logits, token, vocab.vocabSize);
      if (token === vocab.eot) break;
      generated.push(token);
      if (isLooping(generated, vocab.timestampBegin)) break;
      logits = await model.next(first.state, token);
    }

    const averageLogprob = sumLogprob / (generated.length + 1);
    const silent = noSpeechProbability > NO_SPEECH_THRESHOLD && averageLogprob < LOGPROB_THRESHOLD;
    const { segments: windowSegments, advance } = segmentWindow(
      generated,
      seek,
      windowSeconds,
      vocab.timestampBegin,
    );
    if (!silent) {
      for (const segment of windowSegments) {
        const text = tokenizer.decode(segment.tokens).trim();
        if (text) segments.push({ start: segment.start, end: segment.end, text });
      }
    }

    seek += silent ? windowSeconds : Math.max(advance, 0.02);
    options.onProgress?.(Math.min(seek, totalSeconds), totalSeconds);
  }

  return { language: language ?? "en", segments };
}
