import type { CaptionWord } from "../types";

/**
 * A cue's text spelled from its timed words, the one rule both the studio's caption
 * track and a recording edit that cuts some of a cue's words use.
 */
export const captionTextFromWords = (words: readonly CaptionWord[]): string =>
  words.map((word) => word.text).join(" ");
