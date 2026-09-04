import type { GoPlaygroundRunResult } from "./types";
import type { GoPlaygroundServiceErrorKind } from "./client";

/**
 * Renders normalized run results as prefixed console lines for the runtime
 * dock's console state (RuntimePanelRecordingState.consoleLines). This is the
 * implementation-neutral shape that recordings capture and playback replays —
 * no Playground- or Worker-specific detail leaks into the recorded lines.
 */

function summarizeFilePaths(filePaths: readonly string[]): string {
  return filePaths.length <= 4
    ? filePaths.join(" ")
    : `${filePaths.slice(0, 3).join(" ")} … (${filePaths.length} files)`;
}

/**
 * The tags this module emits, as the pattern the runner panel colours by. It
 * lives beside the builders rather than in the panel so the two are read
 * together: a tag added here without the pattern silently loses its colour, and
 * a pattern loose enough to match any `[...]` head paints program output as if
 * the runner had said it — `fmt.Println` of a slice prints `[1 2 3]`.
 */
export const GO_CONSOLE_TAG_PATTERN = /^\[(?:go-run|go-vet|gofmt)(?: error)?\]/;

export function goRunStartedConsoleLines(filePaths: readonly string[]): string[] {
  return [`[go-run] go run ${summarizeFilePaths(filePaths)}`];
}

export function goFormatStartedConsoleLines(filePaths: readonly string[]): string[] {
  return [`[gofmt] gofmt ${summarizeFilePaths(filePaths)}`];
}

export function goFormatResultToConsoleLines(changedFilePaths: readonly string[]): string[] {
  if (changedFilePaths.length === 0) {
    return ["[gofmt] Files already formatted"];
  }

  return [`[gofmt] Formatted ${summarizeFilePaths(changedFilePaths)}`];
}

export function goFormatStaleConsoleLines(): string[] {
  return ["[gofmt error] Files changed while formatting; no formatting was applied"];
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

export function goRunResultToConsoleLines(result: GoPlaygroundRunResult): string[] {
  if (result.status === "compile-error") {
    return ["[go-run error] Build failed", ...splitOutputLines(result.compileErrors ?? "")];
  }

  const lines: string[] = [];

  // Vet diagnostics render before and separately from program output, each
  // line carrying its own prefix so the two streams can't be conflated.
  if (result.vetErrors?.trim()) {
    lines.push("[go-vet] Vet found issues that need attention");
    lines.push(...splitOutputLines(result.vetErrors).map((line) => `[go-vet] ${line}`));
  }

  const outputLines = splitOutputLines(result.output);
  lines.push(...(outputLines.length > 0 ? outputLines : ["[go-run] (no output)"]));

  const exitCode = result.exitCode ?? 0;
  lines.push(
    result.status === "runtime-error"
      ? `[go-run error] Program exited with status ${exitCode}`
      : "[go-run] Program exited",
  );

  return lines;
}

const SERVICE_ERROR_LINES: Record<Exclude<GoPlaygroundServiceErrorKind, "aborted">, string> = {
  unauthenticated: "[go-run error] Sign in to run Go code. Your edits are kept",
  disabled: "[go-run error] Live Run is currently disabled. Editing and playback still work",
  "rate-limited": "[go-run error] Too many runs — wait a minute and try again",
  timeout: "[go-run error] The program took too long to compile and run",
  "invalid-source": "[go-run error] This program can't run in a Go lesson",
  unavailable:
    "[go-run error] The Go Playground service is unavailable right now — your code is unchanged, try again shortly",
};

export function goRunServiceErrorToConsoleLines(
  kind: Exclude<GoPlaygroundServiceErrorKind, "aborted">,
  detail?: string,
): string[] {
  const lines = [SERVICE_ERROR_LINES[kind]];
  if (kind === "invalid-source" && detail) {
    lines.push(detail);
  }
  return lines;
}

const FORMAT_SERVICE_ERROR_LINES: Record<
  Exclude<GoPlaygroundServiceErrorKind, "aborted">,
  string
> = {
  unauthenticated: "[gofmt error] Sign in to format Go code. Your edits are kept",
  disabled: "[gofmt error] Go formatting is currently disabled. Your code is unchanged",
  "rate-limited": "[gofmt error] Too many format requests — wait a minute and try again",
  timeout: "[gofmt error] Formatting took too long. Your code is unchanged",
  "invalid-source": "[gofmt error] gofmt could not format this program",
  unavailable:
    "[gofmt error] The Go Playground formatter is unavailable right now — your code is unchanged",
};

export function goFormatServiceErrorToConsoleLines(
  kind: Exclude<GoPlaygroundServiceErrorKind, "aborted">,
  detail?: string,
): string[] {
  const lines = [FORMAT_SERVICE_ERROR_LINES[kind]];
  if (kind === "invalid-source" && detail) {
    lines.push(detail);
  }
  return lines;
}
