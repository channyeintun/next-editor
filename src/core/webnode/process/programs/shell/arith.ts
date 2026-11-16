// Shell arithmetic: `$((…))`, `((…))`, `for ((…))` and `let`. Integers only,
// with C operator precedence, assignment operators and variables.

/** Variable access for arithmetic. */
export interface ArithScope {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
}

/** An arithmetic error, reported as `sh: <expr>: <message>`. */
export class ArithError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArithError";
  }
}

type Tok =
  | { kind: "num"; value: number }
  | { kind: "name"; value: string }
  | { kind: "op"; value: string };

const OPS = [
  "<<=",
  ">>=",
  "**",
  "++",
  "--",
  "<<",
  ">>",
  "<=",
  ">=",
  "==",
  "!=",
  "&&",
  "||",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "!",
  "~",
  "&",
  "|",
  "^",
  "?",
  ":",
  "=",
  "(",
  ")",
  ",",
];

function tokenize(text: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const match = /^(0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z@_]+|[0-9]+)/.exec(
        text.slice(i),
      ) as RegExpExecArray;
      tokens.push({ kind: "num", value: parseNumber(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i)) as RegExpExecArray;
      tokens.push({ kind: "name", value: match[0] });
      i += match[0].length;
      continue;
    }
    const op = OPS.find((candidate) => text.startsWith(candidate, i));
    if (!op) {
      throw new ArithError(
        `syntax error: invalid arithmetic operator (error token is "${text.slice(i)}")`,
      );
    }
    tokens.push({ kind: "op", value: op });
    i += op.length;
  }
  return tokens;
}

function parseNumber(text: string): number {
  if (/^0[xX]/.test(text)) {
    return parseInt(text.slice(2), 16);
  }
  const based = /^(\d+)#(.+)$/.exec(text);
  if (based) {
    const base = Number(based[1]);
    const value = parseInt(based[2], base);
    if (base < 2 || base > 36 || Number.isNaN(value)) {
      throw new ArithError(`value too great for base (error token is "${text}")`);
    }
    return value;
  }
  if (text.length > 1 && text.startsWith("0")) {
    if (/[89]/.test(text)) {
      throw new ArithError(`value too great for base (error token is "${text}")`);
    }
    return parseInt(text, 8);
  }
  return Number(text);
}

const BINARY: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "|": 3,
  "^": 4,
  "&": 5,
  "==": 6,
  "!=": 6,
  "<": 7,
  "<=": 7,
  ">": 7,
  ">=": 7,
  "<<": 8,
  ">>": 8,
  "+": 9,
  "-": 9,
  "*": 10,
  "/": 10,
  "%": 10,
  "**": 11,
};

