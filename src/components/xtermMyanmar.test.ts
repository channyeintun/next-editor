import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vite-plus/test";
import {
  ESTIMATED_MYANMAR_ADVANCES,
  MYANMAR_UNICODE_VERSION,
  createMyanmarUnicodeProvider,
  myanmarClusterRanges,
} from "./xtermMyanmar";

/** Writes `text` to a real (unopened) xterm and returns row 0's cells. */
async function cellsOf(text: string, provider = createMyanmarUnicodeProvider()) {
  const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: 2 });
  terminal.unicode.register(provider);
  terminal.unicode.activeVersion = provider.version;
  await new Promise<void>((resolve) => terminal.write(text, resolve));
  const line = terminal.buffer.active.getLine(0);
  const cells: Array<{ chars: string; width: number }> = [];
  for (let x = 0; line && x < terminal.cols; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    if (!cell.getChars()) break;
    cells.push({ chars: cell.getChars(), width: cell.getWidth() });
  }
  terminal.dispose();
  return cells;
}

const columns = (cells: Array<{ width: number }>) => cells.reduce((sum, c) => sum + c.width, 0);

describe("Myanmar cluster widths", () => {
  it("keeps a consonant and its vowel signs in one cell, as wide as they draw", async () => {
    // ပ + ါ: one cluster, one two-column cell (the browser shapes it whole).
    expect(await cellsOf("ပါ")).toEqual([{ chars: "ပါ", width: 2 }]);
    // ေ is stored after its consonant but drawn before it: same cell.
    expect(await cellsOf("ပေ")).toEqual([{ chars: "ပေ", width: 2 }]);
  });

  it("starts a new cell only when a cluster needs more than two columns", async () => {
    // အ (1.25) + ေ (0.65) fits two columns; ာ would make 2.5, so it opens a
    // third column of the same cluster (the joiner still draws it as one).
    expect(await cellsOf("အော")).toEqual([
      { chars: "အေ", width: 2 },
      { chars: "ာ", width: 1 },
    ]);
  });

  it("gives a final consonant with asat its own cell", async () => {
    expect(await cellsOf("အောင်")).toEqual([
      { chars: "အေ", width: 2 },
      { chars: "ာ", width: 1 },
      { chars: "င်", width: 1 },
    ]);
  });

  it("draws kinzi and stacked consonants in their base letter's cell", async () => {
    // မင်္ဂ: the nga + asat + virama sits above ဂ and takes no width.
    expect(await cellsOf("မင်္ဂ")).toEqual([
      { chars: "မ", width: 1 },
      { chars: "င်္ဂ", width: 1 },
    ]);
    // ဒ္ဓ: the second consonant is a subscript under the first.
    expect(await cellsOf("ဒ္ဓ")).toEqual([{ chars: "ဒ္ဓ", width: 1 }]);
  });

  it("keeps marks that add no width in the base cell", async () => {
    expect(await cellsOf("ပို့")).toEqual([{ chars: "ပို့", width: 1 }]);
  });

  it("leaves every other script at xterm's default widths", async () => {
    expect(columns(await cellsOf("abc"))).toBe(3);
    expect(await cellsOf("é")).toEqual([{ chars: "é", width: 1 }]);
    expect(await cellsOf("日本")).toEqual([
      { chars: "日", width: 2 },
      { chars: "本", width: 2 },
    ]);
    expect(columns(await cellsOf("[go-run] 100ms"))).toBe(14);
  });

  it("uses measured advances when the font gives them", async () => {
    const narrow = createMyanmarUnicodeProvider({
      base: () => 0.9,
      mark: ESTIMATED_MYANMAR_ADVANCES.mark,
    });
    // 0.9 + 0.65 + 0.6 = 2.15: the whole syllable fits one two-column cell.
    expect(await cellsOf("အော", narrow)).toEqual([{ chars: "အော", width: 2 }]);
  });

  it("registers under its own version name", () => {
    expect(createMyanmarUnicodeProvider().version).toBe(MYANMAR_UNICODE_VERSION);
  });
});

describe("myanmarClusterRanges", () => {
  it("returns each multi-character Myanmar cluster", () => {
    expect(myanmarClusterRanges("အောင်")).toEqual([
      [0, 3],
      [3, 5],
    ]);
  });

  it("joins a kinzi and a stacked consonant with the letter after the virama", () => {
    // မ င ် ္ ဂ လ ာ ပ ါ
    expect(myanmarClusterRanges("မင်္ဂလာပါ")).toEqual([
      [1, 5],
      [5, 7],
      [7, 9],
    ]);
    expect(myanmarClusterRanges("ဗုဒ္ဓ")).toEqual([
      [0, 2],
      [2, 5],
    ]);
  });

  it("ignores everything that is not a Myanmar cluster", () => {
    expect(myanmarClusterRanges("100ms ok")).toEqual([]);
    // ကျပ်: ကျ, then the final ပ် with its asat.
    expect(myanmarClusterRanges("total ၃၀၀၀ ကျပ်")).toEqual([
      [11, 13],
      [13, 15],
    ]);
  });
});
