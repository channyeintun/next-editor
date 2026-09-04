/**
 * The instruction table, written once and read from both directions.
 *
 * An assembler turns a mnemonic and operands into bytes; a decoder turns bytes
 * back into a mnemonic and operands. Those are the same knowledge stated twice,
 * and keeping it in two hand-written tables is how an emulator ends up
 * disagreeing with the assembler that fed it. So there is one table: every
 * entry says which opcode bytes an instruction uses, which slot each operand
 * lives in, and how wide it is. `encoder.ts` reads it forwards and
 * `decoder.ts` reads it backwards, and a round-trip test asserts they meet in
 * the middle.
 *
 * The families that repeat — the eight ALU operations, the sixteen condition
 * codes on `jcc`/`setcc`/`cmovcc`, the shift group — are *generated* below
 * rather than typed out. They are regular in the hardware (ALU opcodes are
 * eight apart, condition codes are the low nibble), and writing out 8 × 9 ALU
 * forms by hand is 72 chances to transpose a byte.
 */

import type { OperandSize } from "./registers";

/** What an operand slot accepts. */
export type OperandPattern =
  | { k: "reg"; size: OperandSize }
  | { k: "rm"; size: OperandSize }
  /** Memory only — `lea` has no register form. */
  | { k: "mem" }
  | { k: "imm"; size: OperandSize; signExtended?: boolean }
  | { k: "rel"; size: 1 | 4 }
  /** A register the opcode names implicitly: `al`, `ax`, `eax`, `rax`, `cl`. */
  | { k: "fixed"; name: string }
  /** The literal `1` in `shl rax, 1`. */
  | { k: "one" };

/**
 * Where the operands sit in the encoding.
 *
 * `MR` puts the first operand in ModRM.rm and the second in ModRM.reg; `RM` is
 * the reverse. `MI` is rm plus an immediate with the opcode extension in
 * ModRM.reg. `O` folds the register into the opcode byte. `D` is a
 * displacement relative to the next instruction. `ZO` has no operand bytes.
 */
export type Encoding = "MR" | "RM" | "MI" | "M" | "I" | "O" | "OI" | "D" | "ZO" | "RMI";

export interface InstructionForm {
  mnemonic: string;
  operands: OperandPattern[];
  /** Opcode bytes, including a leading 0x0F for the two-byte map. */
  opcode: number[];
  /** ModRM.reg opcode extension (`/digit`), when the form uses one. */
  ext?: number;
  encoding: Encoding;
  /**
   * The instruction's operand size, which decides REX.W and the 0x66 prefix.
   * Absent for forms whose size is fixed by the opcode (`push r64`, `jmp`).
   */
  opsize?: OperandSize;
  /** Bytes of immediate actually emitted, when it differs from `opsize`. */
  immBytes?: 1 | 2 | 4 | 8;
  /** Aliases that assemble to this same form (`sal` → `shl`, `jz` → `je`). */
  aliases?: string[];
}

const forms: InstructionForm[] = [];

function form(entry: InstructionForm): void {
  forms.push(entry);
}

const R = (size: OperandSize): OperandPattern => ({ k: "reg", size });
const RM = (size: OperandSize): OperandPattern => ({ k: "rm", size });
const IMM = (size: OperandSize, signExtended = false): OperandPattern => ({
  k: "imm",
  size,
  signExtended,
});
const FIXED = (name: string): OperandPattern => ({ k: "fixed", name });

const WIDE: OperandSize[] = [2, 4, 8];

// ---------------------------------------------------------------------------
// mov, and the moves that change width
// ---------------------------------------------------------------------------

form({ mnemonic: "mov", operands: [RM(1), R(1)], opcode: [0x88], encoding: "MR", opsize: 1 });
form({ mnemonic: "mov", operands: [R(1), RM(1)], opcode: [0x8a], encoding: "RM", opsize: 1 });
form({
  mnemonic: "mov",
  operands: [RM(1), IMM(1)],
  opcode: [0xc6],
  ext: 0,
  encoding: "MI",
  opsize: 1,
});
form({ mnemonic: "mov", operands: [R(1), IMM(1)], opcode: [0xb0], encoding: "OI", opsize: 1 });

