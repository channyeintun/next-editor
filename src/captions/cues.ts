import type { CaptionCue } from "../core/src/types";

/**
 * The cues a caption track keeps: a non-negative start, an end after it and some
 * text, in start order. Importing (parseCaptions.ts) and exporting (serializeVtt.ts)
 * share this one rule, so a file the app writes reads back as the same cues.
 */
export function normalizeCues(cues: CaptionCue[]): CaptionCue[] {
  return cues
    .filter((c) => c.start >= 0 && c.end > c.start && c.text.trim().length > 0)
    .sort((a, b) => a.start - b.start);
}
