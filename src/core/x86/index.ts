/**
 * A first-party x86-64 assembler and machine, running in the page.
 *
 * `robalb/x86-64-playground` showed what this can be: a whole x86-64 Linux
 * machine in a browser tab, with nothing ever sent to a server. It gets there
 * by compiling Blink — a real x86-64 emulator — and a real assembler to
 * WebAssembly. That is the honest way to run *arbitrary* binaries.
 *
 * A lesson runner wants something narrower and gets something better for it.
 * The subset here is the assembly a person actually writes while learning:
 * moves, arithmetic, the flags and the jumps that read them, the stack, and
 * Linux system calls. Keeping it first-party TypeScript buys four things a
 * vendored emulator cannot:
 *
 *   * Every error is a sentence about the program rather than a signal number.
 *     "The program tried to write to 0x401000, which is read-only" is a lesson;
 *     "Segmentation fault" is not.
 *   * The register file and the flags are ordinary values, so the runner can
 *     show them after a run without a debugger protocol in between.
 *   * It is deterministic and dependency-free, which is what a recorded lesson
 *     needs — the same source produces the same bytes and the same output on
 *     every replay, forever, with no service to be down and no multi-megabyte
 *     artifact to fetch.
 *   * It is testable in the repo's own test runner, including a round-trip
 *     between the encoder and the decoder that a compiled blob cannot offer.
 *
 * The trade is real and worth stating: this will not run a binary you did not
 * write here, it has no libc, and an instruction outside the subset is an error
 * rather than an execution. For teaching x86-64 that is the right trade.
 */

export { assemble, AsmError, TEXT_BASE, STACK_TOP } from "./assembler";
export type { AssembledProgram, AssembledSegment, ListingRow } from "./assembler";
export { assembleAndRun, formatDiagnostic, formatListing, load } from "./run";
export type { X86RunResult, X86RunOptions, X86RunStatus, X86RegisterSnapshot } from "./run";
export { Machine } from "./cpu";
export type { Flags, StopReason } from "./cpu";
export { decodeInstruction } from "./decoder";
export { KNOWN_MNEMONICS } from "./isa";
export { REGISTERS_64 } from "./registers";