for (const size of WIDE) {
  form({
    mnemonic: "mov",
    operands: [RM(size), R(size)],
    opcode: [0x89],
    encoding: "MR",
    opsize: size,
  });
  form({
    mnemonic: "mov",
    operands: [R(size), RM(size)],
    opcode: [0x8b],
    encoding: "RM",
    opsize: size,
  });
  form({
    mnemonic: "mov",
    operands: [RM(size), IMM(size, size === 8)],
    opcode: [0xc7],
    ext: 0,
    encoding: "MI",
    opsize: size,
    immBytes: size === 8 ? 4 : (size as 2 | 4),
  });
  form({
    mnemonic: "mov",
    operands: [R(size), IMM(size)],
    opcode: [0xb8],
    encoding: "OI",
    opsize: size,
    immBytes: size === 8 ? 8 : (size as 2 | 4),
  });
}

for (const size of WIDE) {
  form({
    mnemonic: "movzx",
    operands: [R(size), RM(1)],
    opcode: [0x0f, 0xb6],
    encoding: "RM",
    opsize: size,
  });
  form({
    mnemonic: "movsx",
    operands: [R(size), RM(1)],
    opcode: [0x0f, 0xbe],
    encoding: "RM",
    opsize: size,
  });
}
for (const size of [4, 8] as OperandSize[]) {
  form({
    mnemonic: "movzx",
    operands: [R(size), RM(2)],
    opcode: [0x0f, 0xb7],
    encoding: "RM",
    opsize: size,
  });
  form({
    mnemonic: "movsx",
    operands: [R(size), RM(2)],
    opcode: [0x0f, 0xbf],
    encoding: "RM",
    opsize: size,
  });
}
// The 32→64 widening move keeps its own mnemonic because the width it reads
// is not the width it writes; NASM also accepts `movsx` for it.
form({
  mnemonic: "movsxd",
  operands: [R(8), RM(4)],
  opcode: [0x63],
  encoding: "RM",
  opsize: 8,
  aliases: ["movsx"],
});

form({
  mnemonic: "lea",
  operands: [R(4), { k: "mem" }],
  opcode: [0x8d],
  encoding: "RM",
  opsize: 4,
});
form({
  mnemonic: "lea",
  operands: [R(8), { k: "mem" }],
  opcode: [0x8d],
  encoding: "RM",
  opsize: 8,
});
form({
  mnemonic: "lea",
  operands: [R(2), { k: "mem" }],
  opcode: [0x8d],
  encoding: "RM",
  opsize: 2,
});

// `xchg` swaps, so NASM takes its operands in either order against the one pair
// of opcodes. The reversed forms are declared after the straight ones on
// purpose: the encoder keeps the first of two encodings that tie on length, so
// `xchg rax, rbx` stays the byte sequence it has always been.
form({ mnemonic: "xchg", operands: [RM(1), R(1)], opcode: [0x86], encoding: "MR", opsize: 1 });
form({ mnemonic: "xchg", operands: [R(1), RM(1)], opcode: [0x86], encoding: "RM", opsize: 1 });
for (const size of WIDE) {
  form({
    mnemonic: "xchg",
    operands: [RM(size), R(size)],
    opcode: [0x87],
    encoding: "MR",
    opsize: size,
  });
  form({
    mnemonic: "xchg",
    operands: [R(size), RM(size)],
    opcode: [0x87],
    encoding: "RM",
    opsize: size,
  });
}

// ---------------------------------------------------------------------------
// The eight ALU operations, whose opcodes march in steps of eight
// ---------------------------------------------------------------------------

const ALU_GROUP: { mnemonic: string; base: number; ext: number }[] = [
  { mnemonic: "add", base: 0x00, ext: 0 },
  { mnemonic: "or", base: 0x08, ext: 1 },
  { mnemonic: "adc", base: 0x10, ext: 2 },
  { mnemonic: "sbb", base: 0x18, ext: 3 },
  { mnemonic: "and", base: 0x20, ext: 4 },
  { mnemonic: "sub", base: 0x28, ext: 5 },
  { mnemonic: "xor", base: 0x30, ext: 6 },
  { mnemonic: "cmp", base: 0x38, ext: 7 },
];

const ACCUMULATOR: Record<number, string> = { 1: "al", 2: "ax", 4: "eax", 8: "rax" };

