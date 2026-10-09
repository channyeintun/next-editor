/**
 * Machine-code emission: one parsed instruction in, the bytes a real x86-64
 * processor would accept out.
 *
 * The encoder never chooses arbitrarily. When several forms in `isa.ts` could
 * express the same instruction it assembles all of them and keeps the
 * shortest, which is what NASM does and why `add rax, 1` is three bytes rather
 * than seven. The shortest form is often not unique — `mov rax, rbx` is three
 * bytes as either `48 89 d8` or `48 8b c3` — so a tie goes to whichever form
 * `isa.ts` declares first, which is the one NASM emits. `formsFor` preserves
 * declaration order and the sort below is stable, and that pair is what keeps
 * the output stable: the same source always produces the same bytes and a
 * recorded lesson stays byte-identical.
 *
 * Two constraints in the instruction format cause almost every real bug in an
 * encoder, so both are enforced rather than assumed:
 *
 *   * `ah`, `ch`, `dh` and `bh` cannot appear in an instruction that carries a
 *     REX prefix, because REX redefines those four ModRM encodings to mean
 *     `spl`, `bpl`, `sil` and `dil`. Writing `mov ah, r8b` is not a long
 *     instruction — it is not an instruction.
 *   * `rsp` can never be a scaled index, because the index field's value 4
 *     means "no index". The parser owns that rule: it folds an address into
 *     base and index and either swaps `rsp` into the base slot or rejects it.
 *     The check here re-asserts the invariant for a caller that hands
 *     `encodeInstruction` a `MemoryOperand` it built itself, and catches the
 *     one shape the parser's swap cannot fix — `[rsp+rsp]`, where both slots
 *     hold `rsp` and swapping them changes nothing.
 */

import { AsmEncodeError } from "./errors";
import type { InstructionStatement, MemoryOperand, Operand } from "./parser";
import {
  formsFor,
  isKnownMnemonic,
  KNOWN_MNEMONICS,
  type InstructionForm,
  type OperandPattern,
} from "./isa";
import { forbidsRex, requiresRex, type OperandSize } from "./registers";

/** Resolved operand values, supplied by the assembler once symbols are known. */
export interface ResolvedOperands {
  /**
   * Immediate values, indexed by operand position. A relative branch's
   * absolute target is the value of its operand 0.
   */
  immediates: Map<number, bigint>;
  /** Memory displacements, indexed by operand position. */
  displacements: Map<number, bigint>;
}

export interface EncodeRequest {
  statement: InstructionStatement;
  /** Address this instruction will be placed at. */
  address: bigint;
  resolved: ResolvedOperands;
  /**
   * Minimum branch-displacement width to consider, in bytes. The first layout
   * pass runs with this at 4, so every branch that has a long form starts in
   * it; the assembler drops it to 1 from the second pass on, where a branch
   * takes the shortest form that reaches. A branch with no long form ignores it
   * — see `isShortOnlyBranch`. `assembler.ts`'s header describes the loop.
   */
  minimumRelBytes: 1 | 4;
}

export interface EncodedInstruction {
  bytes: number[];
}

function fitsSigned(value: bigint, bytes: number): boolean {
  const bits = BigInt(bytes * 8 - 1);
  return value >= -(1n << bits) && value < 1n << bits;
}

function fitsUnsigned(value: bigint, bytes: number): boolean {
  return value >= 0n && value < 1n << BigInt(bytes * 8);
}

/**
 * Whether an immediate can be written in `bytes` bytes.
 *
 * Both signed and unsigned readings are accepted, because assembly programmers
 * write both: `mov al, 0xff` means the bit pattern, and `mov al, -1` means the
 * same bit pattern by another name.
 */
export function immediateFits(value: bigint, bytes: number): boolean {
  return fitsSigned(value, bytes) || fitsUnsigned(value, bytes);
}

export function encodeLittleEndian(value: bigint, bytes: number): number[] {
  const out: number[] = [];
  let remaining = value & ((1n << BigInt(bytes * 8)) - 1n);
  for (let index = 0; index < bytes; index += 1) {
    out.push(Number(remaining & 0xffn));
    remaining >>= 8n;
  }
  return out;
}

