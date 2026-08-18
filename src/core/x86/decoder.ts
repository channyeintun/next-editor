/**
 * Machine code back to instructions.
 *
 * The emulator does not execute a list of statements the assembler handed it —
 * it executes the *bytes*. That distinction is the whole point: if the encoder
 * emitted the wrong REX prefix or put the register in the wrong ModRM field,
 * a decoder reading those bytes finds a different instruction than the one that
 * was written, and the program behaves differently. Round-tripping every form
 * through both directions is what makes that class of bug impossible to ship
 * quietly (see `roundTrip.test.ts`).
 *
 * It also means the runner can disassemble the image it produced, which is the
 * view that teaches encoding at all: `48 83 c0 01` and `add rax, 1` shown as
 * the same four bytes.
 *
 * The decode table is derived from the same `isa.ts` entries the encoder uses.
 * Nothing here is a second copy of the instruction set; it is an index into the
 * first one.
 */

import { INSTRUCTION_FORMS, type Encoding, type InstructionForm } from "./isa";
import type { OperandSize } from "./registers";

export type DecodedOperand =
  | { kind: "register"; index: number; size: OperandSize; high8: boolean }
  | { kind: "immediate"; value: bigint }
  | {
      kind: "memory";
      size: OperandSize;
      base: number | null;
      index: number | null;
      scale: number;
      displacement: bigint;
      ripRelative: boolean;
    }
  /** A branch displacement, measured from the end of this instruction. */
  | { kind: "relative"; offset: bigint };

export interface DecodedInstruction {
  mnemonic: string;
  encoding: Encoding;
  form: InstructionForm;
  /** Total bytes consumed, prefixes included. */
  length: number;
  /** The width this instruction operates at. */
  operandSize: OperandSize;
  operands: DecodedOperand[];
}

export class AsmDecodeError extends Error {
  readonly address: bigint;

  constructor(message: string, address: bigint) {
    super(message);
    this.name = "AsmDecodeError";
    this.address = address;
  }
}

