// Node's internal error factory and argument validators, shared by the builtin
// modules: `ERR_*` errors with Node's exact message wording (lib/internal/errors.js)
// and the `validate*` helpers from lib/internal/validators.js. Not a builtin
// itself; nothing outside the builtins imports it.

/** An Error carrying Node's `code`. */
export type NodeError<E extends Error = Error> = E & { code: string };

type ErrorBase = new (message?: string, options?: ErrorOptions) => Error;

/**
 * Builds an error the way Node's `NodeError` classes do: an instance of `Base`
 * with an own `code`, `toString()` giving `Name [CODE]: message`, and a stack
 * whose first line names the code.
 */
export function makeNodeError<E extends Error = Error>(
  code: string,
  message: string,
  Base: ErrorBase = Error,
  options?: ErrorOptions,
): NodeError<E> {
  const error = (
    options === undefined ? new Base(message) : new Base(message, options)
  ) as NodeError<E>;
  error.code = code;
  Object.defineProperty(error, "toString", {
    value: function toString(this: Error) {
      return `${this.name} [${code}]: ${this.message}`;
    },
    enumerable: false,
    writable: true,
    configurable: true,
  });
  const stack = error.stack;
  if (typeof stack === "string") {
    const prefix = `${error.name}: `;
    if (stack.startsWith(prefix)) {
      error.stack = `${error.name} [${code}]: ${stack.slice(prefix.length)}`;
    }
  }
  return error;
}

const kTypes = [
  "string",
  "function",
  "number",
  "object",
  "Function",
  "Object",
  "boolean",
  "bigint",
  "symbol",
];
const classRegExp = /^[A-Z][a-zA-Z0-9]*$/;

/** `A`, `A or B`, `A, B, or C`: Node's `formatList`. */
export function formatList(array: readonly string[], type = "and"): string {
  switch (array.length) {
    case 0:
      return "";
    case 1:
      return `${array[0]}`;
    case 2:
      return `${array[0]} ${type} ${array[1]}`;
    case 3:
      return `${array[0]}, ${array[1]}, ${type} ${array[2]}`;
    default:
      return `${array.slice(0, -1).join(", ")}, ${type} ${array[array.length - 1]}`;
  }
}

/**
 * A small `util.inspect` for error messages: primitives, functions, arrays and
 * plain objects in Node's default format, shallow (`depth` levels of nesting).
 */
export function inspectValue(value: unknown, depth = 2): string {
  switch (typeof value) {
    case "string":
      return quoteString(value);
    case "number":
      return Object.is(value, -0) ? "-0" : String(value);
    case "bigint":
      return `${value}n`;
    case "boolean":
    case "undefined":
      return String(value);
    case "symbol":
      return value.toString();
    case "function": {
      const fn = value as { name?: unknown };
      const name = typeof fn.name === "string" && fn.name !== "" ? fn.name : "";
      if (Function.prototype.toString.call(value).startsWith("class")) {
        return name ? `[class ${name}]` : "[class (anonymous)]";
      }
      return name ? `[Function: ${name}]` : "[Function (anonymous)]";
    }
    default:
      break;
  }
  if (value === null) {
    return "null";
  }
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  const object = value as Record<string, unknown>;
  const proto: unknown = Object.getPrototypeOf(object);
  const constructorName =
    proto === null
      ? null
      : typeof (proto as { constructor?: { name?: unknown } }).constructor?.name === "string"
        ? (proto as { constructor: { name: string } }).constructor.name
        : "";
  if (Array.isArray(object)) {
    if (object.length === 0) {
      return "[]";
    }
    if (depth < 0) {
      return "[Array]";
    }
    return `[ ${object.map((item) => inspectValue(item, depth - 1)).join(", ")} ]`;
  }
  const keys = Object.keys(object);
  const prefix =
    constructorName === null
      ? "[Object: null prototype] "
      : constructorName === "Object"
        ? ""
        : `${constructorName || "Object"} `;
  if (depth < 0) {
    return constructorName === null
      ? "[Object: null prototype]"
      : `[${constructorName || "Object"}]`;
  }
  if (keys.length === 0) {
    return `${prefix}{}`;
  }
  const entries = keys.map((key) => {
    const shown = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : quoteString(key);
    return `${shown}: ${inspectValue(object[key], depth - 1)}`;
  });
  return `${prefix}{ ${entries.join(", ")} }`;
}

function quoteString(value: string): string {
  const escaped = value.replace(/[\\\n\r\t\b\f\v]/g, (char) => {
    switch (char) {
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      case "\b":
        return "\\b";
      case "\f":
        return "\\f";
      case "\v":
        return "\\v";
      default:
        return "\\\\";
    }
  });
  if (!escaped.includes("'")) {
    return `'${escaped}'`;
  }
  if (!escaped.includes('"')) {
    return `"${escaped}"`;
  }
  if (!escaped.includes("`") && !escaped.includes("${")) {
    return `\`${escaped}\``;
  }
  return `'${escaped.replace(/'/g, "\\'")}'`;
}

