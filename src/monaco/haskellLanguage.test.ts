import { describe, expect, it } from "vitest";
import {
  HASKELL_LANGUAGE_ID,
  haskellLanguageConfiguration,
  haskellMonarchLanguage,
} from "./haskellLanguage";
import { inferLanguageFromPath } from "../types/workspace";

/**
 * The grammar exists because Monaco ships no Haskell basic-language at all —
 * without it a lesson's Main.hs renders as plaintext. These tests pin the three
 * rules that are easy to write wrongly (the dash operators, the nesting block
 * comment, the primes on identifiers), so a later "simplify this" pass fails
 * here instead of quietly greying out live code in every lesson.
 */

const keywords = haskellMonarchLanguage.keywords as string[];
const types = haskellMonarchLanguage.typeKeywords as string[];
const rootRules = haskellMonarchLanguage.tokenizer.root as unknown[];
const whitespaceRules = haskellMonarchLanguage.tokenizer.whitespace as [RegExp, unknown][];
const blockCommentRules = haskellMonarchLanguage.tokenizer.blockComment as [RegExp, unknown][];

/** The rule in `whitespace` whose action is exactly this token, as a string. */
function whitespacePatternFor(token: string): RegExp {
  const rule = whitespaceRules.find(([, action]) => action === token);

  expect(rule).toBeDefined();
  return rule![0];
}

/**
 * The first rule of a state whose pattern matches `text` from the cursor —
 * which is the only thing that decides a token, since Monarch is first-match
 * wins. Monarch compiles a leading `^` into "only try this at column 0", so
 * `atLineStart` is what tells a gap continuation apart from mid-line text.
 */
function ruleFor(
  rules: unknown[],
  text: string,
  atLineStart = false,
): [RegExp, unknown] | undefined {
  return rules.find((rule): rule is [RegExp, unknown] => {
    if (!Array.isArray(rule)) return false;
    const pattern = rule[0];
    if (!(pattern instanceof RegExp)) return false;
    if (pattern.source.startsWith("^") && !atLineStart) return false;
    const expanded = pattern.source.replace(/@(\w+)/g, (whole, attribute: string) => {
      const value = (haskellMonarchLanguage as Record<string, unknown>)[attribute];
      return value instanceof RegExp ? `(?:${value.source})` : whole;
    });
    return new RegExp(`^(?:${expanded})`).test(text);
  });
}

/** The first rule in `root` whose action is exactly this token, as a string. */
function rootPatternFor(token: string): RegExp {
  const rule = rootRules.find((entry) => Array.isArray(entry) && entry[1] === token) as
    | [RegExp, string]
    | undefined;

  expect(rule).toBeDefined();
  return rule![0];
}

