// The shell's tokenizer: turns source text into words (already split into
// quoted and expandable parts), operators and redirection operators, and reads
// here-document bodies after the line that opened them. The parser pulls
// tokens one at a time; command substitutions are handed back to the parser
// through `parseSubstitution`.
import type { HereDoc, ParamPart, Program, RedirOp, Word, WordPart } from "./ast";

/** A syntax error. `incomplete` means more input could complete it (an open quote, a trailing `&&`). */
export class ShellSyntaxError extends Error {
  readonly incomplete: boolean;
  constructor(message: string, incomplete = false) {
    super(message);
    this.name = "ShellSyntaxError";
    this.incomplete = incomplete;
  }
}

export type Token =
  | { type: "word"; word: Word; raw: string; line: number }
  | { type: "op"; value: string; line: number }
  | { type: "redir"; op: RedirOp; fd?: number; line: number }
  | { type: "eof"; line: number };

/** Parses a `$(…)` body starting at `pos`; returns the program and the index just past `)`. */
export type SubstitutionParser = (
  source: string,
  pos: number,
  line: number,
) => { program: Program; end: number; line: number };

/** Parses a whole source text (for backticks). */
export type ProgramParser = (source: string) => Program;

interface PendingHereDoc {
  delimiter: string;
  stripTabs: boolean;
  target: HereDoc;
}

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const SPECIAL_PARAMS = "@*#?-$!0123456789";

type Mode = "unquoted" | "dq" | "brace" | "heredoc";

/** Pulls tokens from shell source. */
export class Lexer {
  readonly source: string;
  pos: number;
  line: number;
  /** Where the token `next` returned last starts in `source`. */
  tokenStart = 0;
  private readonly pending: PendingHereDoc[] = [];
  private readonly parseSubstitution: SubstitutionParser;
  private readonly parseProgram: ProgramParser;
  /**
   * Reading the word of `${x:-w}` (or `+ = ?`) inside double quotes or a
   * here-document, where bash keeps `'` as a literal character.
   */
  private literalSingleQuotes = false;

  constructor(
    source: string,
    parseSubstitution: SubstitutionParser,
    parseProgram: ProgramParser,
    pos = 0,
    line = 1,
  ) {
    this.source = source;
    this.pos = pos;
    this.line = line;
    this.parseSubstitution = parseSubstitution;
    this.parseProgram = parseProgram;
  }

  /** Registers a here-document whose body follows the next newline. */
  addHereDoc(delimiter: string, stripTabs: boolean, target: HereDoc): void {
    this.pending.push({ delimiter, stripTabs, target });
  }

  /** True when here-documents are waiting for their bodies. */
  hasPendingHereDocs(): boolean {
    return this.pending.length > 0;
  }

  private peekChar(offset = 0): string {
    return this.source[this.pos + offset] ?? "";
  }

  private skipBlanks(): void {
    for (;;) {
      const c = this.peekChar();
      if (c === " " || c === "\t" || c === "\r") {
        this.pos++;
      } else if (c === "\\" && this.peekChar(1) === "\n") {
        this.pos += 2;
        this.line++;
      } else if (c === "\\" && this.pos + 1 >= this.source.length) {
        throw new ShellSyntaxError("unexpected end of input after `\\`", true);
      } else {
        return;
      }
    }
  }

