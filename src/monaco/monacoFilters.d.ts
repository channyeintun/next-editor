// Monaco ships its internal modules without declarations. This types the part
// of vs/base/common/filters.js that fuzzyMatch.ts uses: VS Code's own fuzzy
// matcher, the one behind IntelliSense and the quick-pick highlights.
declare module "monaco-editor/base/common/filters" {
  /** [score, wordStart, ...matched word positions, last first, relative to wordStart] */
  export type FuzzyScore = [score: number, wordStart: number, ...matches: number[]];

  export interface FuzzyScoreOptions {
    readonly firstMatchCanBeWeak: boolean;
    readonly boostFullMatch: boolean;
  }

  export interface IMatch {
    start: number;
    end: number;
  }

  export function fuzzyScore(
    pattern: string,
    patternLow: string,
    patternStart: number,
    word: string,
    wordLow: string,
    wordStart: number,
    options?: FuzzyScoreOptions,
  ): FuzzyScore | undefined;

  export function createMatches(score: FuzzyScore | undefined): IMatch[];
}