for (const { mnemonic, base, ext } of ALU_GROUP) {
  form({ mnemonic, operands: [RM(1), R(1)], opcode: [base + 0], encoding: "MR", opsize: 1 });
  form({ mnemonic, operands: [R(1), RM(1)], opcode: [base + 2], encoding: "RM", opsize: 1 });
  form({
    mnemonic,
    operands: [FIXED("al"), IMM(1)],
    opcode: [base + 4],
    encoding: "I",
    opsize: 1,
    immBytes: 1,
  });
  form({
    mnemonic,
    operands: [RM(1), IMM(1)],
    opcode: [0x80],
    ext,
    encoding: "MI",
    opsize: 1,
    immBytes: 1,
  });

  for (const size of WIDE) {
    form({
      mnemonic,
      operands: [RM(size), R(size)],
      opcode: [base + 1],
      encoding: "MR",
      opsize: size,
    });
    form({
      mnemonic,
      operands: [R(size), RM(size)],
      opcode: [base + 3],
      encoding: "RM",
      opsize: size,
    });
    form({
      mnemonic,
      operands: [FIXED(ACCUMULATOR[size]), IMM(size, size === 8)],
      opcode: [base + 5],
      encoding: "I",
      opsize: size,
      immBytes: size === 8 ? 4 : (size as 2 | 4),
    });
    form({
      mnemonic,
      operands: [RM(size), IMM(size, size === 8)],
      opcode: [0x81],
      ext,
      encoding: "MI",
      opsize: size,
      immBytes: size === 8 ? 4 : (size as 2 | 4),
    });
    // 0x83 is the one that makes `add rax, 1` three bytes instead of seven:
    // one signed byte, widened to the operand size by the hardware.
    form({
      mnemonic,
      operands: [RM(size), IMM(1, true)],
      opcode: [0x83],
      ext,
      encoding: "MI",
      opsize: size,
      immBytes: 1,
    });
  }
}

// `test` is `and` that keeps no result. Intel gives it no reversed *opcode* the
// way the ALU group has one, but the operation is symmetric, so NASM reads both
// orders against the same byte — same trick as `xchg` above.
form({ mnemonic: "test", operands: [RM(1), R(1)], opcode: [0x84], encoding: "MR", opsize: 1 });
form({ mnemonic: "test", operands: [R(1), RM(1)], opcode: [0x84], encoding: "RM", opsize: 1 });
form({
  mnemonic: "test",
  operands: [FIXED("al"), IMM(1)],
  opcode: [0xa8],
  encoding: "I",
  opsize: 1,
  immBytes: 1,
});
form({
  mnemonic: "test",
  operands: [RM(1), IMM(1)],
  opcode: [0xf6],
  ext: 0,
  encoding: "MI",
  opsize: 1,
  immBytes: 1,
});
for (const size of WIDE) {
  form({
    mnemonic: "test",
    operands: [RM(size), R(size)],
    opcode: [0x85],
    encoding: "MR",
    opsize: size,
  });
  form({
    mnemonic: "test",
    operands: [R(size), RM(size)],
    opcode: [0x85],
    encoding: "RM",
    opsize: size,
  });
  form({
    mnemonic: "test",
    operands: [FIXED(ACCUMULATOR[size]), IMM(size, size === 8)],
    opcode: [0xa9],
    encoding: "I",
    opsize: size,
    immBytes: size === 8 ? 4 : (size as 2 | 4),
  });
  form({
    mnemonic: "test",
    operands: [RM(size), IMM(size, size === 8)],
    opcode: [0xf7],
    ext: 0,
    encoding: "MI",
    opsize: size,
    immBytes: size === 8 ? 4 : (size as 2 | 4),
  });
}

// ---------------------------------------------------------------------------
// The unary group (F6/F7) and inc/dec (FE/FF)
// ---------------------------------------------------------------------------

const UNARY_GROUP: { mnemonic: string; ext: number }[] = [
  { mnemonic: "not", ext: 2 },
  { mnemonic: "neg", ext: 3 },
  { mnemonic: "mul", ext: 4 },
  { mnemonic: "imul", ext: 5 },
  { mnemonic: "div", ext: 6 },
  { mnemonic: "idiv", ext: 7 },
];

for (const { mnemonic, ext } of UNARY_GROUP) {
  form({ mnemonic, operands: [RM(1)], opcode: [0xf6], ext, encoding: "M", opsize: 1 });
  for (const size of WIDE) {
    form({ mnemonic, operands: [RM(size)], opcode: [0xf7], ext, encoding: "M", opsize: size });
  }
}

for (const [mnemonic, ext] of [
  ["inc", 0],
  ["dec", 1],
] as const) {
  form({ mnemonic, operands: [RM(1)], opcode: [0xfe], ext, encoding: "M", opsize: 1 });
  for (const size of WIDE) {
    form({ mnemonic, operands: [RM(size)], opcode: [0xff], ext, encoding: "M", opsize: size });
  }
}

