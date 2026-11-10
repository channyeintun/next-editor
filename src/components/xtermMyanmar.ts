import type { IDisposable, IUnicodeVersionProvider, Terminal } from "@xterm/xterm";

/**
 * Burmese text in a passive xterm (runner and process output).
 *
 * xterm lays text out in a grid of cells and gives most Myanmar characters a
 * cell each, including the vowel signs and medials that the script draws
 * around their consonant. Each cell is then drawn as its own run of text, so
 * the browser never shapes the syllable: ေ shows after its consonant instead
 * of before it, medials float apart, and kinzi and stacked consonants break.
 *
 * Two pieces fix that while keeping the grid that the pointer anchors and
 * console points measure against (xtermCellAnchor, the studio driver):
 *
 * - a Unicode width provider that keeps each Myanmar cluster (a base letter,
 *   its marks, and a consonant stacked after ္) in as few cells as it is wide
 *   when drawn, measured in the terminal's own font — up to two cells in one
 *   cell, and a new cell only when a cluster needs a third;
 * - a character joiner that hands every cluster to the renderer as one piece
 *   of text, so the browser shapes it, even when it spans two cells.
 *
 * Everything that is not Myanmar keeps xterm's default (Unicode 6) widths.
 */

/** The version name the provider registers under. */
export const MYANMAR_UNICODE_VERSION = "6-myanmar";

const MYANMAR_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1000, 0x109f], // Myanmar
  [0xa9e0, 0xa9ff], // Myanmar Extended-B
  [0xaa60, 0xaa7f], // Myanmar Extended-A
];

export function isMyanmarCodePoint(codePoint: number): boolean {
  return MYANMAR_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
}

const MARK = /\p{M}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const VIRAMA = 0x1039;
const ASAT = 0x103a;
const NGA = 0x1004;

const isMark = (codePoint: number) => MARK.test(String.fromCodePoint(codePoint));
const isLetterOrDigit = (codePoint: number) =>
  LETTER_OR_DIGIT.test(String.fromCodePoint(codePoint));

/** How wide each Myanmar character draws, in cells of the terminal's font. */
export interface MyanmarAdvances {
  /** A base letter, digit or sign on its own. */
  base(codePoint: number): number;
  /** What a mark adds to the width of the cluster it joins. */
  mark(codePoint: number): number;
}

/**
 * Widths when the font cannot be measured (tests, a browser without canvas):
 * typical of the common Myanmar fonts at a monospace cell.
 */
export const ESTIMATED_MYANMAR_ADVANCES: MyanmarAdvances = {
  base: () => 1.25,
  mark: (codePoint) => {
    switch (codePoint) {
      case 0x1031: // ေ
        return 0.65;
      case 0x102b: // ါ
      case 0x102c: // ာ
        return 0.6;
      case 0x1038: // း
      case 0x103b: // ျ
      case 0x103c: // ြ
        return 0.35;
      default:
        return /\p{Mc}/u.test(String.fromCodePoint(codePoint)) ? 0.5 : 0;
    }
  },
};

/**
 * Measures the advances in the terminal's own font: a mark as the width it
 * adds to က, which is how the font spaces it in a real syllable (a lone mark
 * would be drawn on a dotted circle).
 */
export function measureMyanmarAdvances(fontFamily: string, fontSize: number): MyanmarAdvances {
  const context =
    typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!context) return ESTIMATED_MYANMAR_ADVANCES;
  context.font = `${fontSize}px ${fontFamily}`;
  const cell = context.measureText("W").width;
  const ka = context.measureText("က").width;
  if (!(cell > 0) || !(ka > 0)) return ESTIMATED_MYANMAR_ADVANCES;
  const bases = new Map<number, number>();
  const marks = new Map<number, number>();
  return {
    base(codePoint) {
      let advance = bases.get(codePoint);
      if (advance === undefined) {
        advance = context.measureText(String.fromCodePoint(codePoint)).width / cell;
        bases.set(codePoint, advance);
      }
      return advance;
    },
    mark(codePoint) {
      let advance = marks.get(codePoint);
      if (advance === undefined) {
        const width = context.measureText(`က${String.fromCodePoint(codePoint)}`).width;
        advance = Math.max(0, width - ka) / cell;
        marks.set(codePoint, advance);
      }
      return advance;
    },
  };
}

// ---- The width provider ----------------------------------------------------
//
// xterm asks the provider for each code point's properties, given the
// properties of the one before it, in UnicodeService's packed layout:
// state << 3 | width << 1 | shouldJoin. A joined code point is added to the
// previous cell, whose width becomes the returned width (at most 2).
//
// The 24 state bits carry the cluster: flags in the low five bits, and the
// width drawn so far inside the current cell, in 1/32 of a cell, above them.

const IN_CLUSTER = 1;
const AFTER_VIRAMA = 2;
/** The cluster so far is a lone nga. */
const NGA_START = 4;
/** After the ္ of a kinzi: the next consonant is the full-width base. */
const KINZI = 8;
/** The cluster so far is nga + asat: a ္ next makes it kinzi. */
const NGA_ASAT = 16;
const ADVANCE_SHIFT = 5;
const ADVANCE_UNIT = 32;
const MAX_ADVANCE = (1 << (24 - ADVANCE_SHIFT)) - 1;

const packed = (state: number, width: number, join: boolean) =>
  ((state & 0xffffff) << 3) | ((width & 3) << 1) | (join ? 1 : 0);
