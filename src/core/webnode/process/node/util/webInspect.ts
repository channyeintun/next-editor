// Owns how `util.inspect` prints objects whose state the browser keeps out of
// JavaScript's reach. Two kinds:
//
// - Web platform classes (URL, Headers, Blob, AbortSignal …). Chrome keeps
//   their state behind prototype accessors, so a generic inspect sees no
//   properties and prints `URL {}`. Node gives each of them an
//   `inspect.custom`; `installWebInspectors` gives the browser's the same one,
//   printing what Node prints.
// - Promises, Map/Set iterators and WeakMap/WeakSet. Node reads their state
//   from V8 internals that no browser exposes, so it cannot be known
//   synchronously. `withHiddenStateInspectors` makes them say so
//   (`Promise { <state unknown> }`) instead of printing a made-up
//   `<pending>` or an empty list. These hooks are present only while an
//   inspect call runs, so programs never see them on the built-in prototypes.

const customSymbol = Symbol.for("nodejs.util.inspect.custom");

type InspectFn = (value: unknown, options?: object) => string;
interface CustomOptions {
  depth?: number | null;
  breakLength?: number;
  compact?: boolean | number;
  showHidden?: boolean;
  stylize?: (text: string, style: string) => string;
  [key: string]: unknown;
}
type Custom = (this: object, depth: number, options: CustomOptions, inspect: InspectFn) => unknown;

