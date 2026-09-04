/**
 * Source text to a loaded program image.
 *
 * The hard part of an assembler is not encoding — it is that an instruction's
 * length depends on values that depend on lengths. `jmp done` is two bytes if
 * `done` is within 127 bytes and five otherwise, and whether it is within 127
 * bytes depends on how long every instruction in between turned out to be.
 *
 * This resolves that the way assemblers have always resolved it, by laying the
 * program out repeatedly until it stops moving. The first pass assumes the
 * widest form of everything, which is always correct if wasteful. Each pass
 * after it re-encodes with the addresses the previous pass produced, and every
 * address it produces is less than or equal to the one before — code only ever
 * gets shorter, never longer, because shrinking the bytes between a jump and
 * its target can only bring them closer together. A sequence that only
 * decreases and is bounded below has to stop, so the loop terminates.
 *
 * Where it stops is *a* shortest fixed point rather than *the* shortest layout,
 * and the difference is worth stating rather than glossing. Shrinking is judged
 * one instruction at a time against the current addresses, so a forward branch
 * whose distance sits just above the one-byte limit — 128 to 130 bytes for
 * `jmp`, 128 to 131 for a `jcc` — stays long even though it would fit once it
 * and its neighbours shrank together. The bytes are correct and the program
 * runs; it is three or four bytes larger than NASM's for that one case.
 *
 * The addresses themselves imitate what `ld` produces for a static, no-libc
 * program: `.text` at 0x401000, the read-only and writable sections on the
 * pages after it, and the stack at the top of the user address space. A
 * program that prints its own `_start` address prints something that looks
 * exactly like the real thing, because the shape it is copying is the real
 * thing.
 */

import { AsmSyntaxError } from "./lexer";
import { AsmEncodeError, encodeInstruction, type ResolvedOperands } from "./encoder";
import { parse, type Expression, type Statement } from "./parser";

export const TEXT_BASE = 0x401000n;
export const PAGE_SIZE = 0x1000n;
/** The top of the stack, matching a typical Linux placement. */
export const STACK_TOP = 0x7fff_ffff_f000n;
export const STACK_SIZE = 0x10_0000n;

export interface AssembledSegment {
  name: string;
  start: bigint;
  bytes: Uint8Array;
  writable: boolean;
  executable: boolean;
}

export interface ListingRow {
  address: bigint;
  bytes: number[];
  line: number;
}

export interface AssembledProgram {
  entry: bigint;
  segments: AssembledSegment[];
  /** Zero-filled space reserved by `.bss`; nothing is stored for it. */
  bssStart: bigint;
  bssEnd: bigint;
  /** Where a `brk` syscall starts handing out memory. */
  breakStart: bigint;
  symbols: Map<string, bigint>;
  /** One row per emitted instruction or data statement, in address order. */
  listing: ListingRow[];
  /** Source line for each instruction address, for run-time diagnostics. */
  lineForAddress: Map<bigint, number>;
}

export class AsmError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(message);
    this.name = "AsmError";
    this.line = line;
    this.column = column;
  }
}

const SECTION_ORDER = [".text", ".rodata", ".data", ".bss"] as const;
type SectionName = (typeof SECTION_ORDER)[number];

function normalizeSection(name: string, line: number, column: number): SectionName {
  const cleaned = name.startsWith(".") ? name : `.${name}`;
  if ((SECTION_ORDER as readonly string[]).includes(cleaned)) return cleaned as SectionName;
  throw new AsmError(
    `Unknown section "${name}" — this runner has .text, .rodata, .data and .bss`,
    line,
    column,
  );
}

interface Placed {
  statement: Statement;
  section: SectionName;
  address: bigint;
  bytes: number[];
  /** Branch-width floor, raised when a short jump turned out not to reach. */
  minimumRelBytes: 1 | 4;
}

