import type { AsmPlaygroundRunResult } from "./types";
import type { AsmPlaygroundServiceErrorKind } from "./client";

/**
 * Renders normalized run results as prefixed console lines for the runtime
 * dock's console state (RuntimePanelRecordingState.consoleLines). This is the
 * implementation-neutral shape recordings capture and playback replays — no
 * detail of how the machine works leaks into the recorded lines.
 *
 * The started line names `nasm` and `ld` because that is the command a person
 * would run to do the same thing on their own computer, and it is the pair the
 * lesson is teaching them to reach for. The service-error table is two entries
 * rather than six: an assembly lesson has no service to be signed out of,
 * throttled by, or cut off from.
 */

/**
 * The tags this module emits, as the pattern the runner panel colours by. It
 * lives beside the builders rather than in the panel so the two are read
 * together: a tag added here without the pattern silently loses its colour, and
 * a pattern loose enough to match any `[...]` head paints a program's own
 * bracketed line — a memory dump, say — as if the runner had said it.
 */
export const ASM_CONSOLE_TAG_PATTERN = /^\[asm-run(?: error)?\]/;

export function asmRunStartedConsoleLines(): string[] {
  return ["[asm-run] nasm -f elf64 main.asm && ld -o main main.o && ./main"];
}

function splitOutputLines(output: string): string[] {
  // Trimmed with a loop rather than `/\n+$/`, which backtracks quadratically
  // over a long run of newlines that is *not* at the end of the string. The
  // machine here is in the page with a 256 KiB output budget, so one buggy
  // loop that prints a blank line per iteration and then a summary hands this
  // helper a quarter of a million newlines and freezes the tab for a minute.
  let end = output.length;
  while (end > 0 && output[end - 1] === "\n") end -= 1;
  const trimmed = output.slice(0, end);
  return trimmed ? trimmed.split("\n") : [];
}

export function asmRunResultToConsoleLines(result: AsmPlaygroundRunResult): string[] {
  if (result.status === "assemble-error") {
    // The diagnostics carry their own file, line and caret, so they are shown
    // as the assembler wrote them rather than summarised.
    return ["[asm-run error] Assembly failed", ...splitOutputLines(result.assembleErrors ?? "")];
  }

  // Concatenated rather than spread into `push`: a spread call is capped at
  // roughly 125,000 arguments, and 256 KiB of two-byte lines is more than
  // that. The proxied runners cannot reach the cap because their services cut
  // the output first; this machine prints straight into the page.
  const outputLines = splitOutputLines(result.stdout).concat(splitOutputLines(result.stderr));
  const lines: string[] = outputLines.length > 0 ? outputLines : ["[asm-run] (no output)"];

  if (result.status === "runtime-error") {
    lines.push(`[asm-run error] ${result.exitDetail ?? "The program stopped"}`);
    return lines;
  }

  // The exit status is the program's own answer, so it is always shown — a
  // program that exits 1 has said something, and hiding it would lose it.
  lines.push(`[asm-run] Program exited with status ${result.exitCode ?? 0}`);
  return lines;
}

/**
 * The registers the program changed, rendered for the console.
 *
 * Assembly is the one language here whose lessons are usually *about* the
 * registers, so a run can print them. The client has already narrowed this to
 * what the program actually touched — sixteen rows, most of them zero, teach
 * nothing, and the four or five that moved are the whole story.
 */
export function asmRegisterConsoleLines(result: AsmPlaygroundRunResult): string[] {
  const registers = result.registers ?? [];
  if (registers.length === 0) return [];

  const cells = registers.map((entry) => {
    const value = BigInt(entry.value);
    return `${entry.name}=0x${value.toString(16)}`;
  });

  const rows: string[] = [];
  for (let index = 0; index < cells.length; index += 4) {
    rows.push(`[asm-run] ${cells.slice(index, index + 4).join("  ")}`);
  }
  return rows;
}

const SERVICE_ERROR_LINES: Record<Exclude<AsmPlaygroundServiceErrorKind, "aborted">, string> = {
  "invalid-source": "[asm-run error] This program can't run in an assembly lesson",
  unavailable:
    "[asm-run error] The assembler stopped unexpectedly — your code is unchanged, try again",
};

export function asmRunServiceErrorToConsoleLines(
  kind: Exclude<AsmPlaygroundServiceErrorKind, "aborted">,
  detail?: string,
): string[] {
  // The studio's shared retry engine normalizes *any* playground failure into
  // a kind string, including "timeout" — a kind this runner cannot produce but
  // that the engine can synthesize from its own deadline. Looking that up here
  // would yield `undefined`, and a console line of `undefined` reaches the
  // shared store's `lines[0].startsWith(...)` and throws. The fallback keeps a
  // failure a failure rather than turning it into a crash.
  const lines = [
    SERVICE_ERROR_LINES[kind] ??
      `[asm-run error] The run could not be completed${detail ? ` (${detail})` : ""}`,
  ];
  if (kind === "invalid-source" && detail) {
    lines.push(detail);
  }
  return lines;
}