// `imul` also has the two- and three-operand forms that keep only the low half.
for (const size of [2, 4, 8] as OperandSize[]) {
  form({
    mnemonic: "imul",
    operands: [R(size), RM(size)],
    opcode: [0x0f, 0xaf],
    encoding: "RM",
    opsize: size,
  });
  form({
    mnemonic: "imul",
    operands: [R(size), RM(size), IMM(1, true)],
    opcode: [0x6b],
    encoding: "RMI",
    opsize: size,
    immBytes: 1,
  });
  form({
    mnemonic: "imul",
    operands: [R(size), RM(size), IMM(size, size === 8)],
    opcode: [0x69],
    encoding: "RMI",
    opsize: size,
    immBytes: size === 8 ? 4 : (size as 2 | 4),
  });
}

// ---------------------------------------------------------------------------
// Shifts and rotates
// ---------------------------------------------------------------------------

const SHIFT_GROUP: { mnemonic: string; ext: number; aliases?: string[] }[] = [
  { mnemonic: "rol", ext: 0 },
  { mnemonic: "ror", ext: 1 },
  { mnemonic: "shl", ext: 4, aliases: ["sal"] },
  { mnemonic: "shr", ext: 5 },
  { mnemonic: "sar", ext: 7 },
];

for (const { mnemonic, ext, aliases } of SHIFT_GROUP) {
  const sizes: OperandSize[] = [1, 2, 4, 8];
  for (const size of sizes) {
    const byOne = size === 1 ? 0xd0 : 0xd1;
    const byCl = size === 1 ? 0xd2 : 0xd3;
    const byImm = size === 1 ? 0xc0 : 0xc1;
    form({
      mnemonic,
      operands: [RM(size), { k: "one" }],
      opcode: [byOne],
      ext,
      encoding: "M",
      opsize: size,
      aliases,
    });
    form({
      mnemonic,
      operands: [RM(size), FIXED("cl")],
      opcode: [byCl],
      ext,
      encoding: "M",
      opsize: size,
      aliases,
    });
    form({
      mnemonic,
      operands: [RM(size), IMM(1)],
      opcode: [byImm],
      ext,
      encoding: "MI",
      opsize: size,
      immBytes: 1,
      aliases,
    });
  }
}

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

form({ mnemonic: "push", operands: [R(8)], opcode: [0x50], encoding: "O" });
form({ mnemonic: "push", operands: [RM(8)], opcode: [0xff], ext: 6, encoding: "M" });
form({ mnemonic: "push", operands: [IMM(1, true)], opcode: [0x6a], encoding: "I", immBytes: 1 });
form({ mnemonic: "push", operands: [IMM(4, true)], opcode: [0x68], encoding: "I", immBytes: 4 });
form({ mnemonic: "pop", operands: [R(8)], opcode: [0x58], encoding: "O" });
form({ mnemonic: "pop", operands: [RM(8)], opcode: [0x8f], ext: 0, encoding: "M" });

// ---------------------------------------------------------------------------
// Control flow
// ---------------------------------------------------------------------------

/**
 * The sixteen condition codes, low nibble first, with every spelling the
 * assembler accepts. `jz` and `je` are the same instruction; so are `jnae`,
 * `jb` and `jc`. Keeping the alternates here means the decoder can print one
 * canonical name while the assembler still reads all of them.
 */
export const CONDITION_CODES: { code: number; names: string[] }[] = [
  { code: 0x0, names: ["o"] },
  { code: 0x1, names: ["no"] },
  { code: 0x2, names: ["b", "c", "nae"] },
  { code: 0x3, names: ["ae", "nb", "nc"] },
  { code: 0x4, names: ["e", "z"] },
  { code: 0x5, names: ["ne", "nz"] },
  { code: 0x6, names: ["be", "na"] },
  { code: 0x7, names: ["a", "nbe"] },
  { code: 0x8, names: ["s"] },
  { code: 0x9, names: ["ns"] },
  { code: 0xa, names: ["p", "pe"] },
  { code: 0xb, names: ["np", "po"] },
  { code: 0xc, names: ["l", "nge"] },
  { code: 0xd, names: ["ge", "nl"] },
  { code: 0xe, names: ["le", "ng"] },
  { code: 0xf, names: ["g", "nle"] },
];