function alignUp(value: bigint, boundary: bigint): bigint {
  if (boundary <= 1n) return value;
  const remainder = value % boundary;
  return remainder === 0n ? value : value + (boundary - remainder);
}

/**
 * A stand-in used before any address is known: large, positive and stable.
 *
 * Large so the first pass reaches for the widest encoding, which every later
 * pass can then shrink. It is deliberately not zero: a placeholder that fit in
 * one byte would make the first pass lay the program out too small, and
 * addresses would have to grow.
 */
const UNKNOWN_SYMBOL = 0x7fff_ffffn;

/** The longest an x86 instruction can be, used as a first-pass placeholder. */
const MAX_INSTRUCTION_BYTES = 15;

/** The largest magnitude an expression may reach; see `evaluate`. */
const VALUE_LIMIT = 1n << 128n;

class SymbolTable {
  #values = new Map<string, bigint>();
  /**
   * Symbols whose value was computed from a placeholder and so is not real yet.
   *
   * Without this an `equ` that reads a symbol defined further down stores
   * 0x7fffffff on the first pass and every later pass reads it back as an
   * ordinary number, so nothing ever notices that the value never arrived.
   */
  #provisional = new Set<string>();

  set(name: string, value: bigint, provisional = false): void {
    this.#values.set(name, value);
    if (provisional) this.#provisional.add(name);
    else this.#provisional.delete(name);
  }

  has(name: string): boolean {
    return this.#values.has(name);
  }

  isProvisional(name: string): boolean {
    return this.#provisional.has(name);
  }

  get(name: string): bigint | undefined {
    return this.#values.get(name);
  }

