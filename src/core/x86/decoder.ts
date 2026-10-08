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
 * The bytes-beside-source view that teaches encoding at all — `48 83 c0 01`
 * shown as the same four bytes as `add rax, 1` — is built by `formatListing` in
 * `run.ts` from the assembler's own listing, so what comes back from here is
 * only what executing the bytes needs.
 *
 * The decode table is derived from the same `isa.ts` entries the encoder uses.
 * Nothing here is a second copy of the instruction set; it is an index into the
 * first one.
 */

import { INSTRUCTION_FORMS, type Encoding, type InstructionForm, type OperandPattern } from "./isa";
import {
  encodingNamesHighByte,
  lookupRegister,
  physicalRegister,
  type OperandSize,
  type RegisterRef,
} from "./registers";

export type DecodedOperand =
  | {
      kind: "register";
      /**
       * The physical register, 0-15 with `rax` first — not the ModRM encoding,
       * which for `ah` is 4. The decoder resolves that here so the register
       * file never has to know it.
       */
      index: number;
      size: OperandSize;
      /** Bits 8-15 of `index` rather than its low byte: `ah`, `ch`, `dh`, `bh`. */
      high8: boolean;
    }
  | {
      kind: "immediate";
      /**
       * The immediate sign-extended to the operand width, as unsigned bits —
       * the same convention as a register or memory read, so `mov al, -1`
       * carries 255n and `mov rax, -1` carries 2^64 - 1 whatever the width of
       * the field that encoded it.
       */
      value: bigint;
    }
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

/**
 * The architectural maximum length of one x86 instruction, prefixes included.
 *
 * The decoder enforces it rather than leaving it to whoever fetched the bytes:
 * sixteen `66` prefixes and an opcode is not a long instruction, it is not an
 * instruction at all, and a processor rejects it however many bytes follow.
 */
export const MAX_INSTRUCTION_BYTES = 15;

export interface DecodedInstruction {
  mnemonic: string;
  /** Total bytes consumed, prefixes included. */
  length: number;
  /** The width this instruction operates at. */
  operandSize: OperandSize;
  operands: DecodedOperand[];
}

/**
 * Deliberately outside the `errors.ts` family. Those describe a place in the
 * source and are formatted with a caret under the offending column; this one
 * happens while the program is already running, where the only coordinate left
 * is an address. `cpu.ts` catches it beside `MemoryFault` and turns it into a
 * fault, which is a different report entirely.
 */
export class AsmDecodeError extends Error {
  readonly address: bigint;

  constructor(message: string, address: bigint) {
    super(message);
    this.name = "AsmDecodeError";
    this.address = address;
  }
}

/**
 * The table key for an opcode, as a number. This runs once per executed
 * instruction, so the one or two opcode bytes are folded into an integer rather
 * than a string that has to be built and hashed every time. The `/digit`
 * extension — what tells `0x83 /0` (`add`) from `0x83 /5` (`sub`) — rides in the
 * low bits, with -1 meaning "the form has none".
 */
function opcodeKey(opcode: readonly number[], ext = -1): number {
  let key = 0;
  for (const byte of opcode) key = key * 256 + byte;
  return key * 16 + (ext + 1);
}

function describeOpcode(opcode: readonly number[]): string {
  return opcode.map((byte) => `0x${byte.toString(16)}`).join(" ");
}

/**
 * A register operand as the bytes encode it, in ModRM, REX or the low bits of
 * the opcode. Whether a one-byte encoding of 4-7 means `ah` or `spl` depends on
 * whether the instruction carried REX, which is the register file's rule to
 * state; the operand comes back naming the physical register either way.
 */
function encodedRegister(encoding: number, size: OperandSize, sawRex: boolean): DecodedOperand {
  const high8 = encodingNamesHighByte(size, encoding, sawRex);
  return { kind: "register", index: physicalRegister(encoding, high8), size, high8 };
}

