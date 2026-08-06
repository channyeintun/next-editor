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
 * unauthenticated, rate-limited or disabled. What is left is a source the
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
 * Whether a `kitec` answer is diagnostics rather than program output.
 *
 * `kite_run` answers with what the program printed, or — when it did not
 * compile — with the diagnostics, rendered exactly as a terminal renders them.
 * The two are told apart the same way a reader tells them apart.
 */
function isDiagnostics(answer: string): boolean {
  return /^error(\[[A-Z]\d{4}\])?:/m.test(answer);
}

/** Whether a run's own output reports a trap rather than a compile failure. */
function isTrap(answer: string): boolean {
  return /^(trap|thread .* panicked|error: the program trapped)/m.test(answer);
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

    const answer = compiler.run(entry.content);

    const result: KitePlaygroundRunResult = isDiagnostics(answer)
      ? { status: "compile-error", stdout: "", stderr: "", compileErrors: answer }
      : isTrap(answer)
        ? { status: "runtime-error", stdout: "", stderr: answer, exitDetail: answer.trim() }
        : { status: "success", stdout: answer, stderr: "" };

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
