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

export type TypingCadence =
  | {
      /** Simulated keystrokes: a few characters at a time. */
      mode: "chars";
      /** Average characters per second across the whole insertion. */
      charsPerSecond: number;
      /** Max characters emitted per chunk (chunks break earlier at newlines). */
      maxChunkChars: number;
      /** Extra pause appended after a chunk that ends a line, in ms. */
      lineBreakPauseMs: number;
      /** ±fraction of jitter applied to each chunk delay (0 disables). */
      jitter: number;
    }
  | {
      /** Incremental reveal: whole lines appear one at a time — no keystrokes. */
      mode: "lines";
      /** Base pause before each line, in ms. */
      linePauseMs: number;
      /** Additional per-character reading time added to each line's pause. */
      msPerChar: number;
      jitter: number;
    }
  | {
      /** The whole insertion appears at once after a beat. */
      mode: "block";
      pauseMs: number;
    };

/** Default: unhurried, human-feeling keystrokes. */
export const NATURAL_CADENCE: TypingCadence = {
  mode: "chars",
  charsPerSecond: 8,
  maxChunkChars: 3,
  lineBreakPauseMs: 380,
  jitter: 0.35,
};

/** Brisker keystrokes for dense lessons — still far from teleporting text. */
export const FAST_EXPLAINER_CADENCE: TypingCadence = {
  mode: "chars",
  charsPerSecond: 11,
  maxChunkChars: 4,
  lineBreakPauseMs: 260,
  jitter: 0.25,
};

/** Incremental reveal: code lands line by line at reading pace. */
export const LINE_BY_LINE_CADENCE: TypingCadence = {
  mode: "lines",
  linePauseMs: 500,
  msPerChar: 14,
  jitter: 0.2,
};

/** No animation: the block appears whole after a short beat. */
export const BLOCK_CADENCE: TypingCadence = {
  mode: "block",
  pauseMs: 450,
};

/**
 * Split `text` into insertion chunks with per-chunk delays. Chunks never span
 * a newline so pauses land at line boundaries, matching how the recorder's
 * exact-edit capture groups ordinary typing. "lines" mode emits whole lines
 * (an incremental reveal, not simulated keystrokes); "block" emits one chunk.
 */
export function compileTypingChunks(
  text: string,
  cadence: TypingCadence,
  seed: number,
): TypingChunk[] {
  if (text.length === 0) {
    return [];
  }

  if (cadence.mode === "block") {
    return [{ delayMs: Math.max(8, cadence.pauseMs), text }];
  }

  const random = createSeededRandom(seed);
  const chunks: TypingChunk[] = [];

  if (cadence.mode === "lines") {
    let index = 0;
    while (index < text.length) {
      const newlineIndex = text.indexOf("\n", index);
      const lineEnd = newlineIndex === -1 ? text.length : newlineIndex + 1;
      const lineText = text.slice(index, lineEnd);
      const visibleChars = lineText.replace(/\s+/g, "").length;
      const jitterFactor = 1 + (random() * 2 - 1) * cadence.jitter;
      const delayMs = Math.max(
        8,
        Math.round((cadence.linePauseMs + visibleChars * cadence.msPerChar) * jitterFactor),
      );
      chunks.push({ delayMs, text: lineText });
      index = lineEnd;
    }
    return chunks;
  }

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
