import type { TypingChunk } from "./plan";

/**
 * Seeded generation of the "human" texture in a performance: typing chunk
 * schedules and cursor tween easing. Everything here is pure and deterministic
 * — the compiled plan stores the generated values, so replaying a plan never
 * re-rolls them (docs/agent-lesson-production.md §7).
 */

/** mulberry32 — small deterministic PRNG, good enough for cadence jitter. */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TypingCadence {
  /** Average characters per second across the whole insertion. */
  charsPerSecond: number;
  /** Max characters emitted per chunk (chunks break earlier at newlines). */
  maxChunkChars: number;
  /** Extra pause appended after a chunk that ends a line, in ms. */
  lineBreakPauseMs: number;
  /** ±fraction of jitter applied to each chunk delay (0 disables). */
  jitter: number;
}

export const FAST_EXPLAINER_CADENCE: TypingCadence = {
  charsPerSecond: 16,
  maxChunkChars: 4,
  lineBreakPauseMs: 200,
  jitter: 0.25,
};

/**
 * Split `text` into bounded insertion chunks with per-chunk delays. Chunks
 * never span a newline so playback pauses land at line boundaries, matching
 * how the recorder's exact-edit capture groups ordinary typing.
 */
export function compileTypingChunks(
  text: string,
  cadence: TypingCadence,
  seed: number,
): TypingChunk[] {
  if (text.length === 0) {
    return [];
  }

  const random = createSeededRandom(seed);
  const chunks: TypingChunk[] = [];
  const baseDelayMs = (1000 / cadence.charsPerSecond) * cadence.maxChunkChars;

  let index = 0;
  while (index < text.length) {
    const newlineIndex = text.indexOf("\n", index);
    const lineEnd = newlineIndex === -1 ? text.length : newlineIndex + 1;
    const chunkEnd = Math.min(index + cadence.maxChunkChars, lineEnd);
    const chunkText = text.slice(index, chunkEnd);

    const jitterFactor = 1 + (random() * 2 - 1) * cadence.jitter;
    const scaledDelay = baseDelayMs * (chunkText.length / cadence.maxChunkChars) * jitterFactor;
    const endsLine = chunkText.endsWith("\n");
    const delayMs = Math.max(
      8,
      Math.round(scaledDelay) + (endsLine ? cadence.lineBreakPauseMs : 0),
    );

    chunks.push({ delayMs, text: chunkText });
    index = chunkEnd;
  }

  return chunks;
}

export function totalTypingDurationMs(chunks: readonly TypingChunk[]): number {
  return chunks.reduce((total, chunk) => total + chunk.delayMs, 0);
}

/** Standard ease-in-out cubic used for cursor tweens. */
export function easeInOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped < 0.5 ? 4 * clamped * clamped * clamped : 1 - (-2 * clamped + 2) ** 3 / 2;
}
