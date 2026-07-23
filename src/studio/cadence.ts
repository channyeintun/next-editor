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
      /**
       * Press Enter first: insert the text's trailing newline(s) before typing
       * the body, so existing code moves to the next line instead of sitting
       * glued to the end of the line being typed.
       */
      openLineFirst?: boolean;
      /**
       * Extra pause before the first character of a word (a chunk following a
       * space or newline) — real typists slow down between words. From the
       * reference human recording: word starts run ~2–4× a within-word key.
       */
      wordPauseMs?: number;
      /** Occasional longer "thinking" pause added on top of a word start. */
      thinkPauseMs?: number;
      /** Seeded probability [0,1] that a word start also gets a think pause. */
      thinkChance?: number;
    }
  | {
      /** Incremental reveal: whole lines appear one at a time — no keystrokes. */
      mode: "lines";
      /** Base pause before each line, in ms. */
      linePauseMs: number;
      /** Additional per-character reading time added to each line's pause. */
      msPerChar: number;
      jitter: number;
      openLineFirst?: boolean;
    }
  | {
      /** The whole insertion appears at once after a beat. */
      mode: "block";
      pauseMs: number;
    };

/**
 * Default: single keystrokes matched to the reference human recording
 * (recording-1784617032039.ne — within-word keys median ~140ms with wide
 * jitter, word starts ~2–4× slower, occasional thinking pauses; the think
 * pause is tuned to 400ms, shorter than the recording's ~0.6–1s, by request).
 */
export const NATURAL_CADENCE: TypingCadence = {
  mode: "chars",
  charsPerSecond: 7,
  maxChunkChars: 1,
  lineBreakPauseMs: 380,
  jitter: 0.4,
  openLineFirst: true,
  wordPauseMs: 260,
  thinkPauseMs: 400,
  thinkChance: 0.35,
};

/** Brisker keystrokes for dense lessons — still far from teleporting text. */
export const FAST_EXPLAINER_CADENCE: TypingCadence = {
  mode: "chars",
  charsPerSecond: 10,
  maxChunkChars: 1,
  lineBreakPauseMs: 260,
  jitter: 0.3,
  openLineFirst: true,
  wordPauseMs: 170,
  thinkPauseMs: 280,
  thinkChance: 0.2,
};