function define(proto: object, custom: Custom): void {
  Object.defineProperty(proto, customSymbol, {
    value: custom,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

/** One level less of the overall depth, as Node's own classes pass on. */
function innerOptions(options: CustomOptions): CustomOptions {
  const depth = options.depth;
  return { ...options, depth: typeof depth === "number" ? depth - 1 : depth };
}

function constructorName(value: object, fallback: string): string {
  const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === "string" && name !== "" ? name : fallback;
}

/** `Name { field: value, … }` from a record of getters, as Node's classes print. */
function recordInspector(fallback: string, fields: readonly string[]): Custom {
  return function (this: object, depth, options, inspect) {
    if (depth < 0) {
      return this;
    }
    const record: Record<string, unknown> = {};
    for (const field of fields) {
      if (field in this) {
        record[field] = (this as Record<string, unknown>)[field];
      }
    }
    return `${constructorName(this, fallback)} ${inspect(record, innerOptions(options))}`;
  };
}

/** Node's URLSearchParams format: `URLSearchParams { 'a' => '1' }`. */
const searchParamsInspector: Custom = function (this: object, depth, options, inspect) {
  if (depth < 0) {
    return options.stylize ? options.stylize("[Object]", "special") : "[Object]";
  }
  const inner = { ...options, depth: depth - 1 };
  const output: string[] = [];
  for (const [key, value] of this as URLSearchParams) {
    output.push(`${inspect(key, inner)} => ${inspect(value, inner)}`);
  }
  const name = constructorName(this, "URLSearchParams");
  // eslint-disable-next-line no-control-regex
  const plain = (text: string) => text.replace(/\u001b\[\d+m/g, "");
  const length = output.reduce((total, entry) => total + plain(entry).length + 2, -2);
  if (length > (options.breakLength ?? 80)) {
    return `${name} {\n  ${output.join(",\n  ")} }`;
  }
  return output.length ? `${name} { ${output.join(", ")} }` : `${name} {}`;
};

/** `Name { key: value }` over a class's entries (Headers, FormData), as undici prints them. */
function entriesInspector(fallback: string): Custom {
  return function (this: object, depth, options, inspect) {
    const state: Record<string, unknown> = {};
    for (const [key, value] of this as Iterable<[string, unknown]>) {
      if (!Object.prototype.hasOwnProperty.call(state, key)) {
        // defineProperty, so a "__proto__" entry stays an entry.
        Object.defineProperty(state, key, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } else if (Array.isArray(state[key])) {
        (state[key] as unknown[]).push(value);
      } else {
        state[key] = [state[key], value];
      }
    }
    return `${constructorName(this, fallback)} ${inspect(state, { ...options, depth: options.depth ?? depth })}`;
  };
}

/** Node's TextEncoder prints as a plain record. */
const textEncoderInspector: Custom = function (this: object, depth, options, inspect) {
  if (depth < 0) {
    return this;
  }
  return inspect({ encoding: (this as TextEncoder).encoding }, options);
};

const eventInspector: Custom = function (this: object, depth, options, inspect) {
  const name = constructorName(this, "Event");
  if (depth < 0) {
    return name;
  }
  const event = this as Event;
  const record = {
    type: event.type,
    defaultPrevented: event.defaultPrevented,
    cancelable: event.cancelable,
    timeStamp: event.timeStamp,
  };
  return `${name} ${inspect(record, innerOptions(options))}`;
};

const urlFields = [
  "href",
  "origin",
  "protocol",
  "username",
  "password",
  "host",
  "hostname",
  "port",
  "pathname",
  "search",
  "searchParams",
  "hash",
] as const;

const requestFields = [
  "method",
  "url",
  "headers",
  "destination",
  "referrer",
  "referrerPolicy",
  "mode",
  "credentials",
  "cache",
  "redirect",
  "integrity",
  "keepalive",
  "isReloadNavigation",
  "isHistoryNavigation",
  "signal",
] as const;

const responseFields = [
  "status",
  "statusText",
  "headers",
  "body",
  "bodyUsed",
  "ok",
  "redirected",
  "type",
  "url",
] as const;

/** The inspector each web class gets, by global name. */
const webInspectors: Record<string, Custom> = {
  URL: function (this: object, depth, options, inspect) {
    if (typeof depth === "number" && depth < 0) {
      return this;
    }
    const record: Record<string, unknown> = {};
    for (const field of urlFields) {
      record[field] = (this as unknown as Record<string, unknown>)[field];
    }
    return `${constructorName(this, "URL")} ${inspect(record, options)}`;
  },
  URLSearchParams: searchParamsInspector,
  Headers: entriesInspector("Headers"),
  FormData: entriesInspector("FormData"),
  Blob: recordInspector("Blob", ["size", "type"]),
  File: recordInspector("File", ["size", "type", "name", "lastModified"]),
  AbortSignal: recordInspector("AbortSignal", ["aborted"]),
  AbortController: recordInspector("AbortController", ["signal"]),
  TextEncoder: textEncoderInspector,
  TextDecoder: recordInspector("TextDecoder", ["encoding", "fatal", "ignoreBOM"]),
  Event: eventInspector,
  Request: recordInspector("Request", requestFields),
  Response: recordInspector("Response", responseFields),
};

/**
 * Gives each web class in `scope` Node's `inspect.custom`, unless its
 * prototype already has one (Node's own classes, or a program's).
 */
export function installWebInspectors(scope: Record<string, unknown>): void {
  for (const [name, custom] of Object.entries(webInspectors)) {
    const ctor = scope[name];
    if (typeof ctor !== "function") {
      continue;
    }
    const proto = (ctor as { prototype?: unknown }).prototype;
    // Own, not inherited: Chrome's File would otherwise keep Blob's.
    if (
      proto === null ||
      typeof proto !== "object" ||
      Object.prototype.hasOwnProperty.call(proto, customSymbol)
    ) {
      continue;
    }
    define(proto, custom);
  }
}

// --- State the browser hides -------------------------------------------------

function stylized(options: CustomOptions, text: string, style: string): string {
  return options.stylize ? options.stylize(text, style) : text;
}

/**
 * `head { entry }` laid out as Node lays out an object with one entry
 * (reduceToSingleString): on one line when it fits `breakLength` and `compact`
 * allows, otherwise on its own line. The caller's indentation is added by
 * inspect itself.
 */
function block(head: string, entry: string, options: CustomOptions): string {
  const compact = options.compact ?? 3;
  const breakLength = typeof options.breakLength === "number" ? options.breakLength : 80;
  if (compact === true) {
    return 2 + entry.length <= breakLength ? `${head} ${entry} }` : `${head}\n  ${entry} }`;
  }
  if (
    typeof compact === "number" &&
    compact >= 1 &&
    2 * 1 + head.length + 11 + entry.length <= breakLength
  ) {
    return `${head} ${entry} }`;
  }
  return `${head}\n  ${entry}\n}`;
}

/** `Promise { <state unknown> }`, with the promise's own properties after it. */
const promiseInspector: Custom = function (this: object, depth, options, inspect) {
  const name = constructorName(this, "Promise");
  const prefix = name === "Promise" ? "Promise" : `${name} [Promise]`;
  if (depth < 0) {
    return stylized(options, `[${prefix}]`, "special");
  }
  const unknown = stylized(options, "<state unknown>", "special");
  const own = Object.keys(this);
  if (own.length === 0) {
    return block(`${prefix} {`, unknown, options);
  }
  const record: Record<string, unknown> = {};
  for (const key of own) {
    record[key] = (this as Record<string, unknown>)[key];
  }
  // `{ a: 1 }` → `Promise { <state unknown>, a: 1 }`.
  const rest = inspect(record, innerOptions(options));
  return `${prefix} { ${unknown},${rest.slice(1)}`;
};

function iteratorInspector(tag: string): Custom {
  return function (this: object, depth, options) {
    if (depth < 0) {
      return stylized(options, `[${tag}]`, "special");
    }
    return block(`[${tag}] {`, stylized(options, "<items unknown>", "special"), options);
  };
}

/**
 * WeakMap and WeakSet: inspect already prints `<items unknown>` for them, but
 * with `showHidden` it would list made-up entries; Node lists the real ones.
 */
const weakInspector: Custom = function (this: object, _depth, options, inspect) {
  return options.showHidden ? inspect(this, { ...options, showHidden: false }) : this;
};

function hiddenStatePrototypes(): [object, Custom][] {
  return [
    [Promise.prototype, promiseInspector],
    [Object.getPrototypeOf(new Map().entries()) as object, iteratorInspector("Map Iterator")],
    [Object.getPrototypeOf(new Set().values()) as object, iteratorInspector("Set Iterator")],
    [WeakMap.prototype, weakInspector],
    [WeakSet.prototype, weakInspector],
  ];
}

let hiddenState: [object, Custom][] | undefined;
let activeCalls = 0;

/**
 * Runs `fn` (an inspect or format call) with the hidden-state inspectors on
 * the built-in prototypes, and takes them off again afterwards. A prototype
 * that already has an inspector (a program's) keeps it.
 */
export function withHiddenStateInspectors<T>(fn: () => T): T {
  if (activeCalls > 0) {
    return fn();
  }
  hiddenState ??= hiddenStatePrototypes();
  const installed: object[] = [];
  for (const [proto, custom] of hiddenState) {
    if (!Object.prototype.hasOwnProperty.call(proto, customSymbol)) {
      define(proto, custom);
      installed.push(proto);
    }
  }
  activeCalls++;
  try {
    return fn();
  } finally {
    activeCalls--;
    for (const proto of installed) {
      delete (proto as Record<symbol, unknown>)[customSymbol];
    }
  }
}
