// The module system: CommonJS (`Module`, `require`) and the ES module linker,
// in one place because each loads the other. A CommonJS file is wrapped in a
// function and run. An ES module is rewritten by transform.ts into a function
// too; the linker resolves its static imports, evaluates them first in source
// order (awaiting those that use top-level await) and hands the module live
// views of their exports.
import { BUILTIN_MODULE_NAMES, builtinName } from "../node/names";
import { runtime } from "../runtime";
import { installEvaluatedCode } from "./evaluated";
import {
  clearPackageCache,
  findPackageScope,
  formatByName,
  nodeModulePaths,
  resolveSpecifier,
  unresolvedCandidates,
} from "./resolve";
import type { ResolveMode } from "./resolve";
import {
  DYNAMIC_IMPORT_BINDING,
  exportNameStandIn,
  EXPORTS_BINDING,
  hasTopLevelAwait,
  IMPORT_META_BINDING,
  isCompiledFile,
  isIdentifierName,
  isTypeScriptFile,
  prepareSource,
  sourceUrlComment,
  STATIC_IMPORT_BINDING,
  stripTypes,
} from "./transform";
import { preparedFromStore } from "./prepared";
import type { PreparedSource } from "./transform";

type Namespace = Record<string | symbol, unknown>;

/**
 * What watch mode is told of a file: it was loaded by `require` or by
 * `import`, or it is "missing": a failed `require()` looked for it.
 */
export type LoadKind = "require" | "import" | "missing";

interface LoaderHost {
  /** The exports of builtin module `name`. */
  loadBuiltin(name: string): unknown;
  /** `--conditions` the process was started with. */
  conditions: readonly string[];
  /**
   * Watch mode's child only: told of each file the program loads, and of the
   * files a failed `require()` looked for, as Node tells its watch mode
   * (process/programs/watch.ts). Null otherwise, which costs one check a module.
   */
  report?: ((kind: LoadKind, filename: string) => void) | null;
}

let host: LoaderHost = {
  loadBuiltin(name) {
    throw new Error(`webnode: builtin module "${name}" is not registered`);
  },
  conditions: [],
};

/**
 * Connects the loader to the builtin registry and the process's options, and
 * makes the code the program evaluates itself load through it (evaluated.ts).
 */
export function configureLoader(next: LoaderHost): void {
  host = next;
  installEvaluatedCode(importModule);
}

const decoder = new TextDecoder();

