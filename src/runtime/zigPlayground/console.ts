import type { ZigPlaygroundRunResult } from "./types";
import type { ZigPlaygroundServiceErrorKind } from "./client";

/**
 * Renders normalized run results as prefixed console lines for the runtime
 * dock's console state (RuntimePanelRecordingState.consoleLines). This is the
 * implementation-neutral shape that recordings capture and playback replays —
 * no Playground- or Worker-specific detail leaks into the recorded lines.
 */

export function zigRunStartedConsoleLines(): string[] {
  return ["[zig-run] zig run main.zig"];
}

export function zigFormatStartedConsoleLines(): string[] {
  return ["[zig-fmt] zig fmt main.zig"];
}

export function zigFormatResultToConsoleLines(changed: boolean): string[] {
  return changed ? ["[zig-fmt] Formatted main.zig"] : ["[zig-fmt] main.zig is already formatted"];
}

export function zigFormatStaleConsoleLines(): string[] {
  return ["[zig-fmt error] Files changed while formatting; no formatting was applied"];
}

function splitOutputLines(output: string): string[] {
  const trimmed = output.replace(/\n+$/, "");
  return trimmed ? trimmed.split("\n") : [];
}

export function zigRunResultToConsoleLines(result: ZigPlaygroundRunResult): string[] {
  if (result.status === "compile-error") {
    return ["[zig-run error] Build failed", ...splitOutputLines(result.compileErrors ?? "")];
  }

  const lines: string[] = [];

  const outputLines = splitOutputLines(result.output);
  lines.push(...(outputLines.length > 0 ? outputLines : ["[zig-run] (no output)"]));

  lines.push(
    result.status === "runtime-error"
      ? `[zig-run error] ${result.exitDetail ?? "Program failed"}`
      : "[zig-run] Program exited",
  );

  return lines;
}

const SERVICE_ERROR_LINES: Record<Exclude<ZigPlaygroundServiceErrorKind, "aborted">, string> = {
  unauthenticated: "[zig-run error] Sign in to run Zig code. Your edits are kept",
  disabled: "[zig-run error] Live Run is currently disabled. Editing and playback still work",
  "rate-limited": "[zig-run error] Too many runs — wait a minute and try again",
  timeout: "[zig-run error] The program took too long to compile and run",
  "invalid-source": "[zig-run error] This program can't run in a Zig lesson",
  unavailable:
    "[zig-run error] The Zig Playground service is unavailable right now — your code is unchanged, try again shortly",
};

export function zigRunServiceErrorToConsoleLines(
  kind: Exclude<ZigPlaygroundServiceErrorKind, "aborted">,
  detail?: string,
): string[] {
  const lines = [SERVICE_ERROR_LINES[kind]];
  if (kind === "invalid-source" && detail) {
    lines.push(detail);
  }
  return lines;
}

const FORMAT_SERVICE_ERROR_LINES: Record<
  Exclude<ZigPlaygroundServiceErrorKind, "aborted">,
  string
> = {
  unauthenticated: "[zig-fmt error] Sign in to format Zig code. Your edits are kept",
  disabled: "[zig-fmt error] Zig formatting is currently disabled. Your code is unchanged",
  "rate-limited": "[zig-fmt error] Too many format requests — wait a minute and try again",
  timeout: "[zig-fmt error] Formatting took too long. Your code is unchanged",
  "invalid-source": "[zig-fmt error] zig fmt could not format this program",
  unavailable:
    "[zig-fmt error] The Zig Playground formatter is unavailable right now — your code is unchanged",
};

export function zigFormatServiceErrorToConsoleLines(
  kind: Exclude<ZigPlaygroundServiceErrorKind, "aborted">,
  detail?: string,
): string[] {
  const lines = [FORMAT_SERVICE_ERROR_LINES[kind]];
  if (kind === "invalid-source" && detail) {
    lines.push(detail);
  }
  return lines;
}
