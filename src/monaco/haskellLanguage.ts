import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";

/**
 * First-party Haskell language support for Monaco.
 *
 * Monaco ships basic-language grammars for Go, Kotlin, Rust and a few dozen
 * others, but there is no `haskell` directory under
 * `monaco-editor/esm/vs/basic-languages/` at all — so this file is the whole
 * of it: language id, bracket/comment configuration, and a Monarch tokenizer.
 *
 * Three of the rules below are the reason a borrowed grammar gets a Haskell
 * lesson visibly wrong, and each is easy to get wrong when writing a fresh
 * one:
 *
 *   - `--` opens a comment only when the dashes are not part of a longer
 *     operator. `-->`, `<-->` and `--|` are ordinary operators — Haskell lets
 *     you define your own — and greying out the rest of those lines would
 *     hide real code. A run of dashes with nothing symbolic after it *is* a
 *     comment, which is why `-------` still greys out.
 *   - `{- -}` block comments NEST. `{- outer {- inner -} still outer -}` is a
 *     single comment; a flat open/close pair ends at the first `-}` and then
 *     tokenizes the tail of a commented-out block as live code.
 *   - A trailing prime belongs to the name: `x'`, `go'`, `step''`. Matching
 *     identifiers before character literals is what stops `f x' = x'` from
 *     reading as a half-open `'...'` and swallowing the rest of the line.
 *
 * What this grammar deliberately does not attempt: telling a type variable
 * from an ordinary variable. Both are plain lowercase names — the `a` in
 * `map :: (a -> b) -> [a] -> [b]` is spelled exactly like the `a` in
 * `f a = a` — and only a parser that tracks layout knows which side of a
 * `::` it is on. They tokenize as identifiers, and the grammar spends its
 * precision on the constructors and type names instead, which are the words a
 * lesson actually points at.
 *
 * Registered from monaco/runtime.ts alongside the bundled grammars.
 */

export const HASKELL_LANGUAGE_ID = "haskell";

/**
 * The Haskell 2010 reserved words plus the three GHC adds that a lesson may
 * meet (`forall`, and `mdo`/`rec`/`proc` from the recursive-do and arrow
 * notations). `_` is here because the wildcard pattern is reserved on its own,
 * while `_total` is an ordinary name — a `cases` match tests the whole token,
 * so only the bare underscore is coloured.
 *
 * `qualified`, `as` and `hiding` are deliberately absent. They are special
 * only inside an `import` line and are perfectly good variable names
 * elsewhere: `as` is what everyone calls a list of `a`s, and colouring
 * `map f as` as syntax would be worse than leaving `import qualified` plain.
 */
const KEYWORDS = [
  "case",
  "class",
  "data",
  "default",
  "deriving",
  "do",
  "else",
  "foreign",
  "forall",
  "if",
  "import",
  "in",
  "infix",
  "infixl",
  "infixr",
  "instance",
  "let",
  "mdo",
  "module",
  "newtype",
  "of",
  "proc",
  "rec",
  "then",
  "type",
  "where",
  "_",
];

/**
 * Prelude types, coloured apart from the constructors a lesson defines itself
 * — the same split Zig's grammar makes between its primitives and user types.
 *
 * `True` and `False` are not in any list here on purpose: Haskell has no
 * boolean literal, they are ordinary constructors of `Bool`, and colouring
 * them as a third thing would teach a distinction the language does not make.
 */
const TYPES = [
  "Bool",
  "Char",
  "Double",
  "Either",
  "FilePath",
  "Float",
  "IO",
  "Int",
  "Integer",
  "Maybe",
  "Ordering",
  "Rational",
  "String",
  "Word",
];

/**
 * The reserved operators. Everything else built from symbol characters is a
 * user-definable operator — `<$>`, `>=>`, or one this lesson writes itself —
 * so the list is exactly the syntax, not a sample of the standard library.
 */
const RESERVED_OPERATORS = ["..", ":", "::", "=", "\\", "|", "<-", "->", "@", "~", "=>"];

