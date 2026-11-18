// The `vm` builtin. `runInThisContext` and `compileFunction` are exact: code
// is evaluated by the engine with a `//# sourceURL=<filename>` appended, so its
// own line numbers are unchanged and stack traces and devtools name the file.
//
// Contexts are emulated: a worker has one global, so there is no second realm.
// `runInContext` evaluates the code with a direct `eval` inside a `with` block
// over a Proxy of the context object; the code's `this` and `globalThis` are
// the context object. What differs from Node:
// - There are no separate intrinsics: `Array`, `Object`, `Error`… are the real
//   ones, so `instanceof` across the boundary is always true.
// - Reads fall back to the real globals (`process`, `setTimeout`, … are visible
//   unless the context object shadows them); a read of a name defined nowhere
//   gives `undefined` instead of throwing `ReferenceError`.
// - Writes to undeclared names, and top-level `var` initialisers, land on the
//   context object, as in Node.
// - Top-level `var` and function declarations are copied onto the context
//   object after the run, for the declarations a light scan of the source finds
//   at the top level (statement position, outside any bracket). One that the
//   scan misses stays local to that run.
// - Top-level `let`/`const`/`class` do not persist between runs (in Node they
//   live on in the context's global lexical scope).
// - Code is always run sloppy unless it starts with its own "use strict"
//   directive; `timeout`, `breakOnSigint` and `microtaskMode` have no effect
//   (nothing can interrupt synchronous code in a worker): the first `timeout`
//   or `breakOnSigint` a program passes gets a warning saying so.
//
// `import()` in the code is the one its `importModuleDynamically` option asks
// for, as in Node: the code is rewritten (loader/transform.ts) to call it.
// Without the option it rejects; `USE_MAIN_CONTEXT_DEFAULT_LOADER` loads
// through the loader; a function is called only behind
// `--experimental-vm-modules`, which webnode does not have, so it rejects too.
import { defineEvaluatedImporter, importThroughLoader } from "../loader/evaluated";
import { EVALUATED_BINDING, rewriteEvaluated, sourceUrlComment } from "../loader/transform";
import { runtime } from "../runtime";
import { Buffer } from "./buffer";
import {
  invalidArgType,
  kValidateObjectAllowArray,
  kValidateObjectAllowFunction,
  makeNodeError,
  validateObject,
  validateString,
} from "./internalErrors";

type Global = Record<PropertyKey, unknown>;

function unavailable(name: string): Error {
  return makeNodeError(
    "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
    `vm.${name} is not available in webnode`,
  );
}

const DEFAULT_FILENAME = "evalmachine.<anonymous>";

/** `vm.constants`. */
export const constants = Object.freeze({
  USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol("vm_dynamic_import_main_context_default"),
  DONT_CONTEXTIFY: Symbol("vm_context_no_contextify"),
});

/** The names under which the `import()`s of compiled code are defined (`defineEvaluatedImporter`). */
const IMPORT_WITHOUT_CALLBACK = "vm:no-callback";
const IMPORT_THROUGH_CALLBACK = "vm:callback";
const IMPORT_THROUGH_MAIN_LOADER = "vm:main-context-loader";

defineEvaluatedImporter(IMPORT_WITHOUT_CALLBACK, () =>
  Promise.reject(
    makeNodeError(
      "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING",
      "A dynamic import callback was not specified.",
      TypeError,
    ),
  ),
);
defineEvaluatedImporter(IMPORT_THROUGH_CALLBACK, () =>
  Promise.reject(
    makeNodeError(
      "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG",
      "A dynamic import callback was invoked without --experimental-vm-modules",
      TypeError,
    ),
  ),
);
let warnedMainLoader = false;
defineEvaluatedImporter(IMPORT_THROUGH_MAIN_LOADER, (specifier, parent) => {
  if (!warnedMainLoader) {
    warnedMainLoader = true;
    const process = (
      globalThis as { process?: { emitWarning?: (message: string, type: string) => void } }
    ).process;
    process?.emitWarning?.(
      "vm.USE_MAIN_CONTEXT_DEFAULT_LOADER is an experimental feature and might change at any time",
      "ExperimentalWarning",
    );
  }
  return importThroughLoader(specifier, parent);
});

