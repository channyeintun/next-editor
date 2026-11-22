// Turns a module's source into code the loader can run as a function: strips
// TypeScript, decides whether the file is an ES module, and rewrites ES module
// syntax (`import`, `export`, `import()`, `import.meta`) into calls on the
// loader's own bindings. es-module-lexer finds the syntax; sucrase rewrites it.
// Code a program evaluates itself (`new Function`, `eval`) is rewritten here
// too, so that its `import()` is the loader's as well.
import { init as initLexer, parse as lex } from "es-module-lexer";
import { transform } from "sucrase";
import type { Transform } from "sucrase";
import { parse as parseTokens } from "sucrase/dist/esm/parser/index.js";
import type { SucraseToken } from "sucrase/dist/esm/parser/index.js";
import { IdentifierRole } from "sucrase/dist/esm/parser/tokenizer/index.js";
import { ContextualKeyword } from "sucrase/dist/esm/parser/tokenizer/keywords.js";
import { TokenType } from "sucrase/dist/esm/parser/tokenizer/types.js";

// The engine's own constructors, taken before the loader puts its own in
// their place (evaluated.ts): the checks below only compile code.
const NativeFunction = Function;
const NativeAsyncFunction = Object.getPrototypeOf(async () => {})
  .constructor as FunctionConstructor;

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
/**
 * The loader's function for code a program evaluates itself (evaluated.ts).
 * Called with the file the code belongs to, it gives that code's `import()`,
 * the function a direct `eval` passes its source through, and an indirect
 * `eval`. Such code has no wrapper function to bind a name for it, so this
 * one is a property of the global object, not enumerable. It is called by
 * name alone: the code around a rewritten call may have a `globalThis` or a
 * `Symbol` of its own.
 */
export const EVALUATED_BINDING = "__webnode_evaluated";

/**
 * The expression that gives rewritten code the loader's functions for code of
 * the file `parent`. `importer` names the `import()` that code gets when it is
 * not the loader's (evaluated.ts, `defineEvaluatedImporter`).
 */
function evaluatedHost(parent: string, importer?: string): string {
  const named = importer === undefined ? "" : `, ${JSON.stringify(importer)}`;
  return `${EVALUATED_BINDING}(${JSON.stringify(parent)}${named})`;
}

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
  if (filename.startsWith("/")) {
    namedSources.set(url, filename);
  }
  return `\n//# sourceURL=${url}`;
}

/** The names `sourceUrlComment` gave the code of files (absolute paths), and the file each stands for. */
const namedSources = new Map<string, string>();

