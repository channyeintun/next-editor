import type { RustPlaygroundRunResult } from "./types";
import type { RustPlaygroundServiceErrorKind } from "./client";

/**
 * Renders normalized run results as prefixed console lines for the runtime
 * dock's console state (RuntimePanelRecordingState.consoleLines). This is the
 * implementation-neutral shape that recordings capture and playback replays —
 * no Playground- or Worker-specific detail leaks into the recorded lines.
 */

/**
 * The tags this module emits, as the pattern the runner panel colours by. It
 * lives beside the builders rather than in the panel so the two are read
 * together: a tag added here without the pattern silently loses its colour, and
 * a pattern loose enough to match any `[...]` head paints program output as if
 * the runner had said it — `{:?}` on a Vec prints `[1, 2, 3]`.
 */
export const RUST_CONSOLE_TAG_PATTERN = /^\[(?:rust-run|rustfmt)(?: error)?\]/;

export function rustRunStartedConsoleLines(): string[] {
  return ["[rust-run] cargo run"];
}

export function rustFormatStartedConsoleLines(): string[] {
  return ["[rustfmt] rustfmt main.rs"];
}

export function rustFormatResultToConsoleLines(changed: boolean): string[] {
  return changed ? ["[rustfmt] Formatted main.rs"] : ["[rustfmt] main.rs is already formatted"];
}

export function rustFormatStaleConsoleLines(): string[] {
  return ["[rustfmt error] Files changed while formatting; no formatting was applied"];
}

function splitOutputLines(output: string): string[] {
  // Trimmed with an index walk rather than /\n+$/: an unanchored greedy run is
  // retried from every newline in the run, so a program that prints thousands
  // of blank lines followed by anything else freezes the tab for seconds.
  let end = output.length;
  while (end > 0 && output.charCodeAt(end - 1) === 10) {
    end -= 1;
  }
  const trimmed = output.slice(0, end);
  return trimmed ? trimmed.split("\n") : [];
}

export function rustRunResultToConsoleLines(result: RustPlaygroundRunResult): string[] {
  if (result.status === "compile-error") {
    return ["[rust-run error] Build failed", ...splitOutputLines(result.compileErrors ?? "")];
  }

  const lines: string[] = [];

  const outputLines = [...splitOutputLines(result.stdout), ...splitOutputLines(result.stderr)];
  lines.push(...(outputLines.length > 0 ? outputLines : ["[rust-run] (no output)"]));

  lines.push(
    result.status === "runtime-error"
      ? `[rust-run error] ${result.exitDetail ?? "Program failed"}`
      : "[rust-run] Program exited",
  );

  return lines;
}

const SERVICE_ERROR_LINES: Record<Exclude<RustPlaygroundServiceErrorKind, "aborted">, string> = {
  unauthenticated: "[rust-run error] Sign in to run Rust code. Your edits are kept",
  disabled: "[rust-run error] Live Run is currently disabled. Editing and playback still work",
  "rate-limited": "[rust-run error] Too many runs — wait a minute and try again",
  timeout: "[rust-run error] The program took too long to compile and run",
  "invalid-source": "[rust-run error] This program can't run in a Rust lesson",
  unavailable:
    "[rust-run error] The Rust Playground service is unavailable right now — your code is unchanged, try again shortly",
};

export function rustRunServiceErrorToConsoleLines(
  kind: Exclude<RustPlaygroundServiceErrorKind, "aborted">,
  detail?: string,
): string[] {
  const lines = [SERVICE_ERROR_LINES[kind]];
  if (kind === "invalid-source" && detail) {
    lines.push(detail);
  }
  return lines;
}

const FORMAT_SERVICE_ERROR_LINES: Record<
  Exclude<RustPlaygroundServiceErrorKind, "aborted">,
  string
> = {
  unauthenticated: "[rustfmt error] Sign in to format Rust code. Your edits are kept",
  disabled: "[rustfmt error] Rust formatting is currently disabled. Your code is unchanged",
  "rate-limited": "[rustfmt error] Too many format requests — wait a minute and try again",
  timeout: "[rustfmt error] Formatting took too long. Your code is unchanged",
  "invalid-source": "[rustfmt error] rustfmt could not format this program",
  unavailable:
    "[rustfmt error] The Rust Playground formatter is unavailable right now — your code is unchanged",
};

export function rustFormatServiceErrorToConsoleLines(
  kind: Exclude<RustPlaygroundServiceErrorKind, "aborted">,
  detail?: string,
): string[] {
  const lines = [FORMAT_SERVICE_ERROR_LINES[kind]];
  if (kind === "invalid-source" && detail) {
    lines.push(detail);
  }
  return lines;
}