/** The `import()` that code compiled with this `importModuleDynamically` option gets. */
function importerFor(option: unknown): string {
  if (option === undefined) {
    return IMPORT_WITHOUT_CALLBACK;
  }
  if (option === constants.USE_MAIN_CONTEXT_DEFAULT_LOADER) {
    return IMPORT_THROUGH_MAIN_LOADER;
  }
  if (typeof option !== "function") {
    throw invalidArgType("options.importModuleDynamically", "function", option);
  }
  return IMPORT_THROUGH_CALLBACK;
}

/**
 * The file compiled code imports from: its `filename` when that is an
 * absolute path, the working directory otherwise, as in Node.
 */
function importingFile(filename: string | undefined): string {
  return filename !== undefined && filename.startsWith("/") ? filename : `${runtime().cwd}/[eval]`;
}

/** `code` with its `import()` and its evals rewritten for the `importModuleDynamically` option (`importerFor`). */
function withImporter(code: string, filename: string | undefined, importer: string): string {
  return rewriteEvaluated(code, () => importingFile(filename), importer) ?? code;
}

/** The options `Script` and the `run*` functions take. */
export interface ScriptOptions {
  filename?: string;
  lineOffset?: number;
  columnOffset?: number;
  cachedData?: ArrayBufferView;
  produceCachedData?: boolean;
  displayErrors?: boolean;
  timeout?: number;
  breakOnSigint?: boolean;
  importModuleDynamically?: unknown;
}

function readOptions(options: unknown): ScriptOptions {
  if (typeof options === "string") {
    return { filename: options };
  }
  if (options === undefined) {
    return {};
  }
  validateObject(options, "options");
  const read = options as ScriptOptions;
  if (read.filename !== undefined) {
    validateString(read.filename, "options.filename");
  }
  for (const name of ["lineOffset", "columnOffset", "timeout"] as const) {
    const value = read[name];
    if (value !== undefined && typeof value !== "number") {
      throw invalidArgType(`options.${name}`, "number", value);
    }
  }
  warnIfInterruptible(read);
  importerFor(read.importModuleDynamically);
  if (read.cachedData !== undefined && !ArrayBuffer.isView(read.cachedData)) {
    throw invalidArgType(
      "options.cachedData",
      ["Buffer", "TypedArray", "DataView"],
      read.cachedData,
    );
  }
  return read;
}

let warnedInterruptible = false;

/**
 * Warns, once, that `timeout` and `breakOnSigint` cannot stop the code: a
 * program that counts on them to end a runaway loop would otherwise hang
 * without a word.
 */
function warnIfInterruptible(options: ScriptOptions | undefined): void {
  if (
    warnedInterruptible ||
    options === undefined ||
    options === null ||
    typeof options !== "object" ||
    (!(typeof options.timeout === "number" && options.timeout > 0) &&
      options.breakOnSigint !== true)
  ) {
    return;
  }
  warnedInterruptible = true;
  const process = (globalThis as { process?: { emitWarning?: (message: string) => void } }).process;
  process?.emitWarning?.(
    "vm: the timeout and breakOnSigint options have no effect in webnode; the code runs until it ends",
  );
}

function sourceUrlSuffix(filename: string): string {
  return sourceUrlComment(filename);
}

/**
 * The code as the engine sees it: `lineOffset` blank lines first, then the
 * source, with the `import()` its options ask for, and its sourceURL.
 */
function prepare(code: string, options: ScriptOptions): string {
  const lineOffset = Math.trunc(options.lineOffset ?? 0);
  const prefix = lineOffset > 0 ? "\n".repeat(lineOffset) : "";
  const source = withImporter(code, options.filename, importerFor(options.importModuleDynamically));
  return prefix + source + sourceUrlSuffix(options.filename ?? DEFAULT_FILENAME);
}

