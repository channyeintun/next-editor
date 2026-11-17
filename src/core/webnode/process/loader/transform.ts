// Turns a module's source into code the loader can run as a function: strips
// TypeScript, decides whether the file is an ES module, and rewrites ES module
// syntax (`import`, `export`, `import()`, `import.meta`) into calls on the
// loader's own bindings. es-module-lexer finds the syntax; sucrase rewrites it.
import { init as initLexer, parse as lex } from "es-module-lexer";
import { transform } from "sucrase";
import type { Transform } from "sucrase";
import { parse as parseTokens } from "sucrase/dist/esm/parser/index.js";
import type { SucraseToken } from "sucrase/dist/esm/parser/index.js";
import { ContextualKeyword } from "sucrase/dist/esm/parser/tokenizer/keywords.js";
import { TokenType } from "sucrase/dist/esm/parser/tokenizer/types.js";

export interface PreparedSource {
  format: "esm" | "cjs";
  /** The body of the module's wrapper function. */
  code: string;
  /** For an ES module: its static import specifiers, in source order, without repeats. */
  specifiers: string[];
  /**
   * For an ES module: code, on one line, that runs when the module is linked,
   * before any module of its graph runs. It publishes the exported function
   * declarations, which a real module has from the start (they are hoisted),
   * so a module in an import cycle can call them before this one has run.
   */
  prologue: string;
  /** For an ES module: the names it exports itself and by `export … from`; null when unknown. */
  exportNames: string[] | null;
  /** For an ES module: the specifiers of its `export * from` statements. */
  starExports: string[];
  /** For an ES module: the names each `import … from` statement takes from its specifier. */
  importedNames: { specifier: string; names: string[] }[];
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

/** A name that can be written as an identifier in an import or export clause. */
const IDENTIFIER_NAME = /^[\p{ID_Start}_$][\p{ID_Continue}$\u200c\u200d]*$/u;

/** Whether an export called `name` can be read as `namespace.name` in rewritten code. */
export function isIdentifierName(name: string): boolean {
  return IDENTIFIER_NAME.test(name);
}

/**
 * The identifier that stands for an export whose name is not one
 * (`export { a as "any string" }`). sucrase only reads and writes identifier
 * names, so both the exporting and the importing module are rewritten to use
 * this name, and the namespace carries it as a hidden property beside the
 * real one.
 */
export function exportNameStandIn(name: string): string {
  let code = "__webnode_name";
  for (let index = 0; index < name.length; index += 1) {
    code += `_${name.charCodeAt(index).toString(16)}`;
  }
  return code;
}

/** A string literal in an import or export clause that names an import: `"name" as local`. */
const IMPORTED_STRING_NAME = /(["'])((?:\\.|(?!\1)[^\\\n])*)\1(?=\s+as\b)/g;

/** The value of a string literal's body, or null when it has an escape this does not decode. */
function stringLiteralValue(body: string): string | null {
  if (!body.includes("\\")) {
    return body;
  }
  try {
    return JSON.parse(`"${body.replace(/\\'/g, "'").replace(/(?<!\\)"/g, '\\"')}"`) as string;
  } catch {
    return null;
  }
}

const TYPESCRIPT = /\.(?:ts|mts|cts|tsx)$/;
const JSX = /\.(?:tsx|jsx)$/;
/** The modules sucrase's automatic JSX runtime imports. */
const JSX_RUNTIME = /\/jsx-(?:dev-)?runtime$/;

/** Whether `filename` is TypeScript, which the loader compiles before it runs. */
export function isTypeScriptFile(filename: string): boolean {
  return TYPESCRIPT.test(filename);
}

/** Whether `filename` is TypeScript or JSX: its package, not its syntax, says whether it is CommonJS. */
export function isCompiledFile(filename: string): boolean {
  return TYPESCRIPT.test(filename) || JSX.test(filename);
}

/**
 * The `//# sourceURL=` comment that names evaluated code after `filename` in
 * stack traces. The engine ignores a value with a space or a quote in it, so
 * those are percent-encoded.
 */
export function sourceUrlComment(filename: string): string {
  const url = filename.replace(/[\s"']/g, (character) =>
    character === "'" ? "%27" : encodeURIComponent(character),
  );
  return `\n//# sourceURL=${url}`;
}

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

/** Where `offset` is in `source`, as `line:column`. */
function position(source: string, offset: number): string {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  return `${line}:${offset - before.lastIndexOf("\n")}`;
}

/** The index of the token that closes the brace opened at `open`, or -1. */
function closingBrace(tokens: SucraseToken[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    const type = tokens[index].type;
    if (type === TokenType.braceL || type === TokenType.dollarBraceL) {
      depth += 1;
    } else if (type === TokenType.braceR) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/** The index of the `{` that opens the body of the declaration whose name starts at `index`, or -1. */
function bodyBrace(tokens: SucraseToken[], index: number): number {
  let open = index;
  while (
    tokens[open]?.type === TokenType.name ||
    tokens[open]?.type === TokenType.dot ||
    tokens[open]?.type === TokenType.string
  ) {
    open += 1;
  }
  return tokens[open]?.type === TokenType.braceL ? open : -1;
}

/** Whether the body of a namespace declares only types, so that erasing it loses nothing. */
function declaresOnlyTypes(body: string): boolean {
  let code: string;
  try {
    code = transform(body, { transforms: ["typescript"], disableESTransforms: true }).code;
  } catch {
    return false;
  }
  return code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "").replace(/[\s;]/g, "") === "";
}

/**
 * Throws a SyntaxError for TypeScript that sucrase cannot compile: it leaves
 * decorators in place, which the engine cannot run, and drops a namespace that
 * holds values, which would leave the program silently without it. Namespaces
 * that hold only types, and every `declare` block, are erased as tsc would.
 */
function rejectUncompiledTypeScript(source: string, filename: string): void {
  // Most files have neither; the parse below is only for the ones that may.
  if (!/@|\bnamespace\b|\bmodule\s+[\p{ID_Start}_$]/u.test(source)) {
    return;
  }
  let tokens: SucraseToken[];
  try {
    tokens = parseTokens(source, JSX.test(filename), true, false).tokens;
  } catch {
    // Not valid TypeScript: the transform reports it.
    return;
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === TokenType.at && !token.isType) {
      throw new SyntaxError(
        `TypeScript decorators are not supported in webnode (${filename}:${position(source, token.start)})`,
      );
    }
    if (token.type === TokenType._declare) {
      // `declare namespace`, `declare module`, `declare global`: types only, nested ones too.
      const next = tokens[index + 1];
      const open =
        next?.type === TokenType.name &&
        (next.contextualKeyword === ContextualKeyword._namespace ||
          next.contextualKeyword === ContextualKeyword._module ||
          next.contextualKeyword === ContextualKeyword._global)
          ? bodyBrace(tokens, index + 1)
          : -1;
      if (open >= 0) {
        index = Math.max(index, closingBrace(tokens, open));
      }
      continue;
    }
    const keyword = token.contextualKeyword;
    if (
      token.type !== TokenType.name ||
      !token.isType ||
      (keyword !== ContextualKeyword._namespace && keyword !== ContextualKeyword._module) ||
      tokens[index + 1]?.type !== TokenType.name
    ) {
      continue;
    }
    const open = bodyBrace(tokens, index + 1);
    const close = open >= 0 ? closingBrace(tokens, open) : -1;
    if (close < 0) {
      continue;
    }
    // A namespace nested in this one is checked when the loop reaches it.
    if (!declaresOnlyTypes(source.slice(tokens[open].end, tokens[close].start))) {
      const name = source.slice(tokens[index + 1].start, tokens[open - 1].end);
      throw new SyntaxError(
        `TypeScript namespace "${name}" holds values, which webnode cannot compile; only namespaces of types are supported (${filename}:${position(source, token.start)})`,
      );
    }
  }
}

function sucraseTransforms(filename: string): Transform[] {
  const transforms: Transform[] = [];
  if (TYPESCRIPT.test(filename)) {
    transforms.push("typescript");
  }
  if (JSX.test(filename)) {
    transforms.push("jsx");
  }
  return transforms;
}

/** `source` with its TypeScript types (and JSX) compiled away. */
export function stripTypes(source: string, filename: string): string {
  const transforms = sucraseTransforms(filename);
  if (transforms.length === 0) {
    return source;
  }
  if (TYPESCRIPT.test(filename)) {
    rejectUncompiledTypeScript(source, filename);
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
 * A TypeScript or JSX file that runs as CommonJS, with its `import`/`export`
 * statements compiled to `require` and `exports`, as tsx does. The wrapper
 * binds the loader's names for them (STATIC_IMPORT_BINDING, EXPORTS_BINDING)
 * beside `require` and `module`. `strict` is whether the file was a module to
 * begin with: a script keeps its own mode.
 */
function commonJsFromModule(source: string, filename: string, strict: boolean): PreparedSource {
  let code: string;
  try {
    code = transform(source, {
      transforms: [...sucraseTransforms(filename), "imports"],
      preserveDynamicImport: true,
      disableESTransforms: true,
      jsxRuntime: "automatic",
      production: false,
      filePath: filename,
    }).code;
  } catch (error) {
    throw syntaxError(error, filename);
  }
  if (!strict && code.startsWith('"use strict";')) {
    code = code.slice('"use strict";'.length);
  }
  let imports: ReturnType<typeof lex>[0] = [];
  try {
    [imports] = lex(code, filename);
  } catch {
    // Left for the engine to report.
  }
  for (const entry of [...imports].reverse()) {
    if (entry.type === "dynamic") {
      code = `${code.slice(0, entry.importStart)}${DYNAMIC_IMPORT_BINDING}${code.slice(entry.dynamicStart)}`;
    } else if (entry.type === "import-meta") {
      code = `${code.slice(0, entry.start)}${IMPORT_META_BINDING}${code.slice(entry.end)}`;
    }
  }
  return {
    format: "cjs",
    code,
    specifiers: [],
    prologue: "",
    exportNames: null,
    starExports: [],
    importedNames: [],
  };
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

/** An identifier, a string name, or either followed by `as local`, then a comma or the end. */
const IMPORT_SPECIFIER =
  /\s*(?:(["'])((?:\\.|(?!\1)[^\\\n])*)\1|([\p{ID_Start}_$][\p{ID_Continue}$\u200c\u200d]*))(?:\s+as\s+[\p{ID_Start}_$][\p{ID_Continue}$\u200c\u200d]*)?\s*(?:,|$)/uy;

/**
 * The names an `import … from` clause takes (`default` for a default import),
 * or null when the clause is not one this reads with certainty.
 */
function importedNamesOf(clause: string): string[] | null {
  const text = clause.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ").trim();
  if (text === "") {
    return [];
  }
  const names: string[] = [];
  const brace = text.indexOf("{");
  const head = (brace >= 0 ? text.slice(0, brace) : text).trim().replace(/,$/, "").trim();
  for (const part of head === "" ? [] : head.split(",")) {
    const binding = part.trim();
    if (/^\*\s*as\s/.test(binding)) {
      continue;
    }
    if (!isIdentifierName(binding)) {
      return null;
    }
    names.push("default");
  }
  if (brace < 0) {
    return names;
  }
  const close = text.lastIndexOf("}");
  if (close < brace || text.slice(close + 1).trim() !== "") {
    return null;
  }
  const inner = text.slice(brace + 1, close).trim();
  IMPORT_SPECIFIER.lastIndex = 0;
  while (IMPORT_SPECIFIER.lastIndex < inner.length) {
    const match = IMPORT_SPECIFIER.exec(inner);
    if (!match) {
      return null;
    }
    const name = match[3] ?? stringLiteralValue(match[2]);
    if (name === null) {
      return null;
    }
    names.push(name);
  }
  return names;
}

/** A function declaration's name: `function name(`, `function* name(`. */
const FUNCTION_DECLARATION =
  /\bfunction(?:\s*\*\s*|\s+)([\p{ID_Start}_$][\p{ID_Continue}$\u200c\u200d]*)\s*\(/gu;

/** The names `text` declares functions by, at any depth: one pass over the module. */
function declaredFunctionNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(FUNCTION_DECLARATION)) {
    names.add(match[1]);
  }
  return names;
}

/** An exported function declaration's publication, for the module's prologue. */
function hoistedExport(exported: string, local: string): string {
  const key = JSON.stringify(isIdentifierName(exported) ? exported : exportNameStandIn(exported));
  // `typeof` of a `let` or `class` not yet initialised throws: such a binding is not hoisted.
  return `try{if(typeof ${local}==="function")${EXPORTS_BINDING}[${key}]=${local}}catch{}`;
}

/**
 * Prepares `source` to run. `format` is what the file's name and package say it
 * is, or null to let its syntax decide. A JavaScript file with
 * `import`/`export` statements always runs as an ES module, and so does a file
 * of undecided format whose only module syntax is a top-level await. A
 * TypeScript or JSX file that is CommonJS by its name or package runs as
 * CommonJS, with its `import`/`export` compiled to `require`, as tsx does.
 */
export function prepareSource(
  source: string,
  filename: string,
  format: "esm" | "cjs" | null,
): PreparedSource {
  const original = withoutPreamble(source);
  let text = stripTypes(original, filename);

  let imports: ReturnType<typeof lex>[0];
  let exports: ReturnType<typeof lex>[1];
  let hasModuleSyntax: boolean;
  try {
    [imports, exports, , hasModuleSyntax] = lex(text, filename);
  } catch {
    // Not parseable as a module; run it as it is and let the engine report the error.
    return {
      format: format ?? "cjs",
      code: text,
      specifiers: [],
      prologue: "",
      exportNames: null,
      starExports: [],
      importedNames: [],
    };
  }

  if (isCompiledFile(filename) && hasModuleSyntax && format !== "esm") {
    // The import sucrase adds for the automatic JSX runtime is not the file's own module syntax.
    const ownModuleSyntax =
      !JSX.test(filename) ||
      exports.length > 0 ||
      imports.some(
        (entry) =>
          entry.type === "import-meta" ||
          (entry.type === "static" && !JSX_RUNTIME.test(entry.specifier ?? "")),
      );
    if (format === "cjs" || !ownModuleSyntax) {
      return commonJsFromModule(original, filename, ownModuleSyntax);
    }
  }

  const isModule =
    hasModuleSyntax || format === "esm" || (format === null && needsTopLevelAwait(text));

  // Rewrites of `import(`, `import.meta` and string export names, applied last
  // first so earlier offsets stay valid.
  const edits: { start: number; end: number; text: string }[] = [];
  const specifiers: string[] = [];
  const seen = new Set<string>();
  for (const entry of imports) {
    if (entry.type === "dynamic") {
      edits.push({
        start: entry.importStart,
        end: entry.dynamicStart,
        text: DYNAMIC_IMPORT_BINDING,
      });
    } else if (entry.type === "import-meta") {
      edits.push({ start: entry.start, end: entry.end, text: IMPORT_META_BINDING });
    }
  }
  // Names written as strings. One that is an identifier is written as one;
  // any other goes under its stand-in, which the exporting module's namespace
  // carries beside the real name.
  const renamed = new Map<string, string>();
  if (isModule) {
    // `export { a as "any string" }`, with or without a `from`.
    for (const entry of exports) {
      const quote = text[entry.start];
      const name = (entry as { name?: unknown }).name;
      if ((quote !== '"' && quote !== "'") || typeof name !== "string") {
        continue;
      }
      if (isIdentifierName(name)) {
        edits.push({ start: entry.start, end: entry.end, text: name });
      } else {
        renamed.set(name, exportNameStandIn(name));
        edits.push({ start: entry.start, end: entry.end, text: exportNameStandIn(name) });
      }
    }
    // `import { "any string" as local }` and `export { "any string" as name } from`.
    for (const entry of imports) {
      if (entry.type !== "static") {
        continue;
      }
      const clause = text.slice(entry.importStart, entry.start - 1);
      if (!clause.includes("{") || !/["']/.test(clause)) {
        continue;
      }
      for (const match of clause.matchAll(IMPORTED_STRING_NAME)) {
        const name = stringLiteralValue(match[2]);
        if (name === null) {
          continue;
        }
        const start = entry.importStart + match.index;
        edits.push({
          start,
          end: start + match[0].length,
          text: isIdentifierName(name) ? name : exportNameStandIn(name),
        });
      }
    }
  }
  // What the linker checks and hoists, read before the edits move the offsets.
  const hoisted: string[] = [];
  const exportNames: string[] = [];
  const starExports: string[] = [];
  const importedNames: { specifier: string; names: string[] }[] = [];
  if (isModule) {
    let functions: Set<string> | null = null;
    for (const entry of exports) {
      if (entry.typeOnly) {
        continue;
      }
      if (entry.type === "reexport-all") {
        starExports.push(entry.from);
        continue;
      }
      exportNames.push(entry.name);
      if (entry.type === "direct" && entry.localName !== undefined) {
        functions ??= declaredFunctionNames(text);
        if (functions.has(entry.localName)) {
          hoisted.push(hoistedExport(entry.name, entry.localName));
        }
      }
    }
    for (const entry of imports) {
      if (
        entry.type !== "static" ||
        entry.typeOnly ||
        entry.phase !== null ||
        typeof entry.specifier !== "string" ||
        !text.startsWith("import", entry.importStart)
      ) {
        continue;
      }
      const clause = text
        .slice(entry.importStart + "import".length, entry.start - 1)
        .replace(/\bfrom\s*$/, "");
      const names = importedNamesOf(clause);
      if (names !== null && names.length > 0) {
        importedNames.push({ specifier: entry.specifier, names });
      }
    }
  }

  edits.sort((left, right) => right.start - left.start);
  for (const edit of edits) {
    text = `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`;
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
    return {
      format: "cjs",
      code: text,
      specifiers: [],
      prologue: "",
      exportNames: null,
      starExports: [],
      importedNames: [],
    };
  }

  try {
    let code = transform(text, {
      transforms: ["imports"],
      preserveDynamicImport: true,
      disableESTransforms: true,
      filePath: filename,
    }).code;
    for (const [name, standIn] of renamed) {
      // The stand-in stays the live binding, hidden; the real name reads it.
      code +=
        `\nObject.defineProperty(${EXPORTS_BINDING}, "${standIn}", { enumerable: false });` +
        `\nObject.defineProperty(${EXPORTS_BINDING}, ${JSON.stringify(name)}, { enumerable: true, configurable: true, get: () => ${EXPORTS_BINDING}.${standIn} });`;
    }
    return {
      format: "esm",
      code,
      specifiers,
      prologue: hoisted.join(";"),
      exportNames,
      starExports,
      importedNames,
    };
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