/**
 * Whether an instruction needs a REX prefix: one of its W, R, X or B bits is
 * set, or it names `spl`, `bpl`, `sil` or `dil`, which only exist with one.
 */
function needsRexPrefix(w: number, r: number, x: number, b: number, forceRex: boolean): boolean {
  return w === 1 || r === 1 || x === 1 || b === 1 || forceRex;
}

/** The displacement width of a branch form, or null for any other form. */
function relWidth(form: InstructionForm): 1 | 4 | null {
  const first = form.operands[0];
  return form.encoding === "D" && first?.k === "rel" ? first.size : null;
}

function patternMatches(
  pattern: OperandPattern,
  operand: Operand,
  resolved: ResolvedOperands,
  position: number,
): boolean {
  switch (pattern.k) {
    case "reg":
      return operand.kind === "register" && operand.register.size === pattern.size;
    case "rm":
      if (operand.kind === "register") return operand.register.size === pattern.size;
      if (operand.kind === "memory") return operand.size === null || operand.size === pattern.size;
      return false;
    case "mem":
      return operand.kind === "memory";
    case "imm": {
      if (operand.kind !== "immediate") return false;
      const value = resolved.immediates.get(position);
      if (value === undefined) return false;
      const bytes = pattern.size;
      return pattern.signExtended ? fitsSigned(value, bytes) : immediateFits(value, bytes);
    }
    case "rel":
      return operand.kind === "immediate";
    case "fixed": {
      if (operand.kind !== "register") return false;
      return operand.register.name.toLowerCase() === pattern.name;
    }
    case "one":
      return operand.kind === "immediate" && resolved.immediates.get(position) === 1n;
    default:
      return false;
  }
}

interface ModRmBytes {
  bytes: number[];
  rexR: number;
  rexX: number;
  rexB: number;
}

function encodeModRm(
  regField: number,
  rm: Operand,
  displacement: bigint,
  address: bigint,
  bytesOutsideModRm: number,
  error: (message: string) => AsmEncodeError,
): ModRmBytes {
  const reg = regField & 7;
  const rexR = (regField >> 3) & 1;

  if (rm.kind === "register") {
    return {
      bytes: [0xc0 | (reg << 3) | (rm.register.index & 7)],
      rexR,
      rexX: 0,
      rexB: (rm.register.index >> 3) & 1,
    };
  }

  if (rm.kind !== "memory") {
    throw error("This operand has to be a register or a memory address");
  }

  const memory = rm as MemoryOperand;

  if (memory.ripRelative) {
    // A rip-relative displacement is measured from the *next* instruction, so
    // the whole instruction counts: everything outside this ModRM group, plus
    // the ModRM byte and the four displacement bytes emitted right here.
    const relative = displacement - (address + BigInt(bytesOutsideModRm + 5));
    if (!fitsSigned(relative, 4)) {
      throw error("This address is too far away for a rip-relative reference");
    }
    return {
      bytes: [0x00 | (reg << 3) | 5, ...encodeLittleEndian(relative, 4)],
      rexR,
      rexX: 0,
      rexB: 0,
    };
  }

  const base = memory.base;
  const index = memory.index;

  if (index && (index.name === "rsp" || index.name === "esp")) {
    throw error("rsp cannot be a scaled index register");
  }

  // No registers at all: a bare absolute address, which needs the SIB escape.
  // The disp32 it carries is *sign-extended* to 64 bits by the machine, so
  // 0x80000000 would address 0xffffffff80000000 — a different address than the
  // one written. Only the signed range can be said here.
  if (!base && !index) {
    if (!fitsSigned(displacement, 4)) {
      throw error("An absolute address has to fit in a signed 32-bit displacement");
    }
    return {
      bytes: [
        0x00 | (reg << 3) | 4,
        (0 << 6) | (4 << 3) | 5,
        ...encodeLittleEndian(displacement, 4),
      ],
      rexR,
      rexX: 0,
      rexB: 0,
    };
  }

  const needsSib = index !== null || (base !== null && (base.index & 7) === 4) || base === null;
  const baseIsRbpLike = base !== null && (base.index & 7) === 5;

  let mod: number;
  let displacementBytes: number[];
  if (base === null) {
    // Index with no base is always mod=00 with a disp32 in the SIB form, and
    // that disp32 is sign-extended like every other one.
    if (!fitsSigned(displacement, 4)) {
      throw error("A displacement has to fit in a signed 32-bit field");
    }
    mod = 0;
    displacementBytes = encodeLittleEndian(displacement, 4);
  } else if (displacement === 0n && !baseIsRbpLike) {
    mod = 0;
    displacementBytes = [];
  } else if (fitsSigned(displacement, 1)) {
    mod = 1;
    displacementBytes = encodeLittleEndian(displacement, 1);
  } else if (fitsSigned(displacement, 4)) {
    mod = 2;
    displacementBytes = encodeLittleEndian(displacement, 4);
  } else {
    throw error("A displacement has to fit in a signed 32-bit field");
  }

  if (!needsSib) {
    return {
      bytes: [(mod << 6) | (reg << 3) | (base!.index & 7), ...displacementBytes],
      rexR,
      rexX: 0,
      rexB: (base!.index >> 3) & 1,
    };
  }

  const scaleBits = { 1: 0, 2: 1, 4: 2, 8: 3 }[memory.scale];
  const sibIndex = index ? index.index & 7 : 4;
  const sibBase = base ? base.index & 7 : 5;

  return {
    bytes: [
      (mod << 6) | (reg << 3) | 4,
      (scaleBits << 6) | (sibIndex << 3) | sibBase,
      ...displacementBytes,
    ],
    rexR,
    rexX: index ? (index.index >> 3) & 1 : 0,
    rexB: base ? (base.index >> 3) & 1 : 0,
  };
}