const ASSIGN = new Set(["=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "|=", "^="]);

function toInt(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function applyBinary(op: string, a: number, b: number): number {
  switch (op) {
    case "||":
      return a || b ? 1 : 0;
    case "&&":
      return a && b ? 1 : 0;
    case "|":
      return Number(BigInt.asIntN(64, BigInt(a) | BigInt(b)));
    case "^":
      return Number(BigInt.asIntN(64, BigInt(a) ^ BigInt(b)));
    case "&":
      return Number(BigInt.asIntN(64, BigInt(a) & BigInt(b)));
    case "==":
      return a === b ? 1 : 0;
    case "!=":
      return a !== b ? 1 : 0;
    case "<":
      return a < b ? 1 : 0;
    case "<=":
      return a <= b ? 1 : 0;
    case ">":
      return a > b ? 1 : 0;
    case ">=":
      return a >= b ? 1 : 0;
    case "<<":
      return Number(BigInt.asIntN(64, BigInt(a) << BigInt(b)));
    case ">>":
      return Number(BigInt.asIntN(64, BigInt(a) >> BigInt(b)));
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      if (b === 0) {
        throw new ArithError("division by 0");
      }
      return Math.trunc(a / b);
    case "%":
      if (b === 0) {
        throw new ArithError("division by 0");
      }
      return a % b;
    case "**":
      if (b < 0) {
        throw new ArithError("exponent less than 0");
      }
      return a ** b;
  }
  throw new ArithError(`unknown operator ${op}`);
}

class Evaluator {
  private pos = 0;
  private readonly tokens: Tok[];
  private readonly scope: ArithScope;
  /** When > 0, side effects (assignments) are skipped: the unevaluated side of `&&`, `||`, `?:`. */
  private skip = 0;
  private depth: number;

  constructor(tokens: Tok[], scope: ArithScope, depth: number) {
    this.tokens = tokens;
    this.scope = scope;
    this.depth = depth;
  }

  private peek(): Tok | undefined {
    return this.tokens[this.pos];
  }

  private isOp(value: string): boolean {
    const token = this.peek();
    return token?.kind === "op" && token.value === value;
  }

  run(): number {
    if (this.tokens.length === 0) {
      return 0;
    }
    const value = this.comma();
    if (this.pos < this.tokens.length) {
      const token = this.tokens[this.pos];
      throw new ArithError(`syntax error in expression (error token is "${String(token.value)}")`);
    }
    return value;
  }

  private comma(): number {
    let value = this.assignment();
    while (this.isOp(",")) {
      this.pos++;
      value = this.assignment();
    }
    return value;
  }

  private assignment(): number {
    const token = this.peek();
    const next = this.tokens[this.pos + 1];
    if (token?.kind === "name" && next?.kind === "op" && ASSIGN.has(next.value)) {
      this.pos += 2;
      const right = this.assignment();
      let value = right;
      if (next.value !== "=") {
        value = toInt(applyBinary(next.value.slice(0, -1), this.variable(token.value), right));
      }
      if (!this.skip) {
        this.scope.set(token.value, String(value));
      }
      return value;
    }
    return this.ternary();
  }

  private ternary(): number {
    const condition = this.binary(1);
    if (!this.isOp("?")) {
      return condition;
    }
    this.pos++;
    if (!condition) {
      this.skip++;
    }
    const whenTrue = this.assignment();
    if (!condition) {
      this.skip--;
    }
    if (!this.isOp(":")) {
      throw new ArithError("`:' expected for conditional expression");
    }
    this.pos++;
    if (condition) {
      this.skip++;
    }
    const whenFalse = this.assignment();
    if (condition) {
      this.skip--;
    }
    return condition ? whenTrue : whenFalse;
  }

  private binary(minPrecedence: number): number {
    let left = this.unary();
    for (;;) {
      const token = this.peek();
      if (token?.kind !== "op") {
        return left;
      }
      const precedence = BINARY[token.value];
      if (precedence === undefined || precedence < minPrecedence) {
        return left;
      }
      this.pos++;
      const shortCircuit = (token.value === "&&" && !left) || (token.value === "||" && left);
      if (shortCircuit) {
        this.skip++;
      }
      // `**` is right-associative.
      const right = this.binary(token.value === "**" ? precedence : precedence + 1);
      if (shortCircuit) {
        this.skip--;
      }
      left = toInt(applyBinary(token.value, left, right));
    }
  }

  private unary(): number {
    const token = this.peek();
    if (token?.kind === "op") {
      switch (token.value) {
        case "+":
          this.pos++;
          return this.unary();
        case "-":
          this.pos++;
          return -this.unary();
        case "!":
          this.pos++;
          return this.unary() ? 0 : 1;
        case "~":
          this.pos++;
          return ~this.unary();
        case "++":
        case "--": {
          this.pos++;
          const name = this.peek();
          if (name?.kind !== "name") {
            throw new ArithError("syntax error: operand expected");
          }
          this.pos++;
          const value = this.variable(name.value) + (token.value === "++" ? 1 : -1);
          if (!this.skip) {
            this.scope.set(name.value, String(value));
          }
          return value;
        }
      }
    }
    return this.postfix();
  }

  private postfix(): number {
    const token = this.peek();
    if (token?.kind === "name") {
      this.pos++;
      const value = this.variable(token.value);
      if (this.isOp("++") || this.isOp("--")) {
        const delta = this.isOp("++") ? 1 : -1;
        this.pos++;
        if (!this.skip) {
          this.scope.set(token.value, String(value + delta));
        }
      }
      return value;
    }
    return this.primary();
  }

  private primary(): number {
    const token = this.peek();
    if (!token) {
      throw new ArithError("syntax error: operand expected");
    }
    if (token.kind === "num") {
      this.pos++;
      return token.value;
    }
    if (token.kind === "op" && token.value === "(") {
      this.pos++;
      const value = this.comma();
      if (!this.isOp(")")) {
        throw new ArithError("missing `)'");
      }
      this.pos++;
      return value;
    }
    throw new ArithError(
      `syntax error: operand expected (error token is "${String(token.value)}")`,
    );
  }

  private variable(name: string): number {
    const raw = this.scope.get(name);
    if (raw === undefined || raw.trim() === "") {
      return 0;
    }
    if (/^\s*-?\d+\s*$/.test(raw)) {
      return Number(raw.trim());
    }
    if (this.depth > 32) {
      throw new ArithError("expression recursion level exceeded");
    }
    return evaluateArithmetic(raw, this.scope, this.depth + 1);
  }
}

/** Evaluates an arithmetic expression. Throws `ArithError`. */
export function evaluateArithmetic(text: string, scope: ArithScope, depth = 0): number {
  return new Evaluator(tokenize(text), scope, depth).run();
}
