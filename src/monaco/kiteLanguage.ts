import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";

/**
 * First-party Kite language support for Monaco.
 *
 * Kite files were coloured with Monaco's Rust grammar because the two share a
 * lot of surface — `fn`, `let`, `pub`, `impl`, `trait`, `struct`, `enum`,
 * `match`, `return` — and that was the right call while no Kite grammar
 * existed. It is wrong in the places a Kite lesson spends its time:
 *
 *   - `var`, `check`, `defer`, `nil` and `use` carry meaning here and are not
 *     Rust keywords, so they rendered as plain identifiers.
 *   - Rust's grammar colours `'a'` as a character literal. Kite has no `char`
 *     type at all; `'a'` lexes and then fails to type. Highlighting it as a
 *     value teaches the wrong thing.
 *   - String interpolation is `"\(expr)"`. Under the Rust grammar the hole is
 *     just more string, so the expression inside it disappears into the
 *     literal — and interpolation is how Kite prints almost everything.
 *   - Rust's grammar accepts C-style block comments. Kite has none, and
 *     writing one is `E0005`.
 *
 * Every rule below follows the language's lexical specification (checked
 * against `kitec`): 27 reserved keywords, three line-comment forms and no
 * block comment, no literal suffixes, and no semicolon — `;` is not a token.
 *
 * Registered from monaco/runtime.ts alongside the bundled grammars.
 */

export const KITE_LANGUAGE_ID = "kite";

/**
 * The complete reserved set. The count is fixed at 27 by a test in the
 * compiler's own lexer crate, so this list is exhaustive rather than a
 * best-effort sample — `dyn`, `error` and `extern` are deliberately absent
 * because they are contextual and may be used as ordinary identifiers.
 */
export const KITE_KEYWORDS = [
  "as",
  "async",
  "await",
  "break",
  "check",
  "continue",
  "defer",
  "else",
  "enum",
  "false",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "match",
  "nil",
  "pub",
  "return",
  "self",
  "struct",
  "trait",
  "true",
  "type",
  "use",
  "var",
];

/** Reserved words that are values, coloured as constants rather than syntax. */
const CONSTANTS = ["true", "false", "nil"];

/**
 * Built-in type names plus the two contextual words that only mean anything in
 * type position. A binding may shadow `error` or `dyn`; colouring them as
 * types is the reading that is right almost every time.
 */
const TYPE_KEYWORDS = ["bool", "int", "float", "str", "error", "JsValue", "Option", "Task", "dyn"];

/** Genuine builtins rather than values — they cannot be passed around. */
const BUILTINS = ["assert", "require", "extern"];

/**
 * Heads that resolve to compiler builtins before any module lookup, so
 * `io.print` needs no import. A local binding of the same name shadows them,
 * which no Monarch grammar can see; the reading is right in ordinary code.
 */
const BUILTIN_PATHS = ["io", "errors", "time", "text", "js", "math", "task", "draw", "ptr"];

export const kiteLanguageConfiguration: monaco.languages.LanguageConfiguration = {
  // Three line forms — `//`, `///`, `//!` — and no block comment at all;
  // writing one is E0005. Declaring a blockComment here would make Monaco's
  // comment command emit a form the compiler rejects.
  comments: { lineComment: "//" },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string"] },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
  ],
  indentationRules: {
    increaseIndentPattern: /^.*\{[^}"']*$/,
    decreaseIndentPattern: /^\s*\}/,
  },
};