/**
 * Edit distance that counts a swap of two adjacent characters as one edit.
 *
 * The typo a learner actually makes is `mvo` for `mov`, and plain Levenshtein
 * scores that transposition the same as two unrelated substitutions — far
 * enough away to lose to nothing at all.
 */
function editDistance(typed: string, name: string): number {
  const rows = typed.length + 1;
  const columns = name.length + 1;
  const grid: number[][] = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => 0),
  );
  for (let row = 0; row < rows; row += 1) grid[row][0] = row;
  for (let column = 0; column < columns; column += 1) grid[0][column] = column;
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const substitution = typed[row - 1] === name[column - 1] ? 0 : 1;
      let best = Math.min(
        grid[row - 1][column] + 1,
        grid[row][column - 1] + 1,
        grid[row - 1][column - 1] + substitution,
      );
      if (
        row > 1 &&
        column > 1 &&
        typed[row - 1] === name[column - 2] &&
        typed[row - 2] === name[column - 1]
      ) {
        best = Math.min(best, grid[row - 2][column - 2] + 1);
      }
      grid[row][column] = best;
    }
  }
  return grid[rows - 1][columns - 1];
}

/**
 * The mnemonic a misspelling most likely meant, or null when nothing is close.
 *
 * Naming the nearest mnemonic is only help if it is actually the nearest one: a
 * prefix scan answers `seta` for `see` when `sete` is the word, which sends the
 * learner to a different instruction than the one they were writing.
 */
