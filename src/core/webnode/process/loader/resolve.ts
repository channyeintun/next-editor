// Node's module resolution: from a specifier and the file that asked for it to
// a builtin's name or a real file path. One algorithm serves `require` and
// `import`; they differ in the package `exports` conditions they ask for.
import {
  exports as resolvePackageExports,
  imports as resolvePackageImports,
} from "resolve.exports";
import { errnoDescription, toSystemErrorRecord } from "../../errors";
import { builtinName } from "../node/names";
import { runtime } from "../runtime";

export interface PackageJson {
  name?: string;
  version?: string;
  main?: string;
  type?: string;
  exports?: unknown;
  imports?: unknown;
  bin?: unknown;
  [field: string]: unknown;
}

export interface PackageScope {
  /** The directory holding package.json. */
  directory: string;
  json: PackageJson;
}

export type ResolveMode = "require" | "import";

/** A resolved specifier: a builtin, or a file plus the `?query` the specifier carried. */
export type Resolved = { builtin: string } | { filename: string; query: string };

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

const EXTENSIONS = [".js", ".json", ".node", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".jsx"];
const TYPESCRIPT_SOURCE_FOR: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

const decoder = new TextDecoder();
const packageCache = new Map<string, PackageJson | null>();
const scopeCache = new Map<string, PackageScope | null>();
const resolutionCache = new Map<string, Resolved>();

// What a path is, remembered until the current turn of the event loop ends: one
// `require` probes the same directories many times. Only paths that exist are
// remembered, as Node's stat cache keeps only successful stats: a file written
// a line after a failed require() is found by the next one.
let kindCache: Map<string, number> | null = null;

// The platform's own, taken before a program can replace the global: the
// cache must end with the turn whatever a fake clock does with microtasks.
const platformQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);

const NOTHING = 0;
const FILE = 1;
const DIRECTORY = 2;

function kindOf(path: string): number {
  if (!kindCache) {
    kindCache = new Map();
    platformQueueMicrotask(() => {
      kindCache = null;
    });
  }
  let kind = kindCache.get(path);
  if (kind === undefined) {
    try {
      const mode = runtime().fs.stat(path, true).mode & S_IFMT;
      kind = mode === S_IFREG ? FILE : mode === S_IFDIR ? DIRECTORY : NOTHING;
    } catch {
      kind = NOTHING;
    }
    if (kind !== NOTHING) {
      kindCache.set(path, kind);
    }
  }
  return kind;
}

/** Forgets cached lookups; what was resolved before stays resolved, as in Node. */
export function clearResolveProbeCache(): void {
  kindCache = null;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function join(directory: string, relative: string): string {
  // "/" splits into two empty segments; the root is one.
  const segments = directory === "/" ? [""] : directory.split("/");
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length > 1) {
        segments.pop();
      }
    } else {
      segments.push(segment);
    }
  }
  const joined = segments.join("/");
  return joined === "" ? "/" : joined;
}

/** The read errors Node's GetPackageJSON takes for "there is no package.json". */
const NO_PACKAGE_JSON = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

/** The parsed package.json in `directory`, or null when there is none. */
export function readPackageJson(directory: string): PackageJson | null {
  let json = packageCache.get(directory);
  if (json === undefined) {
    json = parsePackageJson(directory === "/" ? "/package.json" : `${directory}/package.json`);
    packageCache.set(directory, json);
  }
  return json;
}

/**
 * Reads the package.json at `path` as Node's GetPackageJSON does: null when
 * there is none (ENOENT, ENOTDIR, EISDIR); any other read error, such as
 * EACCES from the file or a directory that cannot be searched, and JSON that
 * does not parse, are ERR_INVALID_PACKAGE_CONFIG in Node's words.
 */
