import { describe, expect, it } from "vite-plus/test";
import { findCommonPrefixJS, findCommonSuffixJS } from "./stringAffix";

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
});
