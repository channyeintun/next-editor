import { assemble, AsmError, formatDiagnostic, load, summarizeRun } from "../../core/x86";
import { pickPlaygroundEntry } from "../playgroundFiles";
import { ASM_ENTRY_PATH } from "./files";
import {
  parseAsmPlaygroundRunResult,
  type AsmPlaygroundFile,
  type AsmPlaygroundRunRequest,
  type AsmPlaygroundRunResult,
} from "./types";

/**
 * Why an assembly run can fail without producing a result.
 *
 * Three kinds rather than the six the proxied languages carry, and their
 * absence is the point: **there is no service**, so an assembly lesson cannot
 * be rate-limited, disabled or timed out by one. What is left is a workspace the
 * assembler cannot take, a machine that could not start, and a request a newer
 * one superseded.
 */
export type AsmPlaygroundServiceErrorKind = "invalid-source" | "unavailable" | "aborted";

export class AsmPlaygroundServiceError extends Error {
  readonly kind: AsmPlaygroundServiceErrorKind;

  constructor(kind: AsmPlaygroundServiceErrorKind, message: string) {
    super(message);
    this.name = "AsmPlaygroundServiceError";
    this.kind = kind;
  }
}

/**
 * How many instructions to run before handing the browser back the thread.
 *
 * The machine runs a few million instructions a second, so this is a few
 * hundredths of a second of work: short enough that the page stays
 * responsive, long enough that the yielding costs nothing measurable. There is
 * no Stop control in the panel — the generation check between slices is what
 * lets a newer Run, a lesson switch, playback or unmount take the machine away
 * from a program that will not end. Running a whole program in one go would
 * freeze the tab for as long as the program took, and none of those could
 * happen until it finished.
 */
const SLICE_INSTRUCTIONS = 100_000;

const yieldToBrowser = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * Pick the file to assemble. Exported as the language's `pickEntry`
 * (runner.ts), so the studio's fixture run refuses the same workspaces.
 */
export function pickAsmRunEntry(files: readonly AsmPlaygroundFile[]): AsmPlaygroundFile {
  const entry = pickPlaygroundEntry(files, ASM_ENTRY_PATH);
  if (entry === "empty") {
    throw new AsmPlaygroundServiceError(
      "invalid-source",
      `Add a ${ASM_ENTRY_PATH} file to run this lesson`,
    );
  }
  if (entry === "ambiguous") {
    throw new AsmPlaygroundServiceError(
      "invalid-source",
      `Name the file this lesson runs \`${ASM_ENTRY_PATH}\` — there is no linker here, so with ` +
        `${files.length} files there is no way to tell which one is the program`,
    );
  }
  return entry;
}

/**
 * One run at a time against an in-page assembler and machine.
 *
 * No filesystem, mount, process, PTY, port, preview or teardown surface — like
 * the Go, Kotlin, Rust and Kite Playground clients. Like Kite's and unlike the
 * other three it has no network either, so "cancel" is a generation bump rather
 * than an aborted request: the run loop checks the generation between slices
 * and abandons the machine when a newer action has taken over.
 */
export class AsmPlaygroundClient {
  #generation = 0;

  /** Abandon whatever is running. Called on unmount and before a new action. */
  dispose(): void {
    this.#generation += 1;
  }

  async run(request: AsmPlaygroundRunRequest): Promise<AsmPlaygroundRunResult> {
    this.#generation += 1;
    const generation = this.#generation;

    const entry = pickAsmRunEntry(request.files);

    let program;
    try {
      program = assemble(entry.content);
    } catch (cause) {
      if (cause instanceof AsmError) {
        return validated({
          status: "assemble-error",
          stdout: "",
          stderr: "",
          assembleErrors: formatDiagnostic(cause, entry.content, entry.path),
        });
      }
      throw new AsmPlaygroundServiceError(
        "unavailable",
        `The assembler stopped unexpectedly (${cause instanceof Error ? cause.message : String(cause)})`,
      );
    }

    const machine = load(program, { stdin: request.stdin });
    // What the program *changed* is the interesting answer, so the starting
    // state is kept to subtract later. Reporting every non-zero register
    // instead would put the stack pointer in every readout — a value the
    // loader set, that no lesson is about, and that would shift if the initial
    // stack layout ever did.
    const before = new Map(
      machine.snapshotRegisters().map((entry) => [entry.name, entry.value] as const),
    );

    for (;;) {
      const reason = machine.runSlice(SLICE_INSTRUCTIONS);
      if (reason) {
        const summary = summarizeRun(machine, reason, program, entry.path);
        const { stdout, stderr, instructions, flags } = summary;
        const registers = machine
          .snapshotRegisters()
          .filter((entry) => entry.value !== before.get(entry.name))
          .map((entry) => ({ name: entry.name, value: entry.value.toString() }));

        if (summary.status === "success") {
          return validated({
            status: "success",
            stdout,
            stderr,
            exitCode: summary.exitCode,
            instructions,
            registers,
            flags,
          });
        }

        return validated({
          status: "runtime-error",
          stdout,
          stderr,
          exitDetail: summary.detail,
          instructions,
          registers,
          flags,
        });
      }

      // A newer Run (or unmount) owns the console from here on; drop this one
      // rather than letting a stale answer land after it.
      if (generation !== this.#generation) {
        throw new AsmPlaygroundServiceError("aborted", "Superseded by a newer run");
      }
      await yieldToBrowser();
      if (generation !== this.#generation) {
        throw new AsmPlaygroundServiceError("aborted", "Superseded by a newer run");
      }
    }
  }
}

function validated(result: AsmPlaygroundRunResult): AsmPlaygroundRunResult {
  const parsed = parseAsmPlaygroundRunResult(result);
  if (!parsed) {
    throw new AsmPlaygroundServiceError(
      "unavailable",
      "The machine produced a result that does not match the contract",
    );
  }
  return parsed;
}