// Evaluating code is what `vm` is for.
// eslint-disable-next-line no-eval
const indirectEval = globalThis.eval;

// ---------------------------------------------------------------------------
// Top-level declaration scan

const IDENTIFIER_START = /[A-Za-z_$\u0080-￿]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$\u0080-￿]/;
/** Keywords after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/** The names declared by top-level `var` statements and function declarations in `code`. */
export function scanTopLevelDeclarations(code: string): {
  vars: Set<string>;
  functions: Set<string>;
} {
  const vars = new Set<string>();
  const functions = new Set<string>();
  // One entry per open bracket; "t" marks a `${` inside a template literal.
  const stack: string[] = [];
  let i = 0;
  const n = code.length;
  /** The last significant token: a word, a punctuator, or "" at the start. */
  let last = "";
  let lastKind: "start" | "word" | "value" | "punct" = "start";
  let newlineSinceLast = false;

  const skipString = (quote: string): void => {
    i++;
    while (i < n && code[i] !== quote) {
      if (code[i] === "\\") {
        i++;
      } else if (code[i] === "\n") {
        break;
      }
      i++;
    }
    i++;
  };
  /** Skips template text up to the closing backtick or a `${` (pushed on the stack). */
  const skipTemplate = (): void => {
    while (i < n) {
      const char = code[i];
      if (char === "\\") {
        i += 2;
      } else if (char === "`") {
        i++;
        return;
      } else if (char === "$" && code[i + 1] === "{") {
        i += 2;
        stack.push("t");
        return;
      } else {
        i++;
      }
    }
  };
  const skipRegex = (): void => {
    i++;
    let inClass = false;
    while (i < n) {
      const char = code[i];
      if (char === "\\") {
        i += 2;
        continue;
      }
      if (char === "\n") {
        return;
      }
      i++;
      if (inClass) {
        if (char === "]") {
          inClass = false;
        }
      } else if (char === "[") {
        inClass = true;
      } else if (char === "/") {
        break;
      }
    }
    while (i < n && IDENTIFIER_PART.test(code[i])) {
      i++;
    }
  };
  /** Skips whitespace and comments; reports whether a newline was crossed. */
  const skipTrivia = (): boolean => {
    let crossed = false;
    while (i < n) {
      const char = code[i];
      if (char === "\n" || char === "\r" || char === " " || char === " ") {
        crossed = true;
        i++;
      } else if (
        char === " " ||
        char === "\t" ||
        char === "\v" ||
        char === "\f" ||
        char === "﻿" ||
        char === " "
      ) {
        i++;
      } else if (char === "/" && code[i + 1] === "/") {
        while (i < n && code[i] !== "\n") {
          i++;
        }
      } else if (char === "/" && code[i + 1] === "*") {
        const end = code.indexOf("*/", i + 2);
        const body = code.slice(i, end === -1 ? n : end);
        if (body.includes("\n")) {
          crossed = true;
        }
        i = end === -1 ? n : end + 2;
      } else {
        break;
      }
    }
    return crossed;
  };
  const readWord = (): string => {
    const start = i;
    i++;
    while (i < n && IDENTIFIER_PART.test(code[i])) {
      i++;
    }
    return code.slice(start, i);
  };
  const atStatementStart = (): boolean =>
    lastKind === "start" ||
    last === ";" ||
    last === "}" ||
    (newlineSinceLast &&
      (lastKind === "word" || lastKind === "value" || last === ")" || last === "]"));

  /** Reads the binding names of a `var` declaration list, leaving `i` after it. */
  const readVarDeclarations = (): void => {
    const base = stack.length;
    let expectBinding = true;
    let patternDepth = 0;
    let prev = "";
    for (;;) {
      const crossed = skipTrivia();
      if (i >= n) {
        return;
      }
      const char = code[i];
      if (patternDepth === 0 && !expectBinding && stack.length === base && crossed) {
        // A newline ends the declaration unless the next line continues the list.
        if (char !== ",") {
          return;
        }
      }
      if (IDENTIFIER_START.test(char)) {
        const word = readWord();
        if (expectBinding && patternDepth === 0) {
          vars.add(word);
          expectBinding = false;
        } else if (
          patternDepth > 0 &&
          (prev === "{" || prev === "[" || prev === "," || prev === ":" || prev === "...")
        ) {
          skipTrivia();
          if (code[i] !== ":" && code[i] !== "(") {
            vars.add(word);
          }
        }
        prev = "w";
        continue;
      }
      if (char === '"' || char === "'") {
        skipString(char);
        prev = "v";
        continue;
      }
      if (char === "`") {
        i++;
        skipTemplate();
        prev = "v";
        continue;
      }
      if (char === "." && code.startsWith("...", i)) {
        i += 3;
        prev = "...";
        continue;
      }
      i++;
      if (expectBinding && (char === "{" || char === "[")) {
        patternDepth = 1;
        expectBinding = false;
        prev = char;
        continue;
      }
      if (patternDepth > 0) {
        if (char === "{" || char === "[" || char === "(") {
          // Nested pattern or a default value's own brackets.
          patternDepth++;
          prev = char === "(" ? "(" : char;
        } else if (char === "}" || char === "]" || char === ")") {
          patternDepth--;
          prev = "v";
        } else if (char === "=" && patternDepth > 0) {
          prev = "=";
        } else {
          prev = char;
        }
        continue;
      }
      if (char === "(" || char === "[" || char === "{") {
        stack.push(char);
      } else if (char === ")" || char === "]" || char === "}") {
        if (stack.length === base) {
          i--;
          return;
        }
        stack.pop();
      } else if (stack.length === base) {
        if (char === ";") {
          return;
        }
        if (char === ",") {
          expectBinding = true;
        }
      }
      prev = char;
    }
  };

  while (i < n) {
    newlineSinceLast = skipTrivia() || newlineSinceLast;
    if (i >= n) {
      break;
    }
    const char = code[i];
    if (IDENTIFIER_START.test(char) || char === "\\") {
      const word = readWord();
      const topLevel = stack.length === 0 && last !== "." && last !== "?.";
      if (topLevel && word === "var" && atStatementStart()) {
        readVarDeclarations();
        last = ";";
        lastKind = "punct";
        newlineSinceLast = false;
        continue;
      }
      if (topLevel && word === "function" && (atStatementStart() || last === "async")) {
        skipTrivia();
        if (code[i] === "*") {
          i++;
          skipTrivia();
        }
        if (i < n && IDENTIFIER_START.test(code[i])) {
          functions.add(readWord());
        }
        last = "function";
        lastKind = "punct";
        newlineSinceLast = false;
        continue;
      }
      last = word;
      lastKind = REGEX_AFTER_WORD.has(word) ? "punct" : "word";
      newlineSinceLast = false;
      continue;
    }
    if (char >= "0" && char <= "9") {
      while (i < n && /[0-9A-Za-z_.]/.test(code[i])) {
        i++;
      }
      last = "0";
      lastKind = "value";
      newlineSinceLast = false;
      continue;
    }
    if (char === '"' || char === "'") {
      skipString(char);
      last = '"';
      lastKind = "value";
      newlineSinceLast = false;
      continue;
    }
    if (char === "`") {
      i++;
      skipTemplate();
      last = "`";
      lastKind = "value";
      newlineSinceLast = false;
      continue;
    }
    if (char === "/") {
      const divides =
        lastKind === "word" || lastKind === "value" || last === ")" || last === "]" || last === "}";
      if (!divides) {
        skipRegex();
        last = "/re/";
        lastKind = "value";
        newlineSinceLast = false;
        continue;
      }
    }
    i++;
    if (char === "(" || char === "[" || char === "{") {
      stack.push(char);
    } else if (char === ")" || char === "]") {
      stack.pop();
    } else if (char === "}") {
      if (stack.pop() === "t") {
        skipTemplate();
        last = "`";
        lastKind = "value";
        newlineSinceLast = false;
        continue;
      }
    } else if (char === "?" && code[i] === ".") {
      i++;
      last = "?.";
      lastKind = "punct";
      newlineSinceLast = false;
      continue;
    }
    last = char;
    lastKind = "punct";
    newlineSinceLast = false;
  }
  return { vars, functions };
}

