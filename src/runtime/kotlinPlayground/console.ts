import type { KotlinPlaygroundRunResult } from "./types";
import type { KotlinPlaygroundServiceErrorKind } from "./client";
import {
  serviceErrorConsoleLines,
  splitOutputLines,
  summarizeFilePaths,
} from "../playgroundConsole";

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
 * the runner had said it — `println(listOf(1, 2))` prints `[1, 2]`.
 */
export const KOTLIN_CONSOLE_TAG_PATTERN = /^\[kotlin-(?:run|warn)(?: error)?\]/;

export function kotlinRunStartedConsoleLines(filePaths: readonly string[]): string[] {
  return [`[kotlin-run] kotlin ${summarizeFilePaths(filePaths)}`];
}

export function kotlinRunResultToConsoleLines(result: KotlinPlaygroundRunResult): string[] {
  if (result.status === "compile-error") {
    const lines = [
      "[kotlin-run error] Build failed",
      ...splitOutputLines(result.compileErrors ?? ""),
    ];
    if (result.warnings?.trim()) {
      lines.push(...splitOutputLines(result.warnings).map((line) => `[kotlin-warn] ${line}`));
    }
    return lines;
  }

  const lines: string[] = [];

  // Compiler warnings render before and separately from program output, each
  // line carrying its own prefix so the two streams can't be conflated.
  if (result.warnings?.trim()) {
    lines.push("[kotlin-warn] The compiler reported warnings");
    lines.push(...splitOutputLines(result.warnings).map((line) => `[kotlin-warn] ${line}`));
  }

  const outputLines = splitOutputLines(result.output);
  lines.push(...(outputLines.length > 0 ? outputLines : ["[kotlin-run] (no output)"]));

  if (result.status === "runtime-error") {
    lines.push(...splitOutputLines(result.exception ?? ""));
    lines.push("[kotlin-run error] Program failed");
  } else {
    lines.push("[kotlin-run] Program exited");
  }

  return lines;
}

const SERVICE_ERROR_LINES: Record<Exclude<KotlinPlaygroundServiceErrorKind, "aborted">, string> = {
  disabled: "[kotlin-run error] Live Run is currently disabled. Editing and playback still work",
  "rate-limited": "[kotlin-run error] Too many runs — wait a minute and try again",
  timeout: "[kotlin-run error] The program took too long to compile and run",
  "invalid-source": "[kotlin-run error] This program can't run in a Kotlin lesson",
  unavailable:
    "[kotlin-run error] The Kotlin Playground service is unavailable right now — your code is unchanged, try again shortly",
};

export function kotlinRunServiceErrorToConsoleLines(
  kind: Exclude<KotlinPlaygroundServiceErrorKind, "aborted">,
  detail?: string,
): string[] {
  return serviceErrorConsoleLines(SERVICE_ERROR_LINES, kind, detail);
}
