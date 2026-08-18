import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";

/**
 * First-party NASM-syntax x86-64 support for Monaco.
 *
 * Monaco does ship a grammar called `asm`, and it is not usable here: it is a
 * generic assembly mode that knows neither NASM's directives nor the register
 * names, so `section .data`, `resb` and `rdi` all render as plain identifiers.
 * In a lesson those are exactly the words the eye needs to find — the register
 * being written, the directive that reserves the buffer — so the grammar is
 * first-party, like Zig's and Kite's.
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

/** The instruction names the runner's assembler accepts, plus their aliases. */
const INSTRUCTIONS = [
  "adc",
  "add",
  "and",
  "call",
  "cbw",
  "cdq",
  "cdqe",
  "cmp",
  "cqo",
  "cwd",
  "cwde",
  "dec",
  "div",
  "hlt",
  "idiv",
  "imul",
  "inc",
  "int3",
  "lea",
  "leave",
  "loop",
  "loope",
  "loopne",
  "loopnz",
  "loopz",
  "mov",
  "movsx",
  "movsxd",
  "movzx",
  "mul",
  "neg",
  "nop",
  "not",
  "or",
  "pop",
  "push",
  "ret",
  "rol",
  "ror",
  "sal",
  "sar",
  "sbb",
  "shl",
  "shr",
  "sub",
  "syscall",
  "test",
  "xchg",
  "xor",
];

const CONDITIONS = [
  "a",
  "ae",
  "b",
  "be",
  "c",
  "e",
  "g",
  "ge",
  "l",
  "le",
  "na",
  "nae",
  "nb",
  "nbe",
  "nc",
  "ne",
  "ng",
  "nge",
  "nl",
  "nle",
  "no",
  "np",
  "ns",
  "nz",
  "o",
  "p",
  "pe",
  "po",
  "s",
  "z",
];

/** `je`, `setg`, `cmovae`, … — generated rather than typed out three times. */
const CONDITIONAL_INSTRUCTIONS = CONDITIONS.flatMap((condition) => [
  `j${condition}`,
  `set${condition}`,
  `cmov${condition}`,
]);

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
  "times",
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

  instructions: [...INSTRUCTIONS, ...CONDITIONAL_INSTRUCTIONS, "jmp"],
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

      [/0[xX][0-9a-fA-F_]+/, "number.hex"],
      [/0[bB][01_]+/, "number.binary"],
      [/[0-9][0-9a-fA-F_]*[hH]\b/, "number.hex"],
      [/\d[\d_]*/, "number"],

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
  if (registered) {
    return;
  }
  registered = true;

  // Unlike Zig and Kite, this id may already exist: some Monaco builds bundle a
  // generic `asm` grammar. Registering over it is deliberate — the point of
  // this file is that the generic one highlights neither NASM's directives nor
  // the registers — so the configuration and tokenizer are set either way.
  if (!monaco.languages.getLanguages().some((language) => language.id === ASM_LANGUAGE_ID)) {
    monaco.languages.register({
      id: ASM_LANGUAGE_ID,
      extensions: [".asm", ".s", ".nasm"],
      aliases: ["Assembly", "x86-64 Assembly", "nasm"],
    });
  }
  monaco.languages.setLanguageConfiguration(ASM_LANGUAGE_ID, asmLanguageConfiguration);
  monaco.languages.setMonarchTokensProvider(ASM_LANGUAGE_ID, asmMonarchLanguage);
}
