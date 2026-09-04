/**
 * The processor: sixteen registers, six flags, and a loop that fetches, decodes
 * and executes until the program asks to stop.
 *
 * It executes **bytes**, not statements. Every step reads the machine code at
 * `rip` out of memory and hands it to `decoder.ts`, exactly as hardware would,
 * which is why a program can compute a jump target at run time and land on it.
 * It also means a bug in the encoder shows up here as wrong behaviour rather
 * than as nothing at all.
 *
 * Where this deliberately differs from a real processor is in what it does when
 * something goes wrong. A real one raises a signal and the shell prints
 * "Segmentation fault", which teaches nothing. This one stops with the address
 * it touched, the source line it was on, and a sentence saying what it was
 * trying to do — the information a person needs and the kernel throws away.
 *
 * The flags are worth one note, because they are where an emulator most often
 * quietly disagrees with hardware. They are computed from the *full-width*
 * arithmetic, before truncation: the carry flag after `add al, al` is whether
 * the ninth bit was set, which is only knowable if the addition was not
 * truncated to eight bits first.
 */

import {
  AsmDecodeError,
  decodeInstruction,
  type DecodedInstruction,
  type DecodedOperand,
} from "./decoder";
import { CONDITION_CODES } from "./isa";
import { Memory, MemoryFault } from "./memory";
import { physicalRegister, REGISTERS_64 } from "./registers";

export const RAX = 0;
export const RCX = 1;
export const RDX = 2;
export const RBX = 3;
export const RSP = 4;
export const RBP = 5;
export const RSI = 6;
export const RDI = 7;
/**
 * `ah` as the encoding names it.
 *
 * The register file is addressed by ModRM encoding, not by physical slot, and
 * for the high-byte names those differ — `ah` is encoding 4 and lives in
 * register 0. Passing 0 here with `high8` set would index four registers below
 * `rax`, which a typed array accepts and silently discards.
 */
export const AH = 4;

const U64 = (1n << 64n) - 1n;
const MASKS: Record<number, bigint> = {
  1: 0xffn,
  2: 0xffffn,
  4: 0xffff_ffffn,
  8: U64,
};

export interface Flags {
  carry: boolean;
  parity: boolean;
  adjust: boolean;
  zero: boolean;
  sign: boolean;
  overflow: boolean;
}

export type StopReason =
  | { kind: "exited"; code: number }
  | { kind: "fault"; message: string }
  | { kind: "instruction-limit" }
  | { kind: "output-limit" };

export interface MachineOptions {
  /** Bytes available to `read(0, …)`. */
  stdin?: Uint8Array;
  /** Upper bound on executed instructions, so a runaway loop still answers. */
  maxInstructions?: number;
  /** Upper bound on bytes the program may print. */
  maxOutputBytes?: number;
  /** Upper bound on how far `brk` may push the heap above where it started. */
  maxHeapBytes?: number;
}

/**
 * The instruction budget, chosen from measured throughput rather than taste.
 *
 * This interpreter runs about a million instructions a second, so five million
 * is roughly five seconds of a program that will not stop — long enough that no
 * real lesson program ever reaches it, short enough that a runaway loop answers
 * while the person who wrote it is still looking at the screen.
 */
export const DEFAULT_MAX_INSTRUCTIONS = 5_000_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
/**
 * The same idea for the heap. A bump allocator that never stops asking is an
 * ordinary beginner loop, and the instruction budget is no help there: the
 * memory arrives thousands of times faster than the instructions do, so without
 * this the tab dies before the runner ever gets to say what went wrong.
 */
export const DEFAULT_MAX_HEAP_BYTES = 64 * 1024 * 1024;

/** Canonical condition mnemonic suffix (`e`, `ge`, …) to its 4-bit code. */
const CONDITION_BY_NAME = new Map<string, number>();
for (const { code, names } of CONDITION_CODES) {
  for (const name of names) CONDITION_BY_NAME.set(name, code);
}

class Halt extends Error {
  readonly reason: StopReason;

  constructor(reason: StopReason) {
    super(reason.kind);
    this.name = "Halt";
    this.reason = reason;
  }
}

function parityOf(value: bigint): boolean {
  let byte = Number(value & 0xffn);
  let bits = 0;
  while (byte !== 0) {
    bits += byte & 1;
    byte >>= 1;
  }
  return bits % 2 === 0;
}