  entries(): Map<string, bigint> {
    return new Map(this.#values);
  }
}

/**
 * Evaluate an expression against what is known so far.
 *
 * `unresolved` is set when a symbol that exists but has no value yet is read —
 * a forward reference during the first pass. The caller needs to know, because
 * an instruction built on a placeholder must not be reported as an error: `mov
 * al, SIZE` where `SIZE equ 7` appears later would otherwise fail with "cannot
 * be used with these operands", since 0x7fffffff genuinely does not fit in a
 * byte. It is not a mistake in the program, only a value the assembler has not
 * reached yet.
 */
function evaluate(
  expression: Expression,
  symbols: SymbolTable,
  here: bigint,
  sectionStart: bigint,
  declared: ReadonlySet<string>,
  at: { line: number; column: number },
  unresolved?: { used: boolean },
): bigint {
  switch (expression.kind) {
    case "number":
      return expression.value;
    case "here":
      return here;
    case "sectionStart":
      return sectionStart;
    case "symbol": {
      const value = symbols.get(expression.name);
      if (value !== undefined) {
        // A provisional value is a placeholder wearing a symbol's name, so it
        // counts as a forward reference just as an absent one does.
        if (unresolved && symbols.isProvisional(expression.name)) unresolved.used = true;
        return value;
      }
      if (declared.has(expression.name)) {
        if (unresolved) unresolved.used = true;
        return UNKNOWN_SYMBOL;
      }
      throw new AsmError(`"${expression.name}" is not defined anywhere`, at.line, at.column);
    }
    case "unary": {
      const operand = evaluate(
        expression.operand,
        symbols,
        here,
        sectionStart,
        declared,
        at,
        unresolved,
      );
      return expression.operator === "-" ? -operand : operand;
    }
    case "binary": {
      const left = evaluate(expression.left, symbols, here, sectionStart, declared, at, unresolved);
      const right = evaluate(
        expression.right,
        symbols,
        here,
        sectionStart,
        declared,
        at,
        unresolved,
      );
      switch (expression.operator) {
        case "+":
          return bounded(left + right, at);
        case "-":
          return bounded(left - right, at);
        case "*":
          return bounded(left * right, at);
        case "/":
          if (right === 0n) throw new AsmError("Division by zero", at.line, at.column);
          return left / right;
      }
    }
  }
}

/**
 * Keep a value inside a range a machine word could ever care about.
 *
 * Nothing bounds how big a bigint can get, and a short chain of `equ`s that
 * each square the one above it is re-evaluated on every relaxation pass — a
 * dozen lines is enough to spend seconds building a number with millions of
 * digits before the engine gives up with an error that is not a diagnostic.
 */
function bounded(value: bigint, at: { line: number; column: number }): bigint {
  if (value >= VALUE_LIMIT || value <= -VALUE_LIMIT) {
    throw new AsmError(
      "This expression's value is far too large for any instruction to hold",
      at.line,
      at.column,
    );
  }
  return value;
}

/** How much zero-filled space `.bss` may span in total. */
const BSS_LIMIT = 0x100000n;

/**
 * Bound `.bss` as a whole, not one reservation at a time.
 *
 * Nothing stores bytes for `.bss`, but the machine maps a page of memory for
 * every page of it before the first instruction runs, so a hundred lines that
 * each reserve a legal 1 MiB is a hundred megabytes allocated on the page's
 * main thread.
 */
function checkBssSize(cursor: bigint, sectionStart: bigint, at: Statement): void {
  if (cursor - sectionStart > BSS_LIMIT) {
    throw new AsmError("This runner reserves at most 1 MiB in .bss", at.line, at.column);
  }
}

/** Every name a program defines, gathered before anything is laid out. */
function declaredNames(statements: Statement[]): Set<string> {
  const names = new Set<string>();
  for (const statement of statements) {
    if (statement.kind === "label" || statement.kind === "equ") names.add(statement.name);
  }
  return names;
}

const WIDTH_NAMES: Record<number, string> = {
  1: "a byte",
  2: "a word",
  4: "a dword",
  8: "a qword",
};

function fitsWidth(value: bigint, width: number): boolean {
  const bits = BigInt(width * 8);
  // Either spelling is fine: `db 0xff` and `db -1` are both the same byte.
  return value >= -(1n << (bits - 1n)) && value < 1n << bits;
}

function dataBytes(
  statement: Extract<Statement, { kind: "data" }>,
  symbols: SymbolTable,
  address: bigint,
  sectionStart: bigint,
  declared: ReadonlySet<string>,
): number[] {
  const bytes: number[] = [];
  for (const item of statement.items) {
    if (item.kind === "bytes") {
      // A string in `dw`/`dd`/`dq` is still laid down byte by byte, then padded
      // out to a whole unit — the same thing NASM does.
      for (const byte of item.bytes) bytes.push(byte);
      while (bytes.length % statement.width !== 0) bytes.push(0);
      continue;
    }
    // `$` is the start of the line, as in NASM — not how far into the line this
    // item happens to sit, so `msg db 'ab', $ - msg` is 0 and not 2.
    const unresolved = { used: false };
    const value = evaluate(
      item.value,
      symbols,
      address,
      sectionStart,
      declared,
      statement,
      unresolved,
    );
    // A value built on a forward reference is not this pass's business; the
    // check runs for real once every symbol has one, the same way the
    // instruction path defers its own diagnostics.
    if (!unresolved.used && !fitsWidth(value, statement.width)) {
      throw new AsmError(
        `${value} does not fit in ${WIDTH_NAMES[statement.width]}`,
        statement.line,
        statement.column,
      );
    }
    const masked = value & ((1n << BigInt(statement.width * 8)) - 1n);
    for (let index = 0; index < statement.width; index += 1) {
      bytes.push(Number((masked >> BigInt(index * 8)) & 0xffn));
    }
  }
  return bytes;
}

export function assemble(source: string): AssembledProgram {
  let statements: Statement[];
  try {
    statements = parse(source);
  } catch (cause) {
    if (cause instanceof AsmSyntaxError) {
      throw new AsmError(cause.message, cause.line, cause.column);
    }
    throw cause;
  }

  const declared = declaredNames(statements);

  // Assign each statement to a section, keeping source order inside it.
  const placed: Placed[] = [];
  let currentSection: SectionName = ".text";

  for (const statement of statements) {
    if (statement.kind === "section") {
      currentSection = normalizeSection(statement.name, statement.line, statement.column);
      continue;
    }
    // `global` is a linker instruction and there is no linker here; the entry
    // point is found by name below. `default` was consumed by the parser.
    if (statement.kind === "global" || statement.kind === "default") continue;
    if (statement.kind === "reserve" && currentSection !== ".bss") {
      throw new AsmError(
        "resb, resw, resd and resq reserve space and only belong in section .bss",
        statement.line,
        statement.column,
      );
    }
    if (
      currentSection === ".bss" &&
      (statement.kind === "instruction" || statement.kind === "data")
    ) {
      throw new AsmError(
        "section .bss holds reserved space only — put code in .text and initialised data in .data",
        statement.line,
        statement.column,
      );
    }
    placed.push({ statement, section: currentSection, address: 0n, bytes: [], minimumRelBytes: 4 });
  }

  const bySection = new Map<SectionName, Placed[]>();
  for (const section of SECTION_ORDER) {
    bySection.set(
      section,
      placed.filter((entry) => entry.section === section),
    );
  }

  if ((bySection.get(".text") ?? []).every((entry) => entry.statement.kind !== "instruction")) {
    throw new AsmError("This program has no instructions in section .text", 1, 1);
  }

  const symbols = new SymbolTable();
  let sectionStarts = new Map<SectionName, bigint>();
  let bssStart = 0n;
  let bssEnd = 0n;
  let previousSignature = "";

  // The relaxation loop described in the module comment. The bound is a
  // backstop: a layout that only shrinks converges long before this.
  let settled = false;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    let cursor = TEXT_BASE;
    sectionStarts = new Map();

    for (const section of SECTION_ORDER) {
      const entries = bySection.get(section) ?? [];
      // Each section starts on its own page, the way a linker separates
      // permissions. An empty section still gets an address so `$$` is defined.
      cursor = alignUp(cursor, PAGE_SIZE);
      sectionStarts.set(section, cursor);
      const sectionStart = cursor;

      for (const entry of entries) {
        const { statement } = entry;

        if (statement.kind === "label") {
          // Only on the first pass: every later pass redefines every label by
          // design, so checking on all of them would report each one as its own
          // duplicate.
          if (iteration === 0 && symbols.has(statement.name)) {
            throw new AsmError(
              `"${statement.name}" is defined more than once`,
              statement.line,
              statement.column,
            );
          }
          symbols.set(statement.name, cursor);
          entry.address = cursor;
          entry.bytes = [];
          continue;
        }

        if (statement.kind === "equ") {
          if (iteration === 0 && symbols.has(statement.name)) {
            throw new AsmError(
              `"${statement.name}" is defined more than once`,
              statement.line,
              statement.column,
            );
          }
          const unresolved = { used: false };
          symbols.set(
            statement.name,
            evaluate(
              statement.value,
              symbols,
              cursor,
              sectionStart,
              declared,
              statement,
              unresolved,
            ),
            unresolved.used,
          );
          entry.address = cursor;
          entry.bytes = [];
          continue;
        }

        if (statement.kind === "align") {
          const unresolved = { used: false };
          const boundary = evaluate(
            statement.boundary,
            symbols,
            cursor,
            sectionStart,
            declared,
            statement,
            unresolved,
          );
          // Unlike an instruction, a directive that decides where the next byte
          // lands cannot wait for a later pass — every address after it depends
          // on the answer. NASM calls these critical expressions and rejects
          // them the same way.
          if (unresolved.used) {
            throw new AsmError(
              "align needs a boundary the assembler already knows — define it above this line",
              statement.line,
              statement.column,
            );
          }
          if (boundary <= 0n || (boundary & (boundary - 1n)) !== 0n) {
            throw new AsmError("align needs a power of two", statement.line, statement.column);
          }
          if (boundary > PAGE_SIZE) {
            throw new AsmError(
              "align boundaries above 4096 — one page — are not supported here",
              statement.line,
              statement.column,
            );
          }
          const aligned = alignUp(cursor, boundary);
          entry.address = cursor;
          // Padding in .text is `nop`; anywhere else it is zeroes.
          entry.bytes = Array.from({ length: Number(aligned - cursor) }, () =>
            section === ".text" ? 0x90 : 0x00,
          );
          cursor = aligned;
          if (section === ".bss") checkBssSize(cursor, sectionStart, statement);
          continue;
        }

        if (statement.kind === "data") {
          entry.address = cursor;
          entry.bytes = dataBytes(statement, symbols, cursor, sectionStart, declared);
          cursor += BigInt(entry.bytes.length);
          continue;
        }

        if (statement.kind === "reserve") {
          const unresolved = { used: false };
          const count = evaluate(
            statement.count,
            symbols,
            cursor,
            sectionStart,
            declared,
            statement,
            unresolved,
          );
          if (unresolved.used) {
            throw new AsmError(
              "A reservation needs a count the assembler already knows — define it above this line",
              statement.line,
              statement.column,
            );
          }
          if (count < 0n) {
            throw new AsmError(
              "A reservation cannot be negative",
              statement.line,
              statement.column,
            );
          }
          entry.address = cursor;
          entry.bytes = [];
          cursor += count * BigInt(statement.width);
          checkBssSize(cursor, sectionStart, statement);
          continue;
        }

        // Section, global and default statements never reach the layout — they
        // were consumed while grouping — so what is left is an instruction.
        if (statement.kind !== "instruction") continue;

        entry.address = cursor;
        const resolved: ResolvedOperands = {
          immediates: new Map(),
          targets: new Map(),
          displacements: new Map(),
        };

        const unresolved = { used: false };
        statement.operands.forEach((operand, position) => {
          // Diagnostics quote the operand's own position, not the mnemonic's:
          // the caret under `nowhere` in `jmp nowhere` is what names the
          // mistake.
          if (operand.kind === "immediate") {
            const value = evaluate(
              operand.value,
              symbols,
              cursor,
              sectionStart,
              declared,
              operand,
              unresolved,
            );
            resolved.immediates.set(position, value);
            resolved.targets.set(position, value);
          }
          if (operand.kind === "memory") {
            resolved.displacements.set(
              position,
              evaluate(
                operand.displacement,
                symbols,
                cursor,
                sectionStart,
                declared,
                operand,
                unresolved,
              ),
            );
          }
        });

        try {
          const encoded = encodeInstruction({
            statement,
            address: cursor,
            resolved,
            minimumRelBytes: entry.minimumRelBytes,
          });
          entry.bytes = encoded.bytes;
        } catch (cause) {
          if (cause instanceof AsmEncodeError) {
            // A jump that will not reach is not an error yet — it is a request
            // for the wider form on the next pass.
            if (entry.minimumRelBytes === 1) {
              entry.minimumRelBytes = 4;
              entry.bytes = [0, 0, 0, 0, 0, 0];
            } else if (unresolved.used || iteration === 0) {
              // The instruction was built on a placeholder for a symbol defined
              // further down the file. Whether it encodes cannot be judged yet,
              // so it reserves the longest an instruction can be and is asked
              // again next pass, when every symbol has a real value. Reporting
              // it now would blame `mov al, SIZE` for a `SIZE equ 7` that is
              // three lines below it and perfectly valid.
              //
              // The first pass gets the same benefit of the doubt even without a
              // placeholder, because it lays every branch out in its widest form
              // and `loop` has only a short one: a `loop` whose body settles to
              // 90 bytes can measure 130 on the pass that has not shrunk yet.
              // Pass 1 is the smallest layout the program can have and later
              // passes only widen, so a reach failure from then on is real.
              entry.bytes = Array.from({ length: MAX_INSTRUCTION_BYTES }, () => 0x90);
            } else {
              throw new AsmError(cause.message, cause.line, cause.column);
            }
          } else {
            throw cause;
          }
        }

        cursor += BigInt(entry.bytes.length);
      }

      if (section === ".bss") {
        bssStart = sectionStart;
        bssEnd = cursor;
      }
    }

    // Symbol values belong in the signature as much as the bytes do. `a equ b`
    // above `b equ 5` resolves one link per pass, and a pass that only moved a
    // symbol looks identical byte for byte — so without them the loop stops on
    // the pass that finally learned the value and emits the placeholder.
    const signature = [
      ...placed.map((entry) => `${entry.address}:${entry.bytes.join(",")}`),
      ...[...symbols.entries()].map(([name, value]) => `${name}=${value}`),
    ].join("|");
    if (signature === previousSignature) {
      settled = true;
      break;
    }
    previousSignature = signature;

    // After the first pass every address is real, so short branches become
    // worth trying again.
    if (iteration === 0) {
      for (const entry of placed) {
        if (entry.statement.kind === "instruction") entry.minimumRelBytes = 1;
      }
    }
  }

