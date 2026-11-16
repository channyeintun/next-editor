// Node's module resolution: from a specifier and the file that asked for it to
// a builtin's name or a real file path. One algorithm serves `require` and
// `import`; they differ in the package `exports` conditions they ask for.
import {
  exports as resolvePackageExports,
  imports as resolvePackageImports,
} from "resolve.exports";
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

const NOTHING = 0;
const FILE = 1;
const DIRECTORY = 2;

function kindOf(path: string): number {
  if (!kindCache) {
    kindCache = new Map();
    queueMicrotask(() => {
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

/** The parsed package.json in `directory`, or null when there is none. */
export function readPackageJson(directory: string): PackageJson | null {
  let json = packageCache.get(directory);
  if (json === undefined) {
    const path = directory === "/" ? "/package.json" : `${directory}/package.json`;
    json = null;
    if (kindOf(path) === FILE) {
      try {
        json = JSON.parse(decoder.decode(runtime().fs.readFile(path))) as PackageJson;
      } catch (error) {
        const invalid = new Error(
          `Invalid package config ${path}. ${error instanceof Error ? error.message : ""}`,
        ) as Error & { code: string };
        invalid.code = "ERR_INVALID_PACKAGE_CONFIG";
        throw invalid;
      }
    }
    packageCache.set(directory, json);
  }
  return json;
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

function notFound(specifier: string, parent: string, mode: ResolveMode): Error {
  if (mode === "require") {
    const error = codedError(
      `Cannot find module '${specifier}'\nRequire stack:\n- ${parent}`,
      "MODULE_NOT_FOUND",
    ) as Error & { requireStack: string[] };
    error.requireStack = [parent];
    return error;
  }
  const what = specifier.startsWith(".") || specifier.startsWith("/") ? "module" : "package";
  return codedError(
    `Cannot find ${what} '${specifier}' imported from ${parent}`,
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

function fileUrlToPath(url: string): string {
  const parsed = new URL(url);
  return decodeURIComponent(parsed.pathname);
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
      request = fileUrlToPath(request);
    }
  }

  const conditions = conditionsFor(mode, extraConditions);
  let found: string | null = null;

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
  } else if (
    request.startsWith("/") ||
    request.startsWith("./") ||
    request.startsWith("../") ||
    request === "." ||
    request === ".."
  ) {
    found = tryRequest(join(request.startsWith("/") ? "/" : parentDirectory, request), request);
  } else {
    found = resolveBare(request, parentDirectory, conditions);
  }

  if (!found) {
    throw notFound(specifier, parent, mode);
  }
  const resolved: Resolved = { filename: runtime().fs.realpath(found), query };
  resolutionCache.set(cacheKey, resolved);
  return resolved;
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
