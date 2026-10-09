import { loadKiteCompiler, type KiteCompiler } from "./compiler";
import {
  parseKitePlaygroundRunResult,
  type KitePlaygroundFile,
  type KitePlaygroundFormatRequest,
  type KitePlaygroundFormatResult,
  type KitePlaygroundRunRequest,
  type KitePlaygroundRunResult,
} from "./types";

/**
 * Why a Kite tool request can fail without producing a result.
 *
 * Three of the kinds the other Playground clients carry are missing, and their
 * absence is the point: **there is no service**, so a Kite lesson cannot be
 * rate-limited, disabled or timed out by one. What is left is a source the
 * compiler will not take, a compiler that would not load, and a request a newer
 * one superseded.
 */
export type KitePlaygroundServiceErrorKind = "invalid-source" | "unavailable" | "aborted";

export class KitePlaygroundServiceError extends Error {
  readonly kind: KitePlaygroundServiceErrorKind;

  constructor(kind: KitePlaygroundServiceErrorKind, message: string) {
    super(message);
    this.name = "KitePlaygroundServiceError";
    this.kind = kind;
  }
}

/** The one file a run compiles, and the reason it is one. */
const ENTRY = "main.kite";

/**
 * Pick the file to compile.
 *
 * A Kite module is a *directory*, so every `.kite` file beside the entry is
 * part of the same program — but the compiler running here is handed one
 * source, so a lesson with siblings would compile only part of itself. Rather
 * than compile the wrong thing quietly, a workspace with more than one file
 * says so.
 */
function entryOf(files: readonly KitePlaygroundFile[]): KitePlaygroundFile {
  if (files.length === 0) {
    throw new KitePlaygroundServiceError("invalid-source", "Add a .kite file to run this lesson");
  }
  const named = files.find((file) => file.path === ENTRY || file.path.endsWith(`/${ENTRY}`));
  if (named) return named;
  if (files.length === 1) return files[0];
  throw new KitePlaygroundServiceError(
    "invalid-source",
    `Name the file this lesson runs \`${ENTRY}\` — a Kite module is a directory, and with ` +
      `${files.length} files there is no way to tell which one is the program`,
  );
}

/**
 * The trailer `kite_run` appends when a program traps: the trap's message on an
 * `error:` line, then a fixed note. Anchored to the end of the answer, because
 * a trap ends the program and nothing can print after it.
 */
const TRAP_TRAILER = /\nerror: ([^\n]*)\nnote: traps are not catchable[^\n]*\n?$/;

/**
 * Compile and run one source, and say which of the three outcomes it was.
 *
 * The compiler's own verdict decides compile-versus-run: `kite_check` answers
 * with nothing for a program that compiles and with exactly the diagnostics
 * `kite_run` would print for one that does not. Reading `kite_run`'s answer
 * instead cannot tell them apart — a program is free to print a line that
 * starts with `error:` — so a program that does not compile is never run, and
 * a trap is recognised only by the trailer the compiler writes for one.
 */
export function runKiteSource(compiler: KiteCompiler, source: string): KitePlaygroundRunResult {
  const diagnostics = compiler.check(source);
  if (diagnostics) {
    return { status: "compile-error", stdout: "", stderr: "", compileErrors: diagnostics };
  }

  const answer = compiler.run(source);
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

/**
 * One operation at a time against an in-process compiler.
 *
 * No filesystem, mount, process, PTY, port, preview or teardown surface —
 * exactly like the Go, Kotlin and Rust Playground clients. It differs from them
 * in having no network either: starting a Run or Format still supersedes the
 * previous operation, so a stale answer can never land after a newer explicit
 * action, but the abort is a token rather than an `AbortController` because
 * there is no request to cancel.
 */
export class KitePlaygroundClient {
  #compiler: KiteCompiler | null = null;
  #generation = 0;

  /** Abort whatever is in flight. Called on unmount and before a new action. */
  dispose(): void {
    this.#generation += 1;
  }

  async #compilerFor(generation: number): Promise<KiteCompiler> {
    if (this.#compiler) return this.#compiler;
    try {
      const compiler = await loadKiteCompiler();
      if (generation !== this.#generation) {
        throw new KitePlaygroundServiceError("aborted", "Superseded by a newer operation");
      }
      this.#compiler = compiler;
      return compiler;
    } catch (cause) {
      if (cause instanceof KitePlaygroundServiceError) throw cause;
      throw new KitePlaygroundServiceError(
        "unavailable",
        `The Kite compiler could not be loaded (${cause instanceof Error ? cause.message : String(cause)})`,
      );
    }
  }

  async run(request: KitePlaygroundRunRequest): Promise<KitePlaygroundRunResult> {
    this.#generation += 1;
    const generation = this.#generation;

    const entry = entryOf(request.files);
    const compiler = await this.#compilerFor(generation);
    if (generation !== this.#generation) {
      throw new KitePlaygroundServiceError("aborted", "Superseded by a newer operation");
    }

    const result = runKiteSource(compiler, entry.content);

    const parsed = parseKitePlaygroundRunResult(result);
    if (!parsed) {
      throw new KitePlaygroundServiceError(
        "unavailable",
        "The compiler produced a result that does not match the contract",
      );
    }
    return parsed;
  }

  async format(request: KitePlaygroundFormatRequest): Promise<KitePlaygroundFormatResult> {
    this.#generation += 1;
    const generation = this.#generation;

    if (request.files.length === 0) {
      throw new KitePlaygroundServiceError(
        "invalid-source",
        "Add a .kite file to format this lesson",
      );
    }

    const compiler = await this.#compilerFor(generation);
    if (generation !== this.#generation) {
      throw new KitePlaygroundServiceError("aborted", "Superseded by a newer operation");
    }

    // Every file, not just the entry: `kitec fmt` works on one file at a time
    // and a lesson's siblings deserve the same treatment as its entry.
    const files = request.files.map((file) => ({
      path: file.path,
      content: compiler.format(file.content),
    }));

    return { files };
  }
}