describe("haskell monarch grammar", () => {
  it("registers under the id inferLanguageFromPath returns for Main.hs", () => {
    expect(HASKELL_LANGUAGE_ID).toBe("haskell");
    expect(inferLanguageFromPath("Main.hs")).toBe(HASKELL_LANGUAGE_ID);
  });

  it.each([
    "module",
    "import",
    "where",
    "let",
    "in",
    "do",
    "case",
    "of",
    "if",
    "then",
    "else",
    "data",
    "newtype",
    "type",
    "class",
    "instance",
    "deriving",
    "infix",
    "infixl",
    "infixr",
    "foreign",
    "forall",
    "mdo",
    "rec",
    "proc",
    "_",
  ])("knows the Haskell keyword %s", (keyword) => {
    expect(keywords).toContain(keyword);
  });

  it("leaves as, qualified and hiding out of the keywords", () => {
    // They are keywords only inside an import line and ordinary names
    // everywhere else — `as` is what a list of `a`s is always called, so
    // colouring `map f as` as syntax would be the worse mistake.
    expect(keywords).not.toContain("as");
    expect(keywords).not.toContain("qualified");
    expect(keywords).not.toContain("hiding");
  });

  it("knows the Prelude types a lesson names out loud", () => {
    expect(types).toEqual(
      expect.arrayContaining(["Int", "Integer", "Double", "Bool", "Char", "String", "Maybe", "IO"]),
    );
  });

  it("keeps True and False out of both lists", () => {
    // Haskell has no boolean literal: both are ordinary constructors of Bool,
    // coloured by the constructor rule like `Just` or a lesson's own type.
    for (const list of [keywords, types]) {
      expect(list).not.toContain("True");
      expect(list).not.toContain("False");
    }
  });

  it("declares both comment forms, unlike Zig's line-only config", () => {
    expect(haskellLanguageConfiguration.comments).toEqual({
      lineComment: "--",
      blockComment: ["{-", "-}"],
    });
  });

  it("does not auto-close a single quote, because a prime is part of a name", () => {
    // `go'` and `acc'` are ordinary Haskell names, so auto-closing would leave
    // a stray quote on every recursive helper. Surrounding a selection is fine.
    const autoClosingPairs = haskellLanguageConfiguration.autoClosingPairs ?? [];
    const surroundingPairs = haskellLanguageConfiguration.surroundingPairs ?? [];

    expect(autoClosingPairs.some((pair) => pair.open === "'")).toBe(false);
    expect(surroundingPairs.some((pair) => pair.open === "'")).toBe(true);
  });

  it("starts a line comment on dashes, but not on an operator made of them", () => {
    const lineComment = whitespacePatternFor("comment");

    expect(lineComment.test("-- a note")).toBe(true);
    expect(lineComment.test("--")).toBe(true);
    // A rule of dashes is still a comment; `-->` and `--|` are operators a
    // lesson may define, and greying out their lines would hide real code.
    expect(lineComment.test("------------")).toBe(true);
    expect(lineComment.test("-->")).toBe(false);
    expect(lineComment.test("--|")).toBe(false);
    // The one that catches a lazy lookahead: without `-` in it, this backtracks
    // to the first two dashes, sees a third, and calls the operator a comment.
    expect(lineComment.test("--->")).toBe(false);
    expect(lineComment.test("x - y")).toBe(false);
  });

  it("treats -- | as documentation rather than a plain comment", () => {
    const haddock = whitespacePatternFor("comment.doc");

    expect(haddock.test("-- | The area of a shape.")).toBe(true);
    expect(haddock.test("-- ^ in radians")).toBe(true);
    expect(haddock.test("-- ordinary note")).toBe(false);
  });

  it("nests block comments instead of ending at the first -}", () => {
    // `{- outer {- inner -} still outer -}` is one comment. A flat pair pops on
    // the inner `-}` and tokenizes the rest of a commented-out block as code.
    const opener = blockCommentRules.find(
      ([, action]) => typeof action === "object" && (action as { next?: string }).next === "@push",
    );
    const closer = blockCommentRules.find(
      ([, action]) => typeof action === "object" && (action as { next?: string }).next === "@pop",
    );

    expect(opener).toBeDefined();
    expect(closer).toBeDefined();
    expect(opener![0].test("{-")).toBe(true);
    expect(closer![0].test("-}")).toBe(true);
  });

  it("matches identifiers before character literals so primes survive", () => {
    // `f x' = x'` must not read as a half-open `'...'` swallowing the line.
    const identifierIndex = rootRules.findIndex(
      (rule) => Array.isArray(rule) && String(rule[0]) === String(/[a-z_][\w']*/),
    );
    const charIndex = rootRules.findIndex(
      (rule) => Array.isArray(rule) && String(rule[0]) === String(/'[^\\']'/),
    );

    expect(identifierIndex).toBeGreaterThanOrEqual(0);
    expect(charIndex).toBeGreaterThan(identifierIndex);
  });

  it("reads a qualified name as one token, not a composition", () => {
    // The module separator and the `.` operator are the same character, so
    // `Data.Map.insert` has to be matched whole or it tokenizes as three names
    // joined by function composition.
    const qualified = rootPatternFor("identifier");

    // Matched WHOLE, not merely somewhere inside: a rule that lost its
    // multi-segment support would still find `Map.insert` in the middle of
    // `Data.Map.insert` and pass an unanchored test, which is the regression
    // this case exists to catch.
    expect(qualified.exec("Data.Map.insert")?.[0]).toBe("Data.Map.insert");
    expect(qualified.exec("T.pack")?.[0]).toBe("T.pack");
  });

  it("keeps the range dots out of a fractional literal", () => {
    // `[1..5]` must tokenize as 1, .., 5 — a float rule that allows a trailing
    // dot swallows `1.` and leaves `.5` behind.
    const float = rootPatternFor("number.float");

    expect(float.test("3.14")).toBe(true);
    expect(float.test("6.022e23")).toBe(true);
    expect(float.test("1.")).toBe(false);
  });

  it("spans a string gap on both of its lines, indented or not", () => {
    // A gap splices one literal across lines with a trailing backslash and a
    // leading one: `"abc\` … `  \def"`. Both halves need a rule, and the
    // resuming half has to beat the `[^\\"]+` catch-all: it is `^`-anchored, so
    // once the catch-all has taken the continuation line's indentation the
    // cursor is off column 0 and the rule can never run — the backslash then
    // renders as a bad escape over perfectly legal code, which is exactly what
    // the rule exists to prevent. Asserting rule order alone missed that.
    const stringRules = haskellMonarchLanguage.tokenizer.string as unknown[];

    expect(ruleFor(stringRules, '  \\def"', true)?.[1]).toBe("string.escape");
    expect(ruleFor(stringRules, '\\def"', true)?.[1]).toBe("string.escape");
    // The opening half, at the end of the line that starts the gap.
    expect(ruleFor(stringRules, "\\   ")?.[1]).toBe("string.escape");
    // Mid-line a backslash is still an escape, good or bad.
    expect(ruleFor(stringRules, "\\n rest")?.[1]).toBe("string.escape");
    expect(ruleFor(stringRules, "\\q rest")?.[1]).toBe("string.escape.invalid");
  });

  it("ends an unterminated string at the line, without breaking a gap", () => {
    // Delete a closing quote and, with no guard, the string state carries onto
    // every following line: the type signatures and the data declaration below
    // it all render as one literal until another quote turns up.
    expect(ruleFor(rootRules, '"Sign-in log')?.[1]).toBe("string.invalid");
    expect(ruleFor(rootRules, '"a\\n b')?.[1]).toBe("string.invalid");

    // But a gap opener is a string that legitimately continues on the next
    // line, so it must still reach the rule that enters @string — including
    // the spelling with blanks after the backslash, which is legal too.
    for (const line of ['"hello \\', '"hello \\   ', '"hello \\\t', '"closed"']) {
      // The line travels inside the assertion so a failure names which spelling broke.
      expect({ line, action: ruleFor(rootRules, line)?.[1] }).toMatchObject({
        line,
        action: { next: "@string" },
      });
    }
  });
});