/** The file whose code a stack frame's script name stands for, when the name is one `sourceUrlComment` gave. */
export function fileOfSourceName(name: string): string | undefined {
  return namedSources.get(name);
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

/** A replacement of `text.slice(start, end)`. */
interface Edit {
  start: number;
  end: number;
  text: string;
}

/** `text` with `edits`, which do not overlap, applied. An insertion goes before a replacement that starts where it does. */
function applyEdits(text: string, edits: Edit[]): string {
  if (edits.length === 0) {
    return text;
  }
  const parts: string[] = [];
  let from = 0;
  const ordered = [...edits].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  for (const edit of ordered) {
    parts.push(text.slice(from, edit.start), edit.text);
    from = edit.end;
  }
  parts.push(text.slice(from));
  return parts.join("");
}

const LINE_BREAK = /[\n\r\u2028\u2029]/;

/**
 * An import declaration on one line, without its comments. A declaration holds
 * only names, punctuation and string literals, so a quote always opens a
 * string and a slash always opens a comment.
 */
function onOneLine(declaration: string): string {
  if (!LINE_BREAK.test(declaration) && !declaration.includes("/*") && !declaration.includes("//")) {
    return declaration;
  }
  let line = "";
  for (let index = 0; index < declaration.length; index += 1) {
    const character = declaration[index];
    if (character === '"' || character === "'") {
      let end = index + 1;
      while (end < declaration.length && declaration[end] !== character) {
        if (declaration[end] === "\\" && LINE_BREAK.test(declaration[end + 1] ?? "")) {
          // A line continuation adds nothing to the string's value.
          line += declaration.slice(index, end);
          index = end + (declaration[end + 1] === "\r" && declaration[end + 2] === "\n" ? 3 : 2);
          end = index;
        } else {
          end += declaration[end] === "\\" ? 2 : 1;
        }
      }
      line += declaration.slice(index, end + 1);
      index = end;
    } else if (character === "/" && declaration[index + 1] === "*") {
      const end = declaration.indexOf("*/", index + 2);
      index = end < 0 ? declaration.length : end + 1;
      line += " ";
    } else if (character === "/" && declaration[index + 1] === "/") {
      const end = declaration.slice(index).search(LINE_BREAK);
      index = end < 0 ? declaration.length : index + end;
      line += " ";
    } else {
      line += LINE_BREAK.test(character) ? " " : character;
    }
  }
  return line;
}

/** TypeScript's `import name = require(…)`: an assignment, which runs where it stands. */
const IMPORT_EQUALS = /^import\s+(?:type\s+)?[\p{ID_Start}_$][\p{ID_Continue}$\u200c\u200d]*\s*=/u;

/**
 * Lifts the `import` declarations out of a module's text, as the language
 * hoists them: an imported binding is usable on every line, also above its
 * declaration. Each declaration is replaced where it stands by `;` and its
 * line breaks (a statement boundary, so the lines around it end where they
 * did and keep their numbers) and is returned, on one line, to go before the
 * module's first line. The `edits` inside a declaration move with it; the
 * blanks are added to `edits`.
 */
function liftImports(text: string, imports: ReturnType<typeof lex>[0], edits: Edit[]): string {
  let lifted = "";
  for (const entry of imports) {
    if (
      entry.type !== "static" ||
      entry.phase !== null ||
      !text.startsWith("import", entry.importStart)
    ) {
      continue;
    }
    const start = entry.importStart;
    const end = entry.importEnd;
    const declaration = text.slice(start, end);
    let line = onOneLine(declaration);
    if (line.includes("=") && IMPORT_EQUALS.test(line)) {
      continue;
    }
    const inside: Edit[] = [];
    for (let index = edits.length - 1; index >= 0; index -= 1) {
      const edit = edits[index];
      if (edit.start >= start && edit.end <= end) {
        inside.push({ start: edit.start - start, end: edit.end - start, text: edit.text });
        edits.splice(index, 1);
      }
    }
    if (inside.length > 0) {
      line = onOneLine(applyEdits(declaration, inside));
    }
    lifted += `${line};`;
    edits.push({ start, end, text: `;${declaration.replace(/[^\n\r\u2028\u2029]+/g, "")}` });
  }
  return lifted;
}

/** `source` with its import declarations first (`liftImports`); as it is when the lexer cannot read it. */
function withImportsFirst(source: string, filename: string): string {
  let imports: ReturnType<typeof lex>[0];
  try {
    [imports] = lex(source, filename);
  } catch {
    return source;
  }
  const edits: Edit[] = [];
  const lifted = liftImports(source, imports, edits);
  return lifted + applyEdits(source, edits);
}

/** A letter, digit, `_` or `$`, or any character outside ASCII: what may be part of a name. */
function isNameCode(code: number): boolean {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code === 36 ||
    code > 127
  );
}

/** The index of the first character at or after `from` that is not white space. */
function skipSpace(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/.test(text[index])) {
    index += 1;
  }
  return index;
}

/** The text before `at` without the white space at its end. */
function textBefore(text: string, at: number): string {
  // A keyword and the space after it: no more is looked at.
  return text.slice(Math.max(0, at - 32), at).trimEnd();
}

/** The names of the global object whose `eval` property `aliasEdits` reads as the global `eval`. */
const GLOBAL_OBJECTS = new Set(["globalThis", "global", "self", "window"]);

/** Whether the `.` at `dot` follows one of `GLOBAL_OBJECTS`, itself no property: `globalThis.eval`. */
function followsGlobalObject(text: string, dot: number): boolean {
  let end = dot;
  while (end > 0 && /\s/.test(text[end - 1])) {
    end -= 1;
  }
  let start = end;
  while (start > 0 && isNameCode(text.charCodeAt(start - 1))) {
    start -= 1;
  }
  if (start === end || !GLOBAL_OBJECTS.has(text.slice(start, end))) {
    return false;
  }
  let previous = start;
  while (previous > 0 && /\s/.test(text[previous - 1])) {
    previous -= 1;
  }
  return previous === 0 || text.charCodeAt(previous - 1) !== 46;
}

/** What `aliasEdits` answers for code that has an `eval` of its own. */
const DECLARES_EVAL = "declares eval";

