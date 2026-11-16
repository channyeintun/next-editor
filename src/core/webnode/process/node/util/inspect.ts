// Owns `util.inspect`, `util.format` and `util.formatWithOptions`: Node's own
// inspect, as extracted by the `node-inspect-extracted` package, plus the
// members Node hangs on `inspect` that the package leaves out
// (`defaultOptions`, `replDefaults`).
import * as extracted from "node-inspect-extracted";
import { invalidArgType } from "./nodeErrors";

/** The options `util.inspect` accepts. */
export type InspectOptions = extracted.InspectOptions;

interface ExtractedModule {
  inspect: typeof extracted.inspect;
  inspectDefaultOptions: InspectOptions;
  format: typeof extracted.format;
  formatWithOptions: typeof extracted.formatWithOptions;
  stripVTControlCharacters: (value: string) => string;
}

// The package's CommonJS object carries `inspectDefaultOptions`, which its ES
// module re-exports only through `default`.
const lib = ((extracted as unknown as { default?: ExtractedModule }).default ??
  (extracted as unknown as ExtractedModule)) as ExtractedModule;

const defaultOptions: InspectOptions = lib.inspectDefaultOptions;

// What Node's REPL starts from: the inspect defaults with `showProxy` and colors
// decided by the terminal. Node defines `inspect.replDefaults` when the REPL
// loads; here it is always present.
const replDefaults: InspectOptions = { ...defaultOptions, showProxy: true };

/** `util.inspect`, with `custom`, `colors`, `styles`, `defaultOptions` and `replDefaults`. */
export const inspect = lib.inspect;

function validateOptionsObject(options: unknown): asserts options is object {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw invalidArgType("options", "Object", options);
  }
}

if (!Object.getOwnPropertyDescriptor(inspect, "defaultOptions")?.get) {
  Object.defineProperty(inspect, "defaultOptions", {
    get() {
      return defaultOptions;
    },
    set(options: unknown) {
      validateOptionsObject(options);
      Object.assign(defaultOptions, options);
    },
    configurable: true,
    enumerable: false,
  });
}

if (!Object.getOwnPropertyDescriptor(inspect, "replDefaults")) {
  Object.defineProperty(inspect, "replDefaults", {
    get() {
      return replDefaults;
    },
    set(options: unknown) {
      validateOptionsObject(options);
      Object.assign(replDefaults, options);
    },
    configurable: true,
    enumerable: false,
  });
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
const colors = inspect.colors as Record<string, unknown>;
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

/** `util.format`: printf-like formatting with `%s %d %i %f %j %o %O %c %%`. */
export const format: (...args: unknown[]) => string = lib.format;

/** `util.formatWithOptions(inspectOptions, ...args)`. */
export const formatWithOptions: (options: InspectOptions, ...args: unknown[]) => string =
  lib.formatWithOptions;

/** `util.stripVTControlCharacters`: removes ANSI escape codes, validating the argument. */
export const stripVTControlCharacters: (value: string) => string = lib.stripVTControlCharacters;

/** The registered `util.inspect.custom` symbol. */
export const customInspectSymbol: symbol = Symbol.for("nodejs.util.inspect.custom");