export const kiteMonarchLanguage: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".kite",

  keywords: KITE_KEYWORDS,
  constants: CONSTANTS,
  typeKeywords: TYPE_KEYWORDS,
  builtins: BUILTINS,
  builtinPaths: BUILTIN_PATHS,

  operators: [
    "=",
    "==",
    "!=",
    ">",
    "<",
    ">=",
    "<=",
    "+",
    "-",
    "*",
    "/",
    "%",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "&",
    "|",
    "^",
    "<<",
    ">>",
    "&&",
    "||",
    "!",
    "->",
    "=>",
    "..",
    "..=",
  ],

  symbols: /[=><!~?:&|+\-*/^%.]+/,
  // Exactly the escapes the lexer accepts; anything else is E0003.
  escapes: /\\(?:[nrt0"'\\]|u\{[0-9A-Fa-f]+\})/,
  // Identifiers are UAX #31, so non-Latin names are ordinary.
  identifier: /[A-Za-z_\u00A0-\uFFFF][\w\u00A0-\uFFFF]*/,

  tokenizer: {
    root: [
      { include: "@whitespace" },

      // Attributes: @derive(Debug), @host("js").
      [/@[A-Za-z_]\w*/, "annotation"],

      // A builtin head is only a builtin when a dot follows it.
      [
        /@identifier(?=\s*\.)/,
        {
          cases: {
            "@builtinPaths": "variable.predefined",
            "@keywords": "keyword",
            "@default": "identifier",
          },
        },
      ],

      [
        /@identifier/,
        {
          cases: {
            "@constants": "constant.language",
            "@keywords": "keyword",
            "@typeKeywords": "keyword.type",
            "@builtins": "keyword.builtin",
            "@default": "identifier",
          },
        },
      ],

      [/[{}()[\]]/, "@brackets"],
      [
        /@symbols/,
        {
          cases: {
            "@operators": "operator",
            "@default": "",
          },
        },
      ],

      // No literal suffixes, and `_` may separate digits.
      [/0[xX][0-9a-fA-F_]+/, "number.hex"],
      [/0[oO][0-7_]+/, "number.octal"],
      [/0[bB][01_]+/, "number.binary"],
      [/[0-9][0-9_]*\.[0-9][0-9_]*(?:[eE][+-]?[0-9_]+)?/, "number.float"],
      [/[0-9][0-9_]*[eE][+-]?[0-9_]+/, "number.float"],
      [/[0-9][0-9_]*/, "number"],

      [/,/, "delimiter"],

      // Block strings first: `"""` would otherwise read as an empty string.
      [/"""/, { token: "string.quote", bracket: "@open", next: "@blockString" }],
      // A `"` with no partner before the end of the line. A `"` string may not
      // span lines — that is E0001, and `"""` is the form that may — so without
      // this the string state carries onward and the rest of the file loses its
      // colouring, inverting again at every later quote.
      [/"(?:[^"\\]|\\.)*$/, "string.invalid"],
      [/"/, { token: "string.quote", bracket: "@open", next: "@string" }],
    ],

    whitespace: [
      [/[ \t\r\n]+/, ""],
      // `//!` module docs and `///` declaration docs, whose ```kite fences are
      // compiled and run — worth showing as documentation, not as a comment.
      [/\/\/[/!].*$/, "comment.doc"],
      [/\/\/.*$/, "comment"],
    ],

    string: [
      [/\\\(/, { token: "delimiter.bracket", next: "@interpolation" }],
      [/[^\\"]+/, "string"],
      [/@escapes/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
    ],

    blockString: [
      [/\\\(/, { token: "delimiter.bracket", next: "@interpolation" }],
      [/"""/, { token: "string.quote", bracket: "@close", next: "@pop" }],
      [/[^\\"]+/, "string"],
      [/@escapes/, "string.escape"],
      [/"/, "string"],
    ],

    // A hole holds an ordinary expression — including another string — so the
    // code inside it is tokenized as code, and the closing paren returns to
    // whichever string opened it.
    interpolation: [
      [/\)/, { token: "delimiter.bracket", next: "@pop" }],
      [/\(/, { token: "@brackets", next: "@interpolationParen" }],
      { include: "@interpolationBody" },
    ],

    interpolationParen: [
      [/\)/, { token: "@brackets", next: "@pop" }],
      [/\(/, { token: "@brackets", next: "@interpolationParen" }],
      { include: "@interpolationBody" },
    ],

    interpolationBody: [
      [/[ \t]+/, ""],
      [/"""/, { token: "string.quote", bracket: "@open", next: "@blockString" }],
      [/"/, { token: "string.quote", bracket: "@open", next: "@string" }],
      [
        /@identifier(?=\s*\.)/,
        {
          cases: {
            "@builtinPaths": "variable.predefined",
            "@keywords": "keyword",
            "@default": "identifier",
          },
        },
      ],
      [
        /@identifier/,
        {
          cases: {
            "@constants": "constant.language",
            "@keywords": "keyword",
            "@typeKeywords": "keyword.type",
            "@builtins": "keyword.builtin",
            "@default": "identifier",
          },
        },
      ],
      // The same six forms `root` has. A hole holds an ordinary expression, so
      // `"\(0xFF)"` has to read as one hex literal rather than `0` followed by
      // an identifier named `xFF`.
      [/0[xX][0-9a-fA-F_]+/, "number.hex"],
      [/0[oO][0-7_]+/, "number.octal"],
      [/0[bB][01_]+/, "number.binary"],
      [/[0-9][0-9_]*\.[0-9][0-9_]*(?:[eE][+-]?[0-9_]+)?/, "number.float"],
      [/[0-9][0-9_]*[eE][+-]?[0-9_]+/, "number.float"],
      [/[0-9][0-9_]*/, "number"],
      [/[[\]{}]/, "@brackets"],
      [
        /@symbols/,
        {
          cases: {
            "@operators": "operator",
            "@default": "",
          },
        },
      ],
      [/,/, "delimiter"],
    ],
  },
};

let registered = false;

/** Idempotent: the Monaco runtime module may be imported from several entries. */
export function registerKiteLanguage(): void {
  if (registered || monaco.languages.getLanguages().some((lang) => lang.id === KITE_LANGUAGE_ID)) {
    registered = true;
    return;
  }
  registered = true;

  monaco.languages.register({
    id: KITE_LANGUAGE_ID,
    extensions: [".kite"],
    aliases: ["Kite", "kite"],
  });
  monaco.languages.setLanguageConfiguration(KITE_LANGUAGE_ID, kiteLanguageConfiguration);
  monaco.languages.setMonarchTokensProvider(KITE_LANGUAGE_ID, kiteMonarchLanguage);
}
