import type { KitePlaygroundRunResult } from "./types";
import type { KitePlaygroundServiceErrorKind } from "./client";
import { serviceErrorConsoleLines, splitOutputLines } from "../playgroundConsole";

/**
 * Renders normalized run results as prefixed console lines for the runtime
 * dock's console state (RuntimePanelRecordingState.consoleLines). This is the
 * implementation-neutral shape recordings capture and playback replays — no
 * compiler-specific detail leaks into the recorded lines.
 *
 * The service-error table is two entries rather than five because a Kite
 * lesson has no service to be throttled by, switched off at, or cut off from.
 */

/**
 * The tags this module emits, as the pattern the runner panel colours by. It
 * lives beside the builders rather than in the panel so the two are read
 * together: a tag added here without the pattern silently loses its colour, and
 * a pattern loose enough to match any `[...]` head paints a program's own
 * bracketed line — a printed list, say — as if the runner had said it.
 */
export const KITE_CONSOLE_TAG_PATTERN = /^\[(?:kite-run|kitefmt)(?: error)?\]/;

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
  return serviceErrorConsoleLines(SERVICE_ERROR_LINES, kind, detail);
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
  return serviceErrorConsoleLines(FORMAT_SERVICE_ERROR_LINES, kind, detail);
}
