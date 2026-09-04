import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import { KNOWN_MNEMONICS } from "../core/x86/isa";

/**
 * First-party NASM-syntax x86-64 support for Monaco.
 *
 * Monaco ships no x86 or NASM grammar at all — `mips` is the only assembly
 * mode under `basic-languages/`, and it claims `.s` but knows neither NASM's
 * directives nor the x86 register names, so `section .data`, `resb` and `rdi`
 * would all render as plain identifiers. In a lesson those are exactly the
 * words the eye needs to find — the register being written, the directive that
 * reserves the buffer — so the grammar is first-party, like Zig's and Kite's.
 *
 * Three choices in the tokenizer are worth naming, because they are what make
 * assembly read correctly rather than merely colour:
 *
 *   * **Registers are their own token class.** Half of what a line says is
 *     which register it touches, and a highlighter that treats `rax` as an
 *     identifier hides that half.
 *   * **Labels are matched at the start of a line**, so `_start:` and `.loop:`
 *     stand out as the structure they are. A jump target is the closest thing
 *     assembly has to a function name.
 *   * **`;` starts a comment, and `#` does not.** NASM's comment character is
 *     the semicolon; treating `#` as one too — which several editors do — makes
 *     a stray `#` disappear instead of erroring.
 *
 * Registered from monaco/runtime.ts alongside the bundled grammars.
 */

export const ASM_LANGUAGE_ID = "asm";

/**
 * Only the directives and operand keywords the runner's parser actually
 * accepts. NASM's `times` is deliberately absent: this assembler has no repeat
 * count, so colouring it like `db` would promise a directive that then fails
 * with an error pointing at its operand.
 */
const DIRECTIVES = [
  "section",
  "segment",
  "global",
  "globl",
  "extern",
  "default",
  "align",
  "equ",
  "db",
  "dw",
  "dd",
  "dq",
  "resb",
  "resw",
  "resd",
  "resq",
  "byte",
  "word",
  "dword",
  "qword",
  "rel",
  "abs",
];

const REGISTERS = [
  "rax",
  "rbx",
  "rcx",
  "rdx",
  "rsi",
  "rdi",
  "rbp",
  "rsp",
  "r8",
  "r9",
  "r10",
  "r11",
  "r12",
  "r13",
  "r14",
  "r15",
  "eax",
  "ebx",
  "ecx",
  "edx",
  "esi",
  "edi",
  "ebp",
  "esp",
  "r8d",
  "r9d",
  "r10d",
  "r11d",
  "r12d",
  "r13d",
  "r14d",
  "r15d",
  "ax",
  "bx",
  "cx",
  "dx",
  "si",
  "di",
  "bp",
  "sp",
  "r8w",
  "r9w",
  "r10w",
  "r11w",
  "r12w",
  "r13w",
  "r14w",
  "r15w",
  "al",
  "bl",
  "cl",
  "dl",
  "ah",
  "bh",
  "ch",
  "dh",
  "sil",
  "dil",
  "bpl",
  "spl",
  "r8b",
  "r9b",
  "r10b",
  "r11b",
  "r12b",
  "r13b",
  "r14b",
  "r15b",
  // `rip` is a real register the CPU steps, but not one an operand may name
  // here — rip-relative addressing is written `[rel msg]`. It stays in the
  // list because reading `rip` as anything but a register would be a lie
  // about x86-64, and the assembler's own error says the rest.
  "rip",
];

