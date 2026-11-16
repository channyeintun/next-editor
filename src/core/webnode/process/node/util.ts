// Owns the `util` builtin module: Node 22's `require("util")`. Inspection and
// formatting come from Node's own inspect (util/inspect.ts); deep equality,
// parseArgs, MIME types and .env parsing live in util/ beside this file.
import { Buffer } from "buffer/";
import { errnoName, errnoTable, systemErrorMessage, type ErrnoCode } from "../../errors";
import { isDeepStrictEqual } from "./util/comparisons";
import {
  customInspectSymbol,
  format,
  formatWithOptions,
  inspect,
  stripVTControlCharacters,
} from "./util/inspect";
import { MIMEParams, MIMEType } from "./util/mime";
import {
  invalidArgType,
  nodeError,
  outOfRange,
  validateAbortSignal,
  validateBoolean,
  validateFunction,
  validateNumber,
  validateObject,
  validateOneOf,
  validateString,
} from "./util/nodeErrors";
import { parseArgs } from "./util/parseArgs";
import { parseEnv } from "./util/parseEnv";
import types, { isDate, isNativeError, isPromise, isRegExp } from "./util_types";

type AnyFunction = (...args: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
type AnyConstructor = new (...args: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any

interface ProcessLike {
  pid?: number;
  env?: Record<string, string | undefined>;
  noDeprecation?: boolean;
  throwDeprecation?: boolean;
  stdout?: unknown;
  emitWarning?: (...args: unknown[]) => void;
  nextTick?: (callback: (...args: unknown[]) => void, ...args: unknown[]) => void;
}

/** The running process object, read when needed: webnode's at runtime, Node's under a test. */
function proc(): ProcessLike | undefined {
  return (globalThis as unknown as { process?: ProcessLike }).process;
}

function nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void {
  const tick = proc()?.nextTick;
  if (typeof tick === "function") {
    tick(callback, ...args);
  } else {
    queueMicrotask(() => callback(...args));
  }
}

// ---------------------------------------------------------------------------
// Warnings and deprecation

/** Emits a warning through `process.emitWarning`, or prints it the way Node would. */
export function emitWarning(
  message: string,
  type: string,
  code: string | undefined,
  ctor: AnyFunction | undefined,
): void {
  const p = proc();
  if (typeof p?.emitWarning === "function") {
    if (code !== undefined) {
      p.emitWarning(message, type, code, ctor);
    } else {
      p.emitWarning(message, type, ctor);
    }
    return;
  }
  if (type === "DeprecationWarning" && p?.noDeprecation) {
    return;
  }
  const warning = new Error(message) as Error & { code?: string };
  warning.name = type;
  if (code !== undefined) {
    warning.code = code;
  }
  if (type === "DeprecationWarning" && p?.throwDeprecation) {
    throw warning;
  }
  console.error(`(node:${p?.pid ?? 0}) ${code ? `[${code}] ` : ""}${type}: ${message}`);
}

const codesWarned = new Set<string>();

/**
 * `util.deprecate(fn, msg, code)`: wraps `fn` to warn once (once per `code`
 * across all wrappers) through `process.emitWarning(msg, "DeprecationWarning", code)`.
 */
export function deprecate<T extends AnyFunction | AnyConstructor>(
  fn: T,
  msg: string,
  code?: string,
): T {
  if (proc()?.noDeprecation === true) {
    return fn;
  }
  if (code !== undefined) {
    validateString(code, "code");
  }
  let warned = false;
  function deprecated(this: unknown, ...args: unknown[]): unknown {
    if (!warned) {
      warned = true;
      if (code !== undefined) {
        if (!codesWarned.has(code)) {
          emitWarning(msg, "DeprecationWarning", code, deprecated);
          codesWarned.add(code);
        }
      } else {
        emitWarning(msg, "DeprecationWarning", undefined, deprecated);
      }
    }
    if (new.target) {
      return Reflect.construct(fn, args, new.target);
    }
    return Reflect.apply(fn as AnyFunction, this, args);
  }
  Object.setPrototypeOf(deprecated, fn);
  if (fn.prototype) {
    deprecated.prototype = fn.prototype;
  }
  return deprecated as unknown as T;
}

// ---------------------------------------------------------------------------
// promisify / callbackify

const kCustomPromisifiedSymbol = Symbol.for("nodejs.util.promisify.custom");

function nullPrototypeDescriptors(fn: object): PropertyDescriptorMap {
  const descriptors = Object.getOwnPropertyDescriptors(fn);
  for (const descriptor of Object.values(descriptors)) {
    Object.setPrototypeOf(descriptor, null);
  }
  return descriptors;
}

/** `util.promisify(original)`, honouring `original[util.promisify.custom]`. */
function promisifyImpl(original: unknown): AnyFunction {
  validateFunction(original, "original");
  const target = original as AnyFunction & { [kCustomPromisifiedSymbol]?: unknown };
  if (target[kCustomPromisifiedSymbol]) {
    const fn = target[kCustomPromisifiedSymbol];
    validateFunction(fn, "util.promisify.custom");
    return Object.defineProperty(fn, kCustomPromisifiedSymbol, {
      value: fn,
      enumerable: false,
      writable: false,
      configurable: true,
    }) as AnyFunction;
  }

  function fn(this: unknown, ...args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      args.push((err: unknown, ...values: unknown[]) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(values[0]);
      });
      const result: unknown = Reflect.apply(target, this, args);
      if (isPromise(result)) {
        emitWarning(
          "Calling promisify on a function that returns a Promise is likely a mistake.",
          "DeprecationWarning",
          "DEP0174",
          undefined,
        );
      }
    });
  }

  Object.setPrototypeOf(fn, Object.getPrototypeOf(target));
  Object.defineProperty(fn, kCustomPromisifiedSymbol, {
    value: fn,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return Object.defineProperties(fn, nullPrototypeDescriptors(target));
}

/** `util.promisify`, with `promisify.custom`. */
export const promisify = Object.assign(promisifyImpl, {
  custom: kCustomPromisifiedSymbol,
}) as typeof promisifyImpl & { readonly custom: typeof kCustomPromisifiedSymbol };

function callbackifyOnRejected(reason: unknown, cb: AnyFunction): unknown {
  if (!reason) {
    const error = nodeError(
      Error,
      "ERR_FALSY_VALUE_REJECTION",
      "Promise was rejected with falsy value",
    ) as Error & { reason?: unknown };
    error.reason = reason;
    reason = error;
  }
  return cb(reason);
}

/** `util.callbackify(original)`: an async function to a Node-style callback function. */
export function callbackify(original: unknown): AnyFunction {
  validateFunction(original, "original");
  const target = original as AnyFunction;
  function callbackified(this: unknown, ...args: unknown[]): void {
    const maybeCb = args.pop();
    validateFunction(maybeCb, "last argument");
    const cb = (maybeCb as AnyFunction).bind(this);
    (Reflect.apply(target, this, args) as Promise<unknown>).then(
      (ret) => nextTick(cb, null, ret),
      (rej) => nextTick(() => callbackifyOnRejected(rej, cb)),
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(target);
  if (typeof descriptors.length?.value === "number") {
    descriptors.length.value++;
  }
  if (typeof descriptors.name?.value === "string") {
    descriptors.name.value += "Callbackified";
  }
  for (const descriptor of Object.values(descriptors)) {
    Object.setPrototypeOf(descriptor, null);
  }
  Object.defineProperties(callbackified, descriptors);
  return callbackified;
}

// ---------------------------------------------------------------------------
// inherits / _extend

/** `util.inherits(ctor, superCtor)`: legacy prototype inheritance, sets `ctor.super_`. */
export function inherits(ctor: unknown, superCtor: unknown): void {
  if (ctor === undefined || ctor === null) {
    throw invalidArgType("ctor", "Function", ctor);
  }
  if (superCtor === undefined || superCtor === null) {
    throw invalidArgType("superCtor", "Function", superCtor);
  }
  const superPrototype = (superCtor as { prototype?: unknown }).prototype;
  if (superPrototype === undefined) {
    throw invalidArgType("superCtor.prototype", "Object", superPrototype);
  }
  Object.defineProperty(ctor, "super_", { value: superCtor, writable: true, configurable: true });
  Object.setPrototypeOf((ctor as { prototype: object }).prototype, superPrototype as object);
}

function extend(target: Record<string, unknown>, source: unknown): Record<string, unknown> {
  if (source === null || typeof source !== "object") {
    return target;
  }
  const keys = Object.keys(source);
  let i = keys.length;
  while (i--) {
    target[keys[i]] = (source as Record<string, unknown>)[keys[i]];
  }
  return target;
}

// ---------------------------------------------------------------------------
// debuglog

let testEnabled: ((section: string) => boolean) | undefined;

function sectionEnabled(section: string): boolean {
  if (testEnabled === undefined) {
    let debugEnv = proc()?.env?.NODE_DEBUG;
    if (debugEnv) {
      debugEnv = debugEnv
        .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
        .replaceAll("*", ".*")
        .replaceAll(",", "$|^");
      const pattern = new RegExp(`^${debugEnv}$`, "i");
      testEnabled = (str) => pattern.exec(str) !== null;
    } else {
      testEnabled = () => false;
    }
  }
  return testEnabled(section);
}

const debugImpls: Record<string, AnyFunction> = Object.create(null);

function debuglogImpl(enabled: boolean, set: string): AnyFunction {
  if (debugImpls[set] === undefined) {
    if (enabled) {
      if (set === "HTTP" || set === "HTTP2") {
        emitWarning(
          `Setting the NODE_DEBUG environment variable to '${set.toLowerCase()}' can expose sensitive data (such as passwords, tokens and authentication headers) in the resulting log.`,
          "Warning",
          undefined,
          undefined,
        );
      }
      const pid = proc()?.pid ?? 0;
      debugImpls[set] = function debug(...args: unknown[]) {
        const msg = formatWithOptions({ colors: false }, ...args);
        console.error(format("%s %s: %s", set, inspect(pid, { colors: false }), msg));
      };
    } else {
      debugImpls[set] = () => {};
    }
  }
  return debugImpls[set];
}

/** A `util.debuglog` logger: a function with an `enabled` getter. */
export type DebugLogger = ((...args: unknown[]) => void) & { readonly enabled: boolean };

/**
 * `util.debuglog(section, callback)`: a logger that writes `SECTION PID: message`
 * to stderr when `NODE_DEBUG` names the section.
 */
export function debuglog(set: string, cb?: (fn: AnyFunction) => void): DebugLogger {
  let enabled = false;
  let initialized = false;
  const init = (): void => {
    if (!initialized) {
      initialized = true;
      set = set.toUpperCase();
      enabled = sectionEnabled(set);
    }
  };
  let debug: AnyFunction = (...args: unknown[]) => {
    init();
    debug = debuglogImpl(enabled, set);
    if (typeof cb === "function") {
      cb(debug);
    }
    debug(...args);
  };
  const logger = (...args: unknown[]): void => {
    debug(...args);
  };
  Object.defineProperty(logger, "enabled", {
    get() {
      init();
      return enabled;
    },
    configurable: true,
    enumerable: true,
  });
  return logger as DebugLogger;
}

// ---------------------------------------------------------------------------
// styleText

function isNodeStream(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const v = value as Record<string, unknown>;
  return Boolean(
    v._readableState ||
    v._writableState ||
    (typeof v.write === "function" && typeof v.on === "function") ||
    (typeof v.pipe === "function" && typeof v.on === "function"),
  );
}

function isWebStream(value: unknown): boolean {
  const g = globalThis as unknown as { ReadableStream?: AnyFunction; WritableStream?: AnyFunction };
  return (
    (typeof g.ReadableStream === "function" && value instanceof g.ReadableStream) ||
    (typeof g.WritableStream === "function" && value instanceof g.WritableStream)
  );
}

function shouldColorize(stream: unknown): boolean {
  const forceColor = proc()?.env?.FORCE_COLOR;
  if (forceColor !== undefined) {
    return forceColor !== "0" && forceColor !== "false";
  }
  const s = stream as { isTTY?: boolean; getColorDepth?: () => number } | undefined;
  if (!s?.isTTY) {
    return false;
  }
  return typeof s.getColorDepth === "function" ? s.getColorDepth() > 2 : true;
}

/** `util.styleText(format, text, options)`: wraps `text` in the ANSI codes of `inspect.colors`. */
export function styleText(
  formatName: string | string[],
  text: string,
  { validateStream = true, stream = proc()?.stdout } = {} as {
    validateStream?: boolean;
    stream?: unknown;
  },
): string {
  validateString(text, "text");
  validateBoolean(validateStream, "options.validateStream");
  let skipColorize = false;
  if (validateStream) {
    if (!isNodeStream(stream) && !isWebStream(stream)) {
      throw invalidArgType("stream", ["ReadableStream", "WritableStream", "Stream"], stream);
    }
    skipColorize = !shouldColorize(stream);
  }
  const formats = Array.isArray(formatName) ? formatName : [formatName];
  const colors = inspect.colors as Record<string, [number, number] | undefined>;
  let left = "";
  let right = "";
  for (const key of formats) {
    const codes = colors[key];
    if (codes == null) {
      validateOneOf(key, "format", Object.keys(colors));
    }
    if (skipColorize) {
      continue;
    }
    const [open, close] = codes as [number, number];
    left += `\u001b[${open}m`;
    right = `\u001b[${close}m${right}`;
  }
  return skipColorize ? text : `${left}${text}${right}`;
}

// ---------------------------------------------------------------------------
// System errors

const errnoMessageCache = new Map<number, [string, string]>();

function systemErrorMap(): Map<number, [string, string]> {
  if (errnoMessageCache.size === 0) {
    for (const [code, number] of Object.entries(errnoTable())) {
      // systemErrorMessage gives "CODE: description, syscall".
      const full = systemErrorMessage({ code: code as ErrnoCode, syscall: "" });
      const description = full.slice(code.length + 2, -2);
      errnoMessageCache.set(-number, [code, description]);
    }
  }
  return errnoMessageCache;
}

/** `util.getSystemErrorName(-2)` is `"ENOENT"`. */
export function getSystemErrorName(err: number): string {
  validateNumber(err, "err");
  if (err >= 0 || !Number.isSafeInteger(err)) {
    throw outOfRange("err", "a negative integer", err);
  }
  return errnoName(err) ?? `Unknown system error ${err}`;
}

/** `util.getSystemErrorMap()`: errno → `[name, description]`. */
export function getSystemErrorMap(): Map<number, [string, string]> {
  return new Map(systemErrorMap());
}

function errnoException(err: number, syscall: string, original?: string): Error {
  const code = errnoName(err) ?? `Unknown system error ${err}`;
  const message = original ? `${syscall} ${code} ${original}` : `${syscall} ${code}`;
  return Object.assign(new Error(message), { errno: err, code, syscall });
}

function exceptionWithHostPort(
  err: number,
  syscall: string,
  address: string,
  port?: number,
  additional?: string,
): Error {
  const code = errnoName(err) ?? `Unknown system error ${err}`;
  let details = "";
  if (port && port > 0) {
    details = ` ${address}:${port}`;
  } else if (address) {
    details = ` ${address}`;
  }
  if (additional) {
    details += ` - Local (${additional})`;
  }
  const ex = Object.assign(new Error(`${syscall} ${code}${details}`), {
    errno: err,
    code,
    syscall,
    address,
  }) as Error & { port?: number };
  if (port) {
    ex.port = port;
  }
  return ex;
}

// ---------------------------------------------------------------------------
// Abort helpers

/** `util.aborted(signal, resource)`: resolves when `signal` aborts. */
export async function aborted(signal: AbortSignal, resource: object): Promise<void> {
  if (signal === undefined) {
    throw invalidArgType("signal", "AbortSignal", signal);
  }
  validateAbortSignal(signal, "signal");
  validateObject(resource, "resource", true, true);
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** `util.transferableAbortController()`: an AbortController (every signal can cross threads here). */
export function transferableAbortController(): AbortController {
  return new AbortController();
}

/** `util.transferableAbortSignal(signal)`: returns `signal` after validating it. */
export function transferableAbortSignal(signal: AbortSignal): AbortSignal {
  if (
    signal === null ||
    typeof signal !== "object" ||
    !(typeof AbortSignal === "function" && signal instanceof AbortSignal)
  ) {
    throw invalidArgType("signal", "AbortSignal", signal);
  }
  return signal;
}

// ---------------------------------------------------------------------------
// getCallSites

/** One frame of `util.getCallSites()`. */
export interface CallSite {
  functionName: string;
  scriptName: string;
  scriptId: string;
  lineNumber: number;
  column: number;
  columnNumber: number;
}

const V8_FRAME = /^\s*at (?:(?:async )?(?:new )?(.*?) \()?(.*?):(\d+):(\d+)\)?$/;
const GECKO_FRAME = /^(.*?)@(.*?):(\d+):(\d+)$/;

function parseFrame(line: string): CallSite | null {
  const match = V8_FRAME.exec(line) ?? GECKO_FRAME.exec(line);
  if (match === null) {
    return null;
  }
  const lineNumber = Number(match[3]);
  const column = Number(match[4]);
  return {
    functionName: match[1] ?? "",
    scriptName: match[2],
    scriptId: "0",
    lineNumber,
    column,
    columnNumber: column,
  };
}

/** `util.getCallSites(frameCount)`: the caller's stack, read from `new Error().stack` (best effort). */
export function getCallSites(frameCount: number | object = 10, options?: object): CallSite[] {
  if (typeof frameCount === "object" && frameCount !== null && options === undefined) {
    frameCount = 10;
  }
  validateNumber(frameCount, "frameCount", 1, 200);
  const errorCtor = Error as { stackTraceLimit?: number };
  const previousLimit = errorCtor.stackTraceLimit;
  if (typeof previousLimit === "number") {
    errorCtor.stackTraceLimit = frameCount + 1;
  }
  const stack = new Error().stack ?? "";
  if (typeof previousLimit === "number") {
    errorCtor.stackTraceLimit = previousLimit;
  }
  const frames: CallSite[] = [];
  for (const line of stack.split("\n")) {
    const frame = parseFrame(line);
    if (frame !== null) {
      frames.push(frame);
    }
  }
  // The first frame is getCallSites itself.
  return frames.slice(1, frameCount + 1);
}

// ---------------------------------------------------------------------------
// Legacy type checks and log

/** True for this runtime's `Buffer` (the global one) or the polyfill's. */
function isBuffer(value: unknown): boolean {
  const globalBuffer = (globalThis as { Buffer?: { isBuffer?: (v: unknown) => boolean } }).Buffer;
  if (typeof globalBuffer?.isBuffer === "function" && globalBuffer.isBuffer(value)) {
    return true;
  }
  return Buffer.isBuffer(value);
}

function timestamp(): string {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const pad = (n: number): string => n.toString().padStart(2, "0");
  const d = new Date();
  const t = [pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join(":");
  return `${d.getDate()} ${months[d.getMonth()]} ${t}`;
}

function legacy<T extends AnyFunction>(fn: T, name: string, instead: string, code: string): T {
  return deprecate(
    fn,
    `The \`util.${name}\` API is deprecated. Please use ${instead} instead.`,
    code,
  );
}

/** `util.toUSVString(string)`: lone surrogates become U+FFFD. */
export function toUSVString(input: unknown): string {
  const str = `${input as string}`;
  const wellFormed = (str as { toWellFormed?: () => string }).toWellFormed;
  if (typeof wellFormed === "function") {
    return wellFormed.call(str);
  }
  return str.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "�",
  );
}

/** The `util` module object. */
const util = {
  _errnoException: errnoException,
  _exceptionWithHostPort: exceptionWithHostPort,
  _extend: legacy(extend, "_extend", "Object.assign()", "DEP0060"),
  callbackify,
  debug: debuglog,
  debuglog,
  deprecate,
  format,
  styleText,
  formatWithOptions,
  getCallSites,
  getSystemErrorMap,
  getSystemErrorName,
  inherits,
  inspect,
  isArray: legacy(Array.isArray, "isArray", "`Array.isArray()`", "DEP0044"),
  isBoolean: legacy(
    (arg: unknown) => typeof arg === "boolean",
    "isBoolean",
    '`typeof arg === "boolean"`',
    "DEP0045",
  ),
  isBuffer: legacy((arg: unknown) => isBuffer(arg), "isBuffer", "`Buffer.isBuffer()`", "DEP0046"),
  isDeepStrictEqual,
  isNull: legacy((arg: unknown) => arg === null, "isNull", "`arg === null`", "DEP0050"),
  isNullOrUndefined: legacy(
    (arg: unknown) => arg === null || arg === undefined,
    "isNullOrUndefined",
    "`arg === null || arg === undefined`",
    "DEP0051",
  ),
  isNumber: legacy(
    (arg: unknown) => typeof arg === "number",
    "isNumber",
    '`typeof arg === "number"`',
    "DEP0052",
  ),
  isString: legacy(
    (arg: unknown) => typeof arg === "string",
    "isString",
    '`typeof arg === "string"`',
    "DEP0056",
  ),
  isSymbol: legacy(
    (arg: unknown) => typeof arg === "symbol",
    "isSymbol",
    '`arg === "symbol"`',
    "DEP0057",
  ),
  isUndefined: legacy(
    (arg: unknown) => arg === undefined,
    "isUndefined",
    "`arg === undefined`",
    "DEP0058",
  ),
  isRegExp: legacy(isRegExp, "isRegExp", "`arg instanceof RegExp`", "DEP0055"),
  isObject: legacy(
    (arg: unknown) => arg !== null && typeof arg === "object",
    "isObject",
    '`arg !== null && typeof arg === "object"`',
    "DEP0053",
  ),
  isDate: legacy(isDate, "isDate", "`arg instanceof Date`", "DEP0047"),
  isError: legacy(
    (arg: unknown) => isNativeError(arg) || arg instanceof Error,
    "isError",
    '`ObjectPrototypeToString(e) === "[object Error]" || e instanceof Error`',
    "DEP0048",
  ),
  isFunction: legacy(
    (arg: unknown) => typeof arg === "function",
    "isFunction",
    '`typeof arg === "function"`',
    "DEP0049",
  ),
  isPrimitive: legacy(
    (arg: unknown) => arg === null || (typeof arg !== "object" && typeof arg !== "function"),
    "isPrimitive",
    '`arg === null || (typeof arg !== "object" && typeof arg !== "function")`',
    "DEP0054",
  ),
  log: deprecate(
    (...args: unknown[]) => {
      console.log("%s - %s", timestamp(), format(...args));
    },
    "The `util.log API is deprecated. Please use console.log() with a custom formatter or a third-party logger instead.",
    "DEP0059",
  ),
  promisify,
  stripVTControlCharacters,
  toUSVString,
  transferableAbortSignal,
  transferableAbortController,
  aborted,
  types,
  parseEnv,
  parseArgs,
  TextDecoder: globalThis.TextDecoder,
  TextEncoder: globalThis.TextEncoder,
  MIMEType,
  MIMEParams,
};

export {
  customInspectSymbol,
  format,
  formatWithOptions,
  inspect,
  isDeepStrictEqual,
  MIMEParams,
  MIMEType,
  parseArgs,
  parseEnv,
  stripVTControlCharacters,
  types,
};

export default util;
