// Code a program evaluates itself: the body it gives `new Function` (or the
// async and generator function constructors) and the text it gives `eval`.
// The engine would run that code's `import()` natively, and the browser's
// import knows no file of the program's: it fetches from the page's host,
// fails, and says so only after the program may have ended. Here such code is
// rewritten first (transform.ts) so that it loads through the loader, as code
// of the file that built it, which is the file Node resolves from too.
import { runtime } from "../runtime";
import { EVALUATED_BINDING, fileOfSourceName, rewriteEvaluated } from "./transform";

/** The loader's `import()`: `specifier` as written in the file `parent`. */
type ImportFrom = (specifier: string, parent: string) => Promise<unknown>;

/** An eval called as a function value: an indirect eval of `code`, or `code` when it is no string. */
type IndirectEval = (code: string) => unknown;

/** What rewritten code of one file calls (transform.ts writes the calls). */
interface Evaluated {
  /** `import(specifier)`. */
  import(specifier: unknown): Promise<unknown>;
  /** What a direct `eval(code)` evaluates in place of `code`. */
  source(code: unknown): unknown;
  /** The global `eval` as the code reads it: an indirect eval. */
  eval: IndirectEval;
}

/** The engine's `eval`, called as a function value so that it evaluates in the global scope. */
// eslint-disable-next-line no-eval -- the loader stands in for the program's own indirect eval
const nativeEval = eval;
/** The engine's `Function`, before the loader's takes its place. */
const NativeFunction = Function;

/** What `String(eval)` gives. */
const EVAL_SOURCE = "function eval() { [native code] }";

/**
 * An indirect eval whose code is rewritten first (`rewriteEvaluated`) as code
 * of the file `parent()` names, with the `import()` named `importer`. It is
 * the engine's `eval` in what a program can read of it (`name`, `length`,
 * `String(eval)`, its own properties), except `Function.prototype.toString`
 * called on it, which shows a function without a name.
 */
function indirectEval(parent: () => string, importer: string | undefined): IndirectEval {
  const evaluate = new Proxy(nativeEval, {
    apply(_target, _receiver, values: unknown[]) {
      const code = values[0];
      return typeof code === "string"
        ? nativeEval(rewriteEvaluated(code, parent, importer) ?? code)
        : code;
    },
    get(target, key, receiver) {
      return key === "toString" ? toString : Reflect.get(target, key, receiver);
    },
  });
  const native = Function.prototype.toString;
  function toString(this: unknown): string {
    return this === evaluate ? EVAL_SOURCE : native.call(this);
  }
  return evaluate;
}

/**
 * The loader's indirect eval, the value of `eval` in loaded code
 * (transform.ts, `aliasEdits`). One function for every file, as the engine's
 * is: its code imports from the file that calls it, as in Node.
 */
const loaderEval = indirectEval(callingFile, undefined);

/**
 * The functions rewritten code of the file `parent` calls. `importer` is the
 * name its `import()` was defined under (`defineEvaluatedImporter`), or
 * undefined for the loader's; the code its evals run keeps it.
 */
function evaluatedFor(
  parent: string,
  importer: string | undefined,
  importFrom: ImportFrom,
): Evaluated {
  const rewritten = (code: unknown): unknown =>
    typeof code === "string" ? (rewriteEvaluated(code, () => parent, importer) ?? code) : code;
  return {
    import: (specifier) => importFrom(String(specifier), parent),
    source: rewritten,
    eval: importer === undefined ? loaderEval : indirectEval(() => parent, importer),
  };
}

/** A frame of a structured stack trace, as V8 gives them to `Error.prepareStackTrace`. */
interface CallSite {
  getScriptNameOrSourceURL(): unknown;
}

type StackError = ErrorConstructor & {
  captureStackTrace?(target: object): void;
  prepareStackTrace?: unknown;
  stackTraceLimit?: number;
};

/** How far up the stack the file that called a function constructor is looked for. */
const CALLER_DEPTH = 64;

/**
 * The file of the nearest loaded code on the stack: the code that is calling
 * a function constructor. The engine takes the same file as the referrer of
 * the code the constructor compiles. When the stack names none (an engine
 * without structured traces, a program that froze `Error`), it is the
 * working directory's `[eval]`, as for `node -e`.
 */
function callingFile(): string {
  const errors = Error as StackError;
  if (typeof errors.captureStackTrace === "function") {
    const prepared = Object.getOwnPropertyDescriptor(errors, "prepareStackTrace");
    const limit = errors.stackTraceLimit;
    try {
      errors.stackTraceLimit = CALLER_DEPTH;
      errors.prepareStackTrace = (_error: unknown, sites: unknown) => sites;
      const holder: { stack?: unknown } = {};
      errors.captureStackTrace(holder);
      // Read here: the trace is prepared on the first read of `stack`.
      const sites = holder.stack;
      for (const site of Array.isArray(sites) ? (sites as CallSite[]) : []) {
        const name = site.getScriptNameOrSourceURL();
        const file = typeof name === "string" ? fileOfSourceName(name) : undefined;
        if (file !== undefined) {
          return file;
        }
      }
    } catch {
      // The program made `Error` unwritable; the working directory serves.
    } finally {
      try {
        // As it was: the program's own function, or no such property at all.
        if (prepared) {
          Object.defineProperty(errors, "prepareStackTrace", prepared);
        } else {
          Reflect.deleteProperty(errors, "prepareStackTrace");
        }
        errors.stackTraceLimit = limit;
      } catch {
        // Unwritable, so unchanged.
      }
    }
  }
  return `${runtime().cwd}/[eval]`;
}

