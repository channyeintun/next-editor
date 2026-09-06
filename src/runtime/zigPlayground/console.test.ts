import { describe, expect, it } from "vitest";
import {
  ZIG_CONSOLE_TAG_PATTERN,
  zigFormatResultToConsoleLines,
  zigFormatServiceErrorToConsoleLines,
  zigFormatStaleConsoleLines,
  zigFormatStartedConsoleLines,
  zigRunResultToConsoleLines,
  zigRunServiceErrorToConsoleLines,
  zigRunStartedConsoleLines,
} from "./console";
import type { ZigPlaygroundRunResult } from "./types";

describe("zigRunResultToConsoleLines", () => {
  it("prints program output followed by a clean exit line", () => {
    const result: ZigPlaygroundRunResult = {
      status: "success",
      output: "Squares: { 1, 4, 9, 16, 25 }\nFirst even square: 4\n",
    };

    expect(zigRunResultToConsoleLines(result)).toEqual([
      "Squares: { 1, 4, 9, 16, 25 }",
      "First even square: 4",
      "[zig-run] Program exited",
    ]);
  });

  it("says so explicitly when a program printed nothing", () => {
    // A Zig program that only computes is easy to write by accident, and a
    // blank console reads as a broken runner rather than a silent program.
    expect(zigRunResultToConsoleLines({ status: "success", output: "" })).toEqual([
      "[zig-run] (no output)",
      "[zig-run] Program exited",
    ]);
  });

  it("shows compiler diagnostics under a build-failed line and no exit line", () => {
    const result: ZigPlaygroundRunResult = {
      status: "compile-error",
      output: "",
      compileErrors: "main.zig:3:5: error: expected ';' after statement\n    var x = 1\n",
    };

    expect(zigRunResultToConsoleLines(result)).toEqual([
      "[zig-run error] Build failed",
      "main.zig:3:5: error: expected ';' after statement",
      "    var x = 1",
    ]);
  });

  it("keeps the output a crashed program printed, then names the failure", () => {
    const result: ZigPlaygroundRunResult = {
      status: "runtime-error",
      output:
        "counting up\nthread 1 panic: integer overflow\nmain.zig:5:23: 0xabc in main (main.zig)\n",
      exitDetail: "panic: integer overflow",
    };

    expect(zigRunResultToConsoleLines(result)).toEqual([
      "counting up",
      "thread 1 panic: integer overflow",
      "main.zig:5:23: 0xabc in main (main.zig)",
      "[zig-run error] panic: integer overflow",
    ]);
  });

  it("trims only trailing blank lines, never interior ones", () => {
    expect(zigRunResultToConsoleLines({ status: "success", output: "a\n\nb\n\n\n" })).toEqual([
      "a",
      "",
      "b",
      "[zig-run] Program exited",
    ]);
  });

  it("trims a long run of trailing newlines without stalling the tab", () => {
    // A loop that prints a blank line per iteration and then one summary line:
    // the shape a greedy /\n+$/ retries from every newline in the run. The
    // Worker caps a stream at 256 KiB, so this is well inside what a learner
    // can produce, and the default 5s timeout is the assertion that the trim
    // is linear — the old regex took ~14s on it.
    const output = `${"\n".repeat(100_000)}done`;

    expect(zigRunResultToConsoleLines({ status: "success", output })).toEqual([
      ...Array.from({ length: 100_000 }, () => ""),
      "done",
      "[zig-run] Program exited",
    ]);
  });
});

describe("zig console labels", () => {
  it("names the command a learner would run themselves", () => {
    expect(zigRunStartedConsoleLines()).toEqual(["[zig-run] zig run main.zig"]);
  });

  it("distinguishes a formatting change from a no-op", () => {
    expect(zigFormatResultToConsoleLines(true)).toEqual(["[zig-fmt] Formatted main.zig"]);
    expect(zigFormatResultToConsoleLines(false)).toEqual([
      "[zig-fmt] main.zig is already formatted",
    ]);
  });

  it("explains a rate limit in terms the learner can act on", () => {
    expect(zigRunServiceErrorToConsoleLines("rate-limited")).toEqual([
      "[zig-run error] Too many runs — wait a minute and try again",
    ]);
  });

  it("attaches the detail only for an invalid-source failure", () => {
    expect(
      zigRunServiceErrorToConsoleLines("invalid-source", "Zig lessons run one main.zig"),
    ).toEqual([
      "[zig-run error] This program can't run in a Zig lesson",
      "Zig lessons run one main.zig",
    ]);
    expect(zigRunServiceErrorToConsoleLines("timeout", "ignored")).toEqual([
      "[zig-run error] The program took too long to compile and run",
    ]);
  });

  it("names the format command a learner would run themselves", () => {
    expect(zigFormatStartedConsoleLines()).toEqual(["[zig-fmt] zig fmt main.zig"]);
  });

  it("says a stale format applied nothing", () => {
    expect(zigFormatStaleConsoleLines()[0]).toContain("no formatting was applied");
  });

  // The format table is a second, independent copy of the run table, so a
  // run-side string pasted into it — the plausible slip when the two are
  // edited together — would otherwise reach the console unnoticed.
  it("tags every format failure as zig-fmt, never zig-run", () => {
    for (const kind of [
      "unauthenticated",
      "disabled",
      "rate-limited",
      "timeout",
      "invalid-source",
      "unavailable",
    ] as const) {
      expect(zigFormatServiceErrorToConsoleLines(kind)[0].startsWith("[zig-fmt error] ")).toBe(
        true,
      );
    }
  });

  it("attaches the fmt diagnostic only for an invalid-source failure", () => {
    expect(
      zigFormatServiceErrorToConsoleLines("invalid-source", "main.zig:2:1: error: expected ')'"),
    ).toEqual([
      "[zig-fmt error] zig fmt could not format this program",
      "main.zig:2:1: error: expected ')'",
    ]);
    expect(zigFormatServiceErrorToConsoleLines("unauthenticated", "ignored")).toEqual([
      "[zig-fmt error] Sign in to format Zig code. Your edits are kept",
    ]);
  });
});

describe("ZIG_CONSOLE_TAG_PATTERN", () => {
  it("matches every tag this module emits", () => {
    for (const line of [
      ...zigRunStartedConsoleLines(),
      ...zigFormatStartedConsoleLines(),
      ...zigRunServiceErrorToConsoleLines("timeout"),
      ...zigFormatServiceErrorToConsoleLines("timeout"),
      ...zigFormatStaleConsoleLines(),
    ]) {
      expect(ZIG_CONSOLE_TAG_PATTERN.test(line)).toBe(true);
    }
  });

  it("leaves a bracketed line the program printed itself alone", () => {
    // The panel colours what this matches and dims the rest of the line, so a
    // program's own output must not look like something the runner said.
    expect(ZIG_CONSOLE_TAG_PATTERN.test("[1, 2, 3]")).toBe(false);
    expect(ZIG_CONSOLE_TAG_PATTERN.test("[error: bad input]")).toBe(false);
  });
});
