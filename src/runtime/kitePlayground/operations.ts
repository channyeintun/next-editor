import { loadKiteCompiler, type KiteCompiler } from "./compiler";
import type { KitePlaygroundRunResult } from "./types";

// What a Run and a Format ask of the compiler, written once for both places it
// runs: `kite.worker.ts` exposes these as they are, and the client calls them
// in this page only where there is no Worker (tests, Node hosts).

/**
 * The trailer `kite_run` appends when a program traps: the trap's message on an
 * `error:` line, then a fixed note. Anchored to the end of the answer, because
 * a trap ends the program and nothing can print after it.
 */
const TRAP_TRAILER = /\nerror: ([^\n]*)\nnote: traps are not catchable[^\n]*\n?$/;

/**
 * Compile and run a program — its entry and the module siblings it may `use`,
 * keyed by module name — and say which of the three outcomes it was.
 *
 * The compiler's own verdict decides compile-versus-run: `kite_check_module`
 * answers with nothing for a program that compiles and with exactly the
 * diagnostics `kite_run_module` would print for one that does not. Reading the
 * run's answer instead cannot tell them apart — a program is free to print a
 * line that starts with `error:` — so a program that does not compile is never
 * run, and a trap is recognised only by the trailer the compiler writes for one.
 */
export function runKiteSource(
  compiler: KiteCompiler,
  source: string,
  siblings: Record<string, string> = {},
): KitePlaygroundRunResult {
  const diagnostics = compiler.checkModule(source, siblings);
  if (diagnostics) {
    return { status: "compile-error", stdout: "", stderr: "", compileErrors: diagnostics };
  }

  const answer = compiler.runModule(source, siblings);
  const trap = TRAP_TRAILER.exec(answer);
  if (trap) {
    return {
      status: "runtime-error",
      stdout: answer.slice(0, trap.index),
      stderr: "",
      exitDetail: trap[1],
    };
  }
  return { status: "success", stdout: answer, stderr: "" };
}

/** The compiler operations a client drives, loading the compiler on first use. */
export const kiteOperations = {
  /** Load the compiler, so a failed load is told apart from a failed run. */
  async load(): Promise<void> {
    await loadKiteCompiler();
  },
  /** `siblings`: the other files of the entry's module, keyed by module name. */
  async run(
    source: string,
    siblings: Record<string, string> = {},
  ): Promise<KitePlaygroundRunResult> {
    return runKiteSource(await loadKiteCompiler(), source, siblings);
  },
  /** Every source laid out the one way, in order: `kitec fmt` takes one file at a time. */
  async format(sources: readonly string[]): Promise<string[]> {
    const compiler = await loadKiteCompiler();
    return sources.map((source) => compiler.format(source));
  },
};

export type KiteOperations = typeof kiteOperations;