function readText(filename: string): string {
  return decoder.decode(runtime().fs.readFile(filename));
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

/** `path` made absolute against the working directory, `.` and `..` resolved, as Node's `path.resolve`. */
function absolutePath(path: string): string {
  const segments: string[] = [];
  for (const segment of (path.startsWith("/") ? path : `${runtime().cwd}/${path}`).split("/")) {
    if (segment === "..") {
      segments.pop();
    } else if (segment !== "" && segment !== ".") {
      segments.push(segment);
    }
  }
  return `/${segments.join("/")}`;
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

/**
 * Runs `code` as the body of a function taking `parameters`, named after
 * `filename` in stack traces. A generator is for an ES module: its first step
 * links it, the second runs it.
 */
function compileFunction(
  code: string,
  parameters: string[],
  filename: string,
  isAsync: boolean,
  isGenerator = false,
): (...args: unknown[]) => unknown {
  const source = `(${isAsync ? "async " : ""}function${isGenerator ? "*" : ""} (${parameters.join(", ")}) {${code}\n})${sourceUrlComment(filename)}`;
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
/**
 * What a CommonJS wrapper binds beside Node's parameters: `import()`, and the
 * names a TypeScript file's compiled `import`/`export` use (transform.ts).
 */
const COMMONJS_PARAMETERS = [
  ...WRAPPER_PARAMETERS,
  DYNAMIC_IMPORT_BINDING,
  STATIC_IMPORT_BINDING,
  EXPORTS_BINDING,
];

/** Runs compiled CommonJS `code` for `module`. */
function runCommonJs(module: Module, code: string, filename: string): unknown {
  const run = compileFunction(code, COMMONJS_PARAMETERS, filename, false);
  const require = makeRequire(module);
  return run.call(
    module.exports,
    module.exports,
    require,
    module,
    filename,
    dirname(filename),
    (specifier: unknown) => importModule(String(specifier), filename),
    require,
    module.exports,
  );
}

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
          `${absolutePath(path)}/noop.js`,
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
      ? options.paths.map((path) => `${absolutePath(path)}/noop.js`)
      : [parent?.filename ?? `${runtime().cwd}/[eval]`];
    let failure: unknown;
    for (const from of parents) {
      try {
        const resolved = resolveSpecifier(request, from, "require", host.conditions);
        return "builtin" in resolved ? resolved.builtin : resolved.filename;
      } catch (error) {
        failure = error;
        reportUnresolved(request, from, error);
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
    // Before it runs, as Node does: a file that throws is watched too.
    host.report?.("require", filename);
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
    // A TypeScript or JSX file takes its format from its package, as tsx does;
    // a JavaScript file's syntax still decides.
    const prepared = prepareSource(
      content,
      filename,
      named === "esm" || (named === "cjs" && isCompiledFile(filename)) ? named : null,
    );
    if (prepared.format === "esm") {
      this.exports = requireEsmSource(filename, prepared);
      return undefined;
    }
    return runCommonJs(this, prepared.code, filename);
  }
}

let mainModuleListener: ((module: Module) => void) | null = null;

/** Runs `listener` when the main CommonJS module is created, for `process.mainModule`. */
export function onMainModule(listener: (module: Module) => void): void {
  mainModuleListener = listener;
}

/**
 * Watch mode: a `require()` of `request` from the file `from` found nothing.
 * Reports the files it looked for, as Node's `_findPath` does, so that
 * creating one of them restarts the program.
 */
export function reportUnresolved(request: string, from: string, error: unknown): void {
  const report = host.report;
  if (!report || (error as { code?: unknown } | null)?.code !== "MODULE_NOT_FOUND") {
    return;
  }
  for (const filename of unresolvedCandidates(request, from)) {
    report("missing", filename);
  }
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
  // A file that cannot be read fails with the read's own message; only a parse error names the file.
  const text = readText(filename);
  try {
    module.exports = JSON.parse(text.replace(/^﻿/, ""));
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
  /** The module's code, linked and waiting for its turn to run (`compileFunction`). */
  body: Iterator<unknown> | AsyncIterator<unknown> | null;
  /** Whether the module awaits at its top level. */
  isAsync: boolean;
  /** What it exports by name (null when unknown) and the specifiers it `export *`s from. */
  exportNames: Set<string> | null;
  starExports: string[];
}

const esmRecords = new Map<string, EsmRecord>();

function esmRecord(filename: string, query: string, prepared?: PreparedSource): EsmRecord {
  const id = filename + query;
  let record = esmRecords.get(id);
  if (!record) {
    // Marked as a namespace from the start: a module in an import cycle that
    // runs before this one then reads its exports live, default and `* as` too.
    const namespace: Namespace = {};
    Object.defineProperty(namespace, "__esModule", { value: true });
    record = {
      id,
      filename,
      namespace,
      prepared: prepared ?? null,
      dependencies: new Map(),
      state: "new",
      error: undefined,
      pending: null,
      body: null,
      isAsync: false,
      exportNames: null,
      starExports: [],
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
  host.report?.("import", filename);
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

/**
 * Resolves a module's static imports, and theirs, checks the names they import
 * and compiles them, all before anything runs. A graph that fails to link
 * leaves nothing behind: a later import reads its files again, as Node does.
 */
function link(record: EsmRecord): void {
  if (record.state !== "new") {
    return;
  }
  const linked: EsmRecord[] = [];
  try {
    linkGraph(record, linked);
    for (const each of linked) {
      checkImportedNames(each);
    }
    for (const each of linked) {
      instantiate(each);
    }
  } catch (error) {
    for (const each of linked) {
      if (esmRecords.get(each.id) === each) {
        esmRecords.delete(each.id);
      }
    }
    throw error;
  }
}

function linkGraph(record: EsmRecord, linked: EsmRecord[]): void {
  if (record.state !== "new") {
    return;
  }
  record.state = "linked";
  linked.push(record);
  record.prepared ??=
    preparedFromStore(record.filename) ??
    prepareSource(readText(record.filename), record.filename, "esm");
  const exportNames = record.prepared.exportNames;
  record.exportNames = exportNames === null ? null : new Set(exportNames);
  record.starExports = record.prepared.starExports;
  for (const specifier of record.prepared.specifiers) {
    const dependency = dependencyFor(specifier, record.filename, "import");
    record.dependencies.set(specifier, dependency);
    if (dependency.kind === "esm") {
      linkGraph(dependency.record, linked);
    }
  }
}

/** Whether `record` exports `name`; true when that cannot be known (an `export *` of CommonJS). */
function providesExport(record: EsmRecord, name: string, seen: Set<EsmRecord>): boolean {
  if (record.exportNames === null || record.exportNames.has(name)) {
    return true;
  }
  if (name === "default" || seen.has(record)) {
    return false;
  }
  seen.add(record);
  for (const specifier of record.starExports) {
    const dependency = record.dependencies.get(specifier);
    if (!dependency || dependency.kind !== "esm" || providesExport(dependency.record, name, seen)) {
      return true;
    }
  }
  return false;
}

/**
 * Node's link-time check that an ES module exports each name imported from
 * it. A CommonJS or builtin module is not checked, and neither is a
 * TypeScript importer, whose imports of types sucrase cannot always tell from
 * values.
 */
function checkImportedNames(record: EsmRecord): void {
  if (isTypeScriptFile(record.filename)) {
    return;
  }
  for (const { specifier, names } of record.prepared?.importedNames ?? []) {
    const dependency = record.dependencies.get(specifier);
    if (dependency?.kind !== "esm") {
      continue;
    }
    for (const name of names) {
      if (!providesExport(dependency.record, name, new Set())) {
        throw new SyntaxError(
          `The requested module '${specifier}' does not provide an export named '${name}'`,
        );
      }
    }
  }
}

/**
 * The first steps of the async modules instantiated since evaluation last
 * began. An async generator awaits at its `yield`, so until that step settles
 * a second `next()` is only queued: the module's body would start a turn
 * late, after the siblings that Node runs after it. Evaluation of a graph
 * with such modules waits for these first (`instantiated`).
 */
let firstSteps: Promise<unknown>[] = [];

/** Resolves once every async module instantiated so far can be resumed at once; null when none waits. */
function instantiated(): Promise<void> | null {
  if (firstSteps.length === 0) {
    return null;
  }
  const waiting = firstSteps;
  firstSteps = [];
  return Promise.all(waiting).then(() => undefined);
}

/** Compiles a linked module and publishes its hoisted exports (`PreparedSource.prologue`). */
function instantiate(record: EsmRecord): void {
  const prepared = record.prepared!;
  record.isAsync = hasTopLevelAwait(prepared.code);
  const run = compileFunction(
    `"use strict";${prepared.prologue};yield;${prepared.code}`,
    [EXPORTS_BINDING, STATIC_IMPORT_BINDING, IMPORT_META_BINDING, DYNAMIC_IMPORT_BINDING],
    record.filename,
    record.isAsync,
    true,
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

  const body = run(record.namespace, requireImport, importMetaFor(record), (specifier: unknown) =>
    importModule(String(specifier), record.filename),
  ) as Iterator<unknown> | AsyncIterator<unknown>;
  // An async module's first step settles later, but runs now, up to its `yield`.
  const linked = body.next();
  if (linked instanceof Promise) {
    firstSteps.push(linked.catch(() => {}));
  }
  record.body = body;
}

function importMetaFor(record: EsmRecord): Record<string, unknown> {
  const query = record.id.slice(record.filename.length);
  return {
    url: fileUrl(record.filename) + query,
    filename: record.filename,
    dirname: dirname(record.filename),
    resolve(specifier: string, parent?: string | URL): string {
      const from = parent === undefined ? record.filename : pathFromFileUrl(String(parent));
      const text = String(specifier);
      let resolved: ReturnType<typeof resolveSpecifier>;
      try {
        resolved = resolveSpecifier(text, from, "import", host.conditions);
      } catch (error) {
        // A path or file URL resolves whether or not the file exists, as in Node.
        if (/^(?:\.{1,2}(?:\/|$)|\/|file:)/.test(text)) {
          const url = new URL(text, fileUrl(from));
          if (url.protocol === "file:") {
            return url.href;
          }
        }
        throw error;
      }
      return "builtin" in resolved
        ? `node:${resolved.builtin}`
        : fileUrl(resolved.filename) + resolved.query;
    },
  };
}

/** Runs a linked module's body: a promise when it awaits at its top level. */
function execute(record: EsmRecord): unknown {
  const body = record.body!;
  record.body = null;
  record.prepared = null;
  return body.next();
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
  if (record.isAsync) {
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
  await instantiated();
  await evaluate(dependency.record, new Set());
  return dependency.record.namespace;
}

/** Runs the program's entry file as an ES module or as the main CommonJS module. */
export function runEntry(filename: string): void | Promise<unknown> {
  // Before its source is read: an entry that does not parse is watched too.
  host.report?.(formatByName(filename) === "esm" ? "import" : "require", filename);
  const { format, prepared } = classify(filename);
  if (format === "esm") {
    return evaluateEntry(esmRecord(filename, "", prepared ?? undefined));
  }
  Module._load(filename, null, true);
  return undefined;
}

async function evaluateEntry(record: EsmRecord): Promise<Namespace> {
  link(record);
  await instantiated();
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
    // Always in a promise job, as Node evaluates a module, entry or eval
    // code alike: the ticks it queues run after the promise jobs it queues.
    return evaluateEntry(esmRecord(filename, "", prepared));
  }
  const module = new Module(filename, null);
  module.filename = filename;
  module.paths = nodeModulePaths(dirname(filename));
  module.id = ".";
  Module.main = module;
  mainModuleListener?.(module);
  return runCommonJs(module, prepared.code, filename) as void;
}

/** Forgets what the loader knows about package.json files, for after an install. */
export function resetPackageCaches(): void {
  clearPackageCache();
}