// ---------------------------------------------------------------------------
// Contexts

const contexts = new WeakSet<object>();

const SCOPE = "__webnode_vm_scope__";
const CODE = "__webnode_vm_code__";
const NAMES = "__webnode_vm_names__";
const OUT = "__webnode_vm_out__";
// The function rewritten code calls for its `import()` is the real global's.
const INTERNAL_NAMES = new Set([SCOPE, CODE, NAMES, OUT, "__webnode_vm_i__", EVALUATED_BINDING]);

type Runner = (
  this: object,
  scope: object,
  code: string,
  names: string[],
  out: Record<string, unknown>,
) => unknown;

let runner: Runner | null = null;
/** True while the runner resolves its own `eval`, so a context's `eval` cannot replace it. */
let resolvingEval = false;

function getRunner(): Runner {
  runner ??= indirectEval(
    `(function (${SCOPE}, ${CODE}, ${NAMES}, ${OUT}) {` +
      `try { with (${SCOPE}) { return eval(${CODE}); } } finally {` +
      `for (var __webnode_vm_i__ = 0; __webnode_vm_i__ < ${NAMES}.length; __webnode_vm_i__++) {` +
      `try { ${OUT}[${NAMES}[__webnode_vm_i__]] = eval(${NAMES}[__webnode_vm_i__]); } catch (_) {} } } })`,
  ) as Runner;
  return runner;
}