/** Encodings that carry a ModRM byte after the opcode. */
const USES_MODRM: ReadonlySet<Encoding> = new Set<Encoding>(["MR", "RM", "MI", "M", "RMI"]);

/** Encodings whose last opcode byte carries a register in its low three bits. */
function foldsRegisterIntoOpcode(encoding: Encoding): boolean {
  return encoding === "O" || encoding === "OI";
}

interface TableEntry {
  form: InstructionForm;
  /** True when the low three bits of the last opcode byte name a register. */
  registerInOpcode: boolean;
  /** The register each `fixed` operand names, by operand position; unset elsewhere. */
  fixedRegisters: (RegisterRef | undefined)[];
}

/**
 * A form's table entry, checked against its encoding once, as this module
 * loads. A malformed `isa.ts` entry — a ModRM operand on an encoding with no
 * ModRM byte, an implicit register that is not a register — then fails on
 * import, in every test run, instead of the first time a program executes it.
 */
function tableEntry(form: InstructionForm): TableEntry {
  const registerInOpcode = foldsRegisterIntoOpcode(form.encoding);
  for (const pattern of form.operands) {
    const needsModrm =
      pattern.k === "rm" || pattern.k === "mem" || (pattern.k === "reg" && !registerInOpcode);
    if (needsModrm && !USES_MODRM.has(form.encoding)) {
      throw new Error(
        `isa.ts: ${form.mnemonic}'s ${pattern.k} operand needs a ModRM byte, which its ${form.encoding} encoding does not have`,
      );
    }
  }
  const fixedRegisters = form.operands.map((pattern) => {
    if (pattern.k !== "fixed") return undefined;
    const fixed = lookupRegister(pattern.name);
    if (fixed === null) {
      throw new Error(`isa.ts: ${form.mnemonic} names ${pattern.name}, which is not a register`);
    }
    return fixed;
  });
  return { form, registerInOpcode, fixedRegisters };
}

const TABLE = new Map<number, TableEntry[]>();

/**
 * Opcodes whose ModRM.reg field picks the instruction, keyed as `opcodeKey`
 * keys them without an extension. Only for these is a `/digit` part of what a
 * decode error has to name.
 */
const GROUP_OPCODES = new Set<number>();

function add(key: number, entry: TableEntry): void {
  const bucket = TABLE.get(key);
  if (bucket) bucket.push(entry);
  else TABLE.set(key, [entry]);
}

for (const form of INSTRUCTION_FORMS) {
  const entry = tableEntry(form);
  if (entry.registerInOpcode) {
    // `push rcx` and `push rax` are different bytes for the same form, so the
    // table carries all eight.
    for (let offset = 0; offset < 8; offset += 1) {
      const opcode = [...form.opcode];
      opcode[opcode.length - 1] += offset;
      add(opcodeKey(opcode), entry);
    }
    continue;
  }
  add(opcodeKey(form.opcode, form.ext ?? -1), entry);
  if (form.ext !== undefined) GROUP_OPCODES.add(opcodeKey(form.opcode));
}

class ByteReader {
  #bytes: Uint8Array;
  #offset: number;
  /** One past the last byte this instruction may use: the end of the code, or 15 bytes in. */
  #limit: number;
  #address: bigint;
  readonly start: number;

  constructor(bytes: Uint8Array, offset: number, address: bigint) {
    this.#bytes = bytes;
    this.#offset = offset;
    this.#limit = Math.min(bytes.length, offset + MAX_INSTRUCTION_BYTES);
    this.#address = address;
    this.start = offset;
  }

  get consumed(): number {
    return this.#offset - this.start;
  }

  peek(): number | undefined {
    return this.#offset < this.#limit ? this.#bytes[this.#offset] : undefined;
  }

