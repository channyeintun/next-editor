// Owns `assert.AssertionError`: its fields and the messages Node generates
// for a failed comparison (the first line matches Node's; deep comparisons get
// a `+ actual - expected` line diff).
import { inspect } from "./inspect";
import { invalidArgType } from "./nodeErrors";

const kReadableOperator: Record<string, string> = {
  deepStrictEqual: "Expected values to be strictly deep-equal:",
  strictEqual: "Expected values to be strictly equal:",
  strictEqualObject: 'Expected "actual" to be reference-equal to "expected":',
  deepEqual: "Expected values to be loosely deep-equal:",
  notDeepStrictEqual: 'Expected "actual" not to be strictly deep-equal to:',
  notStrictEqual: 'Expected "actual" to be strictly unequal to:',
  notStrictEqualObject: 'Expected "actual" not to be reference-equal to "expected":',
  notDeepEqual: 'Expected "actual" not to be loosely deep-equal to:',
  notIdentical: "Values identical but not reference-equal:",
  notDeepEqualUnequal: "Expected values not to be loosely deep-equal:",
};

const kMaxShortLength = 12;

function inspectValue(value: unknown): string {
  return inspect(value, {
    compact: false,
    customInspect: false,
    depth: 1000,
    maxArrayLength: Infinity,
    showHidden: false,
    showProxy: false,
    sorted: true,
    getters: true,
  });
}

