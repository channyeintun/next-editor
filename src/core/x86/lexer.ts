/**
 * Tokenizer for NASM-syntax x86-64 assembly.
 *
 * Assembly is line-oriented in a way most languages are not: a newline ends a
 * statement, and nothing continues across one. So the tokens carry their line
 * and column and the parser never has to look for a terminator — it reads until
 * the line runs out. Every diagnostic downstream quotes a line and a column,
 * which is the whole reason those two numbers are threaded through.
 *
 * What the lexer deliberately does *not* do is decide what anything means. A
 * bare word is a `word` token whether it turns out to be `mov`, a register, a
 * label, or a typo; a `[` is a `punct`. Separating "what is written" from "what
 * it refers to" is what lets the assembler resolve a symbol used before it is
 * defined, which every forward jump needs.
 */

export type TokenKind = "word" | "number" | "string" | "punct" | "newline" | "eof";

export interface Token {
  kind: TokenKind;
  /** Source text exactly as written; symbol names are case-sensitive in NASM. */
  value: string;
  /** For `number`, the parsed value; for `string`, the decoded bytes. */
  number?: bigint;
  bytes?: number[];
  line: number;
  column: number;
}

export class AsmSyntaxError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(message);
    this.name = "AsmSyntaxError";
    this.line = line;
    this.column = column;
  }
}

// `$` and `$$` are absent on purpose: they are recognised ahead of this set,
// which is only ever consulted one character at a time.
const PUNCTUATION = new Set(["[", "]", "(", ")", ",", "+", "-", "*", "/", ":"]);

const UTF8 = new TextEncoder();

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_.?@]/.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_.?@$]/.test(character);
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

/**
 * Parse a NASM integer literal.
 *
 * Both spellings of every radix NASM has: the `0x`/`0b`/`0o` prefixes, the
 * `h`/`b`/`q` suffixes, and plain decimal — plus `_` as a digit separator,
 * because `0b1010_1010` is how a bit pattern is readable at all.
 */
export function parseIntegerLiteral(text: string): bigint | null {
  const cleaned = text.replaceAll("_", "");
  if (cleaned.length === 0) return null;

  const lower = cleaned.toLowerCase();
  try {
    if (lower.startsWith("0x")) return BigInt(lower);
    if (lower.startsWith("0b")) return BigInt(lower);
    if (lower.startsWith("0o")) return BigInt(lower);
    if (/^[0-9a-f]+h$/.test(lower)) return BigInt(`0x${lower.slice(0, -1)}`);
    if (/^[01]+b$/.test(lower)) return BigInt(`0b${lower.slice(0, -1)}`);
    if (/^[0-7]+q$/.test(lower)) return BigInt(`0o${lower.slice(0, -1)}`);
    if (/^[0-9]+$/.test(lower)) return BigInt(lower);
  } catch {
    return null;
  }
  return null;
}

/** Decode the escape sequences NASM honours inside a double-quoted string. */
function decodeEscapes(raw: string, quote: string, line: number, column: number): number[] {
  const bytes: number[] = [];
  // Single-quoted strings are literal in NASM; only double quotes escape.
  if (quote === "'") {
    for (const byte of UTF8.encode(raw)) bytes.push(byte);
    return bytes;
  }

  for (let index = 0; index < raw.length; index += 1) {
    // By code point, not by code unit: half of a surrogate pair encoded on its
    // own is U+FFFD, so `"😀"` would lay down replacement characters while the
    // single-quoted spelling of the same string laid down the emoji.
    const character = String.fromCodePoint(raw.codePointAt(index)!);
    if (character !== "\\") {
      for (const byte of UTF8.encode(character)) bytes.push(byte);
      index += character.length - 1;
      continue;
    }

    index += 1;
    const escape = raw[index];
    switch (escape) {
      case "n":
        bytes.push(0x0a);
        break;
      case "t":
        bytes.push(0x09);
        break;
      case "r":
        bytes.push(0x0d);
        break;
      case "0":
        bytes.push(0x00);
        break;
      case "\\":
        bytes.push(0x5c);
        break;
      case '"':
        bytes.push(0x22);
        break;
      case "'":
        bytes.push(0x27);
        break;
      case "e":
        bytes.push(0x1b);
        break;
      case "x": {
        const hex = raw.slice(index + 1, index + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
          throw new AsmSyntaxError(`\\x needs two hex digits`, line, column);
        }
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
        break;
      }
      default:
        throw new AsmSyntaxError(`Unknown escape \\${escape ?? ""}`, line, column);
    }
  }
  return bytes;
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let lineStart = 0;

  const push = (kind: TokenKind, value: string, index: number, extra?: Partial<Token>): void => {
    tokens.push({ kind, value, line, column: index - lineStart + 1, ...extra });
  };

  let index = 0;
  while (index < source.length) {
    const character = source[index];

    if (character === "\n") {
      push("newline", "\n", index);
      index += 1;
      line += 1;
      lineStart = index;
      continue;
    }

    if (character === "\r" || character === " " || character === "\t") {
      index += 1;
      continue;
    }

    // `;` runs to end of line. `#` is not a NASM comment and stays an error.
    if (character === ";") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    if (character === '"' || character === "'") {
      const quote = character;
      const startIndex = index;
      index += 1;
      let raw = "";
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\n") {
          throw new AsmSyntaxError(
            "String literal is not closed",
            line,
            startIndex - lineStart + 1,
          );
        }
        if (source[index] === "\\" && quote === '"') {
          raw += source[index];
          index += 1;
          if (index >= source.length) break;
        }
        raw += source[index];
        index += 1;
      }
      if (index >= source.length || source[index] !== quote) {
        throw new AsmSyntaxError("String literal is not closed", line, startIndex - lineStart + 1);
      }
      index += 1;
      push("string", raw, startIndex, {
        bytes: decodeEscapes(raw, quote, line, startIndex - lineStart + 1),
      });
      continue;
    }

    if (isDigit(character)) {
      const startIndex = index;
      while (index < source.length && /[0-9a-zA-Z_]/.test(source[index])) index += 1;
      const text = source.slice(startIndex, index);
      const value = parseIntegerLiteral(text);
      if (value === null) {
        throw new AsmSyntaxError(`"${text}" is not a number`, line, startIndex - lineStart + 1);
      }
      push("number", text, startIndex, { number: value });
      continue;
    }

    // `$` alone is the current address; `$$` is the section's start. Both are
    // punctuation rather than identifiers so `$ - msg` parses as a subtraction.
    if (character === "$") {
      const startIndex = index;
      if (source[index + 1] === "$") {
        index += 2;
        push("punct", "$$", startIndex);
      } else {
        index += 1;
        push("punct", "$", startIndex);
      }
      continue;
    }

    if (isIdentifierStart(character)) {
      const startIndex = index;
      while (index < source.length && isIdentifierPart(source[index])) index += 1;
      // The raw spelling is kept because symbol names are case-sensitive in
      // NASM even though mnemonics and registers are not; every consumer that
      // compares against a keyword lowercases it there.
      push("word", source.slice(startIndex, index), startIndex);
      continue;
    }

    if (PUNCTUATION.has(character)) {
      push("punct", character, index);
      index += 1;
      continue;
    }

    throw new AsmSyntaxError(`Unexpected character "${character}"`, line, index - lineStart + 1);
  }

  push("eof", "", index);
  return tokens;
}