export const haskellLanguageConfiguration: monaco.languages.LanguageConfiguration = {
  // Haskell has both forms, unlike Zig: `--` to end of line, and the nesting
  // `{- -}`. Declaring both lets Monaco's comment commands produce either.
  comments: { lineComment: "--", blockComment: ["{-", "-}"] },
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
    // No `'` pair: a prime is how Haskell names the next version of a value
    // (`go'`, `acc'`), so auto-closing the quote would fight the user on every
    // recursive helper they write. It stays in surroundingPairs, where it only
    // acts on a selection.
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  // Layout is not expressible as a regex pair, so this covers only the case
  // that is unambiguous: a line ending in a block opener owes the next line an
  // indent. Everything else keeps the previous line's indentation, which is
  // what the next statement of a `do` block or the next guard wants anyway.
  indentationRules: {
    increaseIndentPattern: /(?:\b(?:do|where|of|then|else|let)|=|->|[([{])\s*$/,
    decreaseIndentPattern: /^\s*[)\]}]/,
  },
};

export const haskellMonarchLanguage: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".hs",

  keywords: KEYWORDS,
  typeKeywords: TYPES,
  reservedOperators: RESERVED_OPERATORS,

  // The symbol characters an operator may be built from, per the Haskell
  // report's `symbol` production.
  symbols: /[!#$%&*+./<=>?@\\^|~:-]+/,

  // Every escape the report allows: the single-character ones, `\&` (the empty
  // escape, used to break `\1234` apart), the ASCII control names, `\^X`
  // control codes, and the decimal/hex/octal numeric forms. Longer names come
  // first in the alternation so `\SOH` never matches as `\SO` + `H`.
  escapes:
    /\\(?:[abfnrtv\\"'&]|NUL|SOH|STX|ETX|EOT|ENQ|ACK|BEL|BS|HT|LF|VT|FF|CR|SO|SI|DLE|DC1|DC2|DC3|DC4|NAK|SYN|ETB|CAN|SUB|ESC|EM|FS|GS|RS|US|SP|DEL|\^[@-Z[\]\\^_]|x[0-9A-Fa-f]+|o[0-7]+|[0-9]+)/,

  tokenizer: {
    root: [
      // Comments first: `--` and `{-` both start with characters the operator
      // and bracket rules would otherwise claim.
      { include: "@whitespace" },

      // A qualified name — `Data.Map.insert`, `T.pack`. The module prefix and
      // the name are one token so the dots are not read as the composition
      // operator, which is the same character.
      [/[A-Z][\w']*(?:\.[A-Z][\w']*)*\.[a-z_][\w']*/, "identifier"],

      // Constructors, type names and module names all start with a capital;
      // nothing else in Haskell does, which is why this single rule covers all
      // three. A qualified constructor (`Map.Map`) is matched whole.
      [
        /[A-Z][\w']*(?:\.[A-Z][\w']*)*/,
        {
          cases: {
            "@typeKeywords": "keyword.type",
            "@default": "type.identifier",
          },
        },
      ],

      // Variables and keywords. `[\w']*` keeps the primes on `go'`, and doing
      // this before the character-literal rule is what makes that safe.
      [
        /[a-z_][\w']*/,
        {
          cases: {
            "@keywords": "keyword",
            "@default": "identifier",
          },
        },
      ],

      // `x `div` y` — any function can be used infix inside backticks.
      [/`[A-Za-z_][\w'.]*`/, "operator"],

      [/[{}()[\]]/, "@brackets"],

      [
        /@symbols/,
        {
          cases: {
            "@reservedOperators": "keyword",
            "@default": "operator",
          },
        },
      ],

      // Numeric literals, with the underscore separators GHC accepts. The
      // fractional form requires digits on both sides of the dot, so the `1`
      // and the `5` in `[1..5]` stay numbers and `..` stays an operator.
      [/0[xX][0-9a-fA-F_]+/, "number.hex"],
      [/0[oO][0-7_]+/, "number.octal"],
      [/0[bB][01_]+/, "number.binary"],
      [/[0-9][0-9_]*\.[0-9][0-9_]*(?:[eE][+-]?[0-9_]+)?/, "number.float"],
      [/[0-9][0-9_]*[eE][+-]?[0-9_]+/, "number.float"],
      [/[0-9][0-9_]*/, "number"],

      [/[;,]/, "delimiter"],

      [/"/, { token: "string.quote", bracket: "@open", next: "@string" }],
      [/'[^\\']'/, "string"],
      [/(')(@escapes)(')/, ["string", "string.escape", "string"]],
    ],

    whitespace: [
      [/[ \t\r\n]+/, ""],

      // `{-# LANGUAGE … #-}` is a compiler pragma, not prose: it changes what
      // compiles, so it is not greyed out like an ordinary comment.
      [/\{-#/, { token: "comment.doc", next: "@pragma" }],
      [/\{-/, { token: "comment", next: "@blockComment" }],

      // Haddock attaches documentation to the declaration after `-- |` or
      // before it with `-- ^`. The space is required: `--|` has a symbol
      // straight after the dashes, so it is an operator, not a comment.
      [/--+[ \t]+[|^].*$/, "comment.doc"],

      // Two or more dashes that end the symbol run they are part of. The `-`
      // inside the lookahead is what makes it the WHOLE run: without it the
      // match happily backtracks to the first two dashes of `--->`, finds a
      // third dash rather than a symbol, and greys out an operator's line.
      //
      // The other side needs no lookbehind. Rules are matched anchored at the
      // cursor, so on `x <-- y` the tokenizer is sitting on the `<` when it
      // tries this rule; it fails there, and the operator rule then takes
      // `<--` whole — the same maximal-run reading Haskell's own lexer has.
      [/--+(?![-!#$%&*+./<=>?@\\^|~:]).*$/, "comment"],
    ],

    // Nested: `@push` re-enters this same state for an inner `{-`, so the
    // matching `-}` closes only the innermost comment.
    blockComment: [
      [/[^{-]+/, "comment"],
      [/\{-/, { token: "comment", next: "@push" }],
      [/-\}/, { token: "comment", next: "@pop" }],
      [/[{-]/, "comment"],
    ],

    // A pragma ends at `#-}`; the `#` falls into the first rule, and popping
    // on the bare `-}` also copes with the `{-# … -}` spelling.
    pragma: [
      [/[^-]+/, "comment.doc"],
      [/-\}/, { token: "comment.doc", next: "@pop" }],
      [/-/, "comment.doc"],
    ],

    string: [
      [/[^\\"]+/, "string"],
      [/@escapes/, "string.escape"],
      // A string gap: a backslash at the end of a line, whitespace, then a
      // backslash on the next, splices one literal across lines. Both halves
      // need a rule — without the second, the backslash that resumes the
      // literal is read as a bad escape and the next character is coloured
      // as invalid.
      [/\\[ \t]*$/, "string.escape"],
      [/^[ \t]*\\/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
    ],
  },
};

let registered = false;

/** Idempotent: the Monaco runtime module may be imported from several entries. */
export function registerHaskellLanguage(): void {
  if (
    registered ||
    monaco.languages.getLanguages().some((lang) => lang.id === HASKELL_LANGUAGE_ID)
  ) {
    registered = true;
    return;
  }
  registered = true;

  monaco.languages.register({
    id: HASKELL_LANGUAGE_ID,
    // `.hs` only. `.lhs` is literate Haskell, where the code is the lines
    // starting with `>` and everything else is prose — a different lexical
    // format, and one the playground does not compile.
    extensions: [".hs"],
    aliases: ["Haskell", "haskell"],
  });
  monaco.languages.setLanguageConfiguration(HASKELL_LANGUAGE_ID, haskellLanguageConfiguration);
  monaco.languages.setMonarchTokensProvider(HASKELL_LANGUAGE_ID, haskellMonarchLanguage);
}
