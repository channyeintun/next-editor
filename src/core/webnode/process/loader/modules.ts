// The module system: CommonJS (`Module`, `require`) and the ES module linker,
// in one place because each loads the other. A CommonJS file is wrapped in a
// function and run. An ES module is rewritten by transform.ts into a function
// too; the linker resolves its static imports, evaluates them first in source
// order (awaiting those that use top-level await) and hands the module live
// views of their exports.
import { BUILTIN_MODULE_NAMES, builtinName } from "../node/names";
import { runtime } from "../runtime";
import {
  clearPackageCache,
  findPackageScope,
  formatByName,
  nodeModulePaths,
  resolveSpecifier,
} from "./resolve";
import type { ResolveMode } from "./resolve";
import {
  DYNAMIC_IMPORT_BINDING,
  exportNameStandIn,
  EXPORTS_BINDING,
  hasTopLevelAwait,
  IMPORT_META_BINDING,
  isIdentifierName,
  prepareSource,
  STATIC_IMPORT_BINDING,
  stripTypes,
} from "./transform";
import type { PreparedSource } from "./transform";

type Namespace = Record<string | symbol, unknown>;

interface LoaderHost {
  /** The exports of builtin module `name`. */
  loadBuiltin(name: string): unknown;
  /** `--conditions` the process was started with. */
  conditions: readonly string[];
}

let host: LoaderHost = {
  loadBuiltin(name) {
    throw new Error(`webnode: builtin module "${name}" is not registered`);
  },
  conditions: [],
};

/** Connects the loader to the builtin registry and the process's options. */
export function configureLoader(next: LoaderHost): void {
  host = next;
}

const decoder = new TextDecoder();