/** How Node names the received value in a type-mismatch message. */
export function determineSpecificType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  switch (typeof value) {
    case "bigint":
      return `type bigint (${value}n)`;
    case "number":
      if (value === 0) {
        return 1 / value === -Infinity ? "type number (-0)" : "type number (0)";
      }
      if (Number.isNaN(value)) {
        return "type number (NaN)";
      }
      if (value === Infinity) {
        return "type number (Infinity)";
      }
      if (value === -Infinity) {
        return "type number (-Infinity)";
      }
      return `type number (${value})`;
    case "boolean":
      return value ? "type boolean (true)" : "type boolean (false)";
    case "symbol":
      return `type symbol (${String(value)})`;
    case "function":
      return `function ${(value as { name: string }).name}`;
    case "object": {
      const name: unknown = (value as { constructor?: { name?: unknown } }).constructor?.name;
      if (typeof name === "string" && name !== "") {
        return `an instance of ${name}`;
      }
      return inspectValue(value, -1);
    }
    case "string": {
      let shown = value;
      if (shown.length > 28) {
        shown = `${shown.slice(0, 25)}...`;
      }
      if (!shown.includes("'")) {
        return `type string ('${shown}')`;
      }
      return `type string (${JSON.stringify(shown)})`;
    }
    default:
      return `type ${typeof value}`;
  }
}

/** The message of `ERR_INVALID_ARG_TYPE`, word for word as Node writes it. */
export function invalidArgTypeMessage(
  name: string,
  expected: string | readonly string[],
  actual: unknown,
): string {
  const expectedList = typeof expected === "string" ? [expected] : expected;
  let msg = "The ";
  if (name.endsWith(" argument")) {
    msg += `${name} `;
  } else {
    const type = name.includes(".") ? "property" : "argument";
    msg += `"${name}" ${type} `;
  }
  msg += "must be ";

  const types: string[] = [];
  const instances: string[] = [];
  const other: string[] = [];
  for (const value of expectedList) {
    if (kTypes.includes(value)) {
      types.push(value.toLowerCase());
    } else if (classRegExp.test(value)) {
      instances.push(value);
    } else {
      other.push(value);
    }
  }
  if (instances.length > 0) {
    const pos = types.indexOf("object");
    if (pos !== -1) {
      types.splice(pos, 1);
      instances.push("Object");
    }
  }
  if (types.length > 0) {
    msg += `${types.length > 1 ? "one of type" : "of type"} ${formatList(types, "or")}`;
    if (instances.length > 0 || other.length > 0) {
      msg += " or ";
    }
  }
  if (instances.length > 0) {
    msg += `an instance of ${formatList(instances, "or")}`;
    if (other.length > 0) {
      msg += " or ";
    }
  }
  if (other.length > 0) {
    if (other.length > 1) {
      msg += `one of ${formatList(other, "or")}`;
    } else {
      if (other[0].toLowerCase() !== other[0]) {
        msg += "an ";
      }
      msg += `${other[0]}`;
    }
  }
  msg += `. Received ${determineSpecificType(actual)}`;
  return msg;
}

/** `ERR_INVALID_ARG_TYPE` (a `TypeError`). */
export function invalidArgType(
  name: string,
  expected: string | readonly string[],
  actual: unknown,
): NodeError<TypeError> {
  return makeNodeError<TypeError>(
    "ERR_INVALID_ARG_TYPE",
    invalidArgTypeMessage(name, expected, actual),
    TypeError,
  );
}

function addNumericalSeparator(value: string): string {
  let res = "";
  let i = value.length;
  const start = value[0] === "-" ? 1 : 0;
  for (; i >= start + 4; i -= 3) {
    res = `_${value.slice(i - 3, i)}${res}`;
  }
  return `${value.slice(0, i)}${res}`;
}

/** `ERR_OUT_OF_RANGE` (a `RangeError`). */
export function outOfRange(
  name: string,
  range: string,
  input: unknown,
  replaceDefaultBoolean = false,
): NodeError<RangeError> {
  let msg = replaceDefaultBoolean ? name : `The value of "${name}" is out of range.`;
  let received: string;
  if (Number.isInteger(input) && Math.abs(input as number) > 2 ** 32) {
    received = addNumericalSeparator(String(input));
  } else if (typeof input === "bigint") {
    received = String(input);
    if (input > 2n ** 32n || input < -(2n ** 32n)) {
      received = addNumericalSeparator(received);
    }
    received += "n";
  } else {
    received = inspectValue(input);
  }
  msg += ` It must be ${range}. Received ${received}`;
  return makeNodeError<RangeError>("ERR_OUT_OF_RANGE", msg, RangeError);
}