/** The scope object a context's code sees through `with`. */
function scopeFor(
  context: Global,
  vars: ReadonlySet<string>,
  functions: ReadonlySet<string>,
): object {
  return new Proxy(Object.create(null) as object, {
    has(_target, key) {
      if (typeof key === "string") {
        if (key === CODE) {
          resolvingEval = false;
          return false;
        }
        if (INTERNAL_NAMES.has(key)) {
          return false;
        }
        if (key === "eval" && resolvingEval) {
          return false;
        }
        // The run's own declarations live in the runner's scope until it ends.
        if (functions.has(key) || (vars.has(key) && !(key in context))) {
          return false;
        }
      }
      return true;
    },
    get(_target, key) {
      if (key === Symbol.unscopables) {
        return undefined;
      }
      if (key in context) {
        return Reflect.get(context, key);
      }
      if (key === "globalThis") {
        return context;
      }
      return (globalThis as unknown as Global)[key];
    },
    set(_target, key, value) {
      return Reflect.set(context, key, value);
    },
    deleteProperty(_target, key) {
      return Reflect.deleteProperty(context, key);
    },
  });
}

function evaluateInContext(code: string, context: Global): unknown {
  const { vars, functions } = scanTopLevelDeclarations(code);
  const varsBefore = new Set([...vars].filter((name) => name in context));
  const names = [...vars, ...functions];
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const scope = scopeFor(context, vars, functions);
  resolvingEval = true;
  try {
    return getRunner().call(context, scope, code, names, out);
  } finally {
    resolvingEval = false;
    const realGlobal = globalThis as unknown as Global;
    for (const name of names) {
      if (!(name in out)) {
        continue;
      }
      const value = out[name];
      // A name the scan took for a declaration but the code never declared
      // resolves to the real global; leave the context alone then.
      if (
        name in realGlobal &&
        realGlobal[name] === value &&
        !(value === undefined && vars.has(name))
      ) {
        continue;
      }
      if (functions.has(name)) {
        context[name] = value;
      } else if (!varsBefore.has(name) && !(name in context)) {
        context[name] = value;
      }
    }
  }
}

function validateContext(contextifiedObject: unknown): asserts contextifiedObject is Global {
  if (
    contextifiedObject === null ||
    (typeof contextifiedObject !== "object" && typeof contextifiedObject !== "function") ||
    !contexts.has(contextifiedObject)
  ) {
    throw invalidArgType("contextifiedObject", "vm.Context", contextifiedObject);
  }
}

