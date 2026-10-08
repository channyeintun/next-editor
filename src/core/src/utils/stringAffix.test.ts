import { describe, expect, it } from "vite-plus/test";
import { findCommonAffixLengths, findCommonPrefixJS, findCommonSuffixJS } from "./stringAffix";

describe("stringAffix", () => {
  it("should not treat a shared UTF-8 lead byte as a shared character prefix", () => {
    expect(findCommonPrefixJS("éx", "èy")).toBe(0);
  });

  it("should preserve suffix characters when the differing character is multi-byte", () => {
    expect(findCommonSuffixJS("éa", "ĩa")).toBe(1);
  });

  it("does not end a common prefix inside a surrogate pair", () => {
    // 😀 and 😁 share their high surrogate; the prefix must not keep it alone.
    expect(findCommonPrefixJS("😀", "😁")).toBe(0);
    expect(findCommonPrefixJS("x😁", "x😀😁")).toBe(1);
    expect(findCommonPrefixJS("a😀b", "a😃b")).toBe(1);
    expect(findCommonPrefixJS("😀x", "😀y")).toBe(2);
  });

  it("does not start a common suffix inside a surrogate pair", () => {
    // 😀 (U+1F600) and U+1FA00 share their low surrogate, as do U+20000 and U+10000.
    expect(findCommonSuffixJS("😀", "\u{1FA00}")).toBe(0);
    expect(findCommonSuffixJS("a\u{20000}", "b\u{10000}")).toBe(0);
    expect(findCommonSuffixJS("😀", "😁")).toBe(0);
    expect(findCommonSuffixJS("😁x", "😀😁x")).toBe(3);
    expect(findCommonSuffixJS("x😀", "y😀")).toBe(2);
  });

  it("measures the common suffix after the common prefix so the two never overlap", () => {
    // On its own the common suffix of "aa" and "aaa" is 2, which would overlap the prefix.
    expect(findCommonSuffixJS("aa", "aaa")).toBe(2);
    expect(findCommonAffixLengths("aa", "aaa")).toEqual({ prefix: 2, suffix: 0 });
    expect(findCommonAffixLengths("aaa", "aa")).toEqual({ prefix: 2, suffix: 0 });
    expect(findCommonAffixLengths("same", "same")).toEqual({ prefix: 4, suffix: 0 });
  });

  it("keeps an astral edit in the middle whole at both ends", () => {
    // 😀 (U+1F600) and 😃 share their high surrogate; 😀 and U+1FA00 share their low one.
    expect(findCommonAffixLengths("a😀b", "a😃b")).toEqual({ prefix: 1, suffix: 1 });
    expect(findCommonAffixLengths("x😀y", "x\u{1FA00}y")).toEqual({ prefix: 1, suffix: 1 });
    expect(findCommonAffixLengths("ab😀cd", "ab\u{1FA00}😃cd")).toEqual({ prefix: 2, suffix: 2 });
  });
});