/** `ERR_INVALID_ARG_VALUE` (a `TypeError`). */
export function invalidArgValue(
  name: string,
  value: unknown,
  reason = "is invalid",
): NodeError<TypeError> {
  let inspected = inspectValue(value);
  if (inspected.length > 128) {
    inspected = `${inspected.slice(0, 128)}...`;
  }
  const type = name.includes(".") ? "property" : "argument";
  return makeNodeError<TypeError>(
    "ERR_INVALID_ARG_VALUE",
    `The ${type} '${name}' ${reason}. Received ${inspected}`,
    TypeError,
  );
}

/** `ERR_MISSING_ARGS` (a `TypeError`). */
export function missingArgs(...names: string[]): NodeError<TypeError> {
  let msg = "The ";
  const wrap = (a: string) => `"${a}"`;
  const args = names.map(wrap);
  switch (args.length) {
    case 1:
      msg += `${args[0]} argument`;
      break;
    case 2:
      msg += `${args[0]} and ${args[1]} arguments`;
      break;
    default:
      msg += `${args.slice(0, -1).join(", ")}, and ${args[args.length - 1]} arguments`;
      break;
  }
  return makeNodeError<TypeError>("ERR_MISSING_ARGS", `${msg} must be specified`, TypeError);
}

/**
 * Node's `AbortError`: a plain Error with `code: 'ABORT_ERR'` and
 * `name: 'AbortError'` (not a DOMException).
 */
export class AbortError extends Error {
  code: string;

  constructor(message = "The operation was aborted", options?: ErrorOptions) {
    if (options !== undefined && typeof options !== "object") {
      throw invalidArgType("options", "Object", options);
    }
    super(message, options);
    this.code = "ABORT_ERR";
    this.name = "AbortError";
  }
}

/** `validateString`: throws `ERR_INVALID_ARG_TYPE` unless `value` is a string. */
export function validateString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") {
    throw invalidArgType(name, "string", value);
  }
}

/** `validateFunction`. */
export function validateFunction(
  value: unknown,
  name: string,
): asserts value is (...args: never[]) => unknown {
  if (typeof value !== "function") {
    throw invalidArgType(name, "Function", value);
  }
}

/** `validateBoolean`. */
export function validateBoolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw invalidArgType(name, "boolean", value);
  }
}

/** `validateNumber`, with an optional inclusive range. */
export function validateNumber(
  value: unknown,
  name: string,
  min?: number,
  max?: number,
): asserts value is number {
  if (typeof value !== "number") {
    throw invalidArgType(name, "number", value);
  }
  if (
    (min != null && value < min) ||
    (max != null && value > max) ||
    ((min != null || max != null) && Number.isNaN(value))
  ) {
    throw outOfRange(
      name,
      `${min != null ? `>= ${min}` : ""}${min != null && max != null ? " && " : ""}${
        max != null ? `<= ${max}` : ""
      }`,
      value,
    );
  }
}

/** `validateInteger`. */
export function validateInteger(
  value: unknown,
  name: string,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (typeof value !== "number") {
    throw invalidArgType(name, "number", value);
  }
  if (!Number.isInteger(value)) {
    throw outOfRange(name, "an integer", value);
  }
  if (value < min || value > max) {
    throw outOfRange(name, `>= ${min} && <= ${max}`, value);
  }
}

/** `validateObject` flags: also accept null, arrays, functions. */
export const kValidateObjectAllowNullable = 1;
export const kValidateObjectAllowArray = 2;
export const kValidateObjectAllowFunction = 4;

/** `validateObject`: a non-null, non-array object unless `options` allows more. */
export function validateObject(value: unknown, name: string, options = 0): asserts value is object {
  if (options === 0) {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      throw invalidArgType(name, "Object", value);
    }
    return;
  }
  if ((options & kValidateObjectAllowNullable) === 0 && value === null) {
    throw invalidArgType(name, "Object", value);
  }
  if ((options & kValidateObjectAllowArray) === 0 && Array.isArray(value)) {
    throw invalidArgType(name, "Object", value);
  }
  const allowFunction = (options & kValidateObjectAllowFunction) !== 0;
  if (typeof value !== "object" && (!allowFunction || typeof value !== "function")) {
    throw invalidArgType(name, "Object", value);
  }
}

/** `validateAbortSignal`: undefined, or an object with `aborted`. */
export function validateAbortSignal(
  signal: unknown,
  name: string,
): asserts signal is AbortSignal | undefined {
  if (
    signal !== undefined &&
    (signal === null || typeof signal !== "object" || !("aborted" in signal))
  ) {
    throw invalidArgType(name, "AbortSignal", signal);
  }
}
