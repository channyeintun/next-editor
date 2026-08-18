import { describe, expect, it } from "vitest";
import {
  KITE_KEYWORDS,
  KITE_LANGUAGE_ID,
  kiteLanguageConfiguration,
  kiteMonarchLanguage,
} from "./kiteLanguage";
import { createStarterKiteWorkspace } from "../starters/kite";

/**
 * Kite files were coloured with Monaco's Rust grammar, which is close enough
 * to look right and wrong exactly where a Kite lesson lives. These tests pin
 * the differences, so a later "just use rust, it is nearly the same" change
 * fails here rather than quietly dulling every lesson.
 *
 * Monaco is mocked in this environment (see the alias in vite.config.ts), so
 * the tokenizer cannot be run for real; the rules themselves are exercised
 * instead, including against the Kite source this repo actually ships.
 */

type Rule = [RegExp, unknown];

const root = kiteMonarchLanguage.tokenizer.root as unknown[];
const whitespace = kiteMonarchLanguage.tokenizer.whitespace as unknown[];
const stringState = kiteMonarchLanguage.tokenizer.string as unknown[];
const keywords = kiteMonarchLanguage.keywords as string[];
const constants = kiteMonarchLanguage.constants as string[];
const typeKeywords = kiteMonarchLanguage.typeKeywords as string[];

/**
 * The first rule whose pattern matches `text` from the start. A state's array
 * also holds `{ include: … }` entries, which are not rules and are skipped.
 */
function ruleFor(rules: unknown[], text: string): Rule | undefined {
  return rules.find((rule): rule is Rule => {
    if (!Array.isArray(rule)) return false;
    const pattern = rule[0];
    if (!(pattern instanceof RegExp)) return false;
    const anchored = new RegExp(`^(?:${pattern.source})`, pattern.flags.replace("g", ""));
    return anchored.test(text);
  });
}

describe("kite monarch grammar", () => {
  it("registers under the id inferLanguageFromPath returns for .kite", () => {
    expect(KITE_LANGUAGE_ID).toBe("kite");
  });

  it("lists exactly the 27 reserved keywords the language has", () => {
    // The count is fixed by a test in the compiler's own lexer crate. A 28th
    // entry here would mean colouring an ordinary identifier as syntax.
    expect(KITE_KEYWORDS).toHaveLength(27);
    expect([...KITE_KEYWORDS].sort()).toEqual([
      "as",
      "async",
      "await",
      "break",
      "check",
      "continue",
      "defer",
      "else",
      "enum",
      "false",
      "fn",
      "for",
      "if",
      "impl",
      "in",
      "let",
      "match",
      "nil",
      "pub",
      "return",
      "self",
      "struct",
      "trait",
      "true",
      "type",
      "use",
      "var",
    ]);
  });

  it.each(["var", "check", "defer", "nil", "use", "impl", "trait", "match"])(
    "knows the Kite keyword %s that the Rust grammar left plain",
    (keyword) => {
      expect(keywords).toContain(keyword);
    },
  );

  it("does not reserve the contextual words, which may name a binding", () => {
    // `let error = 5` and `let dyn = 6` both compile.
    for (const word of ["dyn", "error", "extern"]) {
      expect(KITE_KEYWORDS).not.toContain(word);
    }
    // They still read as types where a type is expected, which is almost always.
    expect(typeKeywords).toEqual(expect.arrayContaining(["dyn", "error"]));
  });

  it("colours true, false and nil as values rather than syntax", () => {
    expect(constants).toEqual(["true", "false", "nil"]);
    // Still reserved — the census above must stay complete.
    for (const value of constants) expect(KITE_KEYWORDS).toContain(value);
  });

  it("configures no block comment, because writing one is E0005", () => {
    expect(kiteLanguageConfiguration.comments).toEqual({ lineComment: "//" });
    expect(kiteLanguageConfiguration.comments).not.toHaveProperty("blockComment");
  });

  it("treats /// and //! as documentation, not as an ordinary comment", () => {
    // A ```kite fence inside /// is compiled and run by `kitec test`.
    expect(ruleFor(whitespace, "/// Documentation.")?.[1]).toBe("comment.doc");
    expect(ruleFor(whitespace, "//! Module documentation.")?.[1]).toBe("comment.doc");
    expect(ruleFor(whitespace, "// Ordinary.")?.[1]).toBe("comment");
  });

  it("never reads a single-quoted run as a value, because there is no char type", () => {
    // Rust's grammar colours 'a' as a character literal. In Kite it lexes and
    // then fails to type, so showing it as a value teaches the wrong thing.
    expect(ruleFor(root, "'a'")).toBeUndefined();
  });

  it("opens an interpolation hole inside a string", () => {
    // "\(expr)" is how Kite prints nearly everything; under the Rust grammar
    // the whole hole vanished into the string.
    const hole = ruleFor(stringState, "\\(name)");
    expect(hole).toBeDefined();
    expect(hole?.[1]).toMatchObject({ next: "@interpolation" });
    // And the hole's body is tokenized as code, including a nested string.
    expect(kiteMonarchLanguage.tokenizer.interpolation).toBeDefined();
    expect(kiteMonarchLanguage.tokenizer.interpolationBody).toBeDefined();
  });

  it("matches every number form the lexer accepts, and no suffix", () => {
    for (const literal of ["0xFF", "0o755", "0b1010_1101", "1_000_000", "3.14", "1.5e-3"]) {
      expect(ruleFor(root, literal), `number literal ${literal}`).toBeDefined();
    }
    // `42i64` is E0004. The number rule must stop at 42 and leave `i64` to the
    // identifier rule rather than swallowing the suffix as part of the number.
    const numberRule = ruleFor(root, "42i64");
    expect(numberRule).toBeDefined();
    const numberPattern = numberRule?.[0] as RegExp;
    const anchored = new RegExp(`^(?:${numberPattern.source})`);
    expect("42i64".match(anchored)?.[0]).toBe("42");
  });

  it("accepts non-Latin identifiers, which the language allows", () => {
    const identifier = kiteMonarchLanguage.identifier as RegExp;
    const anchored = new RegExp(`^(?:${identifier.source})`);
    expect(anchored.test("座標")).toBe(true);
    expect(anchored.test("café")).toBe(true);
    expect(anchored.test("นาม")).toBe(true);
  });

  it("classifies every keyword in the Kite starter this repo ships", () => {
    // The strongest available check without a live tokenizer: take real Kite
    // source, pull the words the identifier rule would produce, and confirm
    // each reserved one is in the keyword list rather than falling through to
    // `identifier`.
    const file = createStarterKiteWorkspace().files["main.kite"];
    // A workspace file's content is text or an asset descriptor; the starter's
    // entry is text, and reading it as such is the point of the check.
    const source = typeof file.content === "string" ? file.content : "";
    expect(source.length).toBeGreaterThan(0);
    const identifier = kiteMonarchLanguage.identifier as RegExp;
    const words: string[] = source.match(new RegExp(identifier.source, "g")) ?? [];

    const present = KITE_KEYWORDS.filter((keyword) => words.includes(keyword));
    // The starter is a real program, so it exercises a decent slice of them.
    expect(present.length).toBeGreaterThanOrEqual(8);
    expect(present).toEqual(
      expect.arrayContaining(["fn", "let", "struct", "impl", "return", "if"]),
    );

    for (const keyword of present) {
      expect(keywords, `${keyword} would render as a plain identifier`).toContain(keyword);
    }
  });
});
