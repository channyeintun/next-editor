import type { GoPlaygroundRunResult } from "./types";
import type { GoPlaygroundServiceErrorKind } from "./client";

/**
 * Renders normalized run results as prefixed console lines for the runtime
 * dock's console state (RuntimePanelRecordingState.consoleLines). This is the
 * implementation-neutral shape that recordings capture and playback replays —
 * no Playground- or Worker-specific detail leaks into the recorded lines.
 */

export function goRunStartedConsoleLines(fileName: string): string[] {
  return [`[go-run] go run ${fileName}`];
}

function splitOutputLines(output: string): string[] {
  const trimmed = output.replace(/\n+$/, "");
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
