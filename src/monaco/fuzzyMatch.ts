// Not exported from ./index: that barrel loads the whole Monaco runtime, and a
// caller of this pure matcher (and its tests) needs none of it.
import { createMatches, fuzzyScore } from "monaco-editor/base/common/filters";

/** Monaco's matcher reads at most this many characters of the pattern and of the word. */
export const FUZZY_MATCH_MAX_LENGTH = 128;

export interface FuzzyMatch {
  /** Higher is better. Only comparable between matches of the same pattern. */
  score: number;
  /** The matched indices in `word`, ascending. */
  positions: number[];
}

/**
 * Lowercases one UTF-16 unit at a time, so every index in the result names the
 * same character as in the original. A plain toLowerCase() lengthens "İ" to two
 * units and shifts every match after it.
 */
export function foldCase(text: string): string {
  let folded = "";
  for (const unit of text.split("")) {
    const lower = unit.toLowerCase();
    folded += lower.length === 1 ? lower : unit;
  }
  return folded;
}

/**
 * VS Code's fuzzy match of `pattern` against `word`, as its quick picks score
 * labels: the letters in order, ranked up for word starts, camelCase humps and
 * runs, with the first letter free to land anywhere. Both lowercase forms come
 * from foldCase, which the caller computes once per string.
 */
export function fuzzyMatch(
  pattern: string,
  patternLow: string,
  word: string,
  wordLow: string,
): FuzzyMatch | null {
  const score = fuzzyScore(pattern, patternLow, 0, word, wordLow, 0, {
    firstMatchCanBeWeak: true,
    boostFullMatch: true,
  });
  if (!score) return null;
  const positions: number[] = [];
  for (const { start, end } of createMatches(score)) {
    for (let index = start; index < end; index++) positions.push(index);
  }
  return { score: score[0], positions: positions.sort((left, right) => left - right) };
}
