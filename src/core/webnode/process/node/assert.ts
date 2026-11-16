// Owns the `assert` builtin module: Node 22's `require("assert")`, a function
// with the legacy (loose) members, and `assert.strict`, where `equal` is
// `strictEqual` and so on. Deep comparisons use util/comparisons.ts.
import { AssertionError, type AssertionErrorOptions } from "./util/assertionError";
import { isDeepEqual, isDeepStrictEqual } from "./util/comparisons";
import { inspect } from "./util/inspect";
import {
  determineSpecificType,
  invalidArgType,
  invalidArgValue,
  missingArgs,
  nodeError,
  validateFunction,
} from "./util/nodeErrors";
import { isNativeError, isPromise, isRegExp } from "./util_types";
import { emitWarning } from "./util";

type AnyFunction = (...args: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Message = string | Error | undefined;
type ErrorMatcher = RegExp | AnyFunction | object | string;

const NO_EXCEPTION_SENTINEL = {};

function innerFail(obj: AssertionErrorOptions): never {
  if (obj.message instanceof Error) {
    throw obj.message;
  }
  throw new AssertionError(obj);
}

function isError(value: unknown): value is Error {
  return isNativeError(value) || value instanceof Error;
}

function innerOk(fn: AnyFunction, argLen: number, value: unknown, message: Message): void {
  if (!value) {
    let generatedMessage = false;
    if (argLen === 0) {
      generatedMessage = true;
      message = "No value argument passed to `assert.ok()`";
    } else if (message == null) {
      // Node prints the failing source expression here; this runtime does not
      // read source text, so the message falls back to `value == true`.
      generatedMessage = true;
    } else if (isError(message)) {
      throw message;
    }
    const err = new AssertionError({
      actual: value,
      expected: true,
      message: message as string | undefined,
      operator: "==",
      stackStartFn: fn,
    });
    err.generatedMessage = generatedMessage;
    throw err;
  }
}

/** `assert(value, message)` and `assert.ok`. */
function ok(...args: unknown[]): void {
  innerOk(ok, args.length, args[0], args[1] as Message);
}

/** The assert module: `assert(value, message)` plus its members. */
const assert = ok as typeof ok & Record<string, unknown>;

let failWarned = false;

function fail(
  actual?: unknown,
  expected?: unknown,
  message?: Message,
  operator?: string,
  stackStartFn?: AnyFunction,
): never {
  const argsLen = arguments.length;
  let internalMessage = false;
  if (actual == null && argsLen <= 1) {
    internalMessage = true;
    message = "Failed";
  } else if (argsLen === 1) {
    message = actual as Message;
    actual = undefined;
  } else {
    if (!failWarned) {
      failWarned = true;
      emitWarning(
        "assert.fail() with more than one argument is deprecated. Please use assert.strictEqual() instead or only pass a message.",
        "DeprecationWarning",
        "DEP0094",
        undefined,
      );
    }
    if (argsLen === 2) {
      operator = "!=";
    }
  }
  if (message instanceof Error) {
    throw message;
  }
  const err = new AssertionError({
    actual,
    expected,
    operator: operator === undefined ? "fail" : operator,
    stackStartFn: stackStartFn || fail,
    message,
  });
  if (internalMessage) {
    err.generatedMessage = true;
  }
  throw err;
}

function equal(actual: unknown, expected: unknown, message?: Message): void {
  if (arguments.length < 2) {
    throw missingArgs("actual", "expected");
  }
  // eslint-disable-next-line eqeqeq
  if (actual != expected && (!Number.isNaN(actual) || !Number.isNaN(expected))) {
    innerFail({ actual, expected, message, operator: "==", stackStartFn: equal });
  }
}

function notEqual(actual: unknown, expected: unknown, message?: Message): void {
  if (arguments.length < 2) {
    throw missingArgs("actual", "expected");
  }
  // eslint-disable-next-line eqeqeq
  if (actual == expected || (Number.isNaN(actual) && Number.isNaN(expected))) {
    innerFail({ actual, expected, message, operator: "!=", stackStartFn: notEqual });
  }
}

function deepEqual(actual: unknown, expected: unknown, message?: Message): void {
  if (arguments.length < 2) {
    throw missingArgs("actual", "expected");
  }
  if (!isDeepEqual(actual, expected)) {
    innerFail({ actual, expected, message, operator: "deepEqual", stackStartFn: deepEqual });
  }
}

function notDeepEqual(actual: unknown, expected: unknown, message?: Message): void {
  if (arguments.length < 2) {
    throw missingArgs("actual", "expected");
  }
  if (isDeepEqual(actual, expected)) {
    innerFail({ actual, expected, message, operator: "notDeepEqual", stackStartFn: notDeepEqual });
  }
}

function deepStrictEqual(actual: unknown, expected: unknown, message?: Message): void {
  if (arguments.length < 2) {
    throw missingArgs("actual", "expected");
  }
  if (!isDeepStrictEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: "deepStrictEqual",
      stackStartFn: deepStrictEqual,
    });
  }
}

