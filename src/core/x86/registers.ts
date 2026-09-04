/**
 * The x86-64 general-purpose register file, named the way an assembly
 * programmer names it.
 *
 * One physical register wears four names — `rax`, `eax`, `ax`, `al` — and the
 * name chosen is *how the width is written down*: there is no separate operand
 * for "how many bits". Every table below therefore maps a name to the same
 * three facts the encoder needs: which of the sixteen registers it is, how wide
 * the access is, and whether it is one of the two legacy high-byte names
 * (`ah`, `ch`, `dh`, `bh`) that address bits 8-15 of the first four registers
 * rather than the low byte.
 *
 * The high-byte names matter more than their rarity suggests: they are the one
 * case where a register name does *not* mean "the low bits of index N", and
 * they cannot appear in an instruction that also carries a REX prefix. An
 * assembler that forgets that quietly encodes `spl`/`bpl`/`sil`/`dil` instead,
 * which is a different register.
 */

/** Register index as the ModRM/REX encoding sees it: 0-15, `rax` first. */
export type RegisterIndex = number;

export type OperandSize = 1 | 2 | 4 | 8;

export interface RegisterRef {
  /** Canonical lowercase name, exactly as it was written. */
  name: string;
  index: RegisterIndex;
  size: OperandSize;
  /** True for `ah`, `ch`, `dh`, `bh` — bits 8-15 of registers 0-3. */
  high8: boolean;
}

/** The sixteen 64-bit names, in encoding order. */
export const REGISTERS_64 = [
  "rax",
  "rcx",
  "rdx",
  "rbx",
  "rsp",
  "rbp",
  "rsi",
  "rdi",
  "r8",
  "r9",
  "r10",
  "r11",
  "r12",
  "r13",
  "r14",
  "r15",
] as const;

const REGISTERS_32 = [
  "eax",
  "ecx",
  "edx",
  "ebx",
  "esp",
  "ebp",
  "esi",
  "edi",
  "r8d",
  "r9d",
  "r10d",
  "r11d",
  "r12d",
  "r13d",
  "r14d",
  "r15d",
] as const;

const REGISTERS_16 = [
  "ax",
  "cx",
  "dx",
  "bx",
  "sp",
  "bp",
  "si",
  "di",
  "r8w",
  "r9w",
  "r10w",
  "r11w",
  "r12w",
  "r13w",
  "r14w",
  "r15w",
] as const;

/**
 * The 8-bit names reachable with (or without) a REX prefix.
 *
 * `spl`, `bpl`, `sil` and `dil` are the REX-only spellings of registers 4-7's
 * low byte; without REX those four ModRM encodings mean `ah`, `ch`, `dh`, `bh`
 * instead. That is the whole reason `high8` exists.
 */
const REGISTERS_8 = [
  "al",
  "cl",
  "dl",
  "bl",
  "spl",
  "bpl",
  "sil",
  "dil",
  "r8b",
  "r9b",
  "r10b",
  "r11b",
  "r12b",
  "r13b",
  "r14b",
  "r15b",
] as const;

const HIGH_BYTE_REGISTERS = ["ah", "ch", "dh", "bh"] as const;

const TABLE = new Map<string, RegisterRef>();

function define(names: readonly string[], size: OperandSize, high8 = false): void {
  names.forEach((name, position) => {
    // `index` is always the ModRM encoding, never the physical register — and
    // for the high-byte names those differ. `ah` encodes as 4, the same three
    // bits `spl` uses, and means "bits 8-15 of register 0". Storing 0 here
    // would assemble `mov ah, bl` as `mov al, bl`: a program that runs, prints
    // something, and is wrong. `high8` is what tells the register file to look
    // four registers down and one byte up.
    TABLE.set(name, { name, index: high8 ? position + 4 : position, size, high8 });
  });
}

define(REGISTERS_64, 8);
define(REGISTERS_32, 4);
define(REGISTERS_16, 2);
define(REGISTERS_8, 1);
define(HIGH_BYTE_REGISTERS, 1, true);

/** Look a register name up, or null when it is not one. */
export function lookupRegister(name: string): RegisterRef | null {
  return TABLE.get(name.toLowerCase()) ?? null;
}

/** Whether a name is a register at all, without needing what it refers to. */
export function isRegisterName(name: string): boolean {
  return TABLE.has(name.toLowerCase());
}

/**
 * The register a name actually reads and writes.
 *
 * For every name but the four high-byte ones this is the encoded index itself.
 * `ah` encodes as 4 and lives in register 0.
 */
export function physicalRegister(index: RegisterIndex, high8: boolean): RegisterIndex {
  return high8 ? index - 4 : index;
}

/**
 * Whether an 8-bit register name forces a REX prefix even when nothing else
 * needs one. `spl`/`bpl`/`sil`/`dil` are unreachable without it.
 */
export function requiresRex(reference: RegisterRef): boolean {
  return reference.size === 1 && !reference.high8 && reference.index >= 4 && reference.index <= 7;
}

/** Whether a register name is unencodable alongside a REX prefix. */
export function forbidsRex(reference: RegisterRef): boolean {
  return reference.high8;
}