function signBit(value: bigint, size: number): boolean {
  return ((value >> BigInt(size * 8 - 1)) & 1n) === 1n;
}

function toSigned(value: bigint, size: number): bigint {
  const mask = MASKS[size];
  const masked = value & mask;
  return signBit(masked, size) ? masked - (mask + 1n) : masked;
}

export class Machine {
  readonly memory = new Memory();
  readonly registers = new BigUint64Array(16);
  rip = 0n;
  flags: Flags = {
    carry: false,
    parity: false,
    adjust: false,
    zero: false,
    sign: false,
    overflow: false,
  };

  /** Bytes the program wrote to file descriptor 1 and 2. */
  readonly stdout: number[] = [];
  readonly stderr: number[] = [];

  #stdin: Uint8Array;
  #stdinPosition = 0;
  #break = 0n;
  #heapStart = 0n;
  #instructions = 0;
  #maxInstructions: number;
  #maxOutputBytes: number;
  #maxHeapBytes: number;

  constructor(options: MachineOptions = {}) {
    this.#stdin = options.stdin ?? new Uint8Array(0);
    this.#maxInstructions = options.maxInstructions ?? DEFAULT_MAX_INSTRUCTIONS;
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.#maxHeapBytes = options.maxHeapBytes ?? DEFAULT_MAX_HEAP_BYTES;
  }

  get instructionsExecuted(): number {
    return this.#instructions;
  }

  setBreak(address: bigint): void {
    this.#break = address;
    this.#heapStart = address;
  }

  // -- register file --------------------------------------------------------

  read(index: number, size: number, high8 = false): bigint {
    const slot = physicalRegister(index, high8);
    const full = this.registers[slot];
    if (high8) return (full >> 8n) & 0xffn;
    return full & MASKS[size];
  }

  write(index: number, size: number, value: bigint, high8 = false): void {
    if (high8) {
      const slot = physicalRegister(index, true);
      this.registers[slot] = (this.registers[slot] & ~0xff00n) | ((value & 0xffn) << 8n);
      return;
    }
    if (size === 8) {
      this.registers[index] = value & U64;
      return;
    }
    if (size === 4) {
      // Writing a 32-bit register clears the upper half. This is the one
      // surprise x86-64 keeps for people who learned 32-bit assembly, and
      // getting it wrong makes `xor eax, eax` stop working as `xor rax, rax`.
      this.registers[index] = value & 0xffff_ffffn;
      return;
    }
    const mask = MASKS[size];
    this.registers[index] = (this.registers[index] & ~mask) | (value & mask);
  }

  // -- operands -------------------------------------------------------------

