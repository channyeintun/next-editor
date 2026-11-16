// Owns the Node-style argument errors the util and assert modules raise
// (`ERR_INVALID_ARG_TYPE`, `ERR_INVALID_ARG_VALUE`, `ERR_OUT_OF_RANGE`, …) and
// the validators that throw them, with Node 22's exact message text.
import { inspect } from "./inspect";

/** An `Error` carrying Node's `code`. */
export interface NodeError extends Error {
  code: string;
}

type ErrorClass = new (message?: string) => Error;

/**
 * Builds an error the way Node's internal `NodeError` does: `name` stays the
 * base class name, `code` is an own property, and both `stack` and `toString()`
 * read `TypeError [ERR_X]: message`.
 */
export function nodeError(Base: ErrorClass, code: string, message: string): NodeError {
  const error = new Base(message) as NodeError;
  Object.defineProperty(error, "code", {
    value: code,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const name = Base.name;
  if (typeof error.stack === "string") {
    const prefix = `${name}: ${message}`;
    if (error.stack.startsWith(prefix)) {
      error.stack = `${name} [${code}]: ${message}${error.stack.slice(prefix.length)}`;
    }
  }
  Object.defineProperty(error, "toString", {
    value(this: Error) {
      return `${this.name} [${code}]: ${this.message}`;
    },
    enumerable: false,
    writable: true,
    configurable: true,
  });
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
const classRegExp = /^([A-Z][a-z0-9]*)+$/;

/** How Node describes a received value in an argument error. */
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
      if (value !== value) {
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
      const ctor = (value as { constructor?: { name?: unknown } }).constructor;
      if (ctor && "name" in ctor) {
        return `an instance of ${String(ctor.name)}`;
      }
      return `${inspect(value, { depth: -1 })}`;
    }
    case "string": {
      let text = value;
      if (text.length > 28) {
        text = `${text.slice(0, 25)}...`;
      }
      if (!text.includes("'")) {
        return `type string ('${text}')`;
      }
      return `type string (${JSON.stringify(text)})`;
    }
    default:
      return `type ${typeof value} (${inspect(value, { colors: false })})`;
  }
}

function joinList(list: string[], prefix: string): string {
  if (list.length > 2) {
    const last = list[list.length - 1];
    return `${prefix}${list.slice(0, -1).join(", ")}, or ${last}`;
  }
  if (list.length === 2) {
    return `${prefix}${list[0]} or ${list[1]}`;
  }
  return `${prefix}${list[0]}`;
}

/** `ERR_INVALID_ARG_TYPE` (TypeError). `expected` is a type name, a class name, or a list. */
export function invalidArgType(
  name: string,
  expected: string | string[],
  actual: unknown,
): NodeError {
  const expectedList = Array.isArray(expected) ? expected : [expected];
  let msg = "The ";
  if (name.endsWith(" argument")) {
    msg += `${name} `;
  } else {
    msg += `"${name}" ${name.includes(".") ? "property" : "argument"} `;
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
    msg += types.length === 1 ? `of type ${types[0]}` : joinList(types, "one of type ");
    if (instances.length > 0 || other.length > 0) {
      msg += " or ";
    }
  }
  if (instances.length > 0) {
    if (instances.length > 2) {
      msg += joinList(instances, "an instance of ");
    } else {
      msg += `an instance of ${instances[0]}`;
      if (instances.length === 2) {
        msg += ` or ${instances[1]}`;
      }
    }
    if (other.length > 0) {
      msg += " or ";
    }
  }
  if (other.length > 0) {
    if (other.length > 1) {
      msg += joinList(other, "one of ");
    } else {
      if (other[0].toLowerCase() !== other[0]) {
        msg += "an ";
      }
      msg += other[0];
    }
  }
  msg += `. Received ${determineSpecificType(actual)}`;
  return nodeError(TypeError, "ERR_INVALID_ARG_TYPE", msg);
}

/** `ERR_INVALID_ARG_VALUE` (TypeError): `The argument 'name' is invalid. Received …`. */
export function invalidArgValue(name: string, value: unknown, reason = "is invalid"): NodeError {
  let inspected = inspect(value);
  if (inspected.length > 128) {
    inspected = `${inspected.slice(0, 128)}...`;
  }
  const type = name.includes(".") ? "property" : "argument";
  return nodeError(
    TypeError,
    "ERR_INVALID_ARG_VALUE",
    `The ${type} '${name}' ${reason}. Received ${inspected}`,
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

/** `ERR_OUT_OF_RANGE` (RangeError). */
export function outOfRange(name: string, range: string, input: unknown): NodeError {
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
    received = inspect(input);
  }
  return nodeError(
    RangeError,
    "ERR_OUT_OF_RANGE",
    `The value of "${name}" is out of range. It must be ${range}. Received ${received}`,
  );
}

// `ERR_MISSING_ARGS` has one owner: its message does not depend on inspection.
export { missingArgs } from "../internalErrors";

/** Throws `ERR_INVALID_ARG_TYPE` unless `value` is a function. */
export function validateFunction(value: unknown, name: string): asserts value is Function {
  if (typeof value !== "function") {
    throw invalidArgType(name, "Function", value);
  }
}

/** Throws `ERR_INVALID_ARG_TYPE` unless `value` is a string. */
export function validateString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") {
    throw invalidArgType(name, "string", value);
  }
}

/** Throws `ERR_INVALID_ARG_TYPE` unless `value` is a boolean. */
export function validateBoolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw invalidArgType(name, "boolean", value);
  }
}

/** Throws `ERR_INVALID_ARG_TYPE` unless `value` is a number (and in range, when given). */
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
    (min !== undefined && value < min) ||
    (max !== undefined && value > max) ||
    ((min !== undefined || max !== undefined) && Number.isNaN(value))
  ) {
    const range =
      min !== undefined && max !== undefined
        ? `>= ${min} && <= ${max}`
        : min !== undefined
          ? `>= ${min}`
          : `<= ${max}`;
    throw outOfRange(name, range, value);
  }
}

/** Throws `ERR_INVALID_ARG_TYPE` unless `value` is an array. */
export function validateArray(value: unknown, name: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw invalidArgType(name, "Array", value);
  }
}

/**
 * Throws `ERR_INVALID_ARG_TYPE` unless `value` is a plain object. `allowArray`
 * and `allowFunction` widen it as Node's `kValidateObjectAllow*` flags do.
 */
export function validateObject(
  value: unknown,
  name: string,
  allowArray = false,
  allowFunction = false,
): asserts value is Record<PropertyKey, unknown> {
  const ok =
    value !== null &&
    (typeof value === "object" || (allowFunction && typeof value === "function")) &&
    (allowArray || !Array.isArray(value));
  if (!ok) {
    throw invalidArgType(name, "Object", value);
  }
}

/** Throws `ERR_INVALID_ARG_VALUE` unless `value` is one of `oneOf`. */
export function validateOneOf(value: unknown, name: string, oneOf: readonly unknown[]): void {
  if (!oneOf.includes(value)) {
    const allowed = oneOf.map((v) => (typeof v === "string" ? `'${v}'` : String(v))).join(", ");
    throw invalidArgValue(name, value, `must be one of: ${allowed}`);
  }
}

/** Throws `ERR_INVALID_ARG_TYPE` unless `value` is an `AbortSignal`. */
export function validateAbortSignal(value: unknown, name: string): asserts value is AbortSignal {
  if (
    value !== undefined &&
    (value === null || typeof value !== "object" || !("aborted" in (value as object)))
  ) {
    throw invalidArgType(name, "AbortSignal", value);
  }
}