/** `vm.createContext(object, options)`: marks `object` as a context and returns it. */
export function createContext(contextObject: unknown = {}, options?: unknown): object {
  if (contextObject === constants.DONT_CONTEXTIFY) {
    contextObject = {};
  }
  if (contextObject !== null && typeof contextObject === "object" && contexts.has(contextObject)) {
    return contextObject;
  }
  validateObject(
    contextObject,
    "contextObject",
    kValidateObjectAllowArray | kValidateObjectAllowFunction,
  );
  if (options !== undefined) {
    validateObject(options, "options");
    const { name } = options as { name?: unknown };
    if (name !== undefined) {
      validateString(name, "options.name");
    }
  }
  contexts.add(contextObject);
  return contextObject;
}

/** `vm.isContext(object)`. */
export function isContext(object: unknown): boolean {
  validateObject(object, "object", kValidateObjectAllowArray | kValidateObjectAllowFunction);
  return contexts.has(object);
}

// ---------------------------------------------------------------------------
// Script

/** `vm.Script`: code compiled once and run any number of times. */
export class Script {
  readonly cachedDataRejected: boolean | undefined;
  readonly sourceMapURL: string | undefined;
  cachedDataProduced: boolean | undefined;
  cachedData: Buffer | undefined;
  #code: string;
  #source: string;

