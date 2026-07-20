import type { CaptionCue, CaptionTrack, CaptionWord } from "../../core/src/types";
import type { PronunciationLexicon } from "./lexicon";
import { spokenFormOf } from "./lexicon";
import type { ExtractedNarration, NarrationMarker } from "./markers";

/**
 * Narration alignment (docs/agent-lesson-production.md §6): millisecond spans
 * for every display token, plus marker times and readable caption cues. The
 * estimation provider weighs each token by its spoken length and trailing
 * punctuation pauses, scaled to the measured audio duration; a hosted TTS
 * provider with real word boundaries plugs in through the same
 * `NarrationAlignment` shape. Validation rejects missing, reordered,
 * overlapping, or non-monotonic spans — captions are derived from the script,
 * but that never makes alignment assumed-correct.
 */

export interface AlignedToken {
  text: string;
  startMs: number;
  endMs: number;
}

export interface NarrationAlignment {
  tokens: AlignedToken[];
  durationMs: number;
}

export class AlignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlignmentError";
  }
}

/**
 * Silence the synthesizer adds around an utterance; excluded from token spans.
 * The defaults suit a whole-narration `say` file; per-dialog estimation passes
 * smaller margins since each span is only a sentence or two.
 */
const LEAD_SILENCE_MS = 150;
const TAIL_SILENCE_MS = 300;

export interface AlignmentMargins {
  leadMs: number;
  tailMs: number;
}

const SENTENCE_END_PATTERN = /[.!?:]["')\]]*$/;
const CLAUSE_END_PATTERN = /[,;]["')\]]*$/;

/** Pause weight in "virtual characters" appended after a token. */
function pauseWeightOf(token: string): number {
  if (SENTENCE_END_PATTERN.test(token)) return 7;
  if (CLAUSE_END_PATTERN.test(token)) return 3;
  return 0;
}

function speechWeightOf(token: string, lexicon: PronunciationLexicon): number {
  const spoken = spokenFormOf(token, lexicon).replace(/[^A-Za-z0-9]/g, "");
  // Even a bare punctuation token costs a beat.
  return Math.max(spoken.length, 2) + pauseWeightOf(token);
}

/**
 * Estimate token spans across a measured audio duration by spoken-length
 * weighting. Deterministic for identical inputs.
 */
export function estimateAlignment(
  tokens: readonly string[],
  audioDurationMs: number,
  lexicon: PronunciationLexicon,
  margins: AlignmentMargins = { leadMs: LEAD_SILENCE_MS, tailMs: TAIL_SILENCE_MS },
): NarrationAlignment {
  if (tokens.length === 0) {
    throw new AlignmentError("Cannot align an empty narration");
  }
  const usableMs = audioDurationMs - margins.leadMs - margins.tailMs;
  if (!Number.isFinite(usableMs) || usableMs <= 0) {
    throw new AlignmentError(`Audio too short to align: ${audioDurationMs}ms`);
  }

  const weights = tokens.map((token) => speechWeightOf(token, lexicon));
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);

  const aligned: AlignedToken[] = [];
  let cursorMs = margins.leadMs;
  let consumedWeight = 0;
  for (let i = 0; i < tokens.length; i++) {
    consumedWeight += weights[i];
    const endMs = Math.round(margins.leadMs + (usableMs * consumedWeight) / totalWeight);
    aligned.push({ text: tokens[i], startMs: Math.round(cursorMs), endMs });
    cursorMs = endMs;
  }

  const alignment = { tokens: aligned, durationMs: audioDurationMs };
  validateAlignment(alignment, tokens);
  return alignment;
}

/** Reject missing, reordered, overlapping, or out-of-bounds token spans. */
export function validateAlignment(
  alignment: NarrationAlignment,
  displayTokens: readonly string[],
): void {
  if (alignment.tokens.length !== displayTokens.length) {
    throw new AlignmentError(
      `Alignment covers ${alignment.tokens.length} tokens but the narration has ${displayTokens.length}`,
    );
  }
  for (let i = 0; i < alignment.tokens.length; i++) {
    const token = alignment.tokens[i];
    if (token.text !== displayTokens[i]) {
      throw new AlignmentError(
        `Alignment token ${i} is ${JSON.stringify(token.text)} but the narration has ${JSON.stringify(displayTokens[i])}`,
      );
    }
    if (!Number.isFinite(token.startMs) || !Number.isFinite(token.endMs)) {
      throw new AlignmentError(`Alignment token ${i} has non-finite times`);
    }
    if (token.endMs < token.startMs || token.startMs < 0 || token.endMs > alignment.durationMs) {
      throw new AlignmentError(`Alignment token ${i} span is out of bounds`);
    }
    if (i > 0 && token.startMs < alignment.tokens[i - 1].endMs) {
      throw new AlignmentError(`Alignment token ${i} overlaps token ${i - 1}`);
    }
  }
}

/** A marker's time: the start of the token it precedes (or the narration end). */
export function markerTimeMs(alignment: NarrationAlignment, marker: NarrationMarker): number {
  if (marker.beforeTokenIndex >= alignment.tokens.length) {
    return alignment.tokens[alignment.tokens.length - 1].endMs;
  }
  return alignment.tokens[marker.beforeTokenIndex].startMs;
}

/** Scene start: the start of the scene's first token. */
export function sceneStartMs(
  alignment: NarrationAlignment,
  extracted: ExtractedNarration,
  sceneId: string,
): number {
  const scene = extracted.scenes.find((candidate) => candidate.sceneId === sceneId);
  if (!scene) {
    throw new AlignmentError(`Unknown scene "${sceneId}"`);
  }
  return alignment.tokens[scene.firstTokenIndex].startMs;
}

const MAX_CUE_CHARS = 84;
const MAX_CUE_DURATION_MS = 7_000;

/**
 * Segment aligned tokens into readable cues: break at sentence ends, scene
 * boundaries, the two-line character budget, or the duration cap.
 */
export function buildCaptionTrack(
  alignment: NarrationAlignment,
  extracted: ExtractedNarration,
  options: { id: string; language: string; label?: string },
): CaptionTrack {
  const sceneBreaks = new Set(extracted.scenes.map((scene) => scene.firstTokenIndex));
  const cues: CaptionCue[] = [];
  let cueTokens: AlignedToken[] = [];

  const flush = () => {
    if (cueTokens.length === 0) {
      return;
    }
    const words: CaptionWord[] = cueTokens.map((token) => ({
      start: token.startMs,
      end: token.endMs,
      text: token.text,
    }));
    cues.push({
      start: cueTokens[0].startMs,
      end: cueTokens[cueTokens.length - 1].endMs,
      text: cueTokens.map((token) => token.text).join(" "),
      words,
    });
    cueTokens = [];
  };

  for (let i = 0; i < alignment.tokens.length; i++) {
    if (sceneBreaks.has(i)) {
      flush();
    }
    const token = alignment.tokens[i];
    const currentChars =
      cueTokens.reduce((total, t) => total + t.text.length + 1, 0) + token.text.length;
    const currentDuration = cueTokens.length > 0 ? token.endMs - cueTokens[0].startMs : 0;
    if (
      cueTokens.length > 0 &&
      (currentChars > MAX_CUE_CHARS || currentDuration > MAX_CUE_DURATION_MS)
    ) {
      flush();
    }
    cueTokens.push(token);
    if (SENTENCE_END_PATTERN.test(token.text)) {
      flush();
    }
  }
  flush();

  return {
    id: options.id,
    language: options.language,
    label: options.label,
    default: true,
    cues,
  };
}