  #effectiveAddress(operand: Extract<DecodedOperand, { kind: "memory" }>, nextRip: bigint): bigint {
    let address = operand.displacement;
    if (operand.ripRelative) address += nextRip;
    if (operand.base !== null) address += this.registers[operand.base];
    if (operand.index !== null) address += this.registers[operand.index] * BigInt(operand.scale);
    return address & U64;
  }

  #readOperand(operand: DecodedOperand, nextRip: bigint): bigint {
    switch (operand.kind) {
      case "register":
        return this.read(operand.index, operand.size, operand.high8);
      case "immediate":
        return operand.value;
      case "memory":
        return this.memory.read(this.#effectiveAddress(operand, nextRip), operand.size);
      case "relative":
        return nextRip + operand.offset;
    }
  }

  #writeOperand(operand: DecodedOperand, nextRip: bigint, value: bigint): void {
    switch (operand.kind) {
      case "register":
        this.write(operand.index, operand.size, value, operand.high8);
        return;
      case "memory":
        this.memory.write(this.#effectiveAddress(operand, nextRip), operand.size, value);
        return;
      default:
        throw new Halt({
          kind: "fault",
          message: "This instruction cannot store into that operand",
        });
    }
  }

  // -- flags ----------------------------------------------------------------

  #setLogicFlags(result: bigint, size: number): void {
    const masked = result & MASKS[size];
    this.flags.carry = false;
    this.flags.overflow = false;
    this.flags.zero = masked === 0n;
    this.flags.sign = signBit(masked, size);
    this.flags.parity = parityOf(masked);
    this.flags.adjust = false;
  }

  #setArithmeticFlags(
    left: bigint,
    right: bigint,
    full: bigint,
    size: number,
    isSubtraction: boolean,
  ): bigint {
    const mask = MASKS[size];
    const result = full & mask;
    this.flags.zero = result === 0n;
    this.flags.sign = signBit(result, size);
    this.flags.parity = parityOf(result);
    this.flags.adjust = ((left ^ right ^ result) & 0x10n) !== 0n;
    this.flags.carry = isSubtraction ? full < 0n : full > mask;

    const leftSign = signBit(left & mask, size);
    const rightSign = signBit(right & mask, size);
    const resultSign = signBit(result, size);
    this.flags.overflow = isSubtraction
      ? leftSign !== rightSign && resultSign !== leftSign
      : leftSign === rightSign && resultSign !== leftSign;

    return result;
  }

  #condition(code: number): boolean {
    const { carry, zero, sign, overflow, parity } = this.flags;
    switch (code) {
      case 0x0:
        return overflow;
      case 0x1:
        return !overflow;
      case 0x2:
        return carry;
      case 0x3:
        return !carry;
      case 0x4:
        return zero;
      case 0x5:
        return !zero;
      case 0x6:
        return carry || zero;
      case 0x7:
        return !carry && !zero;
      case 0x8:
        return sign;
      case 0x9:
        return !sign;
      case 0xa:
        return parity;
      case 0xb:
        return !parity;
      case 0xc:
        return sign !== overflow;
      case 0xd:
        return sign === overflow;
      case 0xe:
        return zero || sign !== overflow;
      default:
        return !zero && sign === overflow;
    }
  }

  // -- stack ----------------------------------------------------------------

  #push(value: bigint): void {
    const rsp = (this.registers[RSP] - 8n) & U64;
    this.registers[RSP] = rsp;
    this.memory.write(rsp, 8, value);
  }

  #pop(): bigint {
    const rsp = this.registers[RSP];
    const value = this.memory.read(rsp, 8);
    this.registers[RSP] = (rsp + 8n) & U64;
    return value;
  }

  // -- the loop -------------------------------------------------------------

  /** Run until the program exits or a limit is hit. */
  run(): StopReason {
    for (;;) {
      const reason = this.runSlice(Number.POSITIVE_INFINITY);
      if (reason) return reason;
    }
  }

  /**
   * Run at most `budget` instructions, answering `null` when the program is
   * still going.
   *
   * The runner in the page calls this in slices and yields between them. A tight
   * loop counting to ten million is a perfectly reasonable thing for a learner
   * to write, and running it straight through would freeze the tab until it
   * finished — which also means the Stop button could never be pressed. Slicing
   * costs nothing and makes cancelling real.
   */
  runSlice(budget: number): StopReason | null {
    for (let executed = 0; executed < budget; executed += 1) {
      if (this.#instructions >= this.#maxInstructions) {
        return { kind: "instruction-limit" };
      }
      try {
        this.step();
      } catch (cause) {
        if (cause instanceof Halt) return cause.reason;
        // Only the three ways *the program* can be wrong become a fault. An
        // error from anywhere else is a bug in this runner, and reporting it as
        // the learner's fault would both mislead them and hide it from us.
        if (cause instanceof MemoryFault || cause instanceof AsmDecodeError) {
          return { kind: "fault", message: cause.message };
        }
        throw cause;
      }
    }
    return null;
  }

  /** Execute exactly one instruction. Throws `Halt` when the program stops. */
  step(): DecodedInstruction {
    // 15 bytes is the architectural maximum length of an x86 instruction.
    const window = this.memory.readCode(this.rip, 15);
    const decoded = this.#decode(window);
    const nextRip = (this.rip + BigInt(decoded.length)) & U64;
    this.#instructions += 1;
    this.#execute(decoded, nextRip);
    return decoded;
  }

  #decode(window: Uint8Array): DecodedInstruction {
    try {
      return decodeInstruction(window, 0, this.rip);
    } catch (cause) {
      // The window is exactly the architectural maximum, so a decoder that asks
      // for a sixteenth byte has not run out of *code* — it is looking at bytes
      // no processor would accept as one instruction. Its own reader says "ran
      // off the end of the code", which describes this buffer, not the program.
      if (cause instanceof RangeError) {
        throw new Halt({
          kind: "fault",
          message: `The bytes at 0x${this.rip.toString(16)} are not an instruction — no x86 instruction is longer than the 15 bytes read here`,
        });
      }
      throw cause;
    }
  }

  #execute(decoded: DecodedInstruction, nextRip: bigint): void {
    const { mnemonic, operands, operandSize: size } = decoded;
    const mask = MASKS[size];
    let branched = false;

    const readAt = (position: number): bigint => this.#readOperand(operands[position], nextRip);
    const writeAt = (position: number, value: bigint): void =>
      this.#writeOperand(operands[position], nextRip, value);
    const width = (position: number): number => {
      const operand = operands[position];
      if (operand.kind === "register" || operand.kind === "memory") return operand.size;
      return size;
    };

    switch (mnemonic) {
      case "mov":
        writeAt(0, readAt(1));
        break;

      case "movzx":
        writeAt(0, readAt(1) & MASKS[width(1)]);
        break;

      case "movsx":
      case "movsxd":
        writeAt(0, toSigned(readAt(1), width(1)) & mask);
        break;

      case "lea": {
        const source = operands[1];
        if (source.kind !== "memory")
          throw new Halt({ kind: "fault", message: "lea needs an address" });
        writeAt(0, this.#effectiveAddress(source, nextRip) & mask);
        break;
      }

      case "xchg": {
        const left = readAt(0);
        const right = readAt(1);
        writeAt(0, right);
        writeAt(1, left);
        break;
      }

      case "add":
      case "adc":
      case "sub":
      case "sbb":
      case "cmp": {
        const left = readAt(0);
        const right = readAt(1) & mask;
        const borrow = mnemonic === "adc" || mnemonic === "sbb" ? (this.flags.carry ? 1n : 0n) : 0n;
        const isSubtraction = mnemonic === "sub" || mnemonic === "sbb" || mnemonic === "cmp";
        const full = isSubtraction ? left - right - borrow : left + right + borrow;
        const result = this.#setArithmeticFlags(left, right, full, size, isSubtraction);
        if (mnemonic !== "cmp") writeAt(0, result);
        break;
      }

      case "inc":
      case "dec": {
        // inc and dec deliberately leave the carry flag alone, so a loop can
        // count with them without disturbing an addition in progress.
        const carry = this.flags.carry;
        const left = readAt(0);
        const full = mnemonic === "inc" ? left + 1n : left - 1n;
        const result = this.#setArithmeticFlags(left, 1n, full, size, mnemonic === "dec");
        this.flags.carry = carry;
        writeAt(0, result);
        break;
      }

      case "neg": {
        const value = readAt(0);
        const full = 0n - value;
        const result = this.#setArithmeticFlags(0n, value, full, size, true);
        this.flags.carry = (value & mask) !== 0n;
        writeAt(0, result);
        break;
      }

      case "not":
        writeAt(0, ~readAt(0) & mask);
        break;

      case "and":
      case "or":
      case "xor":
      case "test": {
        const left = readAt(0);
        const right = readAt(1) & mask;
        const result =
          mnemonic === "or" ? left | right : mnemonic === "xor" ? left ^ right : left & right;
        this.#setLogicFlags(result, size);
        if (mnemonic !== "test") writeAt(0, result & mask);
        break;
      }

      case "imul": {
        if (operands.length === 1) {
          const left = toSigned(this.read(RAX, size), size);
          const right = toSigned(readAt(0), size);
          const product = left * right;
          const low = product & mask;
          if (size === 1) {
            this.write(RAX, 2, product & 0xffffn);
          } else {
            this.write(RAX, size, low);
            this.write(RDX, size, (product >> BigInt(size * 8)) & mask);
          }
          const fits = toSigned(low, size) === product;
          this.flags.carry = !fits;
          this.flags.overflow = !fits;
          break;
        }
        const left = toSigned(readAt(operands.length === 3 ? 1 : 0), size);
        const right = toSigned(readAt(operands.length === 3 ? 2 : 1), size);
        const product = left * right;
        const low = product & mask;
        writeAt(0, low);
        const fits = toSigned(low, size) === product;
        this.flags.carry = !fits;
        this.flags.overflow = !fits;
        this.flags.zero = low === 0n;
        this.flags.sign = signBit(low, size);
        this.flags.parity = parityOf(low);
        break;
      }

      case "mul": {
        const left = this.read(RAX, size);
        const right = readAt(0) & mask;
        const product = left * right;
        if (size === 1) {
          this.write(RAX, 2, product & 0xffffn);
        } else {
          this.write(RAX, size, product & mask);
          this.write(RDX, size, (product >> BigInt(size * 8)) & mask);
        }
        const high = product >> BigInt(size * 8);
        this.flags.carry = high !== 0n;
        this.flags.overflow = high !== 0n;
        break;
      }

      case "div":
      case "idiv": {
        const divisor = readAt(0) & mask;
        if (divisor === 0n) {
          throw new Halt({
            kind: "fault",
            message: "The program divided by zero",
          });
        }
        const bits = BigInt(size * 8);
        // The dividend is twice the operand's width — rdx:rax, or just ax for
        // the byte form. It is assembled here rather than masked through
        // MASKS, which only knows the four real operand widths: a 64-bit
        // divide reads a 128-bit dividend, and there is no mask for that.
        const dividendBits = size === 1 ? 16n : bits * 2n;
        const rawDividend =
          size === 1 ? this.read(RAX, 2) : (this.read(RDX, size) << bits) | this.read(RAX, size);

        // The byte form answers in one register: quotient in al, remainder in
        // ah. Everything wider answers in rax and rdx.
        const store = (quotient: bigint, remainder: bigint): void => {
          if (size === 1) {
            this.write(RAX, 1, quotient & 0xffn);
            this.write(AH, 1, remainder & 0xffn, true);
          } else {
            this.write(RAX, size, quotient & mask);
            this.write(RDX, size, remainder & mask);
          }
        };

        if (mnemonic === "div") {
          const quotient = rawDividend / divisor;
          if (quotient > mask) {
            throw new Halt({
              kind: "fault",
              message: "The result of this division is too large to fit in the register",
            });
          }
          store(quotient, rawDividend % divisor);
        } else {
          const signBit = 1n << (dividendBits - 1n);
          const dividend =
            (rawDividend & signBit) !== 0n ? rawDividend - (1n << dividendBits) : rawDividend;
          const signedDivisor = toSigned(divisor, size);
          // BigInt division truncates toward zero, which is what idiv does.
          const quotient = dividend / signedDivisor;
          const limit = 1n << (bits - 1n);
          if (quotient >= limit || quotient < -limit) {
            throw new Halt({
              kind: "fault",
              message: "The result of this division is too large to fit in the register",
            });
          }
          store(quotient, dividend % signedDivisor);
        }
        break;
      }

      case "shl":
      case "shr":
      case "sar":
      case "rol":
      case "ror": {
        const countMask = size === 8 ? 0x3fn : 0x1fn;
        const count = readAt(1) & countMask;
        if (count === 0n) break;
        const value = readAt(0) & mask;
        const bits = BigInt(size * 8);
        let result: bigint;
        let carry: boolean;
        if (mnemonic === "shl") {
          result = (value << count) & mask;
          carry = ((value >> (bits - count)) & 1n) === 1n;
          this.flags.overflow = signBit(result, size) !== carry;
        } else if (mnemonic === "shr") {
          result = value >> count;
          carry = ((value >> (count - 1n)) & 1n) === 1n;
          this.flags.overflow = signBit(value, size);
        } else if (mnemonic === "sar") {
          const signed = toSigned(value, size);
          result = (signed >> count) & mask;
          carry = ((signed >> (count - 1n)) & 1n) === 1n;
          this.flags.overflow = false;
        } else {
          const rotation = count % bits;
          // A rotation of exactly the width is the identity, and shifting by
          // `bits` is not — so the no-op is taken rather than computed.
          result =
            rotation === 0n
              ? value
              : mnemonic === "rol"
                ? ((value << rotation) | (value >> (bits - rotation))) & mask
                : ((value >> rotation) | (value << (bits - rotation))) & mask;
          carry = mnemonic === "rol" ? (result & 1n) === 1n : signBit(result, size);
          // The two rotates do not share an overflow rule. After ROL it is the
          // top bit exclusive-or the carry — which is the bit that just wrapped
          // around to the bottom. After ROR it is the top two bits of the
          // result compared with each other. Using the ROR rule for both makes
          // `rol` report the wrong overflow on the one count the architecture
          // actually defines it for.
          this.flags.overflow =
            mnemonic === "rol"
              ? signBit(result, size) !== carry
              : signBit(result, size) !== (((result >> (bits - 2n)) & 1n) === 1n);
        }
        writeAt(0, result);
        this.flags.carry = carry;
        if (mnemonic === "shl" || mnemonic === "shr" || mnemonic === "sar") {
          this.flags.zero = result === 0n;
          this.flags.sign = signBit(result, size);
          this.flags.parity = parityOf(result);
        }
        break;
      }

      case "push":
        this.#push(readAt(0) & U64);
        break;

      case "pop":
        writeAt(0, this.#pop());
        break;

      case "call": {
        const target = readAt(0) & U64;
        this.#push(nextRip);
        this.rip = target;
        branched = true;
        break;
      }

      case "ret":
        this.rip = this.#pop();
        branched = true;
        break;

      case "leave":
        this.registers[RSP] = this.registers[RBP];
        this.registers[RBP] = this.#pop();
        break;

      case "jmp":
        this.rip = readAt(0) & U64;
        branched = true;
        break;

      case "loop":
      case "loope":
      case "loopne": {
        const counter = (this.registers[RCX] - 1n) & U64;
        this.registers[RCX] = counter;
        const keepGoing =
          counter !== 0n &&
          (mnemonic === "loop" || (mnemonic === "loope" ? this.flags.zero : !this.flags.zero));
        if (keepGoing) {
          this.rip = readAt(0) & U64;
          branched = true;
        }
        break;
      }

      case "cbw":
        this.write(RAX, 2, toSigned(this.read(RAX, 1), 1) & 0xffffn);
        break;
      case "cwde":
        this.write(RAX, 4, toSigned(this.read(RAX, 2), 2) & 0xffff_ffffn);
        break;
      case "cdqe":
        this.write(RAX, 8, toSigned(this.read(RAX, 4), 4) & U64);
        break;
      case "cwd":
        this.write(RDX, 2, signBit(this.read(RAX, 2), 2) ? 0xffffn : 0n);
        break;
      case "cdq":
        this.write(RDX, 4, signBit(this.read(RAX, 4), 4) ? 0xffff_ffffn : 0n);
        break;
      case "cqo":
        this.write(RDX, 8, signBit(this.read(RAX, 8), 8) ? U64 : 0n);
        break;

      case "nop":
        break;

      case "hlt":
        throw new Halt({
          kind: "fault",
          message: "The program ran hlt, which only the operating system may do",
        });

      case "int3":
        throw new Halt({
          kind: "fault",
          message: "The program hit a breakpoint instruction (int3)",
        });

      case "syscall":
        this.#syscall();
        break;

      default: {
        if (mnemonic.startsWith("set")) {
          const code = CONDITION_BY_NAME.get(mnemonic.slice(3));
          if (code === undefined) break;
          writeAt(0, this.#condition(code) ? 1n : 0n);
          break;
        }
        if (mnemonic.startsWith("cmov")) {
          const code = CONDITION_BY_NAME.get(mnemonic.slice(4));
          if (code === undefined) break;
          if (this.#condition(code)) writeAt(0, readAt(1));
          else if (width(0) === 4) writeAt(0, readAt(0));
          break;
        }
        if (mnemonic.startsWith("j")) {
          const code = CONDITION_BY_NAME.get(mnemonic.slice(1));
          if (code === undefined) {
            throw new Halt({ kind: "fault", message: `Unhandled instruction ${mnemonic}` });
          }
          if (this.#condition(code)) {
            this.rip = readAt(0) & U64;
            branched = true;
          }
          break;
        }
        throw new Halt({ kind: "fault", message: `Unhandled instruction ${mnemonic}` });
      }
    }

    if (!branched) this.rip = nextRip;
  }

  // -- the kernel, such as it is -------------------------------------------

  /**
   * The Linux system-call interface, cut down to what a program with no libc
   * actually uses. The register convention is the real one: the number in
   * `rax`, arguments in `rdi`, `rsi`, `rdx`, `r10`, `r8`, `r9`, and the result
   * back in `rax` — a negative value being the error number, as Linux returns
   * it.
   *
   * A syscall this does not implement stops the program by name rather than
   * returning -ENOSYS, because a lesson is better served by "this runner has no
   * `open`" than by a program that silently takes an error path.
   *
   * One divergence from hardware to know about: a real `syscall` destroys `rcx`
   * and `r11` (the return address and the flags go there, which is the whole
   * reason the fourth argument is `r10` and not `rcx`). This one leaves them
   * alone, so a counter kept in `rcx` across a `write` survives here and does
   * not survive on a real Linux machine.
   */
  #syscall(): void {
    const number = this.registers[RAX];
    const arg0 = this.registers[RDI];
    const arg1 = this.registers[RSI];
    const arg2 = this.registers[RDX];

    switch (number) {
      case 0n: {
        // read(fd, buf, count)
        if (arg0 !== 0n) {
          this.registers[RAX] = -9n & U64;
          return;
        }
        const wanted = Number(arg2);
        const available = Math.max(0, Math.min(wanted, this.#stdin.length - this.#stdinPosition));
        const slice = this.#stdin.subarray(this.#stdinPosition, this.#stdinPosition + available);
        this.memory.writeBytes(arg1, slice);
        this.#stdinPosition += available;
        this.registers[RAX] = BigInt(available);
        return;
      }

      case 1n: {
        // write(fd, buf, count)
        if (arg0 !== 1n && arg0 !== 2n) {
          this.registers[RAX] = -9n & U64;
          return;
        }
        const length = Number(arg2);
        // A single count larger than everything the runner will ever hold is
        // not a length anyone meant to write — it is a stale pointer or a
        // subtraction done backwards in rdx. The output limit below would call
        // that a runaway printing loop, which sends the reader looking for a
        // loop that is not there.
        if (length > this.#maxOutputBytes) {
          throw new Halt({
            kind: "fault",
            message: `The program asked write for ${length.toLocaleString("en-US")} bytes, which is not a length it could have meant — check what is in rdx`,
          });
        }
        const sink = arg0 === 1n ? this.stdout : this.stderr;
        if (this.stdout.length + this.stderr.length + length > this.#maxOutputBytes) {
          throw new Halt({ kind: "output-limit" });
        }
        const bytes = this.memory.readBytes(arg1, length);
        for (const byte of bytes) sink.push(byte);
        this.registers[RAX] = BigInt(length);
        return;
      }

      case 12n: {
        // brk(addr) — returns the new break, or the current one when asked for
        // something below it, which is how a program discovers where it is.
        if (arg0 === 0n || arg0 < this.#break) {
          this.registers[RAX] = this.#break;
          return;
        }
        // Two ceilings, and the second is the one that matters: a single call
        // may not jump more than 4 MiB, and the heap as a whole may not pass
        // #maxHeapBytes above where it started. Without the total, a loop of
        // individually reasonable requests grows real memory thousands of times
        // faster than it burns the instruction budget.
        const perCall = this.#break + 0x40_0000n;
        const ceiling = this.#heapStart + BigInt(this.#maxHeapBytes);
        if (arg0 > perCall || arg0 > ceiling) {
          this.registers[RAX] = this.#break;
          return;
        }
        this.memory.map(this.#break, arg0 - this.#break, "rw");
        this.#break = arg0;
        this.registers[RAX] = this.#break;
        return;
      }

      case 39n:
        // getpid — a fixed number, because a lesson that prints it should print
        // the same thing every time it is replayed.
        this.registers[RAX] = 1n;
        return;

      case 60n:
      case 231n:
        throw new Halt({ kind: "exited", code: Number(arg0 & 0xffn) });

      default:
        throw new Halt({
          kind: "fault",
          message:
            `The program asked for system call ${number}, which this runner does not have. ` +
            `It has read (0), write (1), brk (12), getpid (39) and exit (60).`,
        });
    }
  }

  /** A snapshot of the register file, for the runner's register view. */
  snapshotRegisters(): { name: string; value: bigint }[] {
    return REGISTERS_64.map((name, index) => ({ name, value: this.registers[index] }));
  }
}
