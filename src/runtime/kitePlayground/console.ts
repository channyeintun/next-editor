import type { KitePlaygroundRunResult } from "./types";
import type { KitePlaygroundServiceErrorKind } from "./client";

/**
 * Renders normalized run results as prefixed console lines for the runtime
 * dock's console state (RuntimePanelRecordingState.consoleLines). This is the
 * implementation-neutral shape recordings capture and playback replays — no
 * compiler-specific detail leaks into the recorded lines.
 *
 * The service-error table is three entries rather than six because a Kite
 * lesson has no service to be signed out of, throttled by, or cut off from.
 */

export function kiteRunStartedConsoleLines(): string[] {
  return ["[kite-run] kitec run main.kite"];
}

export function kiteFormatStartedConsoleLines(): string[] {
  return ["[kitefmt] kitec fmt main.kite"];
}

export function kiteFormatResultToConsoleLines(changed: boolean): string[] {
  return changed ? ["[kitefmt] Formatted main.kite"] : ["[kitefmt] main.kite is already formatted"];
}

export function kiteFormatStaleConsoleLines(): string[] {
  return ["[kitefmt error] Files changed while formatting; no formatting was applied"];
}

function splitOutputLines(output: string): string[] {
  const trimmed = output.replace(/\n+$/, "");
  return trimmed ? trimmed.split("\n") : [];
}

export function kiteRunResultToConsoleLines(result: KitePlaygroundRunResult): string[] {
  if (result.status === "compile-error") {
    // Kite's diagnostics carry their own span and help text, so they are shown
    // as the compiler wrote them rather than summarised.
    return ["[kite-run error] Build failed", ...splitOutputLines(result.compileErrors ?? "")];
  }

  const lines: string[] = [];

  const outputLines = [...splitOutputLines(result.stdout), ...splitOutputLines(result.stderr)];
  lines.push(...(outputLines.length > 0 ? outputLines : ["[kite-run] (no output)"]));

  lines.push(
    result.status === "runtime-error"
      ? `[kite-run error] ${result.exitDetail ?? "Program trapped"}`
      : "[kite-run] Program exited",
  );

  return lines;
}

const SERVICE_ERROR_LINES: Record<Exclude<KitePlaygroundServiceErrorKind, "aborted">, string> = {
  "invalid-source": "[kite-run error] This program can't run in a Kite lesson",
  unavailable:
    "[kite-run error] The Kite compiler could not be loaded — your code is unchanged, try again shortly",
};

export function kiteRunServiceErrorToConsoleLines(
  kind: Exclude<KitePlaygroundServiceErrorKind, "aborted">,
  detail?: string,
): string[] {
  const lines = [SERVICE_ERROR_LINES[kind]];
  if (kind === "invalid-source" && detail) {
    lines.push(detail);
  }
  return lines;
}

const FORMAT_SERVICE_ERROR_LINES: Record<
  Exclude<KitePlaygroundServiceErrorKind, "aborted">,
  string
> = {
  "invalid-source": "[kitefmt error] kitec could not format this program",
  unavailable: "[kitefmt error] The Kite formatter could not be loaded — your code is unchanged",
};

export function kiteFormatServiceErrorToConsoleLines(
  kind: Exclude<KitePlaygroundServiceErrorKind, "aborted">,
  detail?: string,
): string[] {
  const lines = [FORMAT_SERVICE_ERROR_LINES[kind]];
  if (kind === "invalid-source" && detail) {
    lines.push(detail);
  }
  return lines;
}
