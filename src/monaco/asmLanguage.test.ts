import { describe, expect, it } from "vitest";
import { ASM_LANGUAGE_ID, asmLanguageConfiguration, asmMonarchLanguage } from "./asmLanguage";
import { inferLanguageFromPath } from "../types/workspace";
import { KNOWN_MNEMONICS } from "../core/x86/isa";
import { lookupRegister } from "../core/x86/registers";
import { parseIntegerLiteral } from "../core/x86/lexer";
import { assemble } from "../core/x86/assembler";

/**
 * Monaco ships no x86 grammar, so this one is first-party — and unlike Zig,
 * Haskell and Kite its vocabulary has a second source of truth in the same
 * repo: the runner's own assembler. These tests pin the grammar to it, so a
 * mnemonic added to the ISA, a directive the parser never grew, or a literal
 * spelling the lexer accepts cannot drift into rendering as a plain name.
 *
 * Monaco is mocked in this environment (see the alias in vite.config.ts), so
 * the tokenizer cannot be run for real; the rules are matched the way Monarch
 * matches them instead — anchored at the cursor, first rule wins.
 */

type Rule = [RegExp, unknown];

const root = asmMonarchLanguage.tokenizer.root as unknown[];
const instructions = asmMonarchLanguage.instructions as readonly string[];
const directives = asmMonarchLanguage.directives as string[];
const registers = asmMonarchLanguage.registers as string[];

/**
 * The first rule whose pattern matches `text` from the cursor. Monarch strips a
 * leading `^` and only offers such a rule at column 0, which `atLineStart`
 * models — the difference decides which rule wins on an indented line.
 */
function ruleFor(rules: unknown[], text: string, atLineStart = false): Rule | undefined {
  return rules.find((rule): rule is Rule => {
    if (!Array.isArray(rule)) return false;
    const pattern = rule[0];
    if (!(pattern instanceof RegExp)) return false;
    if (pattern.source.startsWith("^") && !atLineStart) return false;
    const flags = pattern.flags.replace("g", "") + (asmMonarchLanguage.ignoreCase ? "i" : "");
    const anchored = new RegExp(`^(?:${pattern.source})`, [...new Set(flags)].join(""));
    return anchored.test(text);
  });
}

/** What the first matching rule consumes, which is where a literal splits. */
function matchedText(rules: unknown[], text: string, atLineStart = false): string | undefined {
  const rule = ruleFor(rules, text, atLineStart);
  if (!rule) return undefined;
  const flags = rule[0].flags.replace("g", "") + (asmMonarchLanguage.ignoreCase ? "i" : "");
  const anchored = new RegExp(`^(?:${rule[0].source})`, [...new Set(flags)].join(""));
  return text.match(anchored)?.[0];
}

describe("asm monarch grammar", () => {
  it("registers under the id inferLanguageFromPath returns for .asm", () => {
    expect(ASM_LANGUAGE_ID).toBe("asm");
    expect(inferLanguageFromPath("main.asm")).toBe(ASM_LANGUAGE_ID);
    expect(inferLanguageFromPath("boot.nasm")).toBe(ASM_LANGUAGE_ID);
  });

  it("colours exactly the mnemonics the runner's assembler accepts", () => {
    // The list is read off the ISA rather than copied, so this is a guard on
    // the wiring: colour a word as an instruction only if it assembles.
    expect([...instructions].sort()).toEqual([...KNOWN_MNEMONICS].sort());
    // Not a stub of a list — the conditional families are all in there.
    expect(instructions).toEqual(
      expect.arrayContaining(["mov", "syscall", "jmp", "je", "setg", "cmovae"]),
    );
  });

  it("does not offer times, which this assembler has no statement for", () => {
    // Colouring it like `db` promises a directive the runner then rejects with
    // an error pointing at the operand rather than at the word itself.
    expect(directives).not.toContain("times");
    expect(instructions).not.toContain("times");
    expect(() => assemble("section .text\nglobal _start\n_start:\n  times 8 db 0\n")).toThrow(
      /Unexpected "db" after the end of this statement/,
    );
  });

  it("lists the directives and operand keywords the parser knows", () => {
    expect([...directives].sort()).toEqual([
      "abs",
      "align",
      "byte",
      "db",
      "dd",
      "default",
      "dq",
      "dw",
      "dword",
      "equ",
      "extern",
      "global",
      "globl",
      "qword",
      "rel",
      "resb",
      "resd",
      "resq",
      "resw",
      "section",
      "segment",
      "word",
    ]);
  });

  it("names only registers the assembler resolves, plus rip", () => {
    // `rip` is the one deliberate exception: the CPU has it, but an operand
    // spells rip-relative addressing `[rel msg]`, so the assembler's register
    // table does not carry it.
    const unknown = registers.filter((name) => lookupRegister(name) === null);

    expect(unknown).toEqual(["rip"]);
    expect(registers).toEqual(expect.arrayContaining(["rax", "r15b", "sil", "eax", "ax", "al"]));
  });

  it.each([
    ["0xAA", "number.hex"],
    ["0b1010_1010", "number.binary"],
    ["0o17", "number.octal"],
    ["0AAh", "number.hex"],
    ["1010b", "number.binary"],
    ["17q", "number.octal"],
    ["170", "number"],
  ])("reads %s as one %s, the way the lexer does", (literal, token) => {
    // Every spelling parseIntegerLiteral accepts. A rule that stops short
    // leaves the suffix to the identifier rule, so half the literal renders as
    // a variable name on a line that assembles perfectly well.
    expect(parseIntegerLiteral(literal)).not.toBeNull();
    expect(ruleFor(root, literal)?.[1]).toBe(token);
    expect(matchedText(root, literal)).toBe(literal);
  });

  it("keeps the current-address token out of the identifier rule", () => {
    // `$` is legal inside a name, so the identifier rule would swallow the `$`
    // in `equ $ - msg` and colour the address as a symbol.
    expect(ruleFor(root, "$ - msg")?.[1]).toBe("keyword.control");
    expect(ruleFor(root, "$$")?.[1]).toBe("keyword.control");
  });

  it("reads a label at the start of a line as structure, not as a name", () => {
    expect(ruleFor(root, "_start:", true)?.[1]).toBe("type.identifier");
    expect(ruleFor(root, "  .loop:", true)?.[1]).toBe("type.identifier");
    // Mid-line the same word is an ordinary operand.
    expect(ruleFor(root, "msg")?.[1]).toMatchObject({ cases: expect.any(Object) });
  });

  it("starts a comment on ; and not on #", () => {
    // NASM's comment character is the semicolon; treating `#` as one makes a
    // stray `#` disappear instead of erroring.
    expect(ruleFor(root, "; a note")?.[1]).toBe("comment");
    expect(ruleFor(root, "# a note")?.[1]).not.toBe("comment");
    expect(asmLanguageConfiguration.comments).toEqual({ lineComment: ";" });
  });

  it("ends an unterminated string at the line, instead of leaking the state", () => {
    // Delete a closing quote and the string state would otherwise carry onto
    // every following line and colour the rest of the file as a literal.
    expect(ruleFor(root, '"hello')?.[1]).toBe("string.invalid");
    expect(ruleFor(root, "'hello")?.[1]).toBe("string.invalid");
    // A well-formed literal still opens the string state, escapes and all.
    expect(ruleFor(root, '"hello", 10')?.[1]).toMatchObject({ next: "@stringDouble" });
    expect(ruleFor(root, "'hello', 10")?.[1]).toMatchObject({ next: "@stringSingle" });
    expect(ruleFor(root, '"a\\"b"')?.[1]).toMatchObject({ next: "@stringDouble" });
  });
});