function notDeepStrictEqual(actual: unknown, expected: unknown, message?: Message): void {
  if (arguments.length < 2) {
    throw missingArgs("actual", "expected");
  }
  if (isDeepStrictEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: "notDeepStrictEqual",
      stackStartFn: notDeepStrictEqual,
    });
  }
}

function strictEqual(actual: unknown, expected: unknown, message?: Message): void {
  if (arguments.length < 2) {
    throw missingArgs("actual", "expected");
  }
  if (!Object.is(actual, expected)) {
    innerFail({ actual, expected, message, operator: "strictEqual", stackStartFn: strictEqual });
  }
}

function notStrictEqual(actual: unknown, expected: unknown, message?: Message): void {
  if (arguments.length < 2) {
    throw missingArgs("actual", "expected");
  }
  if (Object.is(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: "notStrictEqual",
      stackStartFn: notStrictEqual,
    });
  }
}

function partialDeepStrictEqual(): never {
  throw nodeError(
    Error,
    "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
    "assert.partialDeepStrictEqual is not supported by this runtime",
  );
}

// Validation-object comparisons: copies of the compared keys only, so the
// diff shows what was checked.
class Comparison {
  constructor(obj: Record<PropertyKey, unknown>, keys: PropertyKey[], actual?: unknown) {
    const self = this as unknown as Record<PropertyKey, unknown>;
    for (const key of keys) {
      if (key in obj) {
        const actualValue =
          actual !== undefined ? (actual as Record<PropertyKey, unknown>)[key] : undefined;
        const expectedValue = obj[key];
        if (
          actual !== undefined &&
          typeof actualValue === "string" &&
          isRegExp(expectedValue) &&
          expectedValue.exec(actualValue) !== null
        ) {
          self[key] = actualValue;
        } else {
          self[key] = expectedValue;
        }
      }
    }
  }
}

function compareExceptionKey(
  actual: Record<PropertyKey, unknown>,
  expected: Record<PropertyKey, unknown>,
  key: PropertyKey,
  message: Message,
  keys: PropertyKey[],
  fn: AnyFunction,
): void {
  if (!(key in actual) || !isDeepStrictEqual(actual[key], expected[key])) {
    if (!message) {
      const a = new Comparison(actual, keys);
      const b = new Comparison(expected, keys, actual);
      const err = new AssertionError({
        actual: a,
        expected: b,
        operator: "deepStrictEqual",
        stackStartFn: fn,
      });
      err.actual = actual;
      err.expected = expected;
      err.operator = fn.name;
      throw err;
    }
    innerFail({ actual, expected, message, operator: fn.name, stackStartFn: fn });
  }
}

