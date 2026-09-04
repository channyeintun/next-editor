import { describe, expect, it } from "vitest";
import { ZIG_LANGUAGE_ID, zigLanguageConfiguration, zigMonarchLanguage } from "./zigLanguage";
import { inferLanguageFromPath } from "../types/workspace";

/**
 * The grammar exists because borrowing Monaco's Rust grammar — the shortcut
 * `.kite` took before monaco/kiteLanguage.ts existed — leaves the words that
 * carry the most meaning in Zig unhighlighted. These tests pin exactly that
 * gap, so a later "simplify this, just use rust" change fails here instead of
 * quietly dulling every lesson.
 *
 * Monaco is mocked in this environment (see the alias in vite.config.ts), so
 * the tokenizer cannot be run for real; the rules are matched the way Monarch
 * matches them instead — anchored at the cursor, first rule wins. That is the
 * property most of these rules depend on: `u8` is only a type because the
 * sized-integer rule is tried before the identifier rule.
 */

type Rule = [RegExp, unknown];

const keywords = zigMonarchLanguage.keywords as string[];
const constants = zigMonarchLanguage.constants as string[];
const types = zigMonarchLanguage.typeKeywords as string[];
const operators = zigMonarchLanguage.operators as string[];
const root = zigMonarchLanguage.tokenizer.root as unknown[];
const whitespace = zigMonarchLanguage.tokenizer.whitespace as unknown[];

/**
 * Monarch substitutes an `@name` reference with that attribute's source before
 * compiling, so a rule written against `@escapes` only matches once the macro
 * is expanded the same way.
 */
function expand(source: string): string {
  return source.replace(/@(\w+)/g, (whole, attribute: string) => {
    const value = (zigMonarchLanguage as Record<string, unknown>)[attribute];
    return value instanceof RegExp ? `(?:${value.source})` : whole;
  });
}

/** The first rule whose pattern matches `text` from the cursor. */
function ruleFor(rules: unknown[], text: string): Rule | undefined {
  return rules.find((rule): rule is Rule => {
    if (!Array.isArray(rule)) return false;
    const pattern = rule[0];
    if (!(pattern instanceof RegExp)) return false;
    return new RegExp(`^(?:${expand(pattern.source)})`).test(text);
  });
}

describe("zig monarch grammar", () => {
  it("registers under the id inferLanguageFromPath returns for .zig", () => {
    expect(ZIG_LANGUAGE_ID).toBe("zig");
    expect(inferLanguageFromPath("main.zig")).toBe(ZIG_LANGUAGE_ID);
    expect(inferLanguageFromPath("build.zig.zon")).toBe(ZIG_LANGUAGE_ID);
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
    // i0..i65535 and u0..u65535 are a family; listing them is impossible. The
    // rule only wins because it is tried before the identifier rule — moving
    // the identifier rule up leaves the whole family rendering as plain names
    // while an index-based assertion still passes.
    expect(ruleFor(root, "u8")?.[1]).toBe("keyword.type");
    expect(ruleFor(root, "i128")?.[1]).toBe("keyword.type");
    expect(ruleFor(root, "u3")?.[1]).toBe("keyword.type");
  });

  it("tokenizes @builtins as their own token class", () => {
    expect(ruleFor(root, "@import")?.[1]).toBe("keyword.builtin");
    expect(ruleFor(root, "@TypeOf")?.[1]).toBe("keyword.builtin");
  });

  it("treats a multiline-string line as a string, not a comment", () => {
    // Zig's \\ multiline strings sit where other languages put a comment
    // marker; getting this wrong greys out whole blocks of a lesson's code.
    expect(ruleFor(whitespace, "\\\\hello world")?.[1]).toBe("string");
    // And a doc comment must beat the ordinary comment rule that follows it.
    expect(ruleFor(whitespace, "/// A doc comment.")?.[1]).toBe("comment.doc");
    expect(ruleFor(whitespace, "//! Module docs.")?.[1]).toBe("comment.doc");
    expect(ruleFor(whitespace, "// Ordinary.")?.[1]).toBe("comment");
  });

  it("reads the non-decimal number bases before the decimal one", () => {
    expect(ruleFor(root, "0xFF")?.[1]).toBe("number.hex");
    expect(ruleFor(root, "0o755")?.[1]).toBe("number.octal");
    expect(ruleFor(root, "0b1010_1010")?.[1]).toBe("number.binary");
    expect(ruleFor(root, "1_000")?.[1]).toBe("number");
  });

  it("knows the compound assignments, which are matched whole", () => {
    // `symbols` takes a run of operator characters greedily and the case guard
    // tests the entire run, so `+=` is looked up as "+=" and never split into
    // `+` and `=`. Missing it leaves the commonest line in a loop body — the
    // accumulator update — rendering with no operator colour at all.
    expect(operators).toEqual(
      expect.arrayContaining([
        "+=",
        "-=",
        "*=",
        "/=",
        "%=",
        "&=",
        "|=",
        "^=",
        "<<=",
        ">>=",
        "<<|=",
        "+%=",
        "-%=",
        "*%=",
        "+|=",
        "-|=",
        "*|=",
        "||",
      ]),
    );
  });

  it("keeps the word operators out of the symbol list", () => {
    // `symbols` has no letters in it, so `and`/`or` could never reach this
    // guard; they are keywords, and listing them here only misleads.
    const symbols = zigMonarchLanguage.symbols as RegExp;

    for (const word of ["and", "or"]) {
      expect(symbols.test(word)).toBe(false);
      expect(operators).not.toContain(word);
      expect(keywords).toContain(word);
    }
  });

  it("reads a char literal with a multi-character escape", () => {
    // `'\x41'` and `'\u{1F600}'` are ordinary Zig. A rule that allows only one
    // character after the backslash leaves the quotes unstyled and `x41` as an
    // identifier, on a line that compiles fine.
    const charRule = ruleFor(root, "'\\x41'");

    expect(charRule?.[1]).toBe("string");
    expect(ruleFor(root, "'\\u{1F600}'")?.[1]).toBe("string");
    expect(ruleFor(root, "'a'")?.[1]).toBe("string");
    expect(ruleFor(root, "'\\n'")?.[1]).toBe("string");
  });

  it("ends an unterminated string at the line, instead of leaking the state", () => {
    // Zig `"` strings are single-line. Without the guard, deleting a closing
    // quote carries the string state onto every following line and colours the
    // rest of the file as one literal while the quote is being retyped.
    expect(ruleFor(root, '"Sign-in log')?.[1]).toBe("string.invalid");
    expect(ruleFor(root, '"escaped \\" still open')?.[1]).toBe("string.invalid");
    // A closed literal still opens the string state as before.
    expect(ruleFor(root, '"closed");')?.[1]).toMatchObject({ next: "@string" });
  });
});
