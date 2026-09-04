/**
 * Contracts for the x86-64 assembly runner.
 *
 * Like the Kite Playground and unlike Go, Kotlin, Rust and Zig, **there is no
 * service.** The assembler and the machine are TypeScript in `src/core/x86`,
 * so a run never leaves the page: no proxy, no sign-in, no rate limit, and no
 * lesson that stops working because a public playground went down. What that
 * removes from this file is the whole authentication and throttling vocabulary
 * the four proxied languages have to model.
 *
 * What it adds is `registers` and `flags`. Every other language's result is
 * what the program printed; an assembly lesson is usually *about* the register
 * file, so the runner can carry it after a run — the machine is right here, and
 * its state is an ordinary value rather than something behind a debugger
 * protocol. Only `registers` is rendered today (`asmRegisterConsoleLines`);
 * `flags` is carried for lesson fixtures and has no console line yet.
 *
 * The result shape otherwise mirrors the other five deliberately, so
 * `playgroundRuntime.ts`, the runner panel and the console helpers treat every
 * language the same way.
 */

export type AsmPlaygroundRunStatus = "success" | "assemble-error" | "runtime-error";

export interface AsmPlaygroundFile {
  /** Top-level `.asm` / `.s` path in the lesson workspace. */
  path: string;
  content: string;
}

export interface AsmPlaygroundRunRequest {
  files: readonly AsmPlaygroundFile[];
  /** Bytes offered to the program's `read` system call. */
  stdin?: string;
}

export interface AsmPlaygroundRegister {
  name: string;
  /** Decimal string: a 64-bit value does not survive JSON as a number. */
  value: string;
}

export interface AsmPlaygroundFlags {
  carry: boolean;
  zero: boolean;
  sign: boolean;
  overflow: boolean;
  parity: boolean;
  adjust: boolean;
}

export interface AsmPlaygroundRunResult {
  status: AsmPlaygroundRunStatus;
  /** What the program wrote to file descriptor 1. */
  stdout: string;
  /** What the program wrote to file descriptor 2. */
  stderr: string;
  /** The value passed to `exit`; absent when the program never got there. */
  exitCode?: number;
  /**
   * Assembler diagnostics, rendered the way a compiler renders them — file,
   * line, column, message, and the source line under a caret. Present exactly
   * when status is "assemble-error".
   */
  assembleErrors?: string;
  /** What stopped the program, present exactly when status is "runtime-error". */
  exitDetail?: string;
  /**
   * How many instructions ran. Carried for lesson fixtures and for anyone
   * reading a recorded result; the console does not render it (the runaway-loop
   * message formats its own count from the machine).
   */
  instructions?: number;
  /**
   * The registers the program *changed*, in register-file order.
   *
   * Not every non-zero register: the stack pointer is non-zero before the
   * first instruction runs, and putting it in every readout would say
   * something about the loader rather than about the program.
   */
  registers?: AsmPlaygroundRegister[];
  flags?: AsmPlaygroundFlags;
}

const RUN_STATUSES: ReadonlySet<string> = new Set(["success", "assemble-error", "runtime-error"]);

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function parseRegisters(value: unknown): AsmPlaygroundRegister[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const registers: AsmPlaygroundRegister[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.name !== "string" || typeof candidate.value !== "string") return null;
    registers.push({ name: candidate.name, value: candidate.value });
  }
  return registers;
}

function parseFlags(value: unknown): AsmPlaygroundFlags | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const names = ["carry", "zero", "sign", "overflow", "parity", "adjust"] as const;
  if (names.some((name) => typeof candidate[name] !== "boolean")) return null;
  return {
    carry: candidate.carry as boolean,
    zero: candidate.zero as boolean,
    sign: candidate.sign as boolean,
    overflow: candidate.overflow as boolean,
    parity: candidate.parity as boolean,
    adjust: candidate.adjust as boolean,
  };
}

/**
 * Validate a run result, or null when the payload does not match the contract.
 *
 * The machine is in this page rather than across a network, so this is cheaper
 * than it looks — but it stays for the same reason it stays in the Kite client:
 * a status that disagrees with its own diagnostics would render a successful
 * run for an impossible state, and that is worth catching wherever the value
 * came from.
 */
export function parseAsmPlaygroundRunResult(value: unknown): AsmPlaygroundRunResult | null {
  if (typeof value !== "object" || value === null) return null;

  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate.status !== "string" ||
    !RUN_STATUSES.has(candidate.status) ||
    typeof candidate.stdout !== "string" ||
    typeof candidate.stderr !== "string" ||
    !isOptionalString(candidate.assembleErrors) ||
    !isOptionalString(candidate.exitDetail) ||
    !isOptionalNumber(candidate.exitCode) ||
    !isOptionalNumber(candidate.instructions)
  ) {
    return null;
  }

  const registers = parseRegisters(candidate.registers);
  if (registers === null) return null;
  const flags = parseFlags(candidate.flags);
  if (flags === null) return null;

  const status = candidate.status as AsmPlaygroundRunStatus;
  const hasAssembleErrors =
    typeof candidate.assembleErrors === "string" && candidate.assembleErrors.trim().length > 0;
  const hasExitDetail =
    typeof candidate.exitDetail === "string" && candidate.exitDetail.trim().length > 0;

  if (
    (status === "success" && (hasAssembleErrors || hasExitDetail)) ||
    (status === "assemble-error" && (!hasAssembleErrors || hasExitDetail)) ||
    (status === "runtime-error" && (!hasExitDetail || hasAssembleErrors))
  ) {
    return null;
  }

  const result: AsmPlaygroundRunResult = {
    status,
    stdout: candidate.stdout,
    stderr: candidate.stderr,
  };

  if (candidate.exitCode !== undefined) result.exitCode = candidate.exitCode as number;
  if (candidate.assembleErrors !== undefined) result.assembleErrors = candidate.assembleErrors;
  if (candidate.exitDetail !== undefined) result.exitDetail = candidate.exitDetail;
  if (candidate.instructions !== undefined) result.instructions = candidate.instructions as number;
  if (registers !== undefined) result.registers = registers;
  if (flags !== undefined) result.flags = flags;

  return result;
}
