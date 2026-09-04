/**
 * NASM-syntax parser: tokens in, one statement per source line out.
 *
 * Two decisions shape everything here. The first is that a symbol is never
 * resolved while parsing — `jmp done` produces a reference to the *name*
 * `done`, and the assembler resolves it on a later pass. Assembly is full of
 * forward references (every loop's exit, every `call` to a routine written
 * below) and a parser that insisted on knowing addresses could not read them.
 *
 * The second is that a memory operand is parsed as an ordinary arithmetic
 * expression that happens to contain registers, then *folded* into the
 * base/index/scale/displacement shape the hardware actually encodes. Writing it
 * the other way round — a grammar with a slot for each piece — rejects
 * `[8 + rbx + rax*4]`, which is the same address written in a different order
 * and which NASM accepts.
 */

import { isKnownMnemonic } from "./isa";
import { AsmSyntaxError, type Token, tokenize } from "./lexer";
import { lookupRegister, type OperandSize, type RegisterRef } from "./registers";

export type Expression =
  | { kind: "number"; value: bigint }
  | { kind: "symbol"; name: string }
  /** `$` — the address of the statement being assembled. */
  | { kind: "here" }
  /** `$$` — the address the current section starts at. */
  | { kind: "sectionStart" }
  | { kind: "unary"; operator: "-" | "+"; operand: Expression }
  | { kind: "binary"; operator: "+" | "-" | "*" | "/"; left: Expression; right: Expression };

export interface MemoryOperand {
  kind: "memory";
  /** Explicit `byte`/`word`/`dword`/`qword` size override, when written. */
  size: OperandSize | null;
  base: RegisterRef | null;
  index: RegisterRef | null;
  scale: 1 | 2 | 4 | 8;
  displacement: Expression;
  /** True for `[rel label]`, or any `[label]` under `default rel`. */
  ripRelative: boolean;
}

/** Where an operand starts, so a diagnostic can point at it and not the verb. */
export interface SourcePosition {
  line: number;
  column: number;
}

export type Operand = (
  | { kind: "register"; register: RegisterRef }
  | { kind: "immediate"; value: Expression; size: OperandSize | null }
  | MemoryOperand
) &
  SourcePosition;

export interface InstructionStatement {
  kind: "instruction";
  mnemonic: string;
  operands: Operand[];
  line: number;
  column: number;
}

export type DataWidth = 1 | 2 | 4 | 8;

export interface DataStatement {
  kind: "data";
  width: DataWidth;
  /** `db`-style initialised data; each item is a value or a string's bytes. */
  items: ({ kind: "expression"; value: Expression } | { kind: "bytes"; bytes: number[] })[];
  line: number;
  column: number;
}

export interface ReserveStatement {
  kind: "reserve";
  width: DataWidth;
  count: Expression;
  line: number;
  column: number;
}

export interface LabelStatement {
  kind: "label";
  name: string;
  line: number;
  column: number;
}

export interface EquStatement {
  kind: "equ";
  name: string;
  value: Expression;
  line: number;
  column: number;
}

export interface SectionStatement {
  kind: "section";
  name: string;
  line: number;
  column: number;
}

export interface GlobalStatement {
  kind: "global";
  names: string[];
  line: number;
  column: number;
}

export interface DefaultStatement {
  kind: "default";
  relative: boolean;
  line: number;
  column: number;
}

export interface AlignStatement {
  kind: "align";
  boundary: Expression;
  line: number;
  column: number;
}

export type Statement =
  | InstructionStatement
  | DataStatement
  | ReserveStatement
  | LabelStatement
  | EquStatement
  | SectionStatement
  | GlobalStatement
  | DefaultStatement
  | AlignStatement;

// Maps rather than object literals: `keyword in SIZE_KEYWORDS` would answer
// true for `constructor` and `__proto__`, so a label with either name parsed as
// a size keyword and the line failed with a diagnostic about something else.
const SIZE_KEYWORDS = new Map<string, OperandSize>([
  ["byte", 1],
  ["word", 2],
  ["dword", 4],
  ["qword", 8],
]);

const DATA_WIDTHS = new Map<string, DataWidth>([
  ["db", 1],
  ["dw", 2],
  ["dd", 4],
  ["dq", 8],
]);
const RESERVE_WIDTHS = new Map<string, DataWidth>([
  ["resb", 1],
  ["resw", 2],
  ["resd", 4],
  ["resq", 8],
]);

/**
 * Words that mean "the thing before me was a label", even with no colon.
 *
 * `msg db "hello"` is how every NASM program declares data, and the colon is
 * optional there in a way it is not before an instruction. Rather than guess
 * from column position — NASM's own rule, and a bad one to depend on — a bare
 * word counts as a label only when the word after it is one of these.
 */