  /** The next token. */
  next(): Token {
    this.skipBlanks();
    this.tokenStart = this.pos;
    const line = this.line;
    const c = this.peekChar();
    if (c === "") {
      if (this.pending.length > 0) {
        throw new ShellSyntaxError(
          `here-document delimited by end of file (wanted \`${this.pending[0].delimiter}')`,
          true,
        );
      }
      return { type: "eof", line };
    }
    if (c === "#") {
      while (this.pos < this.source.length && this.peekChar() !== "\n") {
        this.pos++;
      }
      return this.next();
    }
    if (c === "\n") {
      this.pos++;
      this.line++;
      this.readHereDocBodies();
      return { type: "op", value: "\n", line };
    }
    // An IO number: digits directly before `<` or `>`.
    const ioMatch = /^(\d+)(?=[<>])/.exec(this.source.slice(this.pos, this.pos + 12));
    if (ioMatch) {
      this.pos += ioMatch[1].length;
      const op = this.readRedirOp();
      if (op) {
        return { type: "redir", op, fd: Number(ioMatch[1]), line };
      }
    }
    if ((c === "<" || c === ">") && this.peekChar(1) === "(") {
      throw new ShellSyntaxError(`sh: process substitution ${c}(…): not supported`);
    }
    if (c === "<" || c === ">") {
      const op = this.readRedirOp();
      if (op) {
        return { type: "redir", op, line };
      }
    }
    const three = this.source.slice(this.pos, this.pos + 3);
    const two = this.source.slice(this.pos, this.pos + 2);
    if (three === "&>>") {
      this.pos += 3;
      return { type: "redir", op: "&>>", line };
    }
    if (two === "&>") {
      this.pos += 2;
      return { type: "redir", op: "&>", line };
    }
    if (three === ";;&") {
      this.pos += 3;
      return { type: "op", value: ";;&", line };
    }
    for (const op of ["&&", "||", ";;", ";&", "|&"]) {
      if (two === op) {
        this.pos += 2;
        return { type: "op", value: op, line };
      }
    }
    if ("|&;()".includes(c)) {
      this.pos++;
      return { type: "op", value: c, line };
    }
    const start = this.pos;
    const parts = this.readParts("unquoted", "");
    return { type: "word", word: { parts }, raw: this.source.slice(start, this.pos), line };
  }

  private readRedirOp(): RedirOp | null {
    const ops: RedirOp[] = ["<<<", "<<-", "<<", "<>", "<&", ">>", ">&", ">|", "<", ">"];
    for (const op of ops) {
      if (this.source.startsWith(op, this.pos)) {
        this.pos += op.length;
        return op;
      }
    }
    return null;
  }

  /**
   * Reads a raw word for the right side of `=~` inside `[[ ]]`: up to blank
   * space at parenthesis depth zero. Quotes still quote.
   */
  readRegexWord(): Token {
    this.skipBlanks();
    const line = this.line;
    const start = this.pos;
    const parts: WordPart[] = [];
    let depth = 0;
    let lit = "";
    const flush = (): void => {
      if (lit) {
        parts.push({ type: "lit", value: lit });
        lit = "";
      }
    };
    while (this.pos < this.source.length) {
      const c = this.peekChar();
      if (depth === 0 && (c === " " || c === "\t" || c === "\n")) {
        break;
      }
      if (c === "(") {
        depth++;
      } else if (c === ")") {
        depth--;
      }
      if (c === "'" || c === '"' || c === "$" || c === "\\") {
        flush();
        const sub = this.readParts("unquoted", " \t\n()|<>;&", true);
        parts.push(...sub);
        continue;
      }
      lit += c;
      this.pos++;
    }
    flush();
    return { type: "word", word: { parts }, raw: this.source.slice(start, this.pos), line };
  }

