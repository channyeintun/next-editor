import { describe, expect, it } from "vitest";
import { ZIG_LANGUAGE_ID, zigLanguageConfiguration, zigMonarchLanguage } from "./zigLanguage";

/**
 * The grammar exists because borrowing Monaco's Rust grammar — the shortcut
 * `.kite` takes — leaves the words that carry the most meaning in Zig
 * unhighlighted. These tests pin exactly that gap, so a later "simplify this,
 * just use rust" change fails here instead of quietly dulling every lesson.
 */

const keywords = zigMonarchLanguage.keywords as string[];
const constants = zigMonarchLanguage.constants as string[];
const types = zigMonarchLanguage.typeKeywords as string[];

describe("zig monarch grammar", () => {
  it("registers under the id inferLanguageFromPath returns for .zig", () => {
    expect(ZIG_LANGUAGE_ID).toBe("zig");
  });

  it.each([
    "comptime",
    "defer",
    "errdefer",
    "orelse",
    "catch",
    "try",
    "switch",
    "test",
    "var",
    "unreachable",
    "inline",
    "anytype",
    "pub",
    "fn",
    "struct",
    "enum",
    "union",
  ])("knows the Zig keyword %s", (keyword) => {
    expect(keywords).toContain(keyword);
  });

  it("treats undefined and null as language constants, not identifiers", () => {
    // `undefined` is a real value in Zig (`var buf: [8]u8 = undefined`), which
    // is exactly the kind of line a memory lesson puts on screen.
    expect(constants).toEqual(expect.arrayContaining(["true", "false", "null", "undefined"]));
  });

  it("knows the primitive types a lesson names out loud", () => {
    expect(types).toEqual(expect.arrayContaining(["usize", "void", "bool", "type", "anyerror"]));
  });

  it("has no line comment other than //, because Zig has none", () => {
    expect(zigLanguageConfiguration.comments).toEqual({ lineComment: "//" });
    expect(zigLanguageConfiguration.comments).not.toHaveProperty("blockComment");
  });

  it("matches sized integer types by rule rather than by list", () => {
    // i0..i65535 and u0..u65535 are a family; listing them is impossible.
    const [pattern] = zigMonarchLanguage.tokenizer.root[0] as [RegExp, string];

    expect(pattern.test("u8")).toBe(true);
    expect(pattern.test("i128")).toBe(true);
    expect(pattern.test("u3")).toBe(true);
  });

  it("tokenizes @builtins as their own token class", () => {
    const builtinRule = zigMonarchLanguage.tokenizer.root.find(
      (rule) => Array.isArray(rule) && String(rule[1]) === "keyword.builtin",
    ) as [RegExp, string];

    expect(builtinRule).toBeDefined();
    expect(builtinRule[0].test("@import")).toBe(true);
    expect(builtinRule[0].test("@TypeOf")).toBe(true);
  });

  it("treats a multiline-string line as a string, not a comment", () => {
    // Zig's \\ multiline strings sit where other languages put a comment
    // marker; getting this wrong greys out whole blocks of a lesson's code.
    const rule = (zigMonarchLanguage.tokenizer.whitespace as [RegExp, string][]).find(
      ([, token]) => token === "string",
    );

    expect(rule).toBeDefined();
    expect(rule?.[0].test("\\\\hello world")).toBe(true);
  });
});
