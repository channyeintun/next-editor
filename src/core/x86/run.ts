/**
 * The whole toolchain in one call: source in, program output out.
 *
 * This is the layer that stands in for `nasm && ld && ./a.out`, and it is
 * deliberately the only part the rest of the app knows about. Everything below
 * it — the two-pass layout, the encoder, the decoder, the page table — is an
 * implementation detail of "run this assembly".
 *
 * The loading it does is the part people usually never see. A Linux program
 * does not begin with an empty stack: the kernel puts `argc`, the argument
 * pointers, the environment and the auxiliary vector there before jumping to
 * `_start`, which is why `_start` can read them and why `pop rdi` is a real
 * way to get `argc`. The same layout is built here, so a program that walks its
 * own stack finds what it expects.
 */

import { AsmError, assemble, STACK_SIZE, STACK_TOP, type AssembledProgram } from "./assembler";
import {
  DEFAULT_MAX_INSTRUCTIONS,
  DEFAULT_MAX_OUTPUT_BYTES,
  Machine,
  RSP,
  type Flags,
} from "./cpu";

export type X86RunStatus = "success" | "assemble-error" | "runtime-error";

export interface X86RegisterSnapshot {
  name: string;
  value: bigint;
}

export interface X86RunResult {
  status: X86RunStatus;
  stdout: string;
  stderr: string;
  /** The value the program passed to `exit`, or null when it never got there. */
  exitCode: number | null;
  /** Assembler diagnostics, present exactly when status is "assemble-error". */
  diagnostics?: string;
  /** What went wrong at run time, present exactly when status is "runtime-error". */
  detail?: string;
  instructions: number;
  registers: X86RegisterSnapshot[];
  flags: Flags;
  /** Bytes the assembler produced, for a hex listing. */
  listing: { address: bigint; bytes: number[]; line: number }[];
}

export interface X86RunOptions {
  stdin?: string;
  maxInstructions?: number;
  maxOutputBytes?: number;
  /** The name shown in diagnostics. */
  fileName?: string;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Render an assembler error the way a compiler does: the file and line, the
 * message, then the offending line with a caret under it. The caret is the
 * part that saves the reading — a column number alone makes a person count
 * characters.
 */
export function formatDiagnostic(error: AsmError, source: string, fileName: string): string {
  const lines = source.split("\n");
  const text = lines[error.line - 1] ?? "";
  const caretColumn = Math.max(1, Math.min(error.column, text.length + 1));
  return [
    `${fileName}:${error.line}:${error.column}: error: ${error.message}`,
    `  ${text}`,
    `  ${" ".repeat(caretColumn - 1)}^`,
  ].join("\n");
}

/** Assemble and load a program without running it — used by the tests. */
export function load(program: AssembledProgram, options: X86RunOptions = {}): Machine {
  const machine = new Machine({
    stdin: options.stdin ? encoder.encode(options.stdin) : undefined,
    maxInstructions: options.maxInstructions ?? DEFAULT_MAX_INSTRUCTIONS,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  });

  for (const segment of program.segments) {
    machine.memory.map(
      segment.start,
      BigInt(segment.bytes.length),
      segment.executable ? "rx" : segment.writable ? "rw" : "r",
      segment.bytes,
    );
  }

  if (program.bssEnd > program.bssStart) {
    machine.memory.map(program.bssStart, program.bssEnd - program.bssStart, "rw");
  }

  machine.memory.map(STACK_TOP - STACK_SIZE, STACK_SIZE, "rw");
  machine.setBreak(program.breakStart);

  // The initial stack, top down: the program name string, then the auxiliary
  // vector's terminator, the empty environment, the argument list and argc.
  const nameBytes = encoder.encode("/program\0");
  const nameAddress = STACK_TOP - 16n - BigInt(nameBytes.length);
  machine.memory.writeBytes(nameAddress, nameBytes);

  let stackPointer = (nameAddress - 64n) & ~0xfn;
  const pushWord = (value: bigint): void => {
    stackPointer -= 8n;
    machine.memory.write(stackPointer, 8, value);
  };

  pushWord(0n); // AT_NULL value
  pushWord(0n); // AT_NULL key
  pushWord(0n); // envp terminator
  pushWord(0n); // argv terminator
  pushWord(nameAddress); // argv[0]
  pushWord(1n); // argc

  machine.registers[RSP] = stackPointer;
  machine.rip = program.entry;
  return machine;
}

export function assembleAndRun(source: string, options: X86RunOptions = {}): X86RunResult {
  const fileName = options.fileName ?? "main.asm";

  const empty: Omit<X86RunResult, "status"> = {
    stdout: "",
    stderr: "",
    exitCode: null,
    instructions: 0,
    registers: [],
    flags: {
      carry: false,
      parity: false,
      adjust: false,
      zero: false,
      sign: false,
      overflow: false,
    },
    listing: [],
  };

  let program: AssembledProgram;
  try {
    program = assemble(source);
  } catch (cause) {
    if (cause instanceof AsmError) {
      return {
        ...empty,
        status: "assemble-error",
        diagnostics: formatDiagnostic(cause, source, fileName),
      };
    }
    throw cause;
  }

  const machine = load(program, options);
  const reason = machine.run();

  const result: X86RunResult = {
    ...empty,
    status: reason.kind === "exited" ? "success" : "runtime-error",
    stdout: decoder.decode(Uint8Array.from(machine.stdout)),
    stderr: decoder.decode(Uint8Array.from(machine.stderr)),
    exitCode: reason.kind === "exited" ? reason.code : null,
    instructions: machine.instructionsExecuted,
    registers: machine.snapshotRegisters(),
    flags: { ...machine.flags },
    listing: program.listing,
  };

  if (reason.kind !== "exited") {
    result.detail = describeStop(reason, machine, program, fileName);
  }

  return result;
}

function describeStop(
  reason: Exclude<ReturnType<Machine["run"]>, { kind: "exited" }>,
  machine: Machine,
  program: AssembledProgram,
  fileName: string,
): string {
  if (reason.kind === "instruction-limit") {
    return `The program ran ${machine.instructionsExecuted.toLocaleString("en-US")} instructions without stopping — check that every loop can end, and that the program calls exit`;
  }
  if (reason.kind === "output-limit") {
    return "The program printed more than this runner will hold — check that the loop doing the printing can end";
  }

  // A fault is far more useful with the line that caused it, which the listing
  // can supply whenever the fault happened on an instruction boundary.
  const line = program.lineForAddress.get(machine.rip);
  const where = line === undefined ? "" : ` (${fileName}:${line})`;
  return `${reason.message}${where}`;
}

/** A hex listing of the assembled bytes, in the shape objdump prints. */
export function formatListing(program: AssembledProgram, source: string): string {
  const lines = source.split("\n");
  return program.listing
    .map((row) => {
      const address = row.address.toString(16).padStart(8, "0");
      const bytes = row.bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
      const text = (lines[row.line - 1] ?? "").trim();
      return `${address}  ${bytes.padEnd(24)}  ${text}`;
    })
    .join("\n");
}