  /**
   * Reads word parts in `mode` until a terminator. `extraStops` adds stop
   * characters (for `${x/pat/rep}`). `single` stops after one quoted or
   * expansion part (used by `readRegexWord`).
   */
  readParts(mode: Mode, extraStops: string, single = false): WordPart[] {
    const parts: WordPart[] = [];
    let lit = "";
    const flush = (): void => {
      if (lit) {
        parts.push({ type: mode === "unquoted" || mode === "brace" ? "lit" : "sq", value: lit });
        lit = "";
      }
    };
    let braceDepth = 0;
    for (;;) {
      if (single && parts.length > 0 && lit === "") {
        return parts;
      }
      if (this.pos >= this.source.length) {
        if (mode === "dq") {
          throw new ShellSyntaxError(
            "unexpected end of input while looking for matching `\"'",
            true,
          );
        }
        if (mode === "brace") {
          throw new ShellSyntaxError(
            "unexpected end of input while looking for matching `}'",
            true,
          );
        }
        break;
      }
      const c = this.peekChar();
      if (mode === "unquoted" && (" \t\r\n|&;<>()".includes(c) || extraStops.includes(c))) {
        break;
      }
      if (mode === "dq" && c === '"') {
        break;
      }
      if (mode === "brace") {
        if (c === "}" && braceDepth === 0) {
          break;
        }
        if (extraStops.includes(c) && braceDepth === 0) {
          break;
        }
        if (c === "{") {
          braceDepth++;
        } else if (c === "}") {
          braceDepth--;
        }
      }
      if (c === "\\") {
        const n = this.peekChar(1);
        if (n === "") {
          if (mode === "heredoc") {
            lit += c;
            this.pos++;
            continue;
          }
          throw new ShellSyntaxError("unexpected end of input after `\\`", true);
        }
        if (n === "\n") {
          this.pos += 2;
          this.line++;
          continue;
        }
        if (mode === "unquoted" || mode === "brace") {
          flush();
          parts.push({ type: "sq", value: n });
          this.pos += 2;
          continue;
        }
        if (n === "$" || n === "`" || n === "\\" || (mode === "dq" && n === '"')) {
          lit += n;
          this.pos += 2;
          continue;
        }
        lit += c;
        this.pos++;
        continue;
      }
      if (c === "'" && (mode === "unquoted" || (mode === "brace" && !this.literalSingleQuotes))) {
        flush();
        const end = this.source.indexOf("'", this.pos + 1);
        if (end < 0) {
          throw new ShellSyntaxError(
            "unexpected end of input while looking for matching `''",
            true,
          );
        }
        const value = this.source.slice(this.pos + 1, end);
        this.line += countNewlines(value);
        parts.push({ type: "sq", value });
        this.pos = end + 1;
        continue;
      }
      if (c === '"' && (mode === "unquoted" || mode === "brace")) {
        flush();
        this.pos++;
        const inner = this.readParts("dq", "");
        this.pos++; // closing quote
        parts.push({ type: "dq", parts: inner });
        continue;
      }
      if (c === "`") {
        flush();
        parts.push(this.readBacktick());
        continue;
      }
      if (c === "$") {
        const part = this.readDollar(mode);
        if (part) {
          flush();
          parts.push(part);
          continue;
        }
        lit += c;
        this.pos++;
        continue;
      }
      if (c === "\n") {
        this.line++;
      }
      lit += c;
      this.pos++;
    }
    flush();
    return parts;
  }

  private readBacktick(): WordPart {
    this.pos++;
    let body = "";
    for (;;) {
      const c = this.peekChar();
      if (c === "") {
        throw new ShellSyntaxError("unexpected end of input while looking for matching ``'", true);
      }
      if (c === "`") {
        this.pos++;
        break;
      }
      if (c === "\\" && "$`\\".includes(this.peekChar(1)) && this.peekChar(1) !== "") {
        body += this.peekChar(1);
        this.pos += 2;
        continue;
      }
      if (c === "\n") {
        this.line++;
      }
      body += c;
      this.pos++;
    }
    return { type: "cmdsub", program: this.parseProgram(body) };
  }

  /** Reads a `$` form at `pos`; null when the `$` is literal. */
  private readDollar(mode: Mode): WordPart | null {
    const n = this.peekChar(1);
    if (n === "(") {
      if (this.peekChar(2) === "(") {
        const end = findArithEnd(this.source, this.pos + 3);
        if (end >= 0) {
          const text = this.source.slice(this.pos + 3, end);
          this.line += countNewlines(text);
          this.pos = end + 2;
          return {
            type: "arith",
            parts: parseArithText(text, this.parseSubstitution, this.parseProgram),
          };
        }
      }
      const result = this.parseSubstitution(this.source, this.pos + 2, this.line);
      this.pos = result.end;
      this.line = result.line;
      return { type: "cmdsub", program: result.program };
    }
    if (n === "{") {
      this.pos += 2;
      return this.readBraceParam(mode);
    }
    if (n === "'" && mode === "unquoted") {
      this.pos += 2;
      return { type: "sq", value: this.readAnsiC() };
    }
    if (n === '"' && mode === "unquoted") {
      this.pos += 2;
      const inner = this.readParts("dq", "");
      this.pos++;
      return { type: "dq", parts: inner };
    }
    if (n !== "" && SPECIAL_PARAMS.includes(n)) {
      this.pos += 2;
      return { type: "param", name: n };
    }
    if (NAME_START.test(n)) {
      let end = this.pos + 1;
      while (end < this.source.length && NAME_CHAR.test(this.source[end])) {
        end++;
      }
      const name = this.source.slice(this.pos + 1, end);
      this.pos = end;
      return { type: "param", name };
    }
    return null;
  }