const widthOf = (properties: number) => (properties >> 1) & 3;
const stateOf = (properties: number) => properties >>> 3;
const advanceOf = (state: number) => (state >>> ADVANCE_SHIFT) / ADVANCE_UNIT;
const withAdvance = (flags: number, advance: number) =>
  flags | (Math.min(MAX_ADVANCE, Math.round(advance * ADVANCE_UNIT)) << ADVANCE_SHIFT);
/** Cells a drawn width needs; a cell holding a letter is never narrower than 1. */
const cellsFor = (advance: number) => Math.max(1, Math.round(advance));

// Unicode 6 widths, as xterm's default provider has them, for everything else.
const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Cf}]/u;
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3040, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function defaultWidth(codePoint: number): 0 | 1 | 2 {
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (codePoint < 0x300) return 1;
  if (ZERO_WIDTH.test(String.fromCodePoint(codePoint))) return 0;
  if (codePoint >= 0x1160 && codePoint <= 0x11ff) return 0; // Hangul medial vowels and finals
  return WIDE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high) ? 2 : 1;
}

export function createMyanmarUnicodeProvider(
  advances: MyanmarAdvances = ESTIMATED_MYANMAR_ADVANCES,
): IUnicodeVersionProvider {
  return {
    version: MYANMAR_UNICODE_VERSION,
    wcwidth(codePoint) {
      if (!isMyanmarCodePoint(codePoint)) return defaultWidth(codePoint);
      if (isMark(codePoint)) return 0;
      return cellsFor(advances.base(codePoint)) as 1 | 2;
    },
    charProperties(codePoint, preceding) {
      const state = stateOf(preceding);
      if (isMyanmarCodePoint(codePoint)) {
        const mark = isMark(codePoint);
        const inCluster = (state & IN_CLUSTER) !== 0;
        if (inCluster && (mark || ((state & AFTER_VIRAMA) !== 0 && isLetterOrDigit(codePoint)))) {
          let flags = IN_CLUSTER;
          let drawn = advanceOf(state);
          let adds: number;
          if (codePoint === VIRAMA) {
            flags |= AFTER_VIRAMA;
            // Nga + asat + virama is kinzi: the nga is drawn above the next
            // consonant and takes no width of its own.
            if ((state & NGA_ASAT) !== 0) {
              flags |= KINZI;
              drawn = 0;
            }
            adds = 0;
          } else if (mark) {
            if (codePoint === ASAT && (state & NGA_START) !== 0) flags |= NGA_ASAT;
            adds = advances.mark(codePoint);
          } else {
            // The consonant after a virama: the base itself after kinzi,
            // otherwise a subscript drawn under the previous letter.
            adds = (state & KINZI) !== 0 ? advances.base(codePoint) : 0;
          }
          const next = drawn + adds;
          if (cellsFor(next) <= 2) {
            return packed(
              withAdvance(flags, next),
              Math.max(widthOf(preceding), cellsFor(next)),
              true,
            );
          }
          // Wider than two cells: this character starts the cluster's next
          // cell (the joiner still draws the cluster as one piece).
          return packed(withAdvance(flags, adds), Math.min(2, cellsFor(adds)), false);
        }
        if (!mark) {
          const drawn = advances.base(codePoint);
          const flags = IN_CLUSTER | (codePoint === NGA ? NGA_START : 0);
          return packed(withAdvance(flags, drawn), Math.min(2, cellsFor(drawn)), false);
        }
      }
      // xterm's default rule: a zero-width code point joins the cell before it.
      let width: number = defaultWidth(codePoint);
      let join = width === 0 && preceding !== 0;
      if (join) {
        const previousWidth = widthOf(preceding);
        if (previousWidth === 0) join = false;
        else width = Math.max(width, previousWidth);
      }
      return packed(0, width, join);
    },
  };
}

// ---- The joiner ---------------------------------------------------------------

/**
 * The string ranges of the Myanmar clusters in `text` that are longer than
 * one code unit: a base letter followed by its marks, and by a consonant after
 * each ္ (kinzi and stacked consonants).
 */
export function myanmarClusterRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let start = -1;
  let afterVirama = false;
  let index = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    const myanmar = isMyanmarCodePoint(codePoint);
    const mark = myanmar && isMark(codePoint);
    const continues =
      start >= 0 && myanmar && (mark || (afterVirama && isLetterOrDigit(codePoint)));
    if (!continues) {
      if (start >= 0 && index - start > 1) ranges.push([start, index]);
      start = myanmar && !mark ? index : -1;
    }
    afterVirama = codePoint === VIRAMA;
    index += character.length;
  }
  if (start >= 0 && index - start > 1) ranges.push([start, index]);
  return ranges;
}

/**
 * Turns on the Myanmar width provider and cluster joiner for one terminal.
 * The terminal must be created with `allowProposedApi: true`.
 */
export function enableMyanmarText(
  terminal: Terminal,
  font: { family: string; size: number },
): IDisposable {
  terminal.unicode.register(
    createMyanmarUnicodeProvider(measureMyanmarAdvances(font.family, font.size)),
  );
  terminal.unicode.activeVersion = MYANMAR_UNICODE_VERSION;
  const joiner = terminal.registerCharacterJoiner(myanmarClusterRanges);
  return { dispose: () => terminal.deregisterCharacterJoiner(joiner) };
}
