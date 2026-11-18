// @vitest-environment node
// Widths as real Node v26 (with ICU) reports them:
// `node --expose-internals -p "require('internal/util/inspect').getStringWidth(s)"`.
import { describe, expect, it } from "vitest";
import { getStringWidth } from "./stringWidth";

describe("getStringWidth", () => {
  const widths: [string, number][] = [
    ["", 0],
    ["abc", 3],
    ["\x1b[33m1\x1b[39m", 1],
    ["'မောင်မောင်'", 10],
    ["ကျွန်တော်", 6],
    ["ဗမာစာ", 5],
    ["नमस्ते", 4],
    ["日本語", 6],
    ["ｆｕｌｌ", 8],
    ["한국어", 6],
    ["é", 1],
    ["a​b", 2],
    ["a­b", 3],
    ["กำ", 2],
    ["😀", 2],
    ["👍🏽", 4],
    ["👨‍👩‍👧", 6],
    ["🇲🇲", 4],
    ["☺", 1],
    ["☺️", 1],
    ["✅", 2],
    ["⌚", 2],
    ["→", 1],
    ["①", 1],
    ["　", 2],
    ["\t", 0],
    ["\x7f", 0],
    [" ", 1],
    ["x̶", 1],
    ["\ud83d", 1],
    // A mark that is East Asian Wide counts as wide, not as a mark.
    ["゙", 2],
    // A format character, an enclosing mark, a variation selector.
    ["﻿", 0],
    ["⃣", 0],
    ["️", 0],
    // Not assigned, private use: one column.
    ["͸", 1],
    ["", 1],
    // Composed before it is counted: three code points after NFC.
    ["\u{1d160}", 3],
  ];

  it.each(widths)("counts %j as %d columns", (text, width) => {
    expect(getStringWidth(text)).toBe(width);
  });

  it("counts escape sequences when asked to keep them", () => {
    expect(getStringWidth("\x1b[33m1\x1b[39m", false)).toBe(9);
  });
});