/**
 * `Native` (`Function` or one of its three siblings) as programs get it: the
 * same constructor, except that the body it is given is rewritten first when
 * it imports or evals (`rewriteEvaluated`). It reads as native code, has
 * `Native`'s name, length and prototype, and subclasses construct through it.
 */
function loaderConstructor(Native: FunctionConstructor): (...values: unknown[]) => unknown {
  const construct = function (...values: unknown[]): unknown {
    // As the engine reads them: each argument converted to a string, in order.
    const texts = values.map((value) => `${value as string}`);
    if (texts.length > 0) {
      const body = rewriteEvaluated(texts[texts.length - 1], callingFile);
      if (body !== null) {
        texts[texts.length - 1] = body;
      }
    }
    // A subclass constructs through here with itself as the target.
    const target: unknown = new.target;
    return Reflect.construct(
      Native,
      texts,
      typeof target === "function" && target !== construct ? target : Native,
    );
  };
  // `instanceof` on a bound function asks the function it is bound to.
  construct.prototype = Native.prototype;
  // A bound function prints as native code, as the constructor it stands for does.
  const bound = construct.bind(undefined);
  Object.defineProperties(bound, {
    name: { value: Native.name, configurable: true },
    length: { value: Native.length, configurable: true },
    prototype: { value: Native.prototype },
  });
  Object.setPrototypeOf(bound, Object.getPrototypeOf(Native));
  return bound;
}

/** The loader's `import()`, once the loader is configured. */
let importFromLoader: ImportFrom = () =>
  Promise.reject(new Error("webnode: the module loader is not configured"));
let installed = false;
/** The loader's `import()` of `specifier` as written in the file `parent`. */
export function importThroughLoader(specifier: string, parent: string): Promise<unknown> {
  return importFromLoader(specifier, parent);
}

/** The `import()`s other than the loader's that rewritten code may be given, by name. */
const importers = new Map<string, ImportFrom>();
let bound = false;

/**
 * Gives the global object the function that rewritten code calls
 * (`EVALUATED_BINDING`): called with the file the code belongs to and the
 * name of its `import()`, it gives that code's functions. Done once for a
 * process.
 */
function bindEvaluated(): void {
  if (bound) {
    return;
  }
  bound = true;
  const hosts = new Map<string, Evaluated>();
  Object.defineProperty(globalThis, EVALUATED_BINDING, {
    configurable: true,
    value: (parent: string, importer?: string): Evaluated => {
      const key = importer === undefined ? parent : `${importer}\0${parent}`;
      let host = hosts.get(key);
      if (!host) {
        const importFrom: ImportFrom =
          (importer === undefined ? undefined : importers.get(importer)) ?? importThroughLoader;
        host = evaluatedFor(parent, importer, importFrom);
        hosts.set(key, host);
      }
      return host;
    },
  });
}

/**
 * Defines the `import()` that code rewritten with `importer` as its name
 * (`rewriteEvaluated`) calls in place of the loader's: `vm` gives the code it
 * compiles the `import()` its options ask for.
 */
export function defineEvaluatedImporter(importer: string, importFrom: ImportFrom): void {
  importers.set(importer, importFrom);
  bindEvaluated();
}

/**
 * Makes the code a program evaluates itself load through the loader, with
 * `importFrom` as its `import()`: puts the loader's function constructors in
 * the place of the engine's and gives the global object the function that
 * rewritten code calls (`bindEvaluated`). The global `eval` stays the
 * engine's, so a direct eval keeps its scope; transform.ts rewrites the evals
 * written in loaded code instead. Done once for a process.
 */
export function installEvaluatedCode(importFrom: ImportFrom): void {
  importFromLoader = importFrom;
  if (installed) {
    return;
  }
  installed = true;
  bindEvaluated();

  const LoaderFunction = loaderConstructor(NativeFunction);
  Object.defineProperty(globalThis, "Function", {
    value: LoaderFunction,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(NativeFunction.prototype, "constructor", {
    value: LoaderFunction,
    writable: true,
    configurable: true,
  });
  // `AsyncFunction`, `GeneratorFunction` and `AsyncGeneratorFunction` are no
  // globals: a program reaches each as the constructor of such a function.
  for (const sample of [async () => {}, function* () {}, async function* () {}]) {
    const prototype = Object.getPrototypeOf(sample) as { constructor: FunctionConstructor };
    const constructor = loaderConstructor(prototype.constructor);
    Object.setPrototypeOf(constructor, LoaderFunction);
    Object.defineProperty(prototype, "constructor", { value: constructor, configurable: true });
  }
}