/**
 * The edits that make each use of the global `eval` as a value the loader's
 * indirect eval, `host.eval` (`const run = eval`, `eval.call(null, code)`,
 * `eval?.(code)`, `[eval][0](code)`, `(0, eval)(code)`, `{ eval }`), and the
 * same of a read of `eval` on the global object (`globalThis.eval`, and
 * `global`, `self` or `window` when the code has no binding of that name).
 * They are told from everything else by sucrase's parser: a plain call
 * `eval(…)` (also parenthesized, `(eval)(…)`) is a direct eval and is left
 * for `evalEdits`; a property, a key, a label, an assignment to `eval` or a
 * `delete` of it stays as written. `DECLARES_EVAL` when the code binds a name
 * `eval` of its own; null when the parser cannot read the code.
 */
function aliasEdits(text: string, host: () => string): Edit[] | typeof DECLARES_EVAL | null {
  let tokens: SucraseToken[];
  try {
    tokens = parseTokens(text, false, false, false).tokens;
  } catch {
    return null;
  }
  const nameOf = (token: SucraseToken | undefined): string | null =>
    token !== undefined && token.type === TokenType.name
      ? text.slice(token.start, token.end)
      : null;
  const isReference = (role: number | null): boolean =>
    role === IdentifierRole.Access ||
    role === IdentifierRole.ExportAccess ||
    role === IdentifierRole.ImportAccess;
  const bound = new Set<string>();
  for (const token of tokens) {
    const name = nameOf(token);
    if (
      name !== null &&
      token.identifierRole !== null &&
      !isReference(token.identifierRole) &&
      token.identifierRole !== IdentifierRole.ObjectShorthand &&
      token.identifierRole !== IdentifierRole.ObjectKey &&
      (name === "eval" || GLOBAL_OBJECTS.has(name))
    ) {
      if (name === "eval") {
        return DECLARES_EVAL;
      }
      bound.add(name);
    }
  }
  const typeAt = (index: number): number | undefined => tokens[index]?.type;
  const edits: Edit[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (nameOf(token) !== "eval") {
      continue;
    }
    // The expression that reads the global `eval`: the name, or `object.eval`.
    let first = index;
    if (typeAt(index - 1) === TokenType.dot) {
      const object = nameOf(tokens[index - 2]);
      if (
        object === null ||
        !GLOBAL_OBJECTS.has(object) ||
        bound.has(object) ||
        !isReference(tokens[index - 2].identifierRole) ||
        typeAt(index - 3) === TokenType.dot ||
        typeAt(index - 3) === TokenType.questionDot
      ) {
        continue;
      }
      first = index - 2;
    } else if (token.identifierRole === IdentifierRole.ObjectShorthand) {
      edits.push({ start: token.start, end: token.end, text: `eval: ${host()}.eval` });
      continue;
    } else if (!isReference(token.identifierRole)) {
      continue;
    }
    const next = typeAt(index + 1);
    const previous = typeAt(first - 1);
    if (
      next === TokenType.eq ||
      next === TokenType.assign ||
      next === TokenType.preIncDec ||
      next === TokenType.postIncDec ||
      next === TokenType._in ||
      previous === TokenType.preIncDec ||
      previous === TokenType.postIncDec ||
      previous === TokenType._delete ||
      // A label: `eval: for (;;)`.
      (next === TokenType.colon &&
        previous !== TokenType.question &&
        previous !== TokenType._case &&
        first === index)
    ) {
      continue;
    }
    if (first === index) {
      // `eval(…)` and `(eval)(…)` are direct evals.
      let before = index - 1;
      let after = index + 1;
      while (typeAt(before) === TokenType.parenL && typeAt(after) === TokenType.parenR) {
        before -= 1;
        after += 1;
      }
      if (typeAt(after) === TokenType.parenL) {
        continue;
      }
    }
    edits.push({ start: tokens[first].start, end: token.end, text: `${host()}.eval` });
  }
  return edits;
}

/**
 * Adds to `edits` the rewrites that send the code `text` evaluates with `eval`
 * through the loader (`host` is `evaluatedHost` of its file):
 *
 * - a direct `eval(code)` becomes `eval(host.source(code))`. It is still a
 *   direct eval, with the scope it is written in, of code that was rewritten
 *   first (`rewriteEvaluated`);
 * - each other use of the global `eval` as a value, `globalThis.eval` among
 *   them, becomes `host.eval`, the loader's indirect eval (`aliasEdits`), so
 *   `(0, eval)(code)` becomes `(0, host.eval)(code)`.
 *
 * The global `eval` itself stays the engine's: replacing it would make each
 * direct eval indirect. Nothing is rewritten in code that declares a name
 * `eval` of its own.
 *
 * Most files that say `eval` say it in a string or a comment, and the lexer
 * can tell: it reads a copy in which each `eval(` is spelled `import(` and
 * any other `eval` is spelled `import.meta`. It reports those only where
 * they are code, and for a call it reports where the call ends.
 */