/** Incremental reveal: code lands line by line at reading pace. */
export const LINE_BY_LINE_CADENCE: TypingCadence = {
  mode: "lines",
  linePauseMs: 500,
  msPerChar: 14,
  jitter: 0.2,
  openLineFirst: true,
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

  // "Open the line first": when the insertion ends in newline(s), press Enter
  // up front — the trailing newlines land at the anchor before any body text,
  // so code already sitting there moves to the next line the way a developer
  // would move it, instead of trailing the line being typed. The body chunks
  // then carry their position within the final text (offsetInText) so the
  // driver can place them back in front of those newlines.
  const trailing = /\n+$/.exec(text)?.[0] ?? "";
  const body = text.slice(0, text.length - trailing.length);
  const openFirst = Boolean(cadence.openLineFirst) && trailing.length > 0 && body.length > 0;

  const random = createSeededRandom(seed);
  const chunks: TypingChunk[] = [];
  const chunkSource = openFirst ? body : text;

  if (openFirst) {
    const enterPauseMs = cadence.mode === "lines" ? cadence.linePauseMs : cadence.lineBreakPauseMs;
    chunks.push({
      delayMs: Math.max(8, enterPauseMs),
      text: trailing,
      offsetInText: body.length,
    });
  }

  const withOffset = (chunk: TypingChunk, index: number): TypingChunk =>
    openFirst ? { ...chunk, offsetInText: index } : chunk;

  if (cadence.mode === "lines") {
    let index = 0;
    while (index < chunkSource.length) {
      const newlineIndex = chunkSource.indexOf("\n", index);
      const lineEnd = newlineIndex === -1 ? chunkSource.length : newlineIndex + 1;
      const lineText = chunkSource.slice(index, lineEnd);
      const visibleChars = lineText.replace(/\s+/g, "").length;
      const jitterFactor = 1 + (random() * 2 - 1) * cadence.jitter;
      const delayMs = Math.max(
        8,
        Math.round((cadence.linePauseMs + visibleChars * cadence.msPerChar) * jitterFactor),
      );
      chunks.push(withOffset({ delayMs, text: lineText }, index));
      index = lineEnd;
    }
    return chunks;
  }

  const baseDelayMs = (1000 / cadence.charsPerSecond) * cadence.maxChunkChars;
  let index = 0;
  while (index < chunkSource.length) {
    const newlineIndex = chunkSource.indexOf("\n", index);
    const lineEnd = newlineIndex === -1 ? chunkSource.length : newlineIndex + 1;
    const chunkEnd = Math.min(index + cadence.maxChunkChars, lineEnd);
    const chunkText = chunkSource.slice(index, chunkEnd);

    const jitterFactor = 1 + (random() * 2 - 1) * cadence.jitter;
    const scaledDelay = baseDelayMs * (chunkText.length / cadence.maxChunkChars) * jitterFactor;
    const endsLine = chunkText.endsWith("\n");

    // Word starts type slower: the reference recording shows the first key
    // after a space/newline at ~2–4× a within-word key, with an occasional
    // longer thinking pause (seeded, so plans stay reproducible).
    const previousChar = index === 0 ? "" : chunkSource[index - 1];
    const startsWord = previousChar === " " || previousChar === "\n";
    let pauseMs = 0;
    if (startsWord && cadence.wordPauseMs) {
      pauseMs += Math.round(cadence.wordPauseMs * (1 + (random() * 2 - 1) * cadence.jitter));
      if (cadence.thinkPauseMs && random() < (cadence.thinkChance ?? 0)) {
        pauseMs += cadence.thinkPauseMs;
      }
    }

    const delayMs = Math.max(
      8,
      Math.round(scaledDelay) + pauseMs + (endsLine ? cadence.lineBreakPauseMs : 0),
    );

    chunks.push(withOffset({ delayMs, text: chunkText }, index));
    index = chunkEnd;
  }

  return chunks;
}

/**
 * Model-offset placement for a chunk sequence: each chunk (in time order)
 * lands at anchor + the total length of already-inserted chunks positioned
 * before it in the final text. `expectedText` is the final inserted span.
 */
export function chunkPlacements(chunks: readonly TypingChunk[]): {
  relativeOffsets: number[];
  expectedText: string;
} {
  let cumulative = 0;
  const positioned = chunks.map((chunk) => {
    const offsetInText = chunk.offsetInText ?? cumulative;
    cumulative += chunk.text.length;
    return { chunk, offsetInText };
  });

  const relativeOffsets: number[] = [];
  const inserted: { offsetInText: number; length: number }[] = [];
  for (const entry of positioned) {
    let before = 0;
    for (const done of inserted) {
      if (done.offsetInText < entry.offsetInText) before += done.length;
    }
    relativeOffsets.push(before);
    inserted.push({ offsetInText: entry.offsetInText, length: entry.chunk.text.length });
  }

  const expectedText = [...positioned]
    .sort((left, right) => left.offsetInText - right.offsetInText)
    .map((entry) => entry.chunk.text)
    .join("");

  return { relativeOffsets, expectedText };
}

export function totalTypingDurationMs(chunks: readonly TypingChunk[]): number {
  return chunks.reduce((total, chunk) => total + chunk.delayMs, 0);
}

/** Standard ease-in-out cubic used for a free cursor tween that starts at rest. */
export function easeInOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped < 0.5 ? 4 * clamped * clamped * clamped : 1 - (-2 * clamped + 2) ** 3 / 2;
}

/**
 * Ease-out cubic — velocity is highest at the start and decays to a near-stop.
 * This is the profile the reference human recording (human-interactions.ne)
 * shows for a *drag-select*: the hand flings across the span, then decelerates
 * to land precisely on the last character. Averaged over the recording's drags
 * the normalized velocity ran ~0.91 → 0.17 across the gesture (a monotonic
 * decay), which cubic ease-out matches far better than the symmetric
 * slow-fast-slow of {@link easeInOutCubic}.
 */
export function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - (1 - clamped) ** 3;
}