  u8(): number {
    if (this.#offset >= this.#limit) throw this.truncated();
    const value = this.#bytes[this.#offset];
    this.#offset += 1;
    return value;
  }

  /**
   * The error for an instruction that needs a byte past the limit. Which limit
   * it hit decides the sentence: a reader fed a full fetch window has not run
   * out of *code* at byte sixteen, it is looking at bytes no processor would
   * accept as one instruction.
   */
  truncated(): AsmDecodeError {
    const at = `0x${this.#address.toString(16)}`;
    if (this.consumed >= MAX_INSTRUCTION_BYTES) {
      return new AsmDecodeError(
        `The bytes at ${at} are not an instruction — no x86 instruction is longer than the ${MAX_INSTRUCTION_BYTES} bytes read here`,
        this.#address,
      );
    }
    return new AsmDecodeError(
      `The instruction at ${at} runs past the end of the code`,
      this.#address,
    );
  }

  signed(bytes: number): bigint {
    let value = 0n;
    for (let index = 0; index < bytes; index += 1) {
      value |= BigInt(this.u8()) << BigInt(index * 8);
    }
    const signBit = 1n << BigInt(bytes * 8 - 1);
    return value & signBit ? value - (1n << BigInt(bytes * 8)) : value;
  }
}

/** The operand-size override: 16-bit operands where the default is 32. */
const OPERAND_SIZE_PREFIX = 0x66;

/** cs/ds/es/ss: segment overrides that have no effect in 64-bit mode. */
const NO_OP_SEGMENT_PREFIXES: ReadonlySet<number> = new Set([0x2e, 0x3e, 0x26, 0x36]);

/**
 * Prefixes that still change what an instruction does in 64-bit mode, in ways
 * this runner does not model: fs and gs add a segment base to the address,
 * 0x67 cuts the address to 32 bits, lock and rep change how it executes.
 * Skipping one would execute a different instruction than the bytes encode,
 * and leaving it to the opcode lookup would report the prefix as an unknown
 * opcode, so each is refused by name.
 */
const UNSUPPORTED_PREFIXES: ReadonlyMap<number, string> = new Map([
  [0x64, "fs segment"],
  [0x65, "gs segment"],
  [0x67, "address-size"],
  [0xf0, "lock"],
  [0xf2, "repne"],
  [0xf3, "rep"],
]);

/**
 * The forms with no `opsize` that 0x66 still changes: it makes their stack
 * slot 16 bits, so `66 50` is `push ax`. The table has no 16-bit stack forms,
 * so these refuse the prefix rather than run the 64-bit one.
 */
const STACK_WIDTH_MNEMONICS: ReadonlySet<string> = new Set(["push", "pop", "leave"]);

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
  const reader = new ByteReader(bytes, offset, address);

  let operandSizeOverride = false;
  let rex = 0;
  let sawRex = false;

