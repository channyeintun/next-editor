import type { HaskellPlaygroundRunResult } from "./types";
import type { HaskellPlaygroundServiceErrorKind } from "./client";

/**
 * Renders normalized run results as prefixed console lines for the runtime
 * dock's console state (RuntimePanelRecordingState.consoleLines). This is the
 * implementation-neutral shape that recordings capture and playback replays —
 * no Playground- or Worker-specific detail leaks into the recorded lines.
 *
 * The started line names `runghc Main.hs` because that is the command a
 * learner would run on their own machine to get the same result, and there is
 * no format line to pair it with: the upstream service has no formatter.
 */

export function haskellRunStartedConsoleLines(): string[] {
  return ["[haskell-run] runghc Main.hs"];
}

function splitOutputLines(output: string): string[] {
  const trimmed = output.replace(/\n+$/, "");
  return trimmed ? trimmed.split("\n") : [];
}

export function haskellRunResultToConsoleLines(result: HaskellPlaygroundRunResult): string[] {
  if (result.status === "compile-error") {
    // Nothing ran, so there is no exit line to print — the diagnostics are the
    // whole story, and GHC writes them with their own file, line, and caret.
    return ["[haskell-run error] Build failed", ...splitOutputLines(result.compileErrors ?? "")];
  }

  const lines: string[] = [];

  // Compiler warnings render before and separately from program output, each
  // line carrying its own prefix so the two streams can't be conflated. GHC is
  // talkative here — an incomplete pattern match warns even when the run
  // succeeds — and a learner needs to see whose voice a line is in.
  if (result.warnings?.trim()) {
    lines.push("[haskell-warn] The compiler reported warnings");
    lines.push(...splitOutputLines(result.warnings).map((line) => `[haskell-warn] ${line}`));
  }

  const outputLines = [...splitOutputLines(result.stdout), ...splitOutputLines(result.stderr)];
  lines.push(...(outputLines.length > 0 ? outputLines : ["[haskell-run] (no output)"]));

  lines.push(
    result.status === "runtime-error"
      ? `[haskell-run error] ${result.exitDetail ?? "Program failed"}`
      : "[haskell-run] Program exited",
  );

  return lines;
}

const SERVICE_ERROR_LINES: Record<Exclude<HaskellPlaygroundServiceErrorKind, "aborted">, string> = {
  unauthenticated: "[haskell-run error] Sign in to run Haskell code. Your edits are kept",
  disabled: "[haskell-run error] Live Run is currently disabled. Editing and playback still work",
  "rate-limited": "[haskell-run error] Too many runs — wait a minute and try again",
  timeout: "[haskell-run error] The program took too long to compile and run",
  "invalid-source": "[haskell-run error] This program can't run in a Haskell lesson",
  unavailable:
    "[haskell-run error] The Haskell Playground service is unavailable right now — your code is unchanged, try again shortly",
};

export function haskellRunServiceErrorToConsoleLines(
  kind: Exclude<HaskellPlaygroundServiceErrorKind, "aborted">,
  detail?: string,
): string[] {
  const lines = [SERVICE_ERROR_LINES[kind]];
  if (kind === "invalid-source" && detail) {
    lines.push(detail);
  }
  return lines;
}