function suggestMnemonic(typed: string): string | null {
  // Three characters is short enough that two edits reach unrelated names —
  // `rte` is within two of `jae` — so the budget grows with the word.
  const limit = typed.length <= 3 ? 1 : 2;
  let best: string | null = null;
  let bestDistance = limit + 1;
  for (const name of KNOWN_MNEMONICS) {
    // Every edit changes the length by at most one, so a length gap past the
    // budget can never be within it — and a very long token, which nothing
    // stops a source from holding, costs nothing to rule out.
    if (Math.abs(typed.length - name.length) > limit) continue;
    const distance = editDistance(typed, name);
    if (distance > limit) continue;
    // A tie goes to the candidate that starts the way the learner typed:
    // `lae` is `lea`, not `jae`.
    const wins =
      distance < bestDistance ||
      (distance === bestDistance && best !== null && name[0] === typed[0] && best[0] !== typed[0]);
    if (wins) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
}

/** Whether a mnemonic has a branch form with a four-byte displacement. */
function hasLongBranchForm(mnemonic: string): boolean {
  return formsFor(mnemonic).some((form) => relWidth(form) === 4);
}

/**
 * Why a branch cannot reach its target, said about the instruction rather than
 * about the form that was tried.
 *
 * A short form that does not reach simply loses to the long one, so this only
 * reaches a learner when every form failed — and then the reach worth quoting
 * is the mnemonic's longest, whichever form happened to complain first.
 */
function outOfReach(mnemonic: string, relative: bigint): string {
  const distance = relative < 0n ? `${-relative} bytes back` : `${relative} bytes ahead`;
  const message = `This target is out of reach — it is ${distance}, and ${mnemonic} reaches only`;
  if (hasLongBranchForm(mnemonic)) return `${message} about 2 GB either way`;
  // `loope` and `loopne` also test ZF, so the rewrite is only this simple for
  // plain `loop`.
  const hint =
    mnemonic.toLowerCase() === "loop"
      ? " — for a longer loop, count down with dec rcx and jnz"
      : "";
  return `${message} 128 bytes back or 127 ahead${hint}`;
}

/**
 * Whether a mnemonic is a branch with a one-byte displacement and nothing else.
 *
 * That is `loop`, `loope` and `loopne`: the instruction set gives them no long
 * form, so each is two bytes wherever it sits and a target out of reach is an
 * error rather than a reason to widen. The assembler lays them out at that one
 * length on every pass and judges their reach once the layout has settled.
 */
export function isShortOnlyBranch(mnemonic: string): boolean {
  const forms = formsFor(mnemonic);
  return (
    forms.length > 0 && forms.every((form) => form.encoding === "D") && !hasLongBranchForm(mnemonic)
  );
}

function registersOf(operands: Operand[]) {
  const list = [];
  for (const operand of operands) {
    if (operand.kind === "register") list.push(operand.register);
    if (operand.kind === "memory") {
      if (operand.base) list.push(operand.base);
      if (operand.index) list.push(operand.index);
    }
  }
  return list;
}

/**
 * Assemble one instruction, or throw with a message a learner can act on.
 */
export function encodeInstruction(request: EncodeRequest): EncodedInstruction {
  const { statement, address, resolved, minimumRelBytes } = request;
  const error = (message: string): AsmEncodeError =>
    new AsmEncodeError(message, statement.line, statement.column);

  if (!isKnownMnemonic(statement.mnemonic)) {
    const suggestion = suggestMnemonic(statement.mnemonic.toLowerCase());
    throw error(
      `"${statement.mnemonic}" is not an instruction this runner knows` +
        (suggestion ? ` — did you mean ${suggestion}?` : ""),
    );
  }

  // NASM lets the width be written on either side of the comma: `mov [rax],
  // byte 1` is the same store as `mov byte [rax], 1`. The parser records the
  // keyword on whichever operand carried it, so a memory operand that has none
  // adopts the width a sibling immediate declared, before any form is matched.
  let declaredSize: OperandSize | null = null;
  for (const operand of statement.operands) {
    if (operand.kind === "immediate" && operand.size !== null) {
      declaredSize = operand.size;
      break;
    }
  }
  const sized: InstructionStatement =
    declaredSize === null
      ? statement
      : {
          ...statement,
          operands: statement.operands.map((operand) =>
            operand.kind === "memory" && operand.size === null
              ? { ...operand, size: declaredSize }
              : operand,
          ),
        };

  const candidates = formsFor(sized.mnemonic).filter(
    (form) => form.operands.length === sized.operands.length,
  );

  if (candidates.length === 0) {
    throw error(
      `${statement.mnemonic} does not take ${statement.operands.length} operand${
        statement.operands.length === 1 ? "" : "s"
      } here`,
    );
  }

  const matching = candidates.filter((form) =>
    form.operands.every((pattern, position) =>
      patternMatches(pattern, sized.operands[position], resolved, position),
    ),
  );

  if (matching.length === 0) {
    throw error(
      `${statement.mnemonic} cannot be used with these operands — check the register widths and the size of any number`,
    );
  }

  // `mov [rax], 1` says nothing about how many bytes to store, and neither
  // does `movzx eax, [rsi]`. The question is asked per operand rather than per
  // instruction: what matters is whether the forms still in the running
  // disagree about the width of *this* access. `mov [rax], bl` is unambiguous
  // even though its memory operand carries no size keyword, because only the
  // one-byte form can also accept `bl`.
  sized.operands.forEach((operand, position) => {
    if (operand.kind !== "memory" || operand.size !== null) return;
    const widths = new Set<number>();
    for (const form of matching) {
      const pattern = form.operands[position];
      if (pattern.k === "rm") widths.add(pattern.size);
    }
    if (widths.size > 1) {
      throw error(
        "The size of this memory access is not stated — write byte, word, dword or qword before the bracket",
      );
    }
  });

  // The width floor exists so the first layout pass starts every branch in its
  // long form, which needs a long form to exist. `loop`, `loope` and `loopne`
  // have a one-byte displacement and nothing else — the instruction set offers
  // no long form — and a floor applied to them would discard their only
  // encoding, so it never removes the widest branch form still in the running.
  // A `rel` pattern matches any immediate, so the branch forms in `matching`
  // are either all of the mnemonic's or none of them.
  const widestRel = Math.max(0, ...matching.map((form) => relWidth(form) ?? 0));
  const eligible = matching.filter((form) => {
    const width = relWidth(form);
    return width === null || width >= minimumRelBytes || width === widestRel;
  });

  const encodings: EncodedInstruction[] = [];
  const failures: AsmEncodeError[] = [];
  for (const form of eligible) {
    try {
      encodings.push(encodeWithForm(form, sized, address, resolved, error));
    } catch (cause) {
      if (cause instanceof AsmEncodeError) {
        failures.push(cause);
        continue;
      }
      throw cause;
    }
  }

  // When nothing encoded, the first form's own complaint is almost always the
  // real one — "ah cannot travel with a REX prefix", "this target is out of
  // reach" — and a generic summary would throw that away. The generic message
  // is only for the case where no form said anything useful.
  if (encodings.length === 0) {
    throw (
      failures[0] ??
      error(
        `${statement.mnemonic} cannot be encoded with these operands — a value may be out of range or a jump too far`,
      )
    );
  }

  encodings.sort((left, right) => left.bytes.length - right.bytes.length);
  return encodings[0];
}

function encodeWithForm(
  form: InstructionForm,
  statement: InstructionStatement,
  address: bigint,
  resolved: ResolvedOperands,
  error: (message: string) => AsmEncodeError,
): EncodedInstruction {
  const operands = statement.operands;
  const opsize = form.opsize;
  const usedRegisters = registersOf(operands);

  const prefixes: number[] = [];
  if (opsize === 2) prefixes.push(0x66);

  // `push`/`pop`/`jmp` are 64-bit by default in long mode and must not carry
  // REX.W, which is why their forms declare no `opsize` at all.
  const rexW = opsize === 8 ? 1 : 0;

  let rexR = 0;
  let rexX = 0;
  let rexB = 0;
  const forceRex = usedRegisters.some(requiresRex);
  const hasHighByte = usedRegisters.some(forbidsRex);

  let body: number[] = [];
  const opcode = [...form.opcode];

  const immediatePositions = form.operands
    .map((pattern, position) => ({ pattern, position }))
    .filter(({ pattern }) => pattern.k === "imm");

  const immediateBytes = (): number[] => {
    if (immediatePositions.length === 0) return [];
    const { pattern, position } = immediatePositions[immediatePositions.length - 1];
    const value = resolved.immediates.get(position);
    if (value === undefined) throw error("This value could not be worked out");
    const width = form.immBytes ?? (pattern.k === "imm" ? pattern.size : 4);
    if (pattern.k === "imm" && pattern.signExtended && !fitsSigned(value, width)) {
      throw error(`${value} does not fit in a signed ${width * 8}-bit field`);
    }
    if (!immediateFits(value, width)) {
      throw error(`${value} does not fit in ${width * 8} bits`);
    }
    return encodeLittleEndian(value, width);
  };

  switch (form.encoding) {
    case "ZO":
      break;

    case "I":
      body = immediateBytes();
      break;

    case "D": {
      const relPattern = form.operands[0];
      if (relPattern.k !== "rel") throw error("Internal: D form without a relative operand");
      const target = resolved.immediates.get(0);
      if (target === undefined) throw error("This jump target could not be worked out");
      const length = prefixes.length + opcode.length + relPattern.size;
      const relative = target - (address + BigInt(length));
      if (!fitsSigned(relative, relPattern.size)) {
        throw error(outOfReach(statement.mnemonic, relative));
      }
      body = encodeLittleEndian(relative, relPattern.size);
      break;
    }

    case "O":
    case "OI": {
      const first = operands[0];
      if (first.kind !== "register") throw error("This form needs a register");
      opcode[opcode.length - 1] += first.register.index & 7;
      rexB = (first.register.index >> 3) & 1;
      body = form.encoding === "OI" ? immediateBytes() : [];
      break;
    }

    case "MR":
    case "RM":
    case "MI":
    case "M":
    case "RMI": {
      const isRm = form.encoding === "RM" || form.encoding === "RMI";
      const regOperandIndex = isRm ? 0 : 1;
      const rmOperandIndex = isRm ? 1 : 0;

      let regField: number;
      if (form.ext !== undefined) {
        regField = form.ext;
      } else {
        const registerOperand = operands[regOperandIndex];
        if (registerOperand === undefined || registerOperand.kind !== "register") {
          throw error("This form needs a register operand");
        }
        regField = registerOperand.register.index;
      }

      const rmOperand = operands[rmOperandIndex];
      const displacement =
        rmOperand.kind === "memory" ? (resolved.displacements.get(rmOperandIndex) ?? 0n) : 0n;

      const trailing = immediateBytes();
      // The rip-relative branch below needs the instruction's final length, so
      // the REX decision has to be previewed here. A rip-relative address has
      // no base and no index, so REX.X and REX.B are both zero for it and the
      // only bits still unknown cannot change the answer.
      const previewRex = needsRexPrefix(rexW, (regField >> 3) & 1, 0, 0, forceRex) ? 1 : 0;
      const modrm = encodeModRm(
        regField,
        rmOperand,
        displacement,
        address,
        prefixes.length + previewRex + opcode.length + trailing.length,
        error,
      );
      rexR = modrm.rexR;
      rexX = modrm.rexX;
      rexB = modrm.rexB;
      // A wrong preview would leave the displacement a byte off and the
      // program reading the wrong address, so it is checked, not trusted. A
      // plain Error rather than an AsmEncodeError, so it cannot pass for one
      // form failing and quietly lose to another.
      if (
        rmOperand.kind === "memory" &&
        rmOperand.ripRelative &&
        needsRexPrefix(rexW, rexR, rexX, rexB, forceRex) !== (previewRex === 1)
      ) {
        throw new Error("Internal: the REX preview for a rip-relative operand was wrong");
      }
      body = [...modrm.bytes, ...trailing];
      break;
    }

    default:
      throw error(`Internal: unhandled encoding ${form.encoding}`);
  }

  const needsRex = needsRexPrefix(rexW, rexR, rexX, rexB, forceRex);
  if (needsRex && hasHighByte) {
    throw error(
      "ah, ch, dh and bh cannot be used in the same instruction as a REX prefix — use al, cl, dl or bl",
    );
  }

  // A rip-relative displacement was computed against the previewed REX length
  // above. That preview is exact (and checked) because a rip-relative operand
  // never sets REX.X or REX.B.
  const rexBytes = needsRex ? [0x40 | (rexW << 3) | (rexR << 2) | (rexX << 1) | rexB] : [];
  const bytes = [...prefixes, ...rexBytes, ...opcode, ...body];
  return { bytes };
}