  for (;;) {
    const next = reader.peek();
    if (next === undefined) {
      // Only an empty buffer has no instruction at all; prefixes with nothing
      // after them are one that was cut short.
      if (reader.consumed === 0) throw new AsmDecodeError("There is no instruction here", address);
      throw reader.truncated();
    }
    if (next === OPERAND_SIZE_PREFIX) {
      operandSizeOverride = true;
      reader.u8();
      continue;
    }
    if (NO_OP_SEGMENT_PREFIXES.has(next)) {
      // 64-bit mode ignores these segment overrides, so they are skipped.
      reader.u8();
      continue;
    }
    const unsupported = UNSUPPORTED_PREFIXES.get(next);
    if (unsupported !== undefined) {
      throw new AsmDecodeError(
        `This runner does not support the ${unsupported} prefix (0x${next.toString(16)})`,
        address,
      );
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
  let opcodeName = describeOpcode(opcodeBytes);

  // A group opcode carries its real identity in ModRM.reg — 0x83 alone is not
  // an instruction, `0x83 /0` is `add`. Look again with that field, and name it
  // in any error: `0xc6 /0` is an instruction where `0xc6 /1` is not.
  if (candidates.length === 0 && GROUP_OPCODES.has(opcodeKey(opcodeBytes))) {
    const peeked = reader.peek();
    if (peeked !== undefined) {
      const ext = (peeked >> 3) & 7;
      candidates = TABLE.get(opcodeKey(opcodeBytes, ext)) ?? [];
      opcodeName += ` /${ext}`;
    }
  }

  if (candidates.length === 0) {
    throw new AsmDecodeError(
      `The byte ${opcodeName} is not an instruction this runner knows`,
      address,
    );
  }

  // The prefixes name a width; a bucket that has no form at that width is not
  // this instruction. Falling back to whichever form came first would execute a
  // different instruction than the bytes encode, silently — `63 d8` without
  // REX.W is `movsxd ebx, eax` on real hardware, and this table only has the
  // 64-bit form. A form with no `opsize` takes its width from the opcode and
  // accepts 0x66 the way the hardware ignores it there (`66 0f 05` is still
  // `syscall`), except the stack forms, where the prefix asks for 16 bits.
  // REX.W outranks 0x66, so `66 48 50` is still the 64-bit `push rax`.
  const matched =
    candidates.find((entry) => entry.form.opsize === wideSize) ??
    candidates.find((entry) => entry.form.opsize === 1) ??
    candidates.find(
      (entry) =>
        entry.form.opsize === undefined &&
        !(wideSize === 2 && STACK_WIDTH_MNEMONICS.has(entry.form.mnemonic)),
    );

  if (matched === undefined) {
    throw new AsmDecodeError(`This runner has no ${wideSize}-byte form of ${opcodeName}`, address);
  }

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

  const immediateWidth = form.immBytes ?? (operandSize === 8 ? 4 : operandSize);

  // `tableEntry` checked at load that every `rm`, `mem` and ModRM `reg`
  // operand sits on an encoding that reads ModRM, so `modrm` is set wherever
  // it is used below.
  for (let position = 0; position < form.operands.length; position += 1) {
    const pattern = form.operands[position];
    switch (pattern.k) {
      case "reg":
        if (matched.registerInOpcode) {
          operands.push(encodedRegister(opcodeRegister + (rexB << 3), pattern.size, sawRex));
        } else {
          operands.push(encodedRegister(modrm!.reg, pattern.size, sawRex));
        }
        break;
      case "rm":
      case "mem":
        operands.push(modrm!.rm);
        break;
      case "imm":
        // Any field narrower than the operand is sign-extended by the hardware,
        // so the field is always read signed, whatever the form's
        // `signExtended` says — that is an encode-side rule about which values
        // a form will accept. Reducing to the operand width then gives the
        // unsigned bits every other operand read returns; for a full 8-byte
        // field the two steps cancel out.
        operands.push({
          kind: "immediate",
          value: BigInt.asUintN(operandSize * 8, reader.signed(immediateWidth)),
        });
        break;
      case "rel":
        operands.push({ kind: "relative", offset: reader.signed(pattern.size) });
        break;
      case "fixed": {
        // The implicit register is named, not encoded, so the register file is
        // the one place that knows which index and width the name stands for —
        // and a REX prefix on the instruction cannot turn an implicit `ah` into
        // `spl`, so its `high8` is taken as named rather than worked out again.
        // `tableEntry` looked the name up at load, so it is always resolved.
        const fixed = matched.fixedRegisters[position]!;
        operands.push({
          kind: "register",
          index: physicalRegister(fixed.index, fixed.high8),
          size: fixed.size,
          high8: fixed.high8,
        });
        break;
      }
      case "one":
        operands.push({ kind: "immediate", value: 1n });
        break;
      default: {
        const unhandled: never = pattern;
        throw new AsmDecodeError(
          `Internal: unhandled operand pattern ${(unhandled as OperandPattern).k}`,
          address,
        );
      }
    }
  }

  return {
    mnemonic: form.mnemonic,
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
    return { reg, rm: encodedRegister(rmField | (rexB << 3), memorySize, sawRex) };
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