function opcodeKey(opcode: readonly number[]): string {
  return opcode.map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

interface TableEntry {
  form: InstructionForm;
  /** True when the low three bits of the last opcode byte name a register. */
  registerInOpcode: boolean;
}

const TABLE = new Map<string, TableEntry[]>();

function add(key: string, entry: TableEntry): void {
  const bucket = TABLE.get(key);
  if (bucket) bucket.push(entry);
  else TABLE.set(key, [entry]);
}

for (const form of INSTRUCTION_FORMS) {
  const registerInOpcode = form.encoding === "O" || form.encoding === "OI";
  if (registerInOpcode) {
    // `push rcx` and `push rax` are different bytes for the same form, so the
    // table carries all eight.
    for (let offset = 0; offset < 8; offset += 1) {
      const opcode = [...form.opcode];
      opcode[opcode.length - 1] += offset;
      add(opcodeKey(opcode), { form, registerInOpcode: true });
    }
    continue;
  }
  const key =
    form.ext === undefined ? opcodeKey(form.opcode) : `${opcodeKey(form.opcode)}/${form.ext}`;
  add(key, { form, registerInOpcode: false });
}

const USES_MODRM: ReadonlySet<Encoding> = new Set<Encoding>(["MR", "RM", "MI", "M", "RMI"]);

class ByteReader {
  #bytes: Uint8Array;
  #offset: number;
  readonly start: number;

  constructor(bytes: Uint8Array, offset: number) {
    this.#bytes = bytes;
    this.#offset = offset;
    this.start = offset;
  }

  get consumed(): number {
    return this.#offset - this.start;
  }

  peek(): number | undefined {
    return this.#bytes[this.#offset];
  }

  u8(): number {
    const value = this.#bytes[this.#offset];
    if (value === undefined) throw new RangeError("Ran off the end of the code");
    this.#offset += 1;
    return value;
  }

  signed(bytes: number): bigint {
    let value = 0n;
    for (let index = 0; index < bytes; index += 1) {
      value |= BigInt(this.u8()) << BigInt(index * 8);
    }
    const signBit = 1n << BigInt(bytes * 8 - 1);
    return value & signBit ? value - (1n << BigInt(bytes * 8)) : value;
  }

  unsigned(bytes: number): bigint {
    let value = 0n;
    for (let index = 0; index < bytes; index += 1) {
      value |= BigInt(this.u8()) << BigInt(index * 8);
    }
    return value;
  }
}

/**
 * Decode the instruction at `offset`.
 *
 * `address` is only used for diagnostics — a rip-relative displacement is
 * returned as written, and the caller adds the address of the next instruction,
 * because only the caller knows where that is once the length is known.
 */
export function decodeInstruction(
  bytes: Uint8Array,
  offset: number,
  address: bigint,
): DecodedInstruction {
  const reader = new ByteReader(bytes, offset);

  let operandSizeOverride = false;
  let rex = 0;
  let sawRex = false;

  for (;;) {
    const next = reader.peek();
    if (next === undefined) throw new AsmDecodeError("There is no instruction here", address);
    if (next === 0x66) {
      operandSizeOverride = true;
      reader.u8();
      continue;
    }
    if (next === 0x67 || next === 0x2e || next === 0x3e || next === 0x26 || next === 0x36) {
      // Segment and address-size overrides have no effect in this flat model.
      reader.u8();
      continue;
    }
    if (next >= 0x40 && next <= 0x4f) {
      rex = reader.u8();
      sawRex = true;
      // REX must be the last prefix before the opcode.
      break;
    }
    break;
  }

  const rexW = (rex >> 3) & 1;
  const rexR = (rex >> 2) & 1;
  const rexX = (rex >> 1) & 1;
  const rexB = rex & 1;

  const first = reader.u8();
  const opcodeBytes = first === 0x0f ? [0x0f, reader.u8()] : [first];

  const wideSize: OperandSize = rexW ? 8 : operandSizeOverride ? 2 : 4;

  // Forms that fold a register into the opcode are indexed under all eight of
  // the bytes they can occupy, so a plain lookup finds them; which register it
  // was comes from the distance back to the form's own base byte.
  let candidates = TABLE.get(opcodeKey(opcodeBytes)) ?? [];

  // A group opcode carries its real identity in ModRM.reg — 0x83 alone is not
  // an instruction, `0x83 /0` is `add`. Look again with that field.
  if (candidates.length === 0) {
    const peeked = reader.peek();
    if (peeked !== undefined) {
      const ext = (peeked >> 3) & 7;
      candidates = TABLE.get(`${opcodeKey(opcodeBytes)}/${ext}`) ?? [];
    }
  }

  if (candidates.length === 0) {
    throw new AsmDecodeError(
      `The byte ${opcodeBytes.map((b) => `0x${b.toString(16)}`).join(" ")} is not an instruction this runner knows`,
      address,
    );
  }

  const matched =
    candidates.find((entry) => entry.form.opsize === wideSize) ??
    candidates.find((entry) => entry.form.opsize === 1) ??
    candidates.find((entry) => entry.form.opsize === undefined) ??
    candidates[0];

  const form = matched.form;
  const operandSize: OperandSize = form.opsize ?? 8;
  const opcodeRegister = matched.registerInOpcode
    ? opcodeBytes[opcodeBytes.length - 1] - form.opcode[form.opcode.length - 1]
    : 0;

  const operands: DecodedOperand[] = [];
  let modrm: {
    reg: number;
    rm: DecodedOperand;
  } | null = null;

  if (USES_MODRM.has(form.encoding)) {
    modrm = readModRm(reader, rexR, rexX, rexB, sawRex, operandSize, form);
  }

  const registerOperand = (index: number, size: OperandSize): DecodedOperand => ({
    kind: "register",
    index,
    size,
    // A one-byte register numbered 4-7 means `ah`/`ch`/`dh`/`bh` only when no
    // REX prefix is present; with REX it is `spl`/`bpl`/`sil`/`dil`.
    high8: size === 1 && !sawRex && index >= 4 && index <= 7,
  });

  const immediateWidth = form.immBytes ?? (operandSize === 8 ? 4 : operandSize);

  for (let position = 0; position < form.operands.length; position += 1) {
    const pattern = form.operands[position];
    switch (pattern.k) {
      case "reg":
        if (form.encoding === "O" || form.encoding === "OI") {
          operands.push(registerOperand(opcodeRegister + (rexB << 3), pattern.size));
        } else {
          operands.push(registerOperand(modrm!.reg, pattern.size));
        }
        break;
      case "rm":
      case "mem":
        operands.push(modrm!.rm);
        break;
      case "imm": {
        const signed = pattern.signExtended || immediateWidth < 8;
        operands.push({
          kind: "immediate",
          value:
            signed && immediateWidth < 8
              ? reader.signed(immediateWidth)
              : reader.unsigned(immediateWidth),
        });
        break;
      }
      case "rel":
        operands.push({ kind: "relative", offset: reader.signed(pattern.size) });
        break;
      case "fixed": {
        const fixedIndex = { al: 0, ax: 0, eax: 0, rax: 0, cl: 1 }[pattern.name] ?? 0;
        const size: OperandSize =
          pattern.name === "al" || pattern.name === "cl"
            ? 1
            : pattern.name === "ax"
              ? 2
              : pattern.name === "eax"
                ? 4
                : 8;
        operands.push(registerOperand(fixedIndex, size));
        break;
      }
      case "one":
        operands.push({ kind: "immediate", value: 1n });
        break;
    }
  }

  return {
    mnemonic: form.mnemonic,
    encoding: form.encoding,
    form,
    length: reader.consumed,
    operandSize,
    operands,
  };
}

function readModRm(
  reader: ByteReader,
  rexR: number,
  rexX: number,
  rexB: number,
  sawRex: boolean,
  operandSize: OperandSize,
  form: InstructionForm,
): { reg: number; rm: DecodedOperand } {
  const byte = reader.u8();
  const mod = byte >> 6;
  const reg = ((byte >> 3) & 7) | (rexR << 3);
  const rmField = byte & 7;

  // The width of a memory access is the width of the other operand, except in
  // the widening moves where the table states it directly.
  const memorySize = memoryOperandSize(form, operandSize);

  if (mod === 3) {
    const index = rmField | (rexB << 3);
    return {
      reg,
      rm: {
        kind: "register",
        index,
        size: memorySize,
        // Same rule as the reg field: encodings 4-7 of a one-byte register are
        // the high-byte names only when no REX prefix redefined them.
        high8: memorySize === 1 && !sawRex && index >= 4 && index <= 7,
      },
    };
  }

  if (mod === 0 && rmField === 5) {
    return {
      reg,
      rm: {
        kind: "memory",
        size: memorySize,
        base: null,
        index: null,
        scale: 1,
        displacement: reader.signed(4),
        ripRelative: true,
      },
    };
  }

  let base: number | null = null;
  let index: number | null = null;
  let scale = 1;

  if (rmField === 4) {
    const sib = reader.u8();
    scale = 1 << (sib >> 6);
    const sibIndex = ((sib >> 3) & 7) | (rexX << 3);
    const sibBase = (sib & 7) | (rexB << 3);
    // Index 4 without REX.X is the "no index" encoding; r12 (index 12) is a
    // real index and reaches it through REX.X.
    index = sibIndex === 4 ? null : sibIndex;
    base = mod === 0 && (sib & 7) === 5 ? null : sibBase;
  } else {
    base = rmField | (rexB << 3);
  }

  let displacement = 0n;
  if (mod === 1) displacement = reader.signed(1);
  else if (mod === 2) displacement = reader.signed(4);
  else if (base === null) displacement = reader.signed(4);

  return {
    reg,
    rm: {
      kind: "memory",
      size: memorySize,
      base,
      index,
      scale,
      displacement,
      ripRelative: false,
    },
  };
}

/** How many bytes a form's r/m operand touches in memory. */
function memoryOperandSize(form: InstructionForm, operandSize: OperandSize): OperandSize {
  for (const pattern of form.operands) {
    if (pattern.k === "rm") return pattern.size;
  }
  return operandSize;
}