function expectedException(
  actual: unknown,
  expected: ErrorMatcher,
  message: Message,
  fn: AnyFunction,
): void {
  let generatedMessage = false;
  let throwError = false;

  if (typeof expected !== "function") {
    if (isRegExp(expected)) {
      const str = String(actual);
      if (expected.exec(str) !== null) {
        return;
      }
      if (!message) {
        generatedMessage = true;
        message = `The input did not match the regular expression ${inspect(expected)}. Input:\n\n${inspect(str)}\n`;
      }
      throwError = true;
    } else if (typeof actual !== "object" || actual === null) {
      const err = new AssertionError({
        actual,
        expected,
        message: message as string | undefined,
        operator: "deepStrictEqual",
        stackStartFn: fn,
      });
      err.operator = fn.name;
      throw err;
    } else {
      const expectedObject = expected as Record<PropertyKey, unknown>;
      const keys: PropertyKey[] = Object.keys(expectedObject);
      if (expected instanceof Error) {
        keys.push("name", "message");
      } else if (keys.length === 0) {
        throw invalidArgValue("error", expected, "may not be an empty object");
      }
      const actualObject = actual as Record<PropertyKey, unknown>;
      for (const key of keys) {
        const expectedValue = expectedObject[key];
        if (
          typeof actualObject[key] === "string" &&
          isRegExp(expectedValue) &&
          expectedValue.exec(actualObject[key] as string) !== null
        ) {
          continue;
        }
        compareExceptionKey(actualObject, expectedObject, key, message, keys, fn);
      }
      return;
    }
  } else if (expected.prototype !== undefined && actual instanceof expected) {
    return;
  } else if (Object.prototype.isPrototypeOf.call(Error, expected)) {
    if (!message) {
      generatedMessage = true;
      message = `The error is expected to be an instance of "${expected.name}". Received `;
      if (isError(actual)) {
        const name = (actual.constructor as { name?: string } | undefined)?.name || actual.name;
        if (expected.name === name) {
          message += "an error with identical name but a different prototype.";
        } else {
          message += `"${name}"`;
        }
        if (actual.message) {
          message += `\n\nError message:\n\n${actual.message}`;
        }
      } else {
        message += `"${inspect(actual, { depth: -1 })}"`;
      }
    }
    throwError = true;
  } else {
    const res: unknown = Reflect.apply(expected, {}, [actual]);
    if (res !== true) {
      if (!message) {
        generatedMessage = true;
        const name = expected.name ? `"${expected.name}" ` : "";
        message = `The ${name}validation function is expected to return "true". Received ${inspect(res)}`;
        if (isError(actual)) {
          message += `\n\nCaught error:\n\n${String(actual)}`;
        }
      }
      throwError = true;
    }
  }

  if (throwError) {
    const err = new AssertionError({
      actual,
      expected,
      message: message as string | undefined,
      operator: fn.name,
      stackStartFn: fn,
    });
    err.generatedMessage = generatedMessage;
    throw err;
  }
}

function getActual(fn: unknown): unknown {
  validateFunction(fn, "fn");
  try {
    (fn as AnyFunction)();
  } catch (e) {
    return e;
  }
  return NO_EXCEPTION_SENTINEL;
}

function checkIsPromise(obj: unknown): obj is PromiseLike<unknown> {
  return (
    isPromise(obj) ||
    (obj !== null &&
      typeof obj === "object" &&
      typeof (obj as { then?: unknown }).then === "function" &&
      typeof (obj as { catch?: unknown }).catch === "function")
  );
}

async function waitForActual(promiseFn: unknown): Promise<unknown> {
  let resultPromise: unknown;
  if (typeof promiseFn === "function") {
    resultPromise = promiseFn();
    if (!checkIsPromise(resultPromise)) {
      const type = determineSpecificType(resultPromise);
      throw nodeError(
        TypeError,
        "ERR_INVALID_RETURN_VALUE",
        `Expected instance of Promise to be returned from the "promiseFn" function but got ${type}.`,
      );
    }
  } else if (checkIsPromise(promiseFn)) {
    resultPromise = promiseFn;
  } else {
    throw invalidArgType("promiseFn", ["Function", "Promise"], promiseFn);
  }
  try {
    await resultPromise;
  } catch (e) {
    return e;
  }
  return NO_EXCEPTION_SENTINEL;
}