  // Running out of iterations would mean emitting whichever half-relaxed
  // layout the last pass happened to leave behind — bytes that are wrong in a
  // way nothing downstream could detect. There is no known program that gets
  // here; if one exists, it is a bug in this file and should read as one.
  if (!settled) {
    throw new AsmError(
      "The assembler could not settle on a layout for this program — please report it",
      1,
      1,
    );
  }

  // The layout has stopped moving, so a value still built on a placeholder is
  // never going to arrive: the symbol is defined in terms of itself.
  for (const entry of placed) {
    const { statement } = entry;
    if (statement.kind !== "equ" || !symbols.isProvisional(statement.name)) continue;
    throw new AsmError(
      `"${statement.name}" is defined in terms of itself`,
      statement.line,
      statement.column,
    );
  }

  const entrySymbol = symbols.get("_start") ?? symbols.get("main");
  if (entrySymbol === undefined) {
    throw new AsmError(
      "This program has no _start label — a program with no libc starts at _start",
      1,
      1,
    );
  }

  const segments: AssembledSegment[] = [];
  const listing: ListingRow[] = [];
  const lineForAddress = new Map<bigint, number>();

  for (const section of SECTION_ORDER) {
    if (section === ".bss") continue;
    const entries = bySection.get(section) ?? [];
    const start = sectionStarts.get(section)!;
    const bytes: number[] = [];
    for (const entry of entries) {
      if (entry.bytes.length === 0) continue;
      // Sections are contiguous by construction, but `align` can leave a hole
      // between two statements; fill it so the segment stays one run of bytes.
      const offset = Number(entry.address - start);
      while (bytes.length < offset) bytes.push(0);
      // Pushed one at a time rather than spread: a spread passes every byte as
      // its own argument, and a long `db` string overflows the call stack.
      for (const byte of entry.bytes) bytes.push(byte);
      listing.push({ address: entry.address, bytes: entry.bytes, line: entry.statement.line });
      if (entry.statement.kind === "instruction") {
        lineForAddress.set(entry.address, entry.statement.line);
      }
    }
    if (bytes.length === 0) continue;
    segments.push({
      name: section,
      start,
      bytes: Uint8Array.from(bytes),
      writable: section === ".data",
      executable: section === ".text",
    });
  }

  listing.sort((left, right) =>
    left.address < right.address ? -1 : left.address > right.address ? 1 : 0,
  );

  return {
    entry: entrySymbol,
    segments,
    bssStart,
    bssEnd,
    breakStart: alignUp(bssEnd, PAGE_SIZE),
    symbols: symbols.entries(),
    listing,
    lineForAddress,
  };
}