const LABEL_INTRODUCERS = new Set([...DATA_WIDTHS.keys(), ...RESERVE_WIDTHS.keys(), "equ"]);

class Parser {
  #tokens: Token[];
  #position = 0;
  /** The last non-local label, which `.local` names hang off. */
  #lastGlobalLabel: string | null = null;
  #defaultRelative = false;

  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }

  #peek(offset = 0): Token {
    return this.#tokens[Math.min(this.#position + offset, this.#tokens.length - 1)];
  }

  #next(): Token {
    const token = this.#peek();
    if (token.kind !== "eof") this.#position += 1;
    return token;
  }

  #error(message: string, token: Token = this.#peek()): AsmSyntaxError {
    return new AsmSyntaxError(message, token.line, token.column);
  }

  #atLineEnd(): boolean {
    const kind = this.#peek().kind;
    return kind === "newline" || kind === "eof";
  }

  #expectPunct(value: string): Token {
    const token = this.#peek();
    if (token.kind !== "punct" || token.value !== value) {
      throw this.#error(`Expected "${value}"`, token);
    }
    return this.#next();
  }

  #eatPunct(value: string): boolean {
    const token = this.#peek();
    if (token.kind === "punct" && token.value === value) {
      this.#next();
      return true;
    }
    return false;
  }

  /** Expand `.local` into `parent.local` so two routines can both use `.loop`. */
  #qualify(name: string, token: Token): string {
    if (!name.startsWith(".")) return name;
    if (!this.#lastGlobalLabel) {
      throw this.#error(`Local label "${name}" has no label above it to attach to`, token);
    }
    return `${this.#lastGlobalLabel}${name}`;
  }

  parse(): Statement[] {
    const statements: Statement[] = [];
    while (this.#peek().kind !== "eof") {
      if (this.#peek().kind === "newline") {
        this.#next();
        continue;
      }
      this.#parseLine(statements);
    }
    return statements;
  }

  #parseLine(statements: Statement[]): void {
    // A line may open with any number of `label:` prefixes before its body,
    // and — for data — with one colon-less label.
    for (;;) {
      const token = this.#peek();
      if (token.kind !== "word") break;
      const following = this.#peek(1);
      const hasColon = following.kind === "punct" && following.value === ":";
      // `db` and friends mean "the word before me was a label" — but only when
      // that word could be a label. `inc db` is an instruction whose operand
      // happens to be spelled like a directive, and reading it as a label named
      // `inc` followed by a `db` with no values is a parse error blamed on the
      // wrong line.
      const introducesData =
        following.kind === "word" &&
        LABEL_INTRODUCERS.has(following.value.toLowerCase()) &&
        !isKnownMnemonic(token.value);
      if (!hasColon && !introducesData) break;
      // `name equ value` defines a symbol without reserving anything, so it is
      // parsed whole below rather than split into a label and a directive.
      if (introducesData && following.value.toLowerCase() === "equ") break;
      this.#next();
      if (hasColon) this.#next();
      const name = this.#qualify(token.value, token);
      if (!token.value.startsWith(".")) this.#lastGlobalLabel = token.value;
      statements.push({ kind: "label", name, line: token.line, column: token.column });
      if (introducesData) break;
    }

    if (this.#atLineEnd()) return;

    const head = this.#peek();
    if (head.kind !== "word") {
      throw this.#error("Expected an instruction, a directive, or a label", head);
    }

    const keyword = head.value.toLowerCase();

    if (keyword === "section" || keyword === "segment") {
      this.#next();
      const name = this.#next();
      if (name.kind !== "word") throw this.#error("section needs a name like .text", name);
      statements.push({
        kind: "section",
        name: name.value.toLowerCase(),
        line: head.line,
        column: head.column,
      });
      // NASM allows attributes after the name (`section .text progbits alloc`);
      // a flat image has nowhere to put them, so they are read and dropped.
      while (!this.#atLineEnd()) this.#next();
      this.#endOfLine();
      return;
    }

    if (keyword === "global" || keyword === "globl") {
      this.#next();
      const names: string[] = [];
      for (;;) {
        const name = this.#next();
        if (name.kind !== "word") throw this.#error("global needs a symbol name", name);
        names.push(name.value);
        if (!this.#eatPunct(",")) break;
      }
      statements.push({ kind: "global", names, line: head.line, column: head.column });
      this.#endOfLine();
      return;
    }

    if (keyword === "extern") {
      throw this.#error(
        "extern is not available here — this runner assembles and links one file with no libraries",
        head,
      );
    }

    if (keyword === "default") {
      this.#next();
      const mode = this.#next();
      if (mode.kind !== "word" || !["rel", "abs"].includes(mode.value.toLowerCase())) {
        throw this.#error("default takes rel or abs", mode);
      }
      this.#defaultRelative = mode.value.toLowerCase() === "rel";
      statements.push({
        kind: "default",
        relative: this.#defaultRelative,
        line: head.line,
        column: head.column,
      });
      this.#endOfLine();
      return;
    }

    if (keyword === "align") {
      this.#next();
      const boundary = this.#parseExpression();
      statements.push({ kind: "align", boundary, line: head.line, column: head.column });
      this.#endOfLine();
      return;
    }

    // `name equ expression` — the one statement whose label carries no colon.
    if (this.#peek(1).kind === "word" && this.#peek(1).value.toLowerCase() === "equ") {
      const name = this.#next();
      this.#next();
      const value = this.#parseExpression();
      statements.push({
        kind: "equ",
        name: this.#qualify(name.value, name),
        value,
        line: name.line,
        column: name.column,
      });
      this.#endOfLine();
      return;
    }

    const dataWidth = DATA_WIDTHS.get(keyword);
    if (dataWidth !== undefined) {
      this.#next();
      const items: DataStatement["items"] = [];
      for (;;) {
        const token = this.#peek();
        if (token.kind === "string") {
          this.#next();
          items.push({ kind: "bytes", bytes: token.bytes ?? [] });
        } else {
          items.push({ kind: "expression", value: this.#parseExpression() });
        }
        if (!this.#eatPunct(",")) break;
      }
      statements.push({
        kind: "data",
        width: dataWidth,
        items,
        line: head.line,
        column: head.column,
      });
      this.#endOfLine();
      return;
    }

    const reserveWidth = RESERVE_WIDTHS.get(keyword);
    if (reserveWidth !== undefined) {
      this.#next();
      const count = this.#parseExpression();
      statements.push({
        kind: "reserve",
        width: reserveWidth,
        count,
        line: head.line,
        column: head.column,
      });
      this.#endOfLine();
      return;
    }

    // Anything left is an instruction.
    this.#next();
    const operands: Operand[] = [];
    if (!this.#atLineEnd()) {
      for (;;) {
        operands.push(this.#parseOperand());
        if (!this.#eatPunct(",")) break;
      }
    }
    // `imul rax, 7` is shorthand, not an instruction: the hardware has no
    // two-operand multiply with an immediate, only `imul dst, src, imm`.
    // Writing the destination into the source slot is exactly what NASM emits,
    // and doing it here means everything downstream — symbol resolution,
    // encoding, the decoder's view of it — sees one form instead of two.
    if (keyword === "imul" && operands.length === 2 && operands[1].kind === "immediate") {
      operands.splice(1, 0, operands[0]);
    }

    statements.push({
      kind: "instruction",
      mnemonic: keyword,
      operands,
      line: head.line,
      column: head.column,
    });
    this.#endOfLine();
  }

  #endOfLine(): void {
    if (!this.#atLineEnd()) {
      throw this.#error(`Unexpected "${this.#peek().value}" after the end of this statement`);
    }
    if (this.#peek().kind === "newline") this.#next();
  }

  #parseOperand(): Operand {
    const token = this.#peek();
    const at: SourcePosition = { line: token.line, column: token.column };

    // A size keyword only ever qualifies what follows it.
    const size = token.kind === "word" ? SIZE_KEYWORDS.get(token.value.toLowerCase()) : undefined;
    if (size !== undefined) {
      this.#next();
      const inner = this.#parseOperand();
      if (inner.kind === "memory") return { ...inner, size, ...at };
      if (inner.kind === "immediate") return { ...inner, size, ...at };
      throw this.#error("A size keyword cannot qualify a register", token);
    }

    if (token.kind === "punct" && token.value === "[") {
      return { ...this.#parseMemory(), ...at };
    }

    if (token.kind === "word") {
      const register = lookupRegister(token.value);
      if (register) {
        this.#next();
        return { kind: "register", register, ...at };
      }
    }

    return { kind: "immediate", value: this.#parseExpression(), size: null, ...at };
  }

  #parseMemory(): MemoryOperand {
    const open = this.#expectPunct("[");
    // Written `rel`/`abs` is a decision about this one address; `default rel` is
    // only a decision about addresses that name no register, which is why the
    // two are tracked apart until the address has been folded.
    let explicitRelative: boolean | null = null;

    if (this.#peek().kind === "word" && this.#peek().value.toLowerCase() === "rel") {
      this.#next();
      explicitRelative = true;
    } else if (this.#peek().kind === "word" && this.#peek().value.toLowerCase() === "abs") {
      this.#next();
      explicitRelative = false;
    }

    const folded = this.#foldAddress(this.#parseAddressExpression(), 1n, open);
    this.#expectPunct("]");

    if (folded.terms.length > 2) {
      throw this.#error("An address can use at most two registers", open);
    }

    let base: RegisterRef | null = null;
    let index: RegisterRef | null = null;
    let scale: 1 | 2 | 4 | 8 = 1;

    for (const term of folded.terms) {
      if (term.scale === 1n && base === null) {
        base = term.register;
        continue;
      }
      if (index !== null) throw this.#error("An address can use only one scaled register", open);
      const numeric = Number(term.scale);
      if (![1, 2, 4, 8].includes(numeric)) {
        throw this.#error(`Scale must be 1, 2, 4 or 8 — got ${numeric}`, open);
      }
      index = term.register;
      scale = numeric as 1 | 2 | 4 | 8;
    }

    // `[rax*2]` folds to an index with no base, which is exactly what SIB
    // encodes; nothing to repair. But `[rsp]` can never be an index, so a
    // two-register address naming rsp second has to swap them.
    if (index?.name === "rsp" || index?.name === "esp") {
      if (scale !== 1 || base === null) {
        throw this.#error("rsp cannot be a scaled index register", open);
      }
      [base, index] = [index, base];
    }

    if (base && index && base.size !== index.size) {
      throw this.#error("Both address registers must be the same width", open);
    }
    if (base && base.size !== 8) {
      throw this.#error("Addresses use 64-bit registers here", open);
    }
    if (index && index.size !== 8) {
      throw this.#error("Addresses use 64-bit registers here", open);
    }

    const usesRegister = base !== null || index !== null;
    if (explicitRelative === true && usesRegister) {
      throw this.#error("A rip-relative address cannot also use a register", open);
    }
    const ripRelative = explicitRelative ?? (this.#defaultRelative && !usesRegister);

    return {
      kind: "memory",
      size: null,
      base,
      index,
      scale,
      displacement: folded.constant,
      ripRelative,
    };
  }

  /** Expression grammar extended with bare register terms, for `[…]` only. */
  #parseAddressExpression(): AddressExpression {
    return this.#parseAddressAdditive();
  }

  #parseAddressAdditive(): AddressExpression {
    let left = this.#parseAddressMultiplicative();
    for (;;) {
      const token = this.#peek();
      if (token.kind === "punct" && (token.value === "+" || token.value === "-")) {
        this.#next();
        const right = this.#parseAddressMultiplicative();
        left = { kind: "binary", operator: token.value, left, right };
      } else {
        return left;
      }
    }
  }

  #parseAddressMultiplicative(): AddressExpression {
    let left = this.#parseAddressUnary();
    for (;;) {
      const token = this.#peek();
      if (token.kind === "punct" && (token.value === "*" || token.value === "/")) {
        this.#next();
        const right = this.#parseAddressUnary();
        left = { kind: "binary", operator: token.value, left, right };
      } else {
        return left;
      }
    }
  }

  #parseAddressUnary(): AddressExpression {
    const token = this.#peek();
    if (token.kind === "punct" && (token.value === "-" || token.value === "+")) {
      this.#next();
      return { kind: "unary", operator: token.value, operand: this.#parseAddressUnary() };
    }
    if (token.kind === "punct" && token.value === "(") {
      this.#next();
      const inner = this.#parseAddressExpression();
      this.#expectPunct(")");
      return inner;
    }
    if (token.kind === "word") {
      const register = lookupRegister(token.value);
      if (register) {
        this.#next();
        return { kind: "register", register };
      }
    }
    return this.#parsePrimary();
  }

  /**
   * Collapse an address expression into register terms plus one constant.
   *
   * `sign` carries the accumulated multiplier down the tree, so `-(rax*2)`
   * arrives at the register with `-2` and is rejected there rather than
   * silently encoding a scale of 2.
   */
  #foldAddress(
    expression: AddressExpression,
    sign: bigint,
    at: Token,
  ): { terms: { register: RegisterRef; scale: bigint }[]; constant: Expression } {
    switch (expression.kind) {
      case "register":
        if (sign < 0n) throw this.#error("A register cannot be subtracted in an address", at);
        return { terms: [{ register: expression.register, scale: sign }], constant: ZERO };
      case "unary": {
        const nested = this.#foldAddress(
          expression.operand,
          expression.operator === "-" ? -sign : sign,
          at,
        );
        return {
          terms: nested.terms,
          constant:
            expression.operator === "-"
              ? { kind: "unary", operator: "-", operand: nested.constant }
              : nested.constant,
        };
      }
      case "binary": {
        if (expression.operator === "+" || expression.operator === "-") {
          const left = this.#foldAddress(expression.left, sign, at);
          const right = this.#foldAddress(
            expression.right,
            expression.operator === "-" ? -sign : sign,
            at,
          );
          return {
            terms: [...left.terms, ...right.terms],
            constant: {
              kind: "binary",
              operator: expression.operator,
              left: left.constant,
              right: right.constant,
            },
          };
        }

        // Multiplication: exactly one side may be a register.
        const leftRegisters = collectRegisters(expression.left);
        const rightRegisters = collectRegisters(expression.right);
        if (leftRegisters.length > 0 && rightRegisters.length > 0) {
          throw this.#error("Two registers cannot be multiplied together", at);
        }
        if (leftRegisters.length === 0 && rightRegisters.length === 0) {
          return {
            terms: [],
            constant: {
              kind: "binary",
              operator: expression.operator,
              left: toExpression(expression.left, at),
              right: toExpression(expression.right, at),
            },
          };
        }
        if (expression.operator === "/") {
          throw this.#error("A register cannot be divided in an address", at);
        }

        const registerSide = leftRegisters.length > 0 ? expression.left : expression.right;
        const scaleSide = leftRegisters.length > 0 ? expression.right : expression.left;
        const scaleExpression = toExpression(scaleSide, at);
        if (scaleExpression.kind !== "number") {
          throw this.#error("A register's scale must be a plain number", at);
        }
        // The scale multiplies everything under it, constant included: in
        // `[(rax+8)*2]` the displacement is 16, not the 8 that was written.
        const nested = this.#foldAddress(registerSide, sign * scaleExpression.value, at);
        return {
          terms: nested.terms,
          constant: {
            kind: "binary",
            operator: "*",
            left: nested.constant,
            right: scaleExpression,
          },
        };
      }
      default:
        return { terms: [], constant: toExpression(expression, at) };
    }
  }

  #parseExpression(): Expression {
    return toExpression(this.#parseAddressAdditive(), this.#peek());
  }

  #parsePrimary(): AddressExpression {
    const token = this.#next();

    if (token.kind === "number") {
      return { kind: "number", value: token.number ?? 0n };
    }

    if (token.kind === "string") {
      // NASM lets a short string stand in for the number its bytes spell,
      // little-endian: `cmp al, 'a'` is the same as `cmp al, 0x61`.
      const bytes = token.bytes ?? [];
      if (bytes.length > 8) {
        throw this.#error("A string used as a number can be at most 8 bytes", token);
      }
      let value = 0n;
      for (let index = bytes.length - 1; index >= 0; index -= 1) {
        value = (value << 8n) | BigInt(bytes[index]);
      }
      return { kind: "number", value };
    }

    if (token.kind === "punct" && token.value === "$") return { kind: "here" };
    if (token.kind === "punct" && token.value === "$$") return { kind: "sectionStart" };

    if (token.kind === "word") {
      return { kind: "symbol", name: this.#qualify(token.value, token) };
    }

    throw this.#error(`Expected a value, got "${token.value || "end of line"}"`, token);
  }
}

