// Owns `util.inspect`, `util.format` and `util.formatWithOptions`: Node's own
// inspect, as extracted by the `node-inspect-extracted` package, plus the
// members Node hangs on `inspect` that the package leaves out
// (`defaultOptions`, `replDefaults`).
import type * as extracted from "node-inspect-extracted";
import { invalidArgType } from "./nodeErrors";
import { installWebInspectors, withHiddenStateInspectors } from "./webInspect";

/** The options `util.inspect` accepts. */
export type InspectOptions = extracted.InspectOptions;

interface ExtractedModule {
  inspect: typeof extracted.inspect;
  inspectDefaultOptions: InspectOptions;
  format: typeof extracted.format;
  formatWithOptions: typeof extracted.formatWithOptions;
  stripVTControlCharacters: (value: string) => string;
}

// The bundler's CommonJS `require`, which evaluates the package only when it
// is first called (Vitest's module runner has one too). The only lib is DOM.
declare const require: (id: "node-inspect-extracted") => ExtractedModule;

/** The registered `util.inspect.custom` symbol. */
export const customInspectSymbol: symbol = Symbol.for("nodejs.util.inspect.custom");

let loaded: ExtractedModule | null = null;
let replDefaults: InspectOptions | null = null;

/**
 * The package, loaded by the first call that needs it. It builds Node's
 * primordials as it loads, some milliseconds that every process would pay at
 * its start, a shell or a program that never inspects too. Its CommonJS
 * object carries `inspectDefaultOptions`, which its ES module re-exports only
 * through `default`.
 */
function lib(): ExtractedModule {
  if (loaded === null) {
    loaded = require("node-inspect-extracted");
    // What Node's REPL starts from: the inspect defaults with `showProxy`
    // and colors decided by the terminal. Node defines it when the REPL
    // loads; here it is taken as the package loads, before any program can
    // have changed the defaults.
    replDefaults = { ...loaded.inspectDefaultOptions, showProxy: true };
    addColorAliases(loaded.inspect.colors as Record<string, unknown>);
    for (const key of LOADED_MEMBERS) {
      settleMember(key, loaded.inspect[key]);
    }
  }
  return loaded;
}

// Node defines these colour aliases as non-enumerable accessors on
// `inspect.colors`; the extracted package leaves them out.
const colorAliases: [alias: string, target: string][] = [
  ["grey", "gray"],
  ["blackBright", "gray"],
  ["bgGrey", "bgGray"],
  ["bgBlackBright", "bgGray"],
  ["faint", "dim"],
  ["crossedout", "strikethrough"],
  ["strikeThrough", "strikethrough"],
  ["crossedOut", "strikethrough"],
  ["conceal", "hidden"],
  ["swapColors", "inverse"],
  ["swapcolors", "inverse"],
  ["doubleUnderline", "doubleunderline"],
];

function addColorAliases(colors: Record<string, unknown>): void {
  for (const [alias, target] of colorAliases) {
    if (!Object.prototype.hasOwnProperty.call(colors, alias)) {
      Object.defineProperty(colors, alias, {
        get() {
          return colors[target];
        },
        set(value: unknown) {
          colors[target] = value;
        },
        configurable: true,
        enumerable: false,
      });
    }
  }
}

// Some values need the hidden-state inspectors (util/webInspect.ts) while they
// are printed; a call that prints only primitives does not install them.
function hasObject(values: unknown[]): boolean {
  return values.some(
    (value) => (typeof value === "object" && value !== null) || typeof value === "function",
  );
}

/** Calls the package's `name` with the hidden-state inspectors where the arguments need them. */
function hooked(name: "inspect" | "format" | "formatWithOptions") {
  return function (this: unknown, ...args: unknown[]): string {
    const fn = lib()[name] as (...values: unknown[]) => string;
    return hasObject(args)
      ? withHiddenStateInspectors(() => fn.apply(this, args))
      : fn.apply(this, args);
  };
}

/** Gives `fn` the name and length Node's function has. */
function named<F extends (...args: never[]) => unknown>(fn: F, name: string, length: number): F {
  Object.defineProperty(fn, "name", { value: name, configurable: true });
  Object.defineProperty(fn, "length", { value: length, configurable: true });
  return fn;
}

function validateOptionsObject(options: unknown): asserts options is object {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw invalidArgType("options", "Object", options);
  }
}

/** The members of `inspect` that are the package's objects. */
const LOADED_MEMBERS = ["colors", "styles"] as const;

/** Makes `inspect[key]` the data property Node has, holding `value`. */
function settleMember(key: (typeof LOADED_MEMBERS)[number], value: unknown): void {
  Object.defineProperty(inspect, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** `util.inspect`, with `custom`, `colors`, `styles`, `defaultOptions` and `replDefaults`. */
export const inspect = named(hooked("inspect"), "inspect", 2) as typeof extracted.inspect;

// Node's members of `inspect`, in Node's order. `colors` and `styles` are the
// package's own objects, which it reads as it prints: each is an accessor
// until the package loads, and from then on the data property Node has.
Object.defineProperty(inspect, "custom", {
  value: customInspectSymbol,
  writable: true,
  enumerable: true,
  configurable: true,
});
Object.defineProperty(inspect, "defaultOptions", {
  get() {
    return lib().inspectDefaultOptions;
  },
  set(options: unknown) {
    validateOptionsObject(options);
    Object.assign(lib().inspectDefaultOptions, options);
  },
  configurable: false,
  enumerable: false,
});
for (const key of LOADED_MEMBERS) {
  Object.defineProperty(inspect, key, {
    get() {
      lib();
      return inspect[key];
    },
    set(value: unknown) {
      lib();
      settleMember(key, value);
    },
    enumerable: true,
    configurable: true,
  });
}
Object.defineProperty(inspect, "replDefaults", {
  get() {
    lib();
    return replDefaults;
  },
  set(options: unknown) {
    validateOptionsObject(options);
    lib();
    Object.assign(replDefaults!, options);
  },
  configurable: true,
  enumerable: false,
});

installWebInspectors(globalThis as unknown as Record<string, unknown>);

/** `util.format`: printf-like formatting with `%s %d %i %f %j %o %O %c %%`. */
export const format: (...args: unknown[]) => string = named(hooked("format"), "format", 0);

/** `util.formatWithOptions(inspectOptions, ...args)`. */
export const formatWithOptions: (options: InspectOptions, ...args: unknown[]) => string = named(
  hooked("formatWithOptions"),
  "formatWithOptions",
  1,
);

/** `util.stripVTControlCharacters`: removes ANSI escape codes, validating the argument. */
export const stripVTControlCharacters = named(
  (value: string): string => lib().stripVTControlCharacters(value),
  "stripVTControlCharacters",
  1,
);