  constructor(code: string, options?: ScriptOptions | string) {
    validateString(code, "code");
    const read = readOptions(options);
    this.#code = code;
    this.#source = prepare(code, read);
    // A syntax error surfaces here, as in Node. `Function` compiles the body
    // without running it; it is lazily parsed, so this costs little.
    // eslint-disable-next-line typescript/no-implied-eval
    new Function(code);
    // V8's code cache is not reachable from a worker, so supplied cache data is
    // always rejected and none is produced.
    this.cachedDataRejected = read.cachedData === undefined ? undefined : true;
    if (read.produceCachedData) {
      this.cachedDataProduced = false;
    }
    const match = /\/\/[#@] sourceMappingURL=(\S+)\s*$/.exec(code);
    this.sourceMapURL = match === null ? undefined : match[1];
  }

  /** Runs the script against the real global. */
  runInThisContext(options?: ScriptOptions): unknown {
    warnIfInterruptible(options);
    return indirectEval(this.#source);
  }

  /** Runs the script in a context made by `createContext`. */
  runInContext(contextifiedObject: object, options?: ScriptOptions): unknown {
    validateContext(contextifiedObject);
    warnIfInterruptible(options);
    // The leading blank lines of `lineOffset` and the sourceURL travel with the code.
    return evaluateInContext(this.#source, contextifiedObject);
  }

  /** Contextifies `contextObject` (a new object when omitted) and runs the script in it. */
  runInNewContext(contextObject?: object, options?: ScriptOptions): unknown {
    const context = createContext(contextObject ?? {}, undefined);
    return this.runInContext(context, options);
  }

  /** V8's code cache is not reachable from a worker: always an empty Buffer. */
  createCachedData(): Buffer {
    return Buffer.alloc(0);
  }

  /** The source this script was made from. */
  get _code(): string {
    return this.#code;
  }
}

/** `vm.createScript(code, options)` (legacy): `new Script(code, options)`. */
export function createScript(code: string, options?: ScriptOptions | string): Script {
  return new Script(code, options);
}

/** `vm.runInThisContext(code, options | filename)`. */
export function runInThisContext(code: string, options?: ScriptOptions | string): unknown {
  validateString(code, "code");
  return indirectEval(prepare(code, readOptions(options)));
}

/** `vm.runInContext(code, contextifiedObject, options | filename)`. */
export function runInContext(
  code: string,
  contextifiedObject: object,
  options?: ScriptOptions | string,
): unknown {
  validateContext(contextifiedObject);
  return new Script(code, options).runInContext(contextifiedObject);
}

/** `vm.runInNewContext(code, contextObject, options | filename)`. */
export function runInNewContext(
  code: string,
  contextObject?: object,
  options?: ScriptOptions | string,
): unknown {
  const script = new Script(code, options);
  return script.runInNewContext(contextObject);
}

/** `vm.compileFunction` options. */
export interface CompileFunctionOptions {
  filename?: string;
  lineOffset?: number;
  columnOffset?: number;
  cachedData?: ArrayBufferView;
  produceCachedData?: boolean;
  parsingContext?: object;
  contextExtensions?: object[];
  importModuleDynamically?: unknown;
}

/**
 * `vm.compileFunction(code, params, options)`: a real function with `params`
 * whose body is `code`, compiled on the body's own first line so line numbers
 * match the source. `parsingContext` and `contextExtensions` become `with`
 * scopes around it.
 */
export function compileFunction(
  code: string,
  params: readonly string[] = [],
  options: CompileFunctionOptions = {},
): (...args: unknown[]) => unknown {
  validateString(code, "code");
  if (!Array.isArray(params)) {
    throw invalidArgType("params", "Array", params);
  }
  params.forEach((param, index) => validateString(param, `params[${index}]`));
  validateObject(options, "options");
  const filename = options.filename ?? "";
  validateString(filename, "options.filename");
  const body = withImporter(code, filename, importerFor(options.importModuleDynamically));
  const extensions = options.contextExtensions ?? [];
  if (!Array.isArray(extensions)) {
    throw invalidArgType("options.contextExtensions", "Array", extensions);
  }
  extensions.forEach((extension, index) =>
    validateObject(extension, `options.contextExtensions[${index}]`),
  );
  const scopes: object[] = [];
  if (options.parsingContext !== undefined) {
    if (!contexts.has(options.parsingContext)) {
      throw invalidArgType("options.parsingContext", "Context", options.parsingContext);
    }
    scopes.push(scopeFor(options.parsingContext as Global, new Set(), new Set()));
  }
  scopes.push(...extensions);
  const lineOffset = Math.trunc(options.lineOffset ?? 0);
  const prefix = lineOffset > 0 ? "\n".repeat(lineOffset) : "";
  const head = `function (${params.join(", ")}) {`;
  const sourceUrl = sourceUrlSuffix(filename || DEFAULT_FILENAME);
  if (scopes.length === 0) {
    return indirectEval(`${prefix}(${head}${body}\n})${sourceUrl}`) as (
      ...args: unknown[]
    ) => unknown;
  }
  const opens = scopes.map((_, index) => `with (${SCOPE}[${index}]) {`).join(" ");
  const closes = " }".repeat(scopes.length);
  const factory = indirectEval(
    `${prefix}(function (${SCOPE}) { ${opens} return ${head}${body}\n};${closes} })${sourceUrl}`,
  ) as (scopes: object[]) => (...args: unknown[]) => unknown;
  return factory(scopes);
}

/** `vm.measureMemory`: the engine's per-context memory is not reachable from a worker. */
export function measureMemory(): never {
  throw unavailable("measureMemory");
}

/** `vm.SourceTextModule`: webnode links ES modules with its own loader, not V8's module API. */
export class SourceTextModule {
  constructor() {
    throw unavailable("SourceTextModule");
  }
}

/** `vm.SyntheticModule`: see `SourceTextModule`. */
export class SyntheticModule {
  constructor() {
    throw unavailable("SyntheticModule");
  }
}

/** `vm.Module`: see `SourceTextModule`. */
export class Module {
  constructor() {
    throw unavailable("Module");
  }
}

const vm = {
  Script,
  createContext,
  createScript,
  runInContext,
  runInNewContext,
  runInThisContext,
  isContext,
  compileFunction,
  measureMemory,
  constants,
};

// Node defines the module classes only behind --experimental-vm-modules, so they
// are not enumerable keys of the module object; reading them still works here and
// constructing one throws the named error.
for (const [name, value] of Object.entries({ SourceTextModule, SyntheticModule, Module })) {
  Object.defineProperty(vm, name, { value, writable: true, configurable: true, enumerable: false });
}

export default vm;