const ZERO: Expression = { kind: "number", value: 0n };

type AddressExpression =
  | Expression
  | { kind: "register"; register: RegisterRef }
  | { kind: "unary"; operator: "-" | "+"; operand: AddressExpression }
  | {
      kind: "binary";
      operator: "+" | "-" | "*" | "/";
      left: AddressExpression;
      right: AddressExpression;
    };

function collectRegisters(expression: AddressExpression): RegisterRef[] {
  switch (expression.kind) {
    case "register":
      return [expression.register];
    case "unary":
      return collectRegisters(expression.operand);
    case "binary":
      return [...collectRegisters(expression.left), ...collectRegisters(expression.right)];
    default:
      return [];
  }
}

function toExpression(expression: AddressExpression, at: Token): Expression {
  switch (expression.kind) {
    case "register":
      throw new AsmSyntaxError(
        `Register ${expression.register.name} cannot be used in a plain expression`,
        at.line,
        at.column,
      );
    case "unary":
      return {
        kind: "unary",
        operator: expression.operator,
        operand: toExpression(expression.operand, at),
      };
    case "binary":
      return {
        kind: "binary",
        operator: expression.operator,
        left: toExpression(expression.left, at),
        right: toExpression(expression.right, at),
      };
    default:
      return expression;
  }
}

export function parse(source: string): Statement[] {
  return new Parser(tokenize(source)).parse();
}
