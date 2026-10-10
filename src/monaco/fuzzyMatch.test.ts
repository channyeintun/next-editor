import { describe, expect, it } from "vite-plus/test";
import { FUZZY_MATCH_MAX_LENGTH, foldCase, fuzzyMatch } from "./fuzzyMatch";

// Runs Monaco's own matcher (vite.config.ts aliases it past the Monaco test
// mock), so an upgrade that moves or changes vs/base/common/filters fails here.
const match = (pattern: string, word: string) =>
  fuzzyMatch(pattern, foldCase(pattern), word, foldCase(word));

describe("fuzzyMatch", () => {
  it("matches letters in order and returns their positions, ascending", () => {
    expect(match("fsb", "FileSidebar.tsx")?.positions).toEqual([0, 4, 8]);
    expect(match("side", "FileSidebar.tsx")?.positions).toEqual([4, 5, 6, 7]);
  });

  it("ranks word starts and humps above letters inside words", () => {
    expect(match("fs", "FileSidebar.tsx")!.score).toBeGreaterThan(match("fs", "offsets.ts")!.score);
  });

  it("finds nothing when a letter is missing or out of order", () => {
    expect(match("xyz", "FileSidebar.tsx")).toBeNull();
    expect(match("rabe", "FileSidebar.tsx")).toBeNull();
    expect(match("longer", "short")).toBeNull();
  });

  it("reads only the first characters of a long word", () => {
    const word = `${"a".repeat(FUZZY_MATCH_MAX_LENGTH)}z`;
    expect(match("z", word)).toBeNull();
  });

  it("keeps indices aligned past a letter whose lowercase is longer", () => {
    expect(foldCase("İa")).toHaveLength(2);
    expect(match("a", "İa")?.positions).toEqual([1]);
  });
});