function expectsError(
  stackStartFn: AnyFunction,
  actual: unknown,
  ...rest: [error?: ErrorMatcher, message?: Message]
): void {
  let [error, message] = rest;
  if (typeof error === "string") {
    if (rest.length === 2) {
      throw invalidArgType("error", ["Object", "Error", "Function", "RegExp"], error);
    }
    if (typeof actual === "object" && actual !== null) {
      if ((actual as { message?: unknown }).message === error) {
        throw nodeError(
          TypeError,
          "ERR_AMBIGUOUS_ARGUMENT",
          `The "error/message" argument is ambiguous. The error message "${String((actual as { message?: unknown }).message)}" is identical to the message.`,
        );
      }
    } else if (actual === error) {
      throw nodeError(
        TypeError,
        "ERR_AMBIGUOUS_ARGUMENT",
        `The "error/message" argument is ambiguous. The error "${String(actual)}" is identical to the message.`,
      );
    }
    message = error;
    error = undefined;
  } else if (error != null && typeof error !== "object" && typeof error !== "function") {
    throw invalidArgType("error", ["Object", "Error", "Function", "RegExp"], error);
  }

  if (actual === NO_EXCEPTION_SENTINEL) {
    let details = "";
    const errorName = (error as { name?: unknown } | undefined)?.name;
    if (errorName) {
      details += ` (${String(errorName)})`;
    }
    details += message ? `: ${String(message)}` : ".";
    const fnType = stackStartFn === rejects ? "rejection" : "exception";
    innerFail({
      actual: undefined,
      expected: error,
      operator: stackStartFn.name,
      message: `Missing expected ${fnType}${details}`,
      stackStartFn,
    });
  }

  if (!error) {
    return;
  }
  expectedException(actual, error, message, stackStartFn);
}

function hasMatchingError(actual: unknown, expected: unknown): boolean {
  if (typeof expected !== "function") {
    if (isRegExp(expected)) {
      return expected.exec(String(actual)) !== null;
    }
    throw invalidArgType("expected", ["Function", "RegExp"], expected);
  }
  if (expected.prototype !== undefined && actual instanceof expected) {
    return true;
  }
  if (Object.prototype.isPrototypeOf.call(Error, expected)) {
    return false;
  }
  return Reflect.apply(expected, {}, [actual]) === true;
}

function expectsNoError(
  stackStartFn: AnyFunction,
  actual: unknown,
  error?: ErrorMatcher,
  message?: Message,
): void {
  if (actual === NO_EXCEPTION_SENTINEL) {
    return;
  }
  if (typeof error === "string") {
    message = error;
    error = undefined;
  }
  if (!error || hasMatchingError(actual, error)) {
    const details = message ? `: ${String(message)}` : ".";
    const fnType = stackStartFn === doesNotReject ? "rejection" : "exception";
    innerFail({
      actual,
      expected: error,
      operator: stackStartFn.name,
      message: `Got unwanted ${fnType}${details}\nActual message: "${String((actual as { message?: unknown } | null | undefined)?.message)}"`,
      stackStartFn,
    });
  }
  throw actual;
}

function throws(fn: unknown, ...args: [error?: ErrorMatcher, message?: Message]): void {
  expectsError(throws, getActual(fn), ...args);
}

async function rejects(
  promiseFn: unknown,
  ...args: [error?: ErrorMatcher, message?: Message]
): Promise<void> {
  expectsError(rejects, await waitForActual(promiseFn), ...args);
}

function doesNotThrow(fn: unknown, error?: ErrorMatcher, message?: Message): void {
  expectsNoError(doesNotThrow, getActual(fn), error, message);
}

async function doesNotReject(fn: unknown, error?: ErrorMatcher, message?: Message): Promise<void> {
  expectsNoError(doesNotReject, await waitForActual(fn), error, message);
}

function ifError(err: unknown): void {
  if (err !== null && err !== undefined) {
    let message = "ifError got unwanted exception: ";
    const errObject = err as { message?: unknown; constructor?: { name?: string } };
    if (typeof err === "object" && typeof errObject.message === "string") {
      if (errObject.message.length === 0 && errObject.constructor) {
        message += errObject.constructor.name;
      } else {
        message += errObject.message;
      }
    } else {
      message += inspect(err);
    }
    const newErr = new AssertionError({
      actual: err,
      expected: null,
      operator: "ifError",
      message,
      stackStartFn: ifError,
    });
    const origStack = (err as { stack?: unknown }).stack;
    if (typeof origStack === "string" && typeof newErr.stack === "string") {
      // Keep the new frames up to the first one the original error shares,
      // then append the original error's frames.
      const origStackStart = origStack.indexOf("\n    at");
      if (origStackStart !== -1) {
        const originalFrames = origStack.slice(origStackStart + 1).split("\n");
        let newFrames = newErr.stack.split("\n");
        for (const errFrame of originalFrames) {
          const pos = newFrames.indexOf(errFrame);
          if (pos !== -1) {
            newFrames = newFrames.slice(0, pos);
            break;
          }
        }
        newErr.stack = `${newFrames.join("\n")}\n${originalFrames.join("\n")}`;
      }
    }
    throw newErr;
  }
}