function readText(filename: string): string {
  return decoder.decode(runtime().fs.readFile(filename));
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function codedError<T extends Error>(error: T, code: string): T {
  (error as T & { code: string }).code = code;
  return error;
}

/** `file://` URL for an absolute path. */
export function fileUrl(path: string): string {
  return `file://${path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(/%2B|%40|%3A|%24|%2C|%3D|%26/gi, decodeURIComponent),
    )
    .join("/")}`;
}

function pathFromFileUrl(url: string): string {
  return decodeURIComponent(new URL(url).pathname);
}

/** Runs `code` as the body of a function taking `parameters`, named after `filename` in stack traces. */
function compileFunction(
  code: string,
  parameters: string[],
  filename: string,
  isAsync: boolean,
): (...args: unknown[]) => unknown {
  const source = `(${isAsync ? "async " : ""}function (${parameters.join(", ")}) {${code}\n})\n//# sourceURL=${filename}`;
  try {
    // Indirect eval: the function sees only the global scope.
    // eslint-disable-next-line no-eval -- the loader exists to evaluate module source
    return (0, eval)(source) as (...args: unknown[]) => unknown;
  } catch (error) {
    if (error instanceof SyntaxError && !error.message.includes(filename)) {
      // The engine reports no position for evaluated code; name the file at least.
      error.message = `${error.message} (${filename})`;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

type FileFormat = "esm" | "cjs" | "json" | "addon";

interface Classified {
  format: FileFormat;
  /** The source as read to decide the format, for the caller to run; null when the name decided. */
  prepared: PreparedSource | null;
}

/**
 * What a file is, read from disk now. The source read to decide goes back to
 * the caller rather than into a cache, so a file rewritten later is read again.
 */
function classify(filename: string): Classified {
  if (filename.endsWith(".node")) {
    return { format: "addon", prepared: null };
  }
  const named = formatByName(filename);
  if (named === "json" || named === "esm") {
    return { format: named, prepared: null };
  }
  // A CommonJS-named or unmarked file is an ES module when it uses the syntax.
  const prepared = prepareSource(readText(filename), filename, named);
  return { format: prepared.format, prepared };
}

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

const cjsNamespaces = new WeakMap<object, Namespace>();
const builtinNamespaces = new Map<string, Namespace>();

/**
 * The view an ES module gets of a CommonJS module: `default` is its
 * `module.exports`, and each property is a named export read live.
 */
const FUNCTION_OWN_NAMES = new Set(["length", "name", "prototype", "caller", "arguments"]);

/**
 * The names a module object exports. A builtin exports every own property,
 * enumerable or not: several are classes whose static methods are the module's
 * functions (`module.createRequire`).
 */
function exportNames(exported: object, includeHidden: boolean): string[] {
  if (!includeHidden) {
    return Object.keys(exported);
  }
  return Object.getOwnPropertyNames(exported).filter(
    (name) => typeof exported !== "function" || !FUNCTION_OWN_NAMES.has(name),
  );
}

function namespaceOfExports(read: () => unknown, includeHidden = false): Namespace {
  const namespace: Namespace = Object.create(null) as Namespace;
  // Marks the object as already being a namespace for the rewritten imports.
  Object.defineProperty(namespace, "__esModule", { value: true });
  Object.defineProperty(namespace, Symbol.toStringTag, { value: "Module" });
  Object.defineProperty(namespace, "default", { enumerable: true, get: read });
  const exported = read();
  if (exported !== null && (typeof exported === "object" || typeof exported === "function")) {
    for (const key of exportNames(exported, includeHidden)) {
      if (key === "default" || key === "__esModule") {
        continue;
      }
      Object.defineProperty(namespace, key, {
        enumerable: true,
        get: () => (read() as Record<string, unknown>)[key],
      });
    }
  }
  aliasStringNames(namespace);
  return namespace;
}

/**
 * Gives every export whose name is not an identifier its stand-in, hidden, so
 * a module that imports it by a string name (`import { "a-b" as c }`) reads it.
 * An ES module does this for its own exports (loader/transform.ts); this covers
 * the names a namespace gets any other way: CommonJS exports and `export *`.
 */
function aliasStringNames(namespace: Namespace): void {
  for (const key of Object.keys(namespace)) {
    if (isIdentifierName(key)) {
      continue;
    }
    const standIn = exportNameStandIn(key);
    if (!Object.hasOwn(namespace, standIn)) {
      Object.defineProperty(namespace, standIn, { get: () => namespace[key] });
    }
  }
}

function namespaceOfModule(module: Module): Namespace {
  const cached = cjsNamespaces.get(module);
  if (cached) {
    return cached;
  }
  const namespace = namespaceOfExports(() => module.exports);
  // A module still loading (a cycle) may gain exports; build its view again later.
  if (module.loaded) {
    cjsNamespaces.set(module, namespace);
  }
  return namespace;
}

function namespaceOfBuiltin(name: string): Namespace {
  let namespace = builtinNamespaces.get(name);
  if (!namespace) {
    namespace = namespaceOfExports(() => host.loadBuiltin(name), true);
    builtinNamespaces.set(name, namespace);
  }
  return namespace;
}

// ---------------------------------------------------------------------------
// CommonJS
// ---------------------------------------------------------------------------

export interface NodeRequire {
  (request: string): unknown;
  resolve: {
    (request: string, options?: { paths?: string[] }): string;
    paths(request: string): string[] | null;
  };
  main: Module | undefined;
  cache: Record<string, Module>;
  extensions: Record<string, (module: Module, filename: string) => void>;
}

const WRAPPER_PARAMETERS = ["exports", "require", "module", "__filename", "__dirname"];

/** Node's `Module`: one loaded CommonJS module, and the module system's public API. */
export class Module {
  id: string;
  path: string;
  exports: unknown = {};
  filename: string | null = null;
  loaded = false;
  children: Module[] = [];
  paths: string[];
  parent: Module | null | undefined;

  static _cache: Record<string, Module> = Object.create(null) as Record<string, Module>;
  static _pathCache: Record<string, string> = Object.create(null) as Record<string, string>;
  static _extensions: Record<string, (module: Module, filename: string) => void> = Object.create(
    null,
  ) as Record<string, (module: Module, filename: string) => void>;
  static globalPaths: string[] = [];
  static builtinModules: string[] = [...BUILTIN_MODULE_NAMES];
  static wrapper = ["(function (exports, require, module, __filename, __dirname) { ", "\n});"];
  static Module = Module;
  static main: Module | undefined;
  static constants = {
    compileCacheStatus: { FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 },
  };

  constructor(id = "", parent?: Module | null) {
    this.id = id;
    this.path = dirname(id);
    this.parent = parent;
    this.paths = [];
    parent?.children.push(this);
  }

  get isPreloading(): boolean {
    return false;
  }

  static wrap(script: string): string {
    return Module.wrapper[0] + script + Module.wrapper[1];
  }

  static isBuiltin(name: string): boolean {
    return builtinName(name) !== null;
  }

  static _nodeModulePaths(from: string): string[] {
    return nodeModulePaths(from);
  }

  static _initPaths(): void {}

  static _preloadModules(requests: string[]): void {
    const parent = new Module("internal/preload", null);
    parent.paths = nodeModulePaths(runtime().cwd);
    for (const request of requests) {
      parent.require(request);
    }
  }

  static _findPath(request: string, paths: string[]): string | false {
    for (const path of paths) {
      try {
        const resolved = resolveSpecifier(
          request.startsWith("/") ? request : `./${request}`,
          `${path}/noop.js`,
          "require",
          host.conditions,
        );
        if ("filename" in resolved) {
          return resolved.filename;
        }
      } catch {
        // Try the next path.
      }
    }
    return false;
  }

  static _resolveFilename(
    request: string,
    parent?: Module | null,
    _isMain?: boolean,
    options?: { paths?: string[] },
  ): string {
    if (builtinName(request)) {
      return request;
    }
    const parents = options?.paths
      ? options.paths.map((path) => `${path}/noop.js`)
      : [parent?.filename ?? `${runtime().cwd}/[eval]`];
    let failure: unknown;
    for (const from of parents) {
      try {
        const resolved = resolveSpecifier(request, from, "require", host.conditions);
        return "builtin" in resolved ? resolved.builtin : resolved.filename;
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  }

  static _load(request: string, parent?: Module | null, isMain = false): unknown {
    const filename = Module._resolveFilename(request, parent, isMain);
    const builtin = builtinName(filename);
    if (builtin) {
      return host.loadBuiltin(builtin);
    }

    const cached = Module._cache[filename];
    if (cached) {
      if (parent && !parent.children.includes(cached)) {
        parent.children.push(cached);
      }
      return cached.exports;
    }

    const module = new Module(filename, parent);
    if (isMain) {
      module.id = ".";
      Module.main = module;
      mainModuleListener?.(module);
    }
    Module._cache[filename] = module;
    let threw = true;
    try {
      module.load(filename);
      threw = false;
    } finally {
      if (threw) {
        delete Module._cache[filename];
      }
    }
    return module.exports;
  }

  static createRequire(from: string | URL): NodeRequire {
    let filename = typeof from === "string" ? from : from.href;
    if (filename.startsWith("file:")) {
      filename = pathFromFileUrl(filename);
    }
    if (!filename.startsWith("/")) {
      throw codedError(
        new TypeError(
          `The argument 'filename' must be a file URL object, file URL string, or absolute path string. Received '${filename}'`,
        ),
        "ERR_INVALID_ARG_VALUE",
      );
    }
    // A directory given with a trailing slash resolves from inside it.
    const anchor = filename.endsWith("/") ? `${filename}noop.js` : filename;
    const module = new Module(anchor, null);
    module.filename = anchor;
    module.paths = nodeModulePaths(dirname(anchor));
    return makeRequire(module);
  }

  static runMain(main = runtime().argv[1]): void {
    Module._load(main, null, true);
  }

  static syncBuiltinESMExports(): void {}

  static findSourceMap(): undefined {
    return undefined;
  }

  static register(): void {
    warnOnce(
      "module.register",
      "module.register() loader hooks are not supported in webnode and were ignored",
    );
  }

  static registerHooks(): { deregister(): void } {
    warnOnce(
      "module.registerHooks",
      "module.registerHooks() is not supported in webnode and was ignored",
    );
    return { deregister() {} };
  }

  static enableCompileCache(): { status: number } {
    return { status: Module.constants.compileCacheStatus.DISABLED };
  }

  static getCompileCacheDir(): undefined {
    return undefined;
  }

  static flushCompileCache(): void {}

  static stripTypeScriptTypes(code: string): string {
    return stripTypes(code, "input.ts");
  }

  static findPackageJSON(specifier: string | URL, base?: string | URL): string | undefined {
    const from =
      base === undefined
        ? `${runtime().cwd}/noop.js`
        : typeof base === "string" && !base.startsWith("file:")
          ? base
          : pathFromFileUrl(String(base));
    const text = String(specifier);
    try {
      const resolved = resolveSpecifier(text, from, "import", host.conditions);
      if ("builtin" in resolved) {
        return undefined;
      }
      const scope = findPackageScope(dirname(resolved.filename));
      return scope ? `${scope.directory}/package.json` : undefined;
    } catch {
      return undefined;
    }
  }

  require(request: string): unknown {
    if (typeof request !== "string") {
      throw codedError(
        new TypeError(
          `The "id" argument must be of type string. Received ${request === null ? "null" : typeof request}`,
        ),
        "ERR_INVALID_ARG_TYPE",
      );
    }
    if (request === "") {
      throw codedError(
        new TypeError("The argument 'id' must be a non-empty string. Received ''"),
        "ERR_INVALID_ARG_VALUE",
      );
    }
    return Module._load(request, this, false);
  }

  load(filename: string): void {
    this.filename = filename;
    this.paths = nodeModulePaths(dirname(filename));
    const extension = registeredExtension(filename);
    Module._extensions[extension](this, filename);
    this.loaded = true;
  }

  _compile(content: string, filename: string): unknown {
    const named = formatByName(filename);
    const prepared = prepareSource(content, filename, named === "esm" ? "esm" : null);
    if (prepared.format === "esm") {
      this.exports = requireEsmSource(filename, prepared);
      return undefined;
    }

    const run = compileFunction(
      prepared.code,
      [...WRAPPER_PARAMETERS, DYNAMIC_IMPORT_BINDING],
      filename,
      false,
    );
    const directory = dirname(filename);
    return run.call(
      this.exports,
      this.exports,
      makeRequire(this),
      this,
      filename,
      directory,
      (specifier: unknown) => importModule(String(specifier), filename),
    );
  }
}

let mainModuleListener: ((module: Module) => void) | null = null;

/** Runs `listener` when the main CommonJS module is created, for `process.mainModule`. */
export function onMainModule(listener: (module: Module) => void): void {
  mainModuleListener = listener;
}

const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  const emit = (globalThis as { process?: { emitWarning?: (message: string) => void } }).process
    ?.emitWarning;
  emit?.(message);
}

function registeredExtension(filename: string): string {
  const name = filename.slice(filename.lastIndexOf("/") + 1);
  let index = 0;
  for (;;) {
    index = name.indexOf(".", index + 1);
    if (index <= 0) {
      return ".js";
    }
    const extension = name.slice(index);
    if (Module._extensions[extension]) {
      return extension;
    }
  }
}

function makeRequire(module: Module): NodeRequire {
  const require = ((request: string) => module.require(request)) as NodeRequire;
  const resolve = ((request: string, options?: { paths?: string[] }) =>
    Module._resolveFilename(request, module, false, options)) as NodeRequire["resolve"];
  resolve.paths = (request: string) => {
    if (builtinName(request)) {
      return null;
    }
    if (request.startsWith("./") || request.startsWith("../")) {
      return [module.path];
    }
    return [...module.paths];
  };
  require.resolve = resolve;
  require.main = Module.main;
  require.cache = Module._cache;
  require.extensions = Module._extensions;
  return require;
}

function loadScript(module: Module, filename: string): void {
  if (formatByName(filename) === "esm") {
    module.exports = requireEsm(filename);
    return;
  }
  module._compile(readText(filename), filename);
}

Module._extensions[".js"] = loadScript;
Module._extensions[".cjs"] = loadScript;
Module._extensions[".mjs"] = loadScript;
Module._extensions[".ts"] = loadScript;
Module._extensions[".cts"] = loadScript;
Module._extensions[".mts"] = loadScript;
Module._extensions[".tsx"] = loadScript;
Module._extensions[".jsx"] = loadScript;
Module._extensions[".json"] = (module, filename) => {
  try {
    module.exports = JSON.parse(readText(filename).replace(/^﻿/, ""));
  } catch (error) {
    if (error instanceof Error) {
      error.message = `${filename}: ${error.message}`;
    }
    throw error;
  }
};
Module._extensions[".node"] = (_module, filename) => {
  throw codedError(
    new Error(`Native addons cannot run in webnode: ${filename}`),
    "ERR_DLOPEN_FAILED",
  );
};

// ---------------------------------------------------------------------------
// ES modules
// ---------------------------------------------------------------------------

type Dependency =
  | { kind: "esm"; record: EsmRecord }
  | { kind: "other"; load: () => Namespace; loaded: Namespace | null };

interface EsmRecord {
  /** The file path plus the `?query` of the specifier that named it. */
  id: string;
  filename: string;
  namespace: Namespace;
  prepared: PreparedSource | null;
  dependencies: Map<string, Dependency>;
  state: "new" | "linked" | "evaluating" | "evaluated" | "errored";
  error: unknown;
  /** Set while the module (or one it waits for) is in a top-level await. */
  pending: Promise<void> | null;
}

const esmRecords = new Map<string, EsmRecord>();

function esmRecord(filename: string, query: string, prepared?: PreparedSource): EsmRecord {
  const id = filename + query;
  let record = esmRecords.get(id);
  if (!record) {
    record = {
      id,
      filename,
      namespace: {},
      prepared: prepared ?? null,
      dependencies: new Map(),
      state: "new",
      error: undefined,
      pending: null,
    };
    esmRecords.set(id, record);
  }
  return record;
}

function loadNonEsm(filename: string, format: FileFormat): Namespace {
  if (format === "json") {
    const module = Module._cache[filename];
    const exported = module ? module.exports : Module._load(filename, null, false);
    return namespaceOfExports(() => exported);
  }
  const exported = Module._load(filename, null, false);
  // A module may delete itself from require.cache while it loads.
  const module = Module._cache[filename] as Module | undefined;
  return module ? namespaceOfModule(module) : namespaceOfExports(() => exported);
}

/** What `specifier`, written in `parent`, refers to. */
function dependencyFor(specifier: string, parent: string, mode: ResolveMode): Dependency {
  const resolved = resolveSpecifier(specifier, parent, mode, host.conditions);
  if ("builtin" in resolved) {
    const name = resolved.builtin;
    return { kind: "other", load: () => namespaceOfBuiltin(name), loaded: null };
  }
  const { filename, query } = resolved;
  // A module already known by this URL is that module, whatever is on disk now.
  const known = esmRecords.get(filename + query);
  if (known) {
    return { kind: "esm", record: known };
  }
  const { format, prepared } = classify(filename);
  if (format === "esm") {
    return { kind: "esm", record: esmRecord(filename, query, prepared ?? undefined) };
  }
  return { kind: "other", load: () => loadNonEsm(filename, format), loaded: null };
}

/** Resolves a module's static imports, and theirs, before anything runs. */
function link(record: EsmRecord): void {
  if (record.state !== "new") {
    return;
  }
  record.state = "linked";
  try {
    record.prepared ??= prepareSource(readText(record.filename), record.filename, "esm");
    for (const specifier of record.prepared.specifiers) {
      const dependency = dependencyFor(specifier, record.filename, "import");
      record.dependencies.set(specifier, dependency);
      if (dependency.kind === "esm") {
        link(dependency.record);
      }
    }
  } catch (error) {
    record.state = "errored";
    record.error = error;
    throw error;
  }
}

function importMetaFor(record: EsmRecord): Record<string, unknown> {
  const query = record.id.slice(record.filename.length);
  return {
    url: fileUrl(record.filename) + query,
    filename: record.filename,
    dirname: dirname(record.filename),
    resolve(specifier: string, parent?: string | URL): string {
      const from = parent === undefined ? record.filename : pathFromFileUrl(String(parent));
      const resolved = resolveSpecifier(String(specifier), from, "import", host.conditions);
      return "builtin" in resolved
        ? `node:${resolved.builtin}`
        : fileUrl(resolved.filename) + resolved.query;
    },
  };
}

function execute(record: EsmRecord): unknown {
  const prepared = record.prepared!;
  record.prepared = null;
  const run = compileFunction(
    prepared.code,
    [EXPORTS_BINDING, STATIC_IMPORT_BINDING, IMPORT_META_BINDING, DYNAMIC_IMPORT_BINDING],
    record.filename,
    hasTopLevelAwait(prepared.code),
  );

  // The rewritten `import` statements call this with the specifiers linked above.
  const requireImport = (specifier: string): unknown => {
    const dependency = record.dependencies.get(specifier);
    if (!dependency) {
      throw new Error(`webnode: "${specifier}" was not linked for ${record.filename}`);
    }
    if (dependency.kind === "esm") {
      return dependency.record.namespace;
    }
    dependency.loaded ??= dependency.load();
    return dependency.loaded;
  };

  return run(record.namespace, requireImport, importMetaFor(record), (specifier: unknown) =>
    importModule(String(specifier), record.filename),
  );
}

/**
 * Evaluates `record` after its imports. Returns a promise only when the module
 * or one of its imports awaits at the top level. `ancestors` are the modules
 * whose evaluation is waiting on this one, to recognise a cycle.
 */
function evaluate(record: EsmRecord, ancestors: Set<EsmRecord>): void | Promise<void> {
  if (record.state === "evaluated") {
    return;
  }
  if (record.state === "errored") {
    throw record.error;
  }
  if (record.state === "evaluating") {
    // A cycle sees the module as far as it got; anyone else waits for it.
    return ancestors.has(record) ? undefined : (record.pending ?? undefined);
  }

  record.state = "evaluating";
  ancestors.add(record);

  const succeed = () => {
    aliasStringNames(record.namespace);
    record.state = "evaluated";
    record.pending = null;
  };
  const fail = (error: unknown): never => {
    record.state = "errored";
    record.error = error;
    record.pending = null;
    throw error;
  };

  // Every import is visited in order now: one that awaits at the top level
  // holds back only the modules that import it, not its later siblings.
  const waits: Promise<void>[] = [];
  let result: unknown;
  try {
    for (const dependency of record.dependencies.values()) {
      if (dependency.kind === "esm") {
        const pending = evaluate(dependency.record, ancestors);
        if (pending) {
          waits.push(pending);
        }
      } else {
        dependency.loaded ??= dependency.load();
      }
    }
    ancestors.delete(record);
    if (waits.length === 0) {
      result = execute(record);
    }
  } catch (error) {
    ancestors.delete(record);
    // This module fails with `error`; the imports still awaiting report to their other importers.
    for (const wait of waits) {
      wait.catch(() => {});
    }
    return fail(error);
  }

  const finished = waits.length > 0 ? Promise.all(waits).then(() => execute(record)) : result;
  if (finished instanceof Promise) {
    record.pending = finished.then(succeed, fail);
    return record.pending;
  }
  succeed();
  return undefined;
}

function asyncModuleError(filename: string): Error {
  return codedError(
    new Error(
      `require() cannot be used on an ESM graph with top-level await. Use import() instead. To see where the top-level await comes from, use --experimental-print-required-tla.\n  From ${filename}`,
    ),
    "ERR_REQUIRE_ASYNC_MODULE",
  );
}

const requiredViews = new WeakMap<EsmRecord, Namespace>();

/**
 * What `require()` returns for an ES module: its exports read live, plus
 * `__esModule` when it has a default export, as Node marks it.
 */
function requiredView(record: EsmRecord): Namespace {
  let view = requiredViews.get(record);
  if (!view) {
    view = Object.create(null) as Namespace;
    const keys = Object.keys(record.namespace);
    if (keys.includes("default")) {
      Object.defineProperty(view, "__esModule", { enumerable: true, value: true });
    }
    for (const key of keys) {
      Object.defineProperty(view, key, { enumerable: true, get: () => record.namespace[key] });
    }
    Object.defineProperty(view, Symbol.toStringTag, { value: "Module" });
    if (record.state === "evaluated") {
      requiredViews.set(record, view);
    }
  }
  return view;
}

/** Whether a linked module, or one it imports and that has not run yet, awaits at its top level. */
function graphIsAsync(record: EsmRecord, seen: Set<EsmRecord>): boolean {
  if (seen.has(record) || record.state !== "linked") {
    return false;
  }
  seen.add(record);
  if (record.prepared && hasTopLevelAwait(record.prepared.code)) {
    return true;
  }
  for (const dependency of record.dependencies.values()) {
    if (dependency.kind === "esm" && graphIsAsync(dependency.record, seen)) {
      return true;
    }
  }
  return false;
}

function requireRecord(record: EsmRecord): Namespace {
  link(record);
  // Node decides before anything runs: an async graph is not evaluated at all.
  if (graphIsAsync(record, new Set()) || evaluate(record, new Set())) {
    throw asyncModuleError(record.filename);
  }
  // An ES module names what `require()` returns with an export called "module.exports".
  if (Object.hasOwn(record.namespace, "module.exports")) {
    return record.namespace["module.exports"] as Namespace;
  }
  return requiredView(record);
}

/** Loads an ES module for `require()`: it must finish without a top-level await. */
function requireEsm(filename: string): Namespace {
  return requireRecord(esmRecord(filename, ""));
}

/** As `requireEsm`, for source already prepared by `Module.prototype._compile`. */
function requireEsmSource(filename: string, prepared: PreparedSource): Namespace {
  return requireRecord(esmRecord(filename, "", prepared));
}

/** `import(specifier)` as written in the file `parent`. */
export async function importModule(specifier: string, parent: string): Promise<Namespace> {
  const dependency = dependencyFor(specifier, parent, "import");
  if (dependency.kind === "other") {
    dependency.loaded ??= dependency.load();
    return dependency.loaded;
  }
  link(dependency.record);
  await evaluate(dependency.record, new Set());
  return dependency.record.namespace;
}

/** Runs the program's entry file as an ES module or as the main CommonJS module. */
export function runEntry(filename: string): void | Promise<unknown> {
  const { format, prepared } = classify(filename);
  if (format === "esm") {
    return evaluateEntry(esmRecord(filename, "", prepared ?? undefined));
  }
  Module._load(filename, null, true);
  return undefined;
}

async function evaluateEntry(record: EsmRecord): Promise<Namespace> {
  link(record);
  await evaluate(record, new Set());
  return record.namespace;
}

/**
 * Runs `source` as code that lives at `filename` (for `node -e` and worker
 * eval). `format` is what `--input-type` says, or null to let the syntax decide.
 */
export function runSource(
  source: string,
  filename: string,
  format: "esm" | "cjs" | null = null,
): void | Promise<unknown> {
  const prepared = prepareSource(source, filename, format);
  if (prepared.format === "esm") {
    const record = esmRecord(filename, "", prepared);
    link(record);
    return evaluate(record, new Set());
  }
  const module = new Module(filename, null);
  module.filename = filename;
  module.paths = nodeModulePaths(dirname(filename));
  module.id = ".";
  Module.main = module;
  mainModuleListener?.(module);
  const run = compileFunction(
    prepared.code,
    [...WRAPPER_PARAMETERS, DYNAMIC_IMPORT_BINDING],
    filename,
    false,
  );
  return run.call(
    module.exports,
    module.exports,
    makeRequire(module),
    module,
    filename,
    dirname(filename),
    (specifier: unknown) => importModule(String(specifier), filename),
  ) as void;
}

/** Forgets what the loader knows about package.json files, for after an install. */
export function resetPackageCaches(): void {
  clearPackageCache();
}