  private readAnsiC(): string {
    let out = "";
    for (;;) {
      const c = this.peekChar();
      if (c === "") {
        throw new ShellSyntaxError("unexpected end of input while looking for matching `''", true);
      }
      this.pos++;
      if (c === "'") {
        return out;
      }
      if (c !== "\\") {
        if (c === "\n") {
          this.line++;
        }
        out += c;
        continue;
      }
      const e = this.peekChar();
      this.pos++;
      const decoded = decodeEscape(
        e,
        () => this.peekChar(),
        () => this.pos++,
      );
      out += decoded;
    }
  }

  private readBraceParam(mode: Mode): ParamPart {
    const close = (): void => {
      if (this.peekChar() !== "}") {
        throw new ShellSyntaxError(
          `bad substitution near \`${this.source.slice(this.pos, this.pos + 10)}'`,
        );
      }
      this.pos++;
    };
    const innerMode: Mode = "brace";
    let length = false;
    let indirect = false;
    if (this.peekChar() === "!" && NAME_START.test(this.peekChar(1))) {
      indirect = true;
      this.pos++;
    }
    if (this.peekChar() === "#" && this.peekChar(1) !== "}" && this.peekChar(1) !== "") {
      length = true;
      this.pos++;
    }
    let name = "";
    const c = this.peekChar();
    if (c === "") {
      throw new ShellSyntaxError("unexpected end of input in `${'", true);
    }
    if (NAME_START.test(c)) {
      while (NAME_CHAR.test(this.peekChar())) {
        name += this.peekChar();
        this.pos++;
      }
    } else if (/\d/.test(c)) {
      while (/\d/.test(this.peekChar())) {
        name += this.peekChar();
        this.pos++;
      }
    } else if (SPECIAL_PARAMS.includes(c)) {
      name = c;
      this.pos++;
    } else {
      throw new ShellSyntaxError(
        `bad substitution: \${${this.source.slice(this.pos, this.pos + 10)}`,
      );
    }
    if (this.peekChar() === "[") {
      throw new ShellSyntaxError(`sh: \${${name}[…]}: arrays are not supported`);
    }
    if (length) {
      close();
      return { type: "param", name, length: true };
    }
    if (indirect) {
      if (this.peekChar() === "*" || this.peekChar() === "@") {
        throw new ShellSyntaxError(`sh: \${!${name}${this.peekChar()}}: not supported`);
      }
      close();
      return { type: "param", name, indirect: true };
    }
    const rest = this.source.slice(this.pos, this.pos + 2);
    let op: string | undefined;
    for (const candidate of [":-", ":=", ":+", ":?", "%%", "##", "//", "^^", ",,"]) {
      if (rest === candidate) {
        op = candidate;
        break;
      }
    }
    if (!op && rest[0] !== undefined && "-=+?%#/:^,".includes(rest[0])) {
      op = rest[0];
    }
    if (!op) {
      close();
      return { type: "param", name };
    }
    this.pos += op.length;
    if (op === "/" || op === "//") {
      const pattern = this.readParts(innerMode, "/");
      let replacement: WordPart[] = [];
      if (this.peekChar() === "/") {
        this.pos++;
        replacement = this.readParts(innerMode, "");
      }
      close();
      return { type: "param", name, op, word: { parts: pattern }, word2: { parts: replacement } };
    }
    if (op === ":") {
      const offset = this.readParts(innerMode, ":");
      let lengthWord: Word | undefined;
      if (this.peekChar() === ":") {
        this.pos++;
        lengthWord = { parts: this.readParts(innerMode, "") };
      }
      close();
      return { type: "param", name, op, word: { parts: offset }, word2: lengthWord };
    }
    const saved = this.literalSingleQuotes;
    // Pattern operators (`#`, `%`) take quotes even inside "…"; these do not.
    this.literalSingleQuotes =
      "-=+?".includes(op[op.length - 1]) &&
      (mode === "dq" || mode === "heredoc" || (mode === "brace" && saved));
    let word: WordPart[];
    try {
      word = this.readParts(innerMode, "");
    } finally {
      this.literalSingleQuotes = saved;
    }
    close();
    return { type: "param", name, op, word: { parts: word } };
  }