/** A line diff of `actual` against `expected`: `[op, line]`, op is "+" (actual), "-" (expected) or " ". */
function lineDiff(actual: string[], expected: string[]): [string, string][] {
  const n = actual.length;
  const m = expected.length;
  // Longest common subsequence table; inputs are inspect output, so small.
  const table: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        actual[i] === expected[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const result: [string, string][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (actual[i] === expected[j]) {
      result.push([" ", actual[i]]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      result.push(["+", actual[i++]]);
    } else {
      result.push(["-", expected[j++]]);
    }
  }
  while (i < n) {
    result.push(["+", actual[i++]]);
  }
  while (j < m) {
    result.push(["-", expected[j++]]);
  }
  return result;
}

function createErrDiff(actual: unknown, expected: unknown, operator: string): string {
  const actualInspected = inspectValue(actual);
  const expectedInspected = inspectValue(expected);
  const actualLines = actualInspected.split("\n");
  const expectedLines = expectedInspected.split("\n");
  let indicator = "";

  if (
    operator === "strictEqual" &&
    ((typeof actual === "object" &&
      actual !== null &&
      typeof expected === "object" &&
      expected !== null) ||
      (typeof actual === "function" && typeof expected === "function"))
  ) {
    operator = "strictEqualObject";
  }

  if (
    actualLines.length === 1 &&
    expectedLines.length === 1 &&
    actualLines[0] !== expectedLines[0]
  ) {
    const inputLength = actualLines[0].length + expectedLines[0].length;
    if (inputLength <= kMaxShortLength) {
      if (
        (typeof actual !== "object" || actual === null) &&
        (typeof expected !== "object" || expected === null) &&
        (actual !== 0 || expected !== 0)
      ) {
        return `${kReadableOperator[operator]}\n\n${actualLines[0]} !== ${expectedLines[0]}\n`;
      }
    } else if (operator !== "strictEqualObject" && inputLength < 80) {
      let i = 0;
      while (actualLines[0][i] === expectedLines[0][i]) {
        i++;
      }
      if (i > 2) {
        indicator = `\n  ${" ".repeat(i)}^`;
      }
    }
  }

  if (actualInspected === expectedInspected) {
    if (typeof actual === "object" && actual !== null) {
      return `Values have same structure but are not reference-equal:\n\n${actualLines.join("\n")}\n`;
    }
    // Same text, different values (two functions): show both sides.
    return `${kReadableOperator[operator]}\n+ actual - expected\n\n+ ${actualInspected}\n- ${expectedInspected}\n`;
  }

  const diff = lineDiff(actualLines, expectedLines);
  const body = diff.map(([op, line]) => `${op} ${line}`).join("\n");
  return `${kReadableOperator[operator]}\n+ actual - expected\n\n${body}${indicator}\n`;
}

/** The options `new AssertionError(options)` takes. */
export interface AssertionErrorOptions {
  message?: string | Error;
  actual?: unknown;
  expected?: unknown;
  operator?: string;
  stackStartFn?: Function; // eslint-disable-line @typescript-eslint/no-unsafe-function-type
  stackStartFunction?: Function; // eslint-disable-line @typescript-eslint/no-unsafe-function-type
}

function generatedMessageFor(actual: unknown, expected: unknown, operator: string): string {
  if (operator === "deepStrictEqual" || operator === "strictEqual") {
    return createErrDiff(actual, expected, operator);
  }
  if (operator === "notDeepStrictEqual" || operator === "notStrictEqual") {
    let base = kReadableOperator[operator];
    const res = inspectValue(actual).split("\n");
    if (
      operator === "notStrictEqual" &&
      ((typeof actual === "object" && actual !== null) || typeof actual === "function")
    ) {
      base = kReadableOperator.notStrictEqualObject;
    }
    if (res.length > 50) {
      res[46] = "...";
      res.length = 47;
    }
    if (res.length === 1) {
      return `${base}${res[0].length > 5 ? "\n\n" : " "}${res[0]}`;
    }
    return `${base}\n\n${res.join("\n")}\n`;
  }
  let res = inspectValue(actual);
  let other = inspectValue(expected);
  const knownOperator = kReadableOperator[operator];
  if (operator === "notDeepEqual" && res === other) {
    res = `${knownOperator}\n\n${res}`;
    if (res.length > 1024) {
      res = `${res.slice(0, 1021)}...`;
    }
    return res;
  }
  if (res.length > 512) {
    res = `${res.slice(0, 509)}...`;
  }
  if (other.length > 512) {
    other = `${other.slice(0, 509)}...`;
  }
  if (operator === "deepEqual") {
    res = `${knownOperator}\n\n${res}\n\nshould loosely deep-equal\n\n`;
  } else {
    const newOp = kReadableOperator[`${operator}Unequal`];
    if (newOp) {
      res = `${newOp}\n\n${res}\n\nshould not loosely deep-equal\n\n`;
    } else {
      other = ` ${operator} ${other}`;
    }
  }
  return `${res}${other}`;
}

/** `assert.AssertionError`. */
export class AssertionError extends Error {
  generatedMessage: boolean;
  code: "ERR_ASSERTION";
  actual: unknown;
  expected: unknown;
  operator: string | undefined;

  constructor(options: AssertionErrorOptions) {
    if (options === null || typeof options !== "object") {
      throw invalidArgType("options", "Object", options);
    }
    const { message, operator, stackStartFn, stackStartFunction } = options;
    const { actual, expected } = options;
    const text =
      message != null ? String(message) : generatedMessageFor(actual, expected, operator ?? "");
    super(text);
    this.generatedMessage = message == null;
    Object.defineProperty(this, "name", {
      value: "AssertionError [ERR_ASSERTION]",
      enumerable: false,
      writable: true,
      configurable: true,
    });
    this.code = "ERR_ASSERTION";
    this.actual = actual;
    this.expected = expected;
    this.operator = operator;
    const capture = (Error as { captureStackTrace?: (target: object, fn?: Function) => void }) // eslint-disable-line @typescript-eslint/no-unsafe-function-type
      .captureStackTrace;
    if (typeof capture === "function") {
      capture(this, stackStartFn || stackStartFunction);
    }
    // Reading the stack fixes the first line as "AssertionError [ERR_ASSERTION]: …".
    void this.stack;
    this.name = "AssertionError";
  }

  toString(): string {
    return `${this.name} [${this.code}]: ${this.message}`;
  }

  [Symbol.for("nodejs.util.inspect.custom")](_recurseTimes: number, ctx: object): string {
    // Long values are truncated in the inspected error, as in Node.
    const tmpActual = this.actual;
    const tmpExpected = this.expected;
    const truncate = (value: unknown): unknown =>
      typeof value === "string" && value.length > 512 ? `${value.slice(0, 509)}...` : value;
    this.actual = truncate(tmpActual);
    this.expected = truncate(tmpExpected);
    const result = inspect(this, { ...ctx, customInspect: false, depth: 0 });
    this.actual = tmpActual;
    this.expected = tmpExpected;
    return result;
  }
}
