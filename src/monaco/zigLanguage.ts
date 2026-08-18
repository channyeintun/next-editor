import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";

/**
 * First-party Zig language support for Monaco.
 *
 * Unlike Go, Kotlin, and Rust, Monaco ships no Zig grammar, so this file is
 * the whole of it: language id, bracket/comment configuration, and a Monarch
 * tokenizer. Borrowing the Rust grammar — the shortcut `.kite` files took
 * before monaco/kiteLanguage.ts existed — highlights Zig visibly wrong,
 * because the words that carry the most meaning
 * in Zig are exactly the ones Rust does not have: `var`, `defer`, `errdefer`,
 * `comptime`, `orelse`, `catch`, `switch`, `test`, `unreachable`, and every
 * `@builtin`. A lesson that teaches `comptime` should not render it as a plain
 * identifier.
 *
 * Registered from monaco/runtime.ts alongside the bundled grammars.
 */

export const ZIG_LANGUAGE_ID = "zig";

const KEYWORDS = [
  "addrspace",
  "align",
  "allowzero",
  "and",
  "anyframe",
  "anytype",
  "asm",
  "async",
  "await",
  "break",
  "callconv",
  "catch",
  "comptime",
  "const",
  "continue",
  "defer",
  "else",
  "enum",
  "errdefer",
  "error",
  "export",
  "extern",
  "fn",
  "for",
  "if",
  "inline",
  "linksection",
  "noalias",
  "noinline",
  "nosuspend",
  "opaque",
  "or",
  "orelse",
  "packed",
  "pub",
  "resume",
  "return",
  "struct",
  "suspend",
  "switch",
  "test",
  "threadlocal",
  "try",
  "union",
  "unreachable",
  "usingnamespace",
  "var",
  "volatile",
  "while",
];

const CONSTANTS = ["true", "false", "null", "undefined"];

const TYPES = [
  "anyerror",
  "anyopaque",
  "bool",
  "c_char",
  "c_int",
  "c_long",
  "c_longdouble",
  "c_longlong",
  "c_short",
  "c_uint",
  "c_ulong",
  "c_ulonglong",
  "c_ushort",
  "comptime_float",
  "comptime_int",
  "f16",
  "f32",
  "f64",
  "f80",
  "f128",
  "isize",
  "noreturn",
  "type",
  "usize",
  "void",
];

export const zigLanguageConfiguration: monaco.languages.LanguageConfiguration = {
  // Zig has no block comments at all — `//` is the only form, with `///` for
  // doc comments and `//!` for module-level docs.
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
    { open: "'", close: "'", notIn: ["string"] },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  indentationRules: {
    increaseIndentPattern: /^.*\{[^}"']*$/,
    decreaseIndentPattern: /^\s*\}/,
  },
};

export const zigMonarchLanguage: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".zig",

  keywords: KEYWORDS,
  constants: CONSTANTS,
  typeKeywords: TYPES,

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
    "+%",
    "-%",
    "*%",
    "+|",
    "-|",
    "*|",
    "&",
    "|",
    "^",
    "~",
    "<<",
    ">>",
    "<<|",
    "and",
    "or",
    "!",
    "?",
    ".?",
    ".*",
    "..",
    "...",
    "->",
    "=>",
    "++",
    "**",
  ],

  symbols: /[=><!~?:&|+\-*/^%.]+/,
  escapes: /\\(?:[nrt'"\\]|x[0-9A-Fa-f]{2}|u\{[0-9A-Fa-f]+\})/,

  tokenizer: {
    root: [
      // Sized integer types are a family, not a list: i0..i65535, u0..u65535.
      [/\b[iu][0-9]+\b/, "keyword.type"],

      // Builtin functions are always @-prefixed (@import, @sizeOf, @TypeOf).
      [/@[a-zA-Z_]\w*/, "keyword.builtin"],

      // An identifier may be quoted to escape keywords: @"my var".
      [/@"/, { token: "identifier", next: "@quotedIdentifier" }],

      // A capitalized identifier before a call is conventionally a type in
      // Zig, since generic types are functions returning `type`.
      [
        /[a-zA-Z_]\w*/,
        {
          cases: {
            "@keywords": "keyword",
            "@constants": "constant.language",
            "@typeKeywords": "keyword.type",
            "@default": "identifier",
          },
        },
      ],

      { include: "@whitespace" },

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

      // Numbers, with underscore separators and the non-decimal bases.
      [/0[xX][0-9a-fA-F_]*(?:\.[0-9a-fA-F_]*)?(?:[pP][+-]?[0-9_]+)?/, "number.hex"],
      [/0[oO][0-7_]+/, "number.octal"],
      [/0[bB][01_]+/, "number.binary"],
      [/[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?/, "number"],

      [/[;,]/, "delimiter"],

      [/"/, { token: "string.quote", bracket: "@open", next: "@string" }],
      [/'(?:[^'\\]|\\.)'/, "string"],
    ],

    // Zig multiline strings are line-oriented: every line starts with `\\`
    // and runs to its end, with no escape processing and no terminator.
    whitespace: [
      [/[ \t\r\n]+/, ""],
      [/\\\\.*$/, "string"],
      [/\/\/[/!].*$/, "comment.doc"],
      [/\/\/.*$/, "comment"],
    ],

    string: [
      [/[^\\"]+/, "string"],
      [/@escapes/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
    ],

    quotedIdentifier: [
      [/[^\\"]+/, "identifier"],
      [/"/, { token: "identifier", next: "@pop" }],
    ],
  },
};

let registered = false;

/** Idempotent: the Monaco runtime module may be imported from several entries. */
export function registerZigLanguage(): void {
  if (registered || monaco.languages.getLanguages().some((lang) => lang.id === ZIG_LANGUAGE_ID)) {
    registered = true;
    return;
  }
  registered = true;

  monaco.languages.register({
    id: ZIG_LANGUAGE_ID,
    extensions: [".zig", ".zon"],
    aliases: ["Zig", "zig"],
  });
  monaco.languages.setLanguageConfiguration(ZIG_LANGUAGE_ID, zigLanguageConfiguration);
  monaco.languages.setMonarchTokensProvider(ZIG_LANGUAGE_ID, zigMonarchLanguage);
}