  private readHereDocBodies(): void {
    while (this.pending.length > 0) {
      const doc = this.pending.shift() as PendingHereDoc;
      const lines: string[] = [];
      let found = false;
      while (this.pos < this.source.length) {
        let end = this.source.indexOf("\n", this.pos);
        if (end < 0) {
          end = this.source.length;
        }
        let text = this.source.slice(this.pos, end);
        this.pos = Math.min(end + 1, this.source.length);
        this.line++;
        if (doc.stripTabs) {
          text = text.replace(/^\t+/, "");
        }
        if (text === doc.delimiter) {
          found = true;
          break;
        }
        lines.push(text);
      }
      if (!found) {
        throw new ShellSyntaxError(
          `here-document delimited by end of file (wanted \`${doc.delimiter}')`,
          true,
        );
      }
      const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
      if (doc.target.quoted) {
        doc.target.body = { parts: [{ type: "sq", value: body }] };
      } else {
        const sub = new Lexer(body, this.parseSubstitution, this.parseProgram);
        doc.target.body = { parts: sub.readParts("heredoc", "") };
      }
    }
  }
}

function countNewlines(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (ch === "\n") {
      count++;
    }
  }
  return count;
}

/** Index of the `))` that closes a `$((` whose body starts at `start`, or -1. */
function findArithEnd(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      if (depth === 0) {
        return source[i + 1] === ")" ? i : -1;
      }
      depth--;
    }
  }
  return -1;
}

/** The expandable parts of an arithmetic expression's text. */
export function parseArithText(
  text: string,
  parseSubstitution: SubstitutionParser,
  parseProgram: ProgramParser,
): WordPart[] {
  const lexer = new Lexer(text, parseSubstitution, parseProgram);
  return lexer.readParts("heredoc", "");
}

/** Decodes one backslash escape of `$'…'` / `echo -e` / `printf`; `e` is the char after the backslash. */
export function decodeEscape(e: string, peek: () => string, advance: () => void): string {
  switch (e) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "a":
      return "\x07";
    case "b":
      return "\b";
    case "e":
    case "E":
      return "\x1b";
    case "f":
      return "\f";
    case "v":
      return "\v";
    case "\\":
      return "\\";
    case "'":
      return "'";
    case '"':
      return '"';
    case "?":
      return "?";
    case "0":
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
    case "6":
    case "7": {
      let digits = e;
      while (digits.length < 3 && /[0-7]/.test(peek())) {
        digits += peek();
        advance();
      }
      return String.fromCharCode(parseInt(digits, 8) & 0xff);
    }
    case "x": {
      let digits = "";
      while (digits.length < 2 && /[0-9a-fA-F]/.test(peek())) {
        digits += peek();
        advance();
      }
      return digits ? String.fromCharCode(parseInt(digits, 16)) : "\\x";
    }
    case "u":
    case "U": {
      let digits = "";
      const max = e === "u" ? 4 : 8;
      while (digits.length < max && /[0-9a-fA-F]/.test(peek())) {
        digits += peek();
        advance();
      }
      return digits ? String.fromCodePoint(parseInt(digits, 16)) : `\\${e}`;
    }
    case "":
      return "\\";
    default:
      return `\\${e}`;
  }
}