for (const { code, names } of CONDITION_CODES) {
  const [canonical, ...rest] = names;
  form({
    mnemonic: `j${canonical}`,
    operands: [{ k: "rel", size: 1 }],
    opcode: [0x70 + code],
    encoding: "D",
    aliases: rest.map((name) => `j${name}`),
  });
  form({
    mnemonic: `j${canonical}`,
    operands: [{ k: "rel", size: 4 }],
    opcode: [0x0f, 0x80 + code],
    encoding: "D",
    aliases: rest.map((name) => `j${name}`),
  });
  form({
    mnemonic: `set${canonical}`,
    operands: [RM(1)],
    opcode: [0x0f, 0x90 + code],
    ext: 0,
    encoding: "M",
    opsize: 1,
    aliases: rest.map((name) => `set${name}`),
  });
  for (const size of WIDE) {
    form({
      mnemonic: `cmov${canonical}`,
      operands: [R(size), RM(size)],
      opcode: [0x0f, 0x40 + code],
      encoding: "RM",
      opsize: size,
      aliases: rest.map((name) => `cmov${name}`),
    });
  }
}

form({ mnemonic: "jmp", operands: [{ k: "rel", size: 1 }], opcode: [0xeb], encoding: "D" });
form({ mnemonic: "jmp", operands: [{ k: "rel", size: 4 }], opcode: [0xe9], encoding: "D" });
form({ mnemonic: "jmp", operands: [RM(8)], opcode: [0xff], ext: 4, encoding: "M" });
form({ mnemonic: "call", operands: [{ k: "rel", size: 4 }], opcode: [0xe8], encoding: "D" });
form({ mnemonic: "call", operands: [RM(8)], opcode: [0xff], ext: 2, encoding: "M" });
form({ mnemonic: "ret", operands: [], opcode: [0xc3], encoding: "ZO" });
form({ mnemonic: "leave", operands: [], opcode: [0xc9], encoding: "ZO" });
form({ mnemonic: "loop", operands: [{ k: "rel", size: 1 }], opcode: [0xe2], encoding: "D" });
form({
  mnemonic: "loope",
  operands: [{ k: "rel", size: 1 }],
  opcode: [0xe1],
  encoding: "D",
  aliases: ["loopz"],
});
form({
  mnemonic: "loopne",
  operands: [{ k: "rel", size: 1 }],
  opcode: [0xe0],
  encoding: "D",
  aliases: ["loopnz"],
});

// ---------------------------------------------------------------------------
// Sign extension of the accumulator, and the rest
// ---------------------------------------------------------------------------

form({ mnemonic: "cbw", operands: [], opcode: [0x98], encoding: "ZO", opsize: 2 });
form({ mnemonic: "cwde", operands: [], opcode: [0x98], encoding: "ZO", opsize: 4 });
form({ mnemonic: "cdqe", operands: [], opcode: [0x98], encoding: "ZO", opsize: 8 });
form({ mnemonic: "cwd", operands: [], opcode: [0x99], encoding: "ZO", opsize: 2 });
form({ mnemonic: "cdq", operands: [], opcode: [0x99], encoding: "ZO", opsize: 4 });
form({ mnemonic: "cqo", operands: [], opcode: [0x99], encoding: "ZO", opsize: 8 });

form({ mnemonic: "nop", operands: [], opcode: [0x90], encoding: "ZO" });
form({ mnemonic: "syscall", operands: [], opcode: [0x0f, 0x05], encoding: "ZO" });
form({ mnemonic: "hlt", operands: [], opcode: [0xf4], encoding: "ZO" });
form({ mnemonic: "int3", operands: [], opcode: [0xcc], encoding: "ZO" });

export const INSTRUCTION_FORMS: readonly InstructionForm[] = forms;

const BY_MNEMONIC = new Map<string, InstructionForm[]>();
for (const entry of forms) {
  for (const name of [entry.mnemonic, ...(entry.aliases ?? [])]) {
    const bucket = BY_MNEMONIC.get(name);
    if (bucket) bucket.push(entry);
    else BY_MNEMONIC.set(name, [entry]);
  }
}

/** Every form a mnemonic (or one of its aliases) can assemble to. */
export function formsFor(mnemonic: string): readonly InstructionForm[] {
  return BY_MNEMONIC.get(mnemonic.toLowerCase()) ?? [];
}

export function isKnownMnemonic(mnemonic: string): boolean {
  return BY_MNEMONIC.has(mnemonic.toLowerCase());
}

/** Every mnemonic the assembler accepts, sorted — used for "did you mean". */
export const KNOWN_MNEMONICS: readonly string[] = [...BY_MNEMONIC.keys()].sort();
