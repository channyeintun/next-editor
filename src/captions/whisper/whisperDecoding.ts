// ============================================================================
// Whisper decoding: which token may come next, and how a window's tokens
// become timed segments. A port of the rules in OpenAI's reference decoder
// (SuppressTokens, SuppressBlank, ApplyTimestampRules, and transcribe()'s
// segment/seek logic), kept free of the model so it can be tested alone.
// ============================================================================

/** Whisper's timestamp tokens are 20 ms apart. */
export const WHISPER_TIME_PRECISION = 0.02;

export interface WhisperVocabulary {
  sot: number;
  /** `<|startofprev|>`: introduces the text a window is conditioned on. */
  startOfPrevious: number;
  eot: number;
  transcribe: number;
  noTimestamps: number;
  /** `<|nocaptions|>`: its probability at the first step says whether a window is speech. */
  noSpeech?: number;
  /** `<|0.00|>`; every later id up to the vocabulary's end is a timestamp. */
  timestampBegin: number;
  vocabSize: number;
  languages: ReadonlyArray<{ code: string; id: number }>;
  suppress: readonly number[];
  /** Suppressed only as the first sampled token (a leading space, an immediate end). */
  beginSuppress: readonly number[];
  /** The latest a window's first timestamp may be, in steps after `<|0.00|>`. */
  maxInitialTimestampIndex: number;
}

/**
 * Masks `logits` in place so only a token Whisper's rules allow after `generated` (the
 * tokens sampled in this window so far, prompt excluded) can be chosen.
 */
export function applyWhisperLogitRules(
  logits: Float32Array,
  generated: readonly number[],
  vocab: WhisperVocabulary,
): void {
  const { eot, timestampBegin } = vocab;
  const vocabSize = Math.min(logits.length, vocab.vocabSize);

  for (const id of vocab.suppress) logits[id] = -Infinity;
  // Everything between the end of text and the timestamps is prompt vocabulary
  // (languages, tasks, no-timestamps): never output.
  for (let id = eot + 1; id < timestampBegin; id++) logits[id] = -Infinity;
  if (generated.length === 0) {
    for (const id of vocab.beginSuppress) logits[id] = -Infinity;
  }

  const last = generated[generated.length - 1];
  const penultimate = generated[generated.length - 2];
  const lastWasTimestamp = last !== undefined && last >= timestampBegin;
  const penultimateWasTimestamp = generated.length < 2 || penultimate >= timestampBegin;

  if (lastWasTimestamp) {
    if (penultimateWasTimestamp) {
      // A pair of timestamps closed a segment: text (or the end) comes next.
      for (let id = timestampBegin; id < vocabSize; id++) logits[id] = -Infinity;
    } else {
      // A segment's text is followed by the timestamp that closes it.
      for (let id = 0; id < eot; id++) logits[id] = -Infinity;
    }
  }

  // Timestamps never go back, and every segment lasts at least one step.
  let lastTimestamp = -1;
  for (const token of generated) if (token >= timestampBegin) lastTimestamp = token;
  if (lastTimestamp >= 0) {
    const floor = lastWasTimestamp && !penultimateWasTimestamp ? lastTimestamp : lastTimestamp + 1;
    for (let id = timestampBegin; id < floor; id++) logits[id] = -Infinity;
  }

  if (generated.length === 0) {
    // A window opens with a timestamp, and not a late one.
    for (let id = 0; id < timestampBegin; id++) logits[id] = -Infinity;
    const lastAllowed = timestampBegin + vocab.maxInitialTimestampIndex;
    for (let id = lastAllowed + 1; id < vocabSize; id++) logits[id] = -Infinity;
  }

  // When a timestamp is likelier than any single text token, take a timestamp.
  let maxLogit = -Infinity;
  for (let id = 0; id < vocabSize; id++) if (logits[id] > maxLogit) maxLogit = logits[id];
  if (maxLogit === -Infinity) return;
  let timestampMass = 0;
  let maxText = -Infinity;
  for (let id = 0; id < vocabSize; id++) {
    const value = logits[id];
    if (value === -Infinity) continue;
    if (id >= timestampBegin) timestampMass += Math.exp(value - maxLogit);
    else if (value > maxText) maxText = value;
  }
  if (timestampMass > 0 && Math.log(timestampMass) + maxLogit > maxText) {
    for (let id = 0; id < timestampBegin; id++) logits[id] = -Infinity;
  }
}

/** The index of the largest value. */
export function argmax(values: Float32Array, length = values.length): number {
  let best = 0;
  for (let index = 1; index < length; index++) if (values[index] > values[best]) best = index;
  return best;
}

/** log p(token) under a softmax of `logits`. */
export function logSoftmaxAt(logits: Float32Array, token: number, length = logits.length): number {
  let max = -Infinity;
  for (let index = 0; index < length; index++) if (logits[index] > max) max = logits[index];
  let sum = 0;
  for (let index = 0; index < length; index++) {
    if (logits[index] !== -Infinity) sum += Math.exp(logits[index] - max);
  }
  return logits[token] - max - Math.log(sum);
}

/** The language whose token scores highest after `<|startoftranscript|>`. */
export function detectLanguage(logits: Float32Array, vocab: WhisperVocabulary): string {
  let best = vocab.languages[0];
  for (const language of vocab.languages) {
    if (logits[language.id] > logits[best.id]) best = language;
  }
  return best.code;
}

export interface WindowSegment {
  /** Seconds from the start of the audio. */
  start: number;
  end: number;
  tokens: number[];
}

/**
 * Timed segments from one window's sampled tokens (end of text excluded), and how far
 * to move the window: past the whole window when its last segment closed, or back to
 * the last timestamp when speech ran on past it.
 */
export function segmentWindow(
  tokens: readonly number[],
  windowStart: number,
  windowDuration: number,
  timestampBegin: number,
): { segments: WindowSegment[]; advance: number } {
  const isTimestamp = tokens.map((token) => token >= timestampBegin);
  const singleTimestampEnding =
    tokens.length >= 2 && !isTimestamp[tokens.length - 2] && isTimestamp[tokens.length - 1];
  const consecutive: number[] = [];
  for (let index = 1; index < tokens.length; index++) {
    if (isTimestamp[index - 1] && isTimestamp[index]) consecutive.push(index);
  }
  const timeOf = (token: number) => (token - timestampBegin) * WHISPER_TIME_PRECISION;

  if (consecutive.length > 0) {
    const slices = singleTimestampEnding ? [...consecutive, tokens.length] : consecutive;
    const segments: WindowSegment[] = [];
    let lastSlice = 0;
    for (const slice of slices) {
      const sliced = tokens.slice(lastSlice, slice);
      segments.push({
        start: windowStart + timeOf(sliced[0]),
        end: windowStart + timeOf(sliced[sliced.length - 1]),
        tokens: sliced.slice(1, -1),
      });
      lastSlice = slice;
    }
    const advance = singleTimestampEnding
      ? windowDuration
      : timeOf(tokens[lastSlice - 1]) || windowDuration;
    return { segments, advance };
  }

  let duration = windowDuration;
  const timestamps = tokens.filter((token) => token >= timestampBegin);
  const lastTimestamp = timestamps[timestamps.length - 1];
  if (lastTimestamp !== undefined && lastTimestamp !== timestampBegin) {
    duration = timeOf(lastTimestamp);
  }
  return {
    segments: [
      {
        start: windowStart,
        end: windowStart + duration,
        tokens: tokens.filter((token) => token < timestampBegin),
      },
    ],
    advance: windowDuration,
  };
}
