// Node-shaped errors and argument validators for the crypto builtin: the same
// classes, `code`s and messages Node's `internal/errors` and
// `internal/validators` produce, for the checks `crypto` performs.

/** An `Error` (or subclass) carrying Node's `code`. */
export type CodedError = Error & { code: string };

type ErrorClass = ErrorConstructor | TypeErrorConstructor | RangeErrorConstructor;

/** Builds `new Base(message)` with `code`, named like Node's internal errors. */
export function codedError(Base: ErrorClass, code: string, message: string): CodedError {
  const error = new Base(message) as CodedError;
  error.code = code;
  return error;
}

function inspectPrimitive(value: unknown): string {
  if (typeof value === "string") {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;
  }
  if (typeof value === "number") {
    return Object.is(value, -0) ? "-0" : String(value);
  }
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  return String(value);
}

/** The "Received ..." tail Node appends to `ERR_INVALID_ARG_TYPE`. */
export function describeReceived(value: unknown): string {
  if (value === null || value === undefined) {
    return ` Received ${value}`;
  }
  if (typeof value === "function") {
    const name = (value as { name?: string }).name;
    return ` Received function ${name || "<anonymous>"}`;
  }
  if (typeof value === "object") {
    const ctor = (value as { constructor?: { name?: string } }).constructor;
    if (ctor?.name) {
      return ` Received an instance of ${ctor.name}`;
    }
    return ` Received ${Object.prototype.toString.call(value)}`;
  }
  let inspected = inspectPrimitive(value);
  if (inspected.length > 28) {
    inspected = `${inspected.slice(0, 25)}...`;
  }
  return ` Received type ${typeof value} (${inspected})`;
}

function addNumericalSeparator(text: string): string {
  let result = "";
  let i = text.length;
  const start = text[0] === "-" ? 1 : 0;
  for (; i >= start + 4; i -= 3) {
    result = `_${text.slice(i - 3, i)}${result}`;
  }
  return `${text.slice(0, i)}${result}`;
}

function nameKind(name: string): string {
  return name.includes(".") ? "property" : "argument";
}

/** `ERR_INVALID_ARG_TYPE`: `The "<name>" argument must be <expected>. Received ...`. */
export function invalidArgType(name: string, expected: string, value: unknown): CodedError {
  return codedError(
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    `The "${name}" ${nameKind(name)} must be ${expected}.${describeReceived(value)}`,
  );
}

/** `ERR_INVALID_ARG_VALUE`: `The argument '<name>' <reason>. Received <value>`. */
export function invalidArgValue(name: string, value: unknown, reason = "is invalid"): CodedError {
  return codedError(
    TypeError,
    "ERR_INVALID_ARG_VALUE",
    `The ${nameKind(name)} '${name}' ${reason}. Received ${inspectPrimitive(value)}`,
  );
}

/** `ERR_OUT_OF_RANGE`: `The value of "<name>" is out of range. It must be <range>. Received <value>`. */
export function outOfRange(name: string, range: string, value: unknown): CodedError {
  let received: string;
  if (typeof value === "number" && Number.isInteger(value) && Math.abs(value) > 2 ** 32) {
    received = addNumericalSeparator(String(value));
  } else if (typeof value === "bigint") {
    received = `${value}n`;
  } else {
    received = inspectPrimitive(value);
  }
  return codedError(
    RangeError,
    "ERR_OUT_OF_RANGE",
    `The value of "${name}" is out of range. It must be ${range}. Received ${received}`,
  );
}

/** `validateFunction`. */
export function validateFunction(value: unknown, name: string): asserts value is Function {
  if (typeof value !== "function") {
    throw invalidArgType(name, "of type function", value);
  }
}

/** `validateString`. */
export function validateString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") {
    throw invalidArgType(name, "of type string", value);
  }
}

/** `validateBoolean`. */
export function validateBoolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw invalidArgType(name, "of type boolean", value);
  }
}

/** `validateObject` with Node's default options (no null, no arrays, no functions). */
export function validateObject(value: unknown, name: string): asserts value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidArgType(name, "of type object", value);
  }
}

/** `validateNumber`: a number (NaN allowed unless the range rejects it). */
export function validateNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number") {
    throw invalidArgType(name, "of type number", value);
  }
}

/** `validateInteger`: a safe integer in `[min, max]`. */
export function validateInteger(
  value: unknown,
  name: string,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  validateNumber(value, name);
  if (!Number.isInteger(value)) {
    throw outOfRange(name, "an integer", value);
  }
  if (value < min || value > max) {
    throw outOfRange(name, `>= ${min} && <= ${max}`, value);
  }
}

/** `validateInt32`. */
export function validateInt32(
  value: unknown,
  name: string,
  min = -2147483648,
  max = 2147483647,
): asserts value is number {
  validateInteger(value, name, min, max);
}

/** `validateUint32`. */
export function validateUint32(value: unknown, name: string): asserts value is number {
  validateInteger(value, name, 0, 4294967295);
}

/** The error a member webnode cannot provide throws when it is called. */
export function unavailable(name: string): CodedError {
  return codedError(
    Error,
    "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
    `crypto.${name} is not available in webnode`,
  );
}

/**
 * An OpenSSL error as Node surfaces it: `error:<hex>:<library>::<reason>`,
 * with `library`, `reason` and `code` (`ERR_OSSL_<prefix><REASON>`; the prefix
 * is OpenSSL's library tag, e.g. `EVP_` for "digital envelope routines").
 */
export function opensslError(
  hex: string,
  library: string,
  reason: string,
  codePrefix = "",
): CodedError {
  const error = new Error(`error:${hex}:${library}::${reason}`) as CodedError & {
    library: string;
    reason: string;
  };
  error.library = library;
  error.reason = reason;
  error.code = `ERR_OSSL_${codePrefix}${reason.toUpperCase().replace(/ /g, "_")}`;
  return error;
}
