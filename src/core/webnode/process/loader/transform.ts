// Turns a module's source into code the loader can run as a function: strips
// TypeScript, decides whether the file is an ES module, and rewrites ES module
// syntax (`import`, `export`, `import()`, `import.meta`) into calls on the
// loader's own bindings. es-module-lexer finds the syntax; sucrase rewrites it.
import { init as initLexer, parse as lex } from "es-module-lexer";
import { transform } from "sucrase";
import type { Transform } from "sucrase";

export interface PreparedSource {
  format: "esm" | "cjs";
  /** The body of the module's wrapper function. */
  code: string;
  /** For an ES module: its static import specifiers, in source order, without repeats. */
  specifiers: string[];
}

/** Resolves once `prepareSource` may be called. */
export const transformReady: Promise<void> = Promise.resolve(initLexer).then(() => undefined);

/** The names the wrapper function binds for rewritten syntax. */
export const IMPORT_META_BINDING = "__webnode_import_meta";
export const DYNAMIC_IMPORT_BINDING = "__webnode_import";
/**
 * The function the rewritten `import` statements call. The bundler renames
 * sucrase's own `require(...)` to this (build/webnodeBundle.ts), so an ES module
 * is free to declare its own `require`, as `createRequire` users do.
 */
export const STATIC_IMPORT_BINDING = "__webnode_require";
/** The object the rewritten `export` statements write to, renamed the same way. */
export const EXPORTS_BINDING = "__webnode_exports";

const TYPESCRIPT = /\.(?:ts|mts|cts|tsx)$/;
const JSX = /\.(?:tsx|jsx)$/;

function syntaxError(error: unknown, filename: string): SyntaxError {
  const message = error instanceof Error ? error.message : String(error);
  const failure = new SyntaxError(`${message}\n    at ${filename}`);
  return failure;
}

/** Removes a byte-order mark and comments out a `#!` line, keeping line numbers. */
function withoutPreamble(source: string): string {
  let text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  if (text.startsWith("#!")) {
    text = `//${text.slice(2)}`;
  }
  return text;
}

/** `source` with its TypeScript types (and JSX) compiled away. */
export function stripTypes(source: string, filename: string): string {
  const transforms: Transform[] = [];
  if (TYPESCRIPT.test(filename)) {
    transforms.push("typescript");
  }
  if (JSX.test(filename)) {
    transforms.push("jsx");
  }
  if (transforms.length === 0) {
    return source;
  }
  try {
    return transform(source, {
      transforms,
      disableESTransforms: true,
      jsxRuntime: "automatic",
      production: false,
      filePath: filename,
    }).code;
  } catch (error) {
    throw syntaxError(error, filename);
  }
}

/**
 * Whether code with no `import`/`export` still has to be an ES module: it does
 * not compile as a script (a CommonJS wrapper body) but does as an async
 * function body, so its top level awaits. Node 22's module detection retries
 * such a file as ESM; a script that merely says `return` stays CommonJS.
 */
function needsTopLevelAwait(code: string): boolean {
  if (!/\bawait\b/.test(code)) {
    return false;
  }
  try {
    // Only compiled, never called.
    new Function(code);
    return false;
  } catch {
    // Not a script; see whether it is one only because of `await`.
  }
  try {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as FunctionConstructor;
    new AsyncFunction(code);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prepares `source` to run. `format` is what the file's name and package say it
 * is, or null to let its syntax decide. A file with `import`/`export`
 * statements always runs as an ES module, and so does a file of undecided
 * format whose only module syntax is a top-level await.
 */
export function prepareSource(
  source: string,
  filename: string,
  format: "esm" | "cjs" | null,
): PreparedSource {
  let text = stripTypes(withoutPreamble(source), filename);

  let imports: ReturnType<typeof lex>[0];
  let hasModuleSyntax: boolean;
  try {
    [imports, , , hasModuleSyntax] = lex(text, filename);
  } catch {
    // Not parseable as a module; run it as it is and let the engine report the error.
    return { format: format ?? "cjs", code: text, specifiers: [] };
  }

  const isModule =
    hasModuleSyntax || format === "esm" || (format === null && needsTopLevelAwait(text));

  // Replace `import(` and `import.meta`, last first so offsets stay valid.
  const specifiers: string[] = [];
  const seen = new Set<string>();
  for (let index = imports.length - 1; index >= 0; index -= 1) {
    const entry = imports[index];
    if (entry.type === "dynamic") {
      text = `${text.slice(0, entry.importStart)}${DYNAMIC_IMPORT_BINDING}${text.slice(entry.dynamicStart)}`;
    } else if (entry.type === "import-meta") {
      text = `${text.slice(0, entry.start)}${IMPORT_META_BINDING}${text.slice(entry.end)}`;
    }
  }
  for (const entry of imports) {
    if (entry.type === "dynamic" || entry.type === "import-meta") {
      continue;
    }
    const specifier = entry.specifier;
    if (typeof specifier === "string" && !seen.has(specifier)) {
      seen.add(specifier);
      specifiers.push(specifier);
    }
  }

  if (!isModule) {
    return { format: "cjs", code: text, specifiers: [] };
  }

  try {
    const code = transform(text, {
      transforms: ["imports"],
      preserveDynamicImport: true,
      disableESTransforms: true,
      filePath: filename,
    }).code;
    return { format: "esm", code, specifiers };
  } catch (error) {
    throw syntaxError(error, filename);
  }
}

/**
 * Whether module code awaits at its top level. Inside a class static block
 * `await` is a reserved word, so code that uses it there fails to compile,
 * while `await` inside nested async functions still compiles.
 */
export function hasTopLevelAwait(code: string): boolean {
  if (!/\bawait\b/.test(code)) {
    return false;
  }
  try {
    // Only compiled, never called.
    new Function(`class __webnode_probe { static {\n${code}\n} }`);
    return false;
  } catch {
    return true;
  }
}