export const asmLanguageConfiguration: monaco.languages.LanguageConfiguration = {
  // NASM has no block comment. Offering one would let Toggle Comment write
  // something the assembler rejects.
  comments: { lineComment: ";" },
  brackets: [
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string", "comment"] },
    { open: "'", close: "'", notIn: ["string", "comment"] },
  ],
  surroundingPairs: [
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};

export const asmMonarchLanguage: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  ignoreCase: true,
  tokenPostfix: ".asm",

  // Read straight off the assembler's own table — including every `jcc`,
  // `setcc` and `cmovcc` spelling and the aliases — so a mnemonic added to
  // the ISA is highlighted the day it starts assembling, with no second list
  // to remember. The runner already pulls this module into the same bundle.
  instructions: KNOWN_MNEMONICS,
  directives: DIRECTIVES,
  registers: REGISTERS,

  tokenizer: {
    root: [
      [/;.*$/, "comment"],

      // A label at the start of a line: `_start:` and `.loop:` with their
      // colon, and a bare `.loop` for the local-label form that omits it. A
      // data label like `msg db "x"` also omits the colon, but matching a bare
      // word at the start of a line would swallow every instruction too, so it
      // is left as an identifier rather than guessed at.
      [/^\s*[.\w$?@]+:/, "type.identifier"],
      [/^\s*\.[\w$?@]+/, "type.identifier"],

      // Before the identifier rule, not after: `$` is a valid character *inside*
      // an identifier, so the identifier rule would otherwise consume the `$`
      // in `equ $ - msg` and colour the current-address token as a name.
      [/\$\$?/, "keyword.control"],

      [
        /[a-zA-Z_.?@][\w$?@.]*/,
        {
          cases: {
            "@registers": "variable.predefined",
            "@instructions": "keyword",
            "@directives": "keyword.control",
            "@default": "identifier",
          },
        },
      ],

      // Every spelling parseIntegerLiteral accepts, prefix and suffix forms
      // alike. The suffix rules have to precede the plain-decimal one, which
      // would otherwise take the digits and leave `b`/`q` to the identifier
      // rule — so `1010b` would read as a number next to a variable name.
      [/0[xX][0-9a-fA-F_]+/, "number.hex"],
      [/0[bB][01_]+/, "number.binary"],
      [/0[oO][0-7_]+/, "number.octal"],
      [/[01][01_]*[bB]\b/, "number.binary"],
      [/[0-7][0-7_]*[qQ]\b/, "number.octal"],
      [/[0-9][0-9a-fA-F_]*[hH]\b/, "number.hex"],
      [/\d[\d_]*/, "number"],

      // A quote with no partner before the end of the line. Without these the
      // string state carries onto the next line and colours the rest of the
      // file as a literal while the missing quote is being typed.
      [/"(?:[^"\\]|\\.)*$/, "string.invalid"],
      [/'[^']*$/, "string.invalid"],

      [/"/, { token: "string.quote", bracket: "@open", next: "@stringDouble" }],
      [/'/, { token: "string.quote", bracket: "@open", next: "@stringSingle" }],

      [/[[\]()]/, "@brackets"],
      [/[+\-*/,:]/, "operator"],
      [/\s+/, ""],
    ],

    stringDouble: [
      [/[^\\"]+/, "string"],
      [/\\./, "string.escape"],
      [/"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
    ],

    // Single-quoted strings are literal in NASM — no escapes at all — so a
    // backslash inside one is an ordinary byte, not the start of a sequence.
    stringSingle: [
      [/[^']+/, "string"],
      [/'/, { token: "string.quote", bracket: "@close", next: "@pop" }],
    ],
  },
};

let registered = false;

/** Idempotent: the Monaco runtime module may be imported from several entries. */
export function registerAsmLanguage(): void {
  if (registered || monaco.languages.getLanguages().some((lang) => lang.id === ASM_LANGUAGE_ID)) {
    registered = true;
    return;
  }
  registered = true;

  monaco.languages.register({
    id: ASM_LANGUAGE_ID,
    extensions: [".asm", ".s", ".nasm"],
    aliases: ["Assembly", "x86-64 Assembly", "nasm"],
  });
  monaco.languages.setLanguageConfiguration(ASM_LANGUAGE_ID, asmLanguageConfiguration);
  monaco.languages.setMonarchTokensProvider(ASM_LANGUAGE_ID, asmMonarchLanguage);
}