function parsePackageJson(path: string): PackageJson | null {
  let bytes: Uint8Array;
  try {
    bytes = runtime().fs.readFile(path);
  } catch (error) {
    const code = toSystemErrorRecord(error)?.code;
    if (code === undefined || NO_PACKAGE_JSON.has(code)) {
      return null;
    }
    throw codedError(
      `Cannot read package config ${path}: ${errnoDescription(code)}.`,
      "ERR_INVALID_PACKAGE_CONFIG",
    );
  }
  try {
    return JSON.parse(decoder.decode(bytes)) as PackageJson;
  } catch {
    throw codedError(`Invalid package config ${path}.`, "ERR_INVALID_PACKAGE_CONFIG");
  }
}

/** The nearest package.json at or above `directory`. */
export function findPackageScope(directory: string): PackageScope | null {
  const cached = scopeCache.get(directory);
  if (cached !== undefined) {
    return cached;
  }
  let scope: PackageScope | null = null;
  let current = directory;
  for (;;) {
    if (current.endsWith("/node_modules")) {
      break;
    }
    const json = readPackageJson(current);
    if (json) {
      scope = { directory: current, json };
      break;
    }
    if (current === "/") {
      break;
    }
    current = dirname(current);
  }
  scopeCache.set(directory, scope);
  return scope;
}

/** Forgets every package.json read so far, for after an install. */
export function clearPackageCache(): void {
  packageCache.clear();
  scopeCache.clear();
}

function tryFile(path: string): string | null {
  return kindOf(path) === FILE ? path : null;
}

function tryExtensions(path: string): string | null {
  for (const extension of EXTENSIONS) {
    if (kindOf(path + extension) === FILE) {
      return path + extension;
    }
  }
  return null;
}

/** `./a.js` written in TypeScript source means `./a.ts` on disk. */
function tryTypeScriptSource(path: string): string | null {
  const dot = path.lastIndexOf(".");
  const candidates = dot < 0 ? undefined : TYPESCRIPT_SOURCE_FOR[path.slice(dot)];
  if (!candidates) {
    return null;
  }
  for (const extension of candidates) {
    const candidate = path.slice(0, dot) + extension;
    if (kindOf(candidate) === FILE) {
      return candidate;
    }
  }
  return null;
}

function tryDirectory(path: string): string | null {
  if (kindOf(path) !== DIRECTORY) {
    return null;
  }
  const main = readPackageJson(path)?.main;
  if (typeof main === "string" && main !== "") {
    const target = join(path, main);
    const found = tryFile(target) ?? tryExtensions(target) ?? tryIndex(target);
    if (found) {
      return found;
    }
  }
  return tryIndex(path);
}

function tryIndex(directory: string): string | null {
  return kindOf(directory) === DIRECTORY ? tryExtensions(`${directory}/index`) : null;
}

function tryPath(path: string): string | null {
  return tryFile(path) ?? tryExtensions(path) ?? tryTypeScriptSource(path) ?? tryDirectory(path);
}

/**
 * Whether a request names a directory outright (`./`, `.`, `..`, `dir/`,
 * `dir/.`): Node then looks only for the directory's package main or index,
 * never for a file of that name with an extension added.
 */
function namesDirectory(request: string): boolean {
  return (
    request.endsWith("/") ||
    request === "." ||
    request === ".." ||
    request.endsWith("/.") ||
    request.endsWith("/..")
  );
}

/** `tryPath` for a request as written, honouring a trailing slash. */
function tryRequest(path: string, request: string): string | null {
  return namesDirectory(request) ? tryDirectory(path) : tryPath(path);
}

function conditionsFor(mode: ResolveMode, extra: readonly string[]): string[] {
  return [mode, "node", "module-sync", ...extra];
}