function internalMatch(string: unknown, regexp: unknown, message: Message, fn: AnyFunction): void {
  if (!isRegExp(regexp)) {
    throw invalidArgType("regexp", "RegExp", regexp);
  }
  const shouldMatch = fn === match;
  if (typeof string !== "string" || (regexp.exec(string) !== null) !== shouldMatch) {
    if (message instanceof Error) {
      throw message;
    }
    const generatedMessage = !message;
    message =
      message ||
      (typeof string !== "string"
        ? `The "string" argument must be of type string. Received type ${typeof string} (${inspect(string)})`
        : `${shouldMatch ? "The input did not match the regular expression " : "The input was expected to not match the regular expression "}${inspect(regexp)}. Input:\n\n${inspect(string)}\n`);
    const err = new AssertionError({
      actual: string,
      expected: regexp,
      message,
      operator: fn.name,
      stackStartFn: fn,
    });
    err.generatedMessage = generatedMessage;
    throw err;
  }
}

function match(string: unknown, regexp: RegExp, message?: Message): void {
  internalMatch(string, regexp, message, match);
}

function doesNotMatch(string: unknown, regexp: RegExp, message?: Message): void {
  internalMatch(string, regexp, message, doesNotMatch);
}

/** `assert.CallTracker`: deprecated in Node and not provided here. */
class CallTracker {
  constructor() {
    throw nodeError(
      Error,
      "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
      "assert.CallTracker is not supported by this runtime",
    );
  }
}

Object.assign(assert, {
  AssertionError,
  ok,
  fail,
  equal,
  notEqual,
  deepEqual,
  notDeepEqual,
  deepStrictEqual,
  notDeepStrictEqual,
  strictEqual,
  notStrictEqual,
  partialDeepStrictEqual,
  match,
  doesNotMatch,
  throws,
  rejects,
  doesNotThrow,
  doesNotReject,
  ifError,
  CallTracker,
});

/** `assert.strict`: the module again, with the comparisons all strict. */
function strict(...args: unknown[]): void {
  innerOk(strict, args.length, args[0], args[1] as Message);
}

const strictAssert = Object.assign(strict, assert, {
  equal: strictEqual,
  deepEqual: deepStrictEqual,
  notEqual: notStrictEqual,
  notDeepEqual: notDeepStrictEqual,
}) as typeof strict & Record<string, unknown>;
strictAssert.strict = strictAssert;
assert.strict = strictAssert;

/** The typed shape of `require("assert")`. */
export interface AssertModule {
  (value: unknown, message?: Message): asserts value;
  AssertionError: typeof AssertionError;
  ok(value: unknown, message?: Message): asserts value;
  fail(message?: Message): never;
  equal(actual: unknown, expected: unknown, message?: Message): void;
  notEqual(actual: unknown, expected: unknown, message?: Message): void;
  deepEqual(actual: unknown, expected: unknown, message?: Message): void;
  notDeepEqual(actual: unknown, expected: unknown, message?: Message): void;
  deepStrictEqual(actual: unknown, expected: unknown, message?: Message): void;
  notDeepStrictEqual(actual: unknown, expected: unknown, message?: Message): void;
  strictEqual(actual: unknown, expected: unknown, message?: Message): void;
  notStrictEqual(actual: unknown, expected: unknown, message?: Message): void;
  partialDeepStrictEqual(actual: unknown, expected: unknown, message?: Message): void;
  match(value: unknown, regexp: RegExp, message?: Message): void;
  doesNotMatch(value: unknown, regexp: RegExp, message?: Message): void;
  throws(fn: () => unknown, error?: ErrorMatcher, message?: Message): void;
  rejects(
    fn: (() => PromiseLike<unknown>) | PromiseLike<unknown>,
    error?: ErrorMatcher,
    message?: Message,
  ): Promise<void>;
  doesNotThrow(fn: () => unknown, error?: ErrorMatcher, message?: Message): void;
  doesNotReject(
    fn: (() => PromiseLike<unknown>) | PromiseLike<unknown>,
    error?: ErrorMatcher,
    message?: Message,
  ): Promise<void>;
  ifError(value: unknown): void;
  CallTracker: new () => never;
  strict: AssertModule;
}

export { AssertionError };

export default assert as unknown as AssertModule;