function evalEdits(text: string, host: () => string, edits: Edit[]): void {
  // Each `eval` that is a word of its own and not a property (`a.eval`, `#eval`).
  const words: { at: number; called: boolean; probe: number }[] = [];
  // The probe's offset where each replacement ends, and how much longer the probe is by then.
  const ends: number[] = [];
  const growth: number[] = [];
  const parts: string[] = [];
  let from = 0;
  let grown = 0;
  // Whether the code may read `eval` on the global object (`globalThis.eval`).
  let globalProperty = false;
  // Looked for by its last three letters: the engine finds a word by its
  // first letter, and no letter is commoner in source than `e`.
  for (let val = text.indexOf("val"); val >= 0; val = text.indexOf("val", val + 3)) {
    const at = val - 1;
    if (at < 0 || text.charCodeAt(at) !== 101) {
      continue;
    }
    const before = at === 0 ? 0 : text.charCodeAt(at - 1);
    if (isNameCode(before) || before === 35 || isNameCode(text.charCodeAt(at + 4))) {
      continue;
    }
    if (before === 46) {
      globalProperty ||= followsGlobalObject(text, at - 1);
      continue;
    }
    const called = text[skipSpace(text, at + 4)] === "(";
    const spelled = called ? "import" : "import.meta";
    parts.push(text.slice(from, at), spelled);
    words.push({ at, called, probe: at + grown });
    grown += spelled.length - 4;
    ends.push(at + 4 + grown);
    growth.push(grown);
    from = at + 4;
  }
  if (words.length === 0) {
    if (globalProperty) {
      const aliases = aliasEdits(text, host);
      if (aliases !== DECLARES_EVAL && aliases !== null) {
        edits.push(...aliases);
      }
    }
    return;
  }
  parts.push(text.slice(from));

  const calls = new Map<number, { open: number; end: number }>();
  const inCode = new Set<number>();
  try {
    for (const entry of lex(parts.join(""))[0]) {
      if (entry.type === "dynamic") {
        calls.set(entry.importStart, { open: entry.dynamicStart, end: entry.importEnd });
      } else if (entry.type === "import-meta") {
        inCode.add(entry.start);
      }
    }
  } catch {
    // Not a spelling the lexer reads; the evals stay the engine's.
    return;
  }
  /** The offset in `text` of an offset in the probe that is not inside a replacement. */
  const original = (offset: number): number => {
    let low = 0;
    let high = ends.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (ends[middle] <= offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low === 0 ? offset : offset - growth[low - 1];
  };

  const found: Edit[] = [];
  // The indirect evals spelled `(…, eval)(`, for code the parser cannot read.
  const sequences: Edit[] = [];
  // Whether a use of `eval` needs the parser to be told apart (`aliasEdits`).
  let parse = globalProperty;
  for (const word of words) {
    if (word.called) {
      const call = calls.get(word.probe);
      if (!call) {
        // Not a call in code. `function eval(` gives the code an eval of its own.
        if (/\bfunction\s*\*?$/.test(textBefore(text, word.at))) {
          return;
        }
        continue;
      }
      const open = original(call.open);
      const close = original(call.end) - 1;
      if (text[open] !== "(" || text[close] !== ")") {
        continue;
      }
      found.push(
        { start: open + 1, end: open + 1, text: `${host()}.source(` },
        { start: close, end: close, text: ")" },
      );
    } else if (inCode.has(word.probe)) {
      const before = textBefore(text, word.at);
      if (/\b(?:var|let|const)$/.test(before)) {
        return;
      }
      // `(…, eval)(`: the value of a sequence, called at once.
      const after = skipSpace(text, word.at + 4);
      if (before.endsWith(",") && text[after] === ")" && text[skipSpace(text, after + 1)] === "(") {
        sequences.push({ start: word.at, end: word.at + 4, text: `${host()}.eval` });
      } else if (!(text[after] === ":" && (before.endsWith("{") || before.endsWith(",")))) {
        // Any other value but a key (`{ eval: … }`).
        parse = true;
      }
    }
  }
  const aliases = parse ? aliasEdits(text, host) : null;
  if (aliases === DECLARES_EVAL) {
    return;
  }
  edits.push(...found, ...(aliases ?? sequences));
}

/**
 * Code that a program evaluates itself (the body given to `new Function`, the
 * text given to `eval`), rewritten so that what it loads comes from the
 * loader: the engine's own `import()` knows no file of the program's and
 * fetches from the page's host instead. Its `import(` becomes a call of the
 * loader's import and its evals are rewritten in turn (`evalEdits`), all as
 * code of the file `parent()` names, which is asked only when something is
 * rewritten. With `importer`, its `import()` is the one defined under that
 * name instead of the loader's, and so is the `import()` of the code its own
 * evals run. Null when the code needs no rewriting, or does not lex: the
 * engine then reports it.
 */
export function rewriteEvaluated(
  code: string,
  parent: () => string,
  importer?: string,
): string | null {
  const imports = code.includes("import");
  if (!imports && !code.includes("eval")) {
    return null;
  }
  let named: string | null = null;
  const host = () => (named ??= evaluatedHost(parent(), importer));
  const edits: Edit[] = [];
  if (imports) {
    try {
      for (const entry of lex(code)[0]) {
        if (entry.type === "dynamic") {
          edits.push({
            start: entry.importStart,
            end: entry.dynamicStart,
            text: `${host()}.import`,
          });
        }
      }
    } catch {
      return null;
    }
  }
  evalEdits(code, host, edits);
  return edits.length === 0 ? null : applyEdits(code, edits);
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
    code = transform(withImportsFirst(source, filename), {
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
  const edits: Edit[] = [];
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
  evalEdits(code, () => evaluatedHost(filename), edits);
  return {
    format: "cjs",
    code: applyEdits(code, edits),
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
 *
 * `runsAsScript`, where the caller has one, compiles the code as the caller
 * will run it and answers whether it did. Most files that say `await` say it
 * inside a function and are scripts: asked first, the caller has then
 * compiled such a file once, for running, instead of once here and again to
 * run it.
 */
function needsTopLevelAwait(code: string, runsAsScript?: () => boolean): boolean {
  if (!/\bawait\b/.test(code)) {
    return false;
  }
  if (runsAsScript?.()) {
    return false;
  }
  try {
    // Only compiled, never called.
    new NativeFunction(code);
    return false;
  } catch {
    // Not a script; see whether it is one only because of `await`.
  }
  try {
    new NativeAsyncFunction(code);
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
 *
 * `rewriteImports` stands in for sucrase where an ES module's `import` and
 * `export` statements become calls on the loader's bindings: it is given the
 * module's text with everything else already rewritten, and answers the code.
 * What it throws ends the preparation (the worker that makes large modules'
 * entries passes one, loader/rewriter).
 *
 * `compilesAsScript` is for a caller that runs the code it gets: given the
 * CommonJS code of a file whose syntax has to decide (`needsTopLevelAwait`),
 * it compiles that code as it will run it, keeps what it compiled, and
 * answers whether it compiled.
 */
export function prepareSource(
  source: string,
  filename: string,
  format: "esm" | "cjs" | null,
  rewriteImports?: (text: string) => string,
  compilesAsScript?: (code: string) => boolean,
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

  // A file of no named format and without module syntax is a script, unless
  // it awaits at its top level: decided below, on the code it becomes. Such
  // a file has no `import` or `export` for the steps between to rewrite.
  const isModule = hasModuleSyntax || format === "esm";
  const asWritten = text;

  // Rewrites of `import(`, `import.meta` and string export names.
  const edits: Edit[] = [];
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

  evalEdits(text, () => evaluatedHost(filename), edits);
  const lifted = isModule ? liftImports(text, imports, edits) : "";
  text = lifted + applyEdits(text, edits);
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
    const code = text;
    if (
      format === null &&
      needsTopLevelAwait(asWritten, compilesAsScript && (() => compilesAsScript(code)))
    ) {
      return prepareSource(source, filename, "esm", rewriteImports);
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

  try {
    let code = rewriteImports
      ? rewriteImports(text)
      : transform(text, {
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
    new NativeFunction(`class __webnode_probe { static {\n${code}\n} }`);
    return false;
  } catch {
    return true;
  }
}