function codedError(message: string, code: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

/**
 * The error for a request that matched nothing. `path` is the file an
 * `import` of a path looked for, which is what Node's message names; null for
 * a package.
 */
function notFound(
  specifier: string,
  parent: string,
  mode: ResolveMode,
  path: string | null,
): Error {
  if (mode === "require") {
    const error = codedError(
      `Cannot find module '${specifier}'\nRequire stack:\n- ${parent}`,
      "MODULE_NOT_FOUND",
    ) as Error & { requireStack: string[] };
    error.requireStack = [parent];
    return error;
  }
  return codedError(
    path === null
      ? `Cannot find package '${specifier}' imported from ${parent}`
      : `Cannot find module '${path}' imported from ${parent}`,
    "ERR_MODULE_NOT_FOUND",
  );
}

/** Splits `@scope/name/sub/path` into the package name and `./sub/path`. */
function splitBareSpecifier(specifier: string): { name: string; subpath: string } | null {
  const parts = specifier.split("/");
  const nameParts = specifier.startsWith("@") ? 2 : 1;
  if (parts.length < nameParts || parts[0] === "") {
    return null;
  }
  const name = parts.slice(0, nameParts).join("/");
  const rest = parts.slice(nameParts).join("/");
  return { name, subpath: rest === "" ? "." : `./${rest}` };
}

function resolveInPackage(
  directory: string,
  json: PackageJson | null,
  subpath: string,
  conditions: string[],
  specifier: string,
): string | null {
  if (json && json.exports !== undefined && json.exports !== null) {
    let targets: string[] | void;
    try {
      targets = resolvePackageExports(json, subpath, { conditions, unsafe: true });
    } catch {
      targets = undefined;
    }
    for (const target of targets ?? []) {
      const path = join(directory, target);
      const found = tryFile(path) ?? tryTypeScriptSource(path);
      if (found) {
        return found;
      }
    }
    throw codedError(
      subpath === "."
        ? `No "exports" main defined in ${directory}/package.json`
        : `Package subpath '${subpath}' is not defined by "exports" in ${directory}/package.json`,
      "ERR_PACKAGE_PATH_NOT_EXPORTED",
    );
  }

  if (subpath === ".") {
    return tryDirectory(directory);
  }
  void specifier;
  return tryRequest(join(directory, subpath), subpath);
}

function resolveBare(
  specifier: string,
  parentDirectory: string,
  conditions: string[],
): string | null {
  const split = splitBareSpecifier(specifier);
  if (!split) {
    return null;
  }

  // A package may import itself by name through its own "exports".
  const scope = findPackageScope(parentDirectory);
  if (scope && scope.json.name === split.name && scope.json.exports !== undefined) {
    return resolveInPackage(scope.directory, scope.json, split.subpath, conditions, specifier);
  }

  let current = parentDirectory;
  for (;;) {
    if (!current.endsWith("/node_modules")) {
      const directory = `${current === "/" ? "" : current}/node_modules/${split.name}`;
      if (kindOf(directory) === DIRECTORY) {
        const found = resolveInPackage(
          directory,
          readPackageJson(directory),
          split.subpath,
          conditions,
          specifier,
        );
        if (found) {
          return found;
        }
      }
    }
    if (current === "/") {
      return null;
    }
    current = dirname(current);
  }
}

function resolveImportsField(
  specifier: string,
  parentDirectory: string,
  conditions: string[],
  mode: ResolveMode,
  extra: readonly string[],
): Resolved | null {
  const scope = findPackageScope(parentDirectory);
  if (!scope || scope.json.imports === undefined) {
    return null;
  }
  let targets: string[] | void;
  try {
    targets = resolvePackageImports(scope.json, specifier, { conditions, unsafe: true });
  } catch {
    targets = undefined;
  }
  for (const target of targets ?? []) {
    if (target.startsWith("./") || target.startsWith("../")) {
      const found = tryFile(join(scope.directory, target));
      if (found) {
        return { filename: runtime().fs.realpath(found), query: "" };
      }
    } else {
      // The target is another package or a builtin.
      return resolveSpecifier(target, `${scope.directory}/package.json`, mode, extra);
    }
  }
  throw codedError(
    `Package import specifier "${specifier}" is not defined in package ${scope.directory}/package.json`,
    "ERR_PACKAGE_IMPORT_NOT_DEFINED",
  );
}

/** A path separator written as a percent escape: `%2F`, `%5C`. */
const ENCODED_SEPARATOR = /%2f|%5c/i;

/**
 * The path that the path part of an `import` specifier names. An import
 * specifier is a URL reference, so its percent escapes are decoded:
 * `./sp%20ace.mjs` is the file `sp ace.mjs`, and `%2e%2e` is `..`. An encoded
 * path separator is refused and an escape that does not decode throws
 * URIError, both as in Node; `named` is the path Node's message gives. A
 * `require()` request is a plain path and never comes here.
 */
function decodeImportPath(path: string, named: string, parent: string): string {
  if (!path.includes("%")) {
    return path;
  }
  if (ENCODED_SEPARATOR.test(path)) {
    const error = new TypeError(
      `Invalid module "${named}" must not include encoded "/" or "\\" characters imported from ${parent}`,
    ) as TypeError & { code: string };
    error.code = "ERR_INVALID_MODULE_SPECIFIER";
    throw error;
  }
  return decodeURIComponent(path);
}

function fileUrlToPath(url: string, parent: string): string {
  const { pathname } = new URL(url);
  return decodeImportPath(pathname, pathname, parent);
}

/** Whether a request names a path (`/a`, `./a`, `../a`, `.`, `..`) rather than a package. */
function isPathRequest(request: string): boolean {
  return (
    request.startsWith("/") ||
    request.startsWith("./") ||
    request.startsWith("../") ||
    request === "." ||
    request === ".."
  );
}

/**
 * Resolves `specifier` as asked for by the file `parent`. `extraConditions`
 * are the `--conditions` the process was started with. Throws Node's
 * `MODULE_NOT_FOUND` / `ERR_MODULE_NOT_FOUND` when nothing matches.
 */
export function resolveSpecifier(
  specifier: string,
  parent: string,
  mode: ResolveMode,
  extraConditions: readonly string[],
): Resolved {
  const builtin = builtinName(specifier);
  if (builtin) {
    return { builtin };
  }
  if (specifier.startsWith("node:")) {
    throw codedError(`No such built-in module: ${specifier}`, "ERR_UNKNOWN_BUILTIN_MODULE");
  }

  const parentDirectory = dirname(parent);
  const cacheKey = `${mode}\0${parentDirectory}\0${specifier}`;
  const cached = resolutionCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let request = specifier;
  let query = "";
  if (mode === "import") {
    if (/^(?:data|https?|blob):/.test(request)) {
      throw codedError(
        `Only file and node URLs are supported by the loader. Received '${request}'`,
        "ERR_UNSUPPORTED_ESM_URL_SCHEME",
      );
    }
    const mark = request.search(/[?#]/);
    if (
      mark >= 0 &&
      (request.startsWith(".") || request.startsWith("/") || request.startsWith("file:"))
    ) {
      query = request.slice(mark);
      request = request.slice(0, mark);
    }
    if (request.startsWith("file:")) {
      request = fileUrlToPath(request, parent);
    } else if (isPathRequest(request)) {
      request = decodeImportPath(
        request,
        join(request.startsWith("/") ? "/" : parentDirectory, request),
        parent,
      );
    } else if (!request.startsWith("#")) {
      // A package's name is taken as written; the path inside it is a URL path.
      const split = splitBareSpecifier(request);
      if (split && split.subpath !== ".") {
        request = split.name + decodeImportPath(split.subpath.slice(1), request, parent);
      }
    }
  }

  const conditions = conditionsFor(mode, extraConditions);
  let found: string | null = null;
  // The file a path request names; null for a package.
  let path: string | null = null;

  if (request.startsWith("#")) {
    const viaImports = resolveImportsField(
      request,
      parentDirectory,
      conditions,
      mode,
      extraConditions,
    );
    if (viaImports) {
      resolutionCache.set(cacheKey, viaImports);
      return viaImports;
    }
  } else if (isPathRequest(request)) {
    path = join(request.startsWith("/") ? "/" : parentDirectory, request);
    found = tryRequest(path, request);
  } else {
    found = resolveBare(request, parentDirectory, conditions);
  }

  if (!found) {
    throw notFound(specifier, parent, mode, path);
  }
  const resolved: Resolved = { filename: runtime().fs.realpath(found), query };
  resolutionCache.set(cacheKey, resolved);
  return resolved;
}

/**
 * The files a `require()` of `request` from `parent` that found nothing
 * looked for: the path it names (in each existing `node_modules` directory,
 * for a package name) with nothing and with each extension added, as Node's
 * `_findPath` reports them to watch mode. A request for a directory (`dir/`)
 * adds no extension. Only called when the require already failed.
 */
export function unresolvedCandidates(request: string, parent: string): string[] {
  if (request === "" || request.startsWith("#") || request.startsWith("node:")) {
    return [];
  }
  const suffixes = namesDirectory(request) ? [""] : ["", ...EXTENSIONS];
  const candidates = (base: string) => {
    const files = suffixes.map((suffix) => base + suffix);
    // `./a.js` is also looked for as its TypeScript source, `./a.ts`.
    const dot = base.lastIndexOf(".");
    const sources =
      suffixes.length > 1 && dot > base.lastIndexOf("/")
        ? TYPESCRIPT_SOURCE_FOR[base.slice(dot)]
        : undefined;
    for (const extension of sources ?? []) {
      files.push(base.slice(0, dot) + extension);
    }
    return files;
  };
  const parentDirectory = dirname(parent);
  if (request.startsWith("/")) {
    return candidates(join("/", request));
  }
  if (
    request.startsWith("./") ||
    request.startsWith("../") ||
    request === "." ||
    request === ".."
  ) {
    // Node skips a directory that does not exist, unless the request leaves it.
    if (!leavesDirectory(request) && kindOf(parentDirectory) !== DIRECTORY) {
      return [];
    }
    return candidates(join(parentDirectory, request));
  }
  const files: string[] = [];
  for (const directory of nodeModulePaths(parentDirectory)) {
    if (kindOf(directory) === DIRECTORY) {
      files.push(...candidates(join(directory, request)));
    }
  }
  return files;
}

/** Whether a relative request, normalized, starts with `..`. */
function leavesDirectory(request: string): boolean {
  let depth = 0;
  for (const segment of request.split("/")) {
    if (segment === "..") {
      depth -= 1;
      if (depth < 0) {
        return true;
      }
    } else if (segment !== "" && segment !== ".") {
      depth += 1;
    }
  }
  return false;
}

/** The `node_modules` directories searched from `directory`, nearest first. */
export function nodeModulePaths(directory: string): string[] {
  const paths: string[] = [];
  let current = directory;
  for (;;) {
    if (!current.endsWith("/node_modules")) {
      paths.push(`${current === "/" ? "" : current}/node_modules`);
    }
    if (current === "/") {
      return paths;
    }
    current = dirname(current);
  }
}

/** Whether the file at `filename` is an ES module by its extension or its package's `type`. */
export function formatByName(filename: string): "esm" | "cjs" | "json" | null {
  if (/\.(?:mjs|mts)$/.test(filename)) {
    return "esm";
  }
  if (/\.(?:cjs|cts)$/.test(filename)) {
    return "cjs";
  }
  if (filename.endsWith(".json")) {
    return "json";
  }
  const type = findPackageScope(dirname(filename))?.json.type;
  if (type === "module") {
    return "esm";
  }
  if (type === "commonjs") {
    return "cjs";
  }
  // No `type`: the source decides.
  return null;
}
