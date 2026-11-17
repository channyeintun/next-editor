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

// Line diff operations, as Node's lib/internal/assert/myers_diff.js names them.
const kDelete = -1;
const kNop = 0;
const kInsert = 1;
// Runs of equal lines longer than this are collapsed to "...".
const kNopLinesToCollapse = 5;
// A Myers diff costs time and memory in the number of differing lines (D).
// Past this many, the diff falls back to a plain report (common head and tail,
// then every other actual line, then every other expected line), so a failing
// comparison of two very different large values stays fast.
const kMaxDiffLevel = 1000;

type DiffEntry = [op: number, line: string];

function areLinesEqual(actual: string, expected: string, checkCommaDisparity: boolean): boolean {
  if (actual === expected) {
    return true;
  }
  // The last entry of an object or array has no trailing comma.
  return checkCommaDisparity && (`${actual},` === expected || actual === `${expected},`);
}

/**
 * Node's Myers diff of the inspected lines, newest entry first (Node prints
 * from the end). Each level keeps only the diagonals it reached, so memory is
 * O(D²) rather than O(D·(n+m)).
 */
function myersDiff(
  actual: string[],
  expected: string[],
  checkCommaDisparity: boolean,
): DiffEntry[] {
  const n = actual.length;
  const m = expected.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 1);
  // trace[d] is v over diagonals -d+1 … d-1 before level d ran.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, kMaxDiffLevel); d++) {
    trace.push(d === 0 ? new Int32Array(0) : v.slice(max - d + 1, max + d));
    for (let k = -d; k <= d; k += 2) {
      const offset = k + max;
      let x =
        k === -d || (k !== d && v[offset - 1] < v[offset + 1]) ? v[offset + 1] : v[offset - 1] + 1;
      let y = x - k;
      while (x < n && y < m && areLinesEqual(actual[x], expected[y], checkCommaDisparity)) {
        x++;
        y++;
      }
      v[offset] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, actual, expected, checkCommaDisparity);
      }
    }
  }
  return plainDiff(actual, expected, checkCommaDisparity);
}

function backtrack(
  trace: Int32Array[],
  actual: string[],
  expected: string[],
  checkCommaDisparity: boolean,
): DiffEntry[] {
  let x = actual.length;
  let y = expected.length;
  const result: DiffEntry[] = [];
  for (let d = trace.length - 1; d >= 0; d--) {
    const level = trace[d];
    // Diagonal k of level d sits at index k + d - 1.
    const at = (k: number): number => level[k + d - 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      const actualItem = actual[x - 1];
      result.push([
        kNop,
        checkCommaDisparity && !actualItem.endsWith(",") ? expected[y - 1] : actualItem,
      ]);
      x--;
      y--;
    }
    if (d > 0) {
      result.push(x > prevX ? [kInsert, actual[--x]] : [kDelete, expected[--y]]);
    }
  }
  return result;
}

/** The fallback past kMaxDiffLevel: linear, but not a minimal diff. */
function plainDiff(
  actual: string[],
  expected: string[],
  checkCommaDisparity: boolean,
): DiffEntry[] {
  let head = 0;
  while (
    head < actual.length &&
    head < expected.length &&
    areLinesEqual(actual[head], expected[head], checkCommaDisparity)
  ) {
    head++;
  }
  let tail = 0;
  while (
    tail < actual.length - head &&
    tail < expected.length - head &&
    areLinesEqual(
      actual[actual.length - 1 - tail],
      expected[expected.length - 1 - tail],
      checkCommaDisparity,
    )
  ) {
    tail++;
  }
  const forward: DiffEntry[] = [];
  for (let i = 0; i < head; i++) forward.push([kNop, actual[i]]);
  for (let i = head; i < actual.length - tail; i++) forward.push([kInsert, actual[i]]);
  for (let j = head; j < expected.length - tail; j++) forward.push([kDelete, expected[j]]);
  for (let i = actual.length - tail; i < actual.length; i++) forward.push([kNop, actual[i]]);
  return forward.reverse();
}

/** Node's printMyersDiff without colours: long runs of equal lines become "...". */
function printDiff(diff: DiffEntry[]): { message: string; skipped: boolean } {
  let message = "";
  let skipped = false;
  let nopCount = 0;
  for (let i = diff.length - 1; i >= 0; i--) {
    const [operation, value] = diff[i];
    const previousOperation = i < diff.length - 1 ? diff[i + 1][0] : null;
    // A run is collapsed only when that hides more than one line.
    if (previousOperation === kNop && operation !== previousOperation) {
      if (nopCount === kNopLinesToCollapse + 1) {
        message += `  ${diff[i + 1][1]}\n`;
      } else if (nopCount === kNopLinesToCollapse + 2) {
        message += `  ${diff[i + 2][1]}\n  ${diff[i + 1][1]}\n`;
      } else if (nopCount >= kNopLinesToCollapse + 3) {
        message += `...\n  ${diff[i + 1][1]}\n`;
        skipped = true;
      }
      nopCount = 0;
    }
    if (operation === kInsert) {
      message += `+ ${value}\n`;
    } else if (operation === kDelete) {
      message += `- ${value}\n`;
    } else {
      if (nopCount < kNopLinesToCollapse) {
        message += `  ${value}\n`;
      }
      nopCount++;
    }
  }
  return { message: message.trimEnd(), skipped };
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

  const checkCommaDisparity = actual != null && typeof actual === "object";
  const { message, skipped } = printDiff(
    myersDiff(actualLines, expectedLines, checkCommaDisparity),
  );
  const skippedMessage = skipped ? "\n... Skipped lines" : "";
  return `${kReadableOperator[operator]}\n+ actual - expected${skippedMessage}\n\n${message}${indicator}\n`;
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
