import { describe, expect, it } from "vitest";
import {
  HASKELL_CONSOLE_TAG_PATTERN,
  haskellRunResultToConsoleLines,
  haskellRunServiceErrorToConsoleLines,
  haskellRunStartedConsoleLines,
} from "./console";
import type { HaskellPlaygroundRunResult } from "./types";

describe("haskellRunResultToConsoleLines", () => {
  it("prints program output followed by a clean exit line", () => {
    const result: HaskellPlaygroundRunResult = {
      status: "success",
      stdout: "Squares: [1,4,9,16,25]\nFirst even square: 4\n",
      stderr: "",
    };

    expect(haskellRunResultToConsoleLines(result)).toEqual([
      "Squares: [1,4,9,16,25]",
      "First even square: 4",
      "[haskell-run] Program exited",
    ]);
  });

  it("prints stdout first and stderr after it", () => {
    // Upstream hands back the two streams separately, so their interleaving is
    // already lost; concatenating in this fixed order at least makes the
    // console deterministic instead of pretending to know which came first.
    const result: HaskellPlaygroundRunResult = {
      status: "success",
      stdout: "to stdout\n",
      stderr: "to stderr\n",
    };

    expect(haskellRunResultToConsoleLines(result)).toEqual([
      "to stdout",
      "to stderr",
      "[haskell-run] Program exited",
    ]);
  });

  it("says so explicitly when a program printed nothing", () => {
    // A Haskell program that only evaluates is easy to write by accident, and
    // a blank console reads as a broken runner rather than a silent program.
    expect(haskellRunResultToConsoleLines({ status: "success", stdout: "", stderr: "" })).toEqual([
      "[haskell-run] (no output)",
      "[haskell-run] Program exited",
    ]);
  });

  it("puts compiler warnings in their own prefixed block above the output", () => {
    const result: HaskellPlaygroundRunResult = {
      status: "success",
      stdout: "5\n",
      stderr: "",
      warnings:
        "Main.hs:6:10: warning: [GHC-06201] Pattern match(es) are non-exhaustive\n    In an equation for 'headOf'\n",
    };

    expect(haskellRunResultToConsoleLines(result)).toEqual([
      "[haskell-warn] The compiler reported warnings",
      "[haskell-warn] Main.hs:6:10: warning: [GHC-06201] Pattern match(es) are non-exhaustive",
      "[haskell-warn]     In an equation for 'headOf'",
      "5",
      "[haskell-run] Program exited",
    ]);
  });

  it("shows compiler diagnostics under a build-failed line and no exit line", () => {
    const result: HaskellPlaygroundRunResult = {
      status: "compile-error",
      stdout: "",
      stderr: "",
      compileErrors:
        "Main.hs:2:22: error: [GHC-83865]\n    Couldn't match type 'Int' with '[Char]'\n",
    };

    expect(haskellRunResultToConsoleLines(result)).toEqual([
      "[haskell-run error] Build failed",
      "Main.hs:2:22: error: [GHC-83865]",
      "    Couldn't match type 'Int' with '[Char]'",
    ]);
  });

  it("keeps the output a crashed program printed, then names the failure", () => {
    // The exception report GHC's runtime prints arrives on stderr, so it is
    // part of the program's output rather than a separate channel.
    const result: HaskellPlaygroundRunResult = {
      status: "runtime-error",
      stdout: "counting up\n",
      stderr: "Main: Prelude.head: empty list\n",
      warnings: "Main.hs:2:8: warning: [GHC-63394] In the use of 'head'\n",
      exitDetail: "Exited with status 1",
    };

    expect(haskellRunResultToConsoleLines(result)).toEqual([
      "[haskell-warn] The compiler reported warnings",
      "[haskell-warn] Main.hs:2:8: warning: [GHC-63394] In the use of 'head'",
      "counting up",
      "Main: Prelude.head: empty list",
      "[haskell-run error] Exited with status 1",
    ]);
  });

  it("trims only trailing blank lines, never interior ones", () => {
    expect(
      haskellRunResultToConsoleLines({ status: "success", stdout: "a\n\nb\n\n\n", stderr: "" }),
    ).toEqual(["a", "", "b", "[haskell-run] Program exited"]);
  });

  it("keeps GHC's blank separator between two warnings unprefixed", () => {
    // Two default-on -Wx-partial diagnostics (a `head` and a `tail` in one
    // program) arrive as one string with a blank line between them; prefixing
    // that blank would paint a tag with nothing after it.
    const result: HaskellPlaygroundRunResult = {
      status: "success",
      stdout: "1\n",
      stderr: "",
      warnings:
        "Main.hs:3:10: warning: [GHC-63394] [-Wx-partial]\n    In the use of 'head'\n\nMain.hs:4:10: warning: [GHC-63394] [-Wx-partial]\n    In the use of 'tail'\n",
    };

    expect(haskellRunResultToConsoleLines(result)).toEqual([
      "[haskell-warn] The compiler reported warnings",
      "[haskell-warn] Main.hs:3:10: warning: [GHC-63394] [-Wx-partial]",
      "[haskell-warn]     In the use of 'head'",
      "",
      "[haskell-warn] Main.hs:4:10: warning: [GHC-63394] [-Wx-partial]",
      "[haskell-warn]     In the use of 'tail'",
      "1",
      "[haskell-run] Program exited",
    ]);
  });

  it("trims a long run of trailing newlines without stalling the tab", () => {
    // `putStr (replicate 99999 '\n' ++ "x")` fits under the upstream 100,000
    // byte per-stream cap. A greedy /\n+$/ takes ~14s on this shape in V8, so
    // the default 5s test timeout is the assertion that the trim is linear.
    const stdout = `${"\n".repeat(100_000)}x`;

    expect(haskellRunResultToConsoleLines({ status: "success", stdout, stderr: "" })).toEqual([
      ...Array.from({ length: 100_000 }, () => ""),
      "x",
      "[haskell-run] Program exited",
    ]);
  });
});

describe("haskell console labels", () => {
  it("names the command a learner would run themselves", () => {
    expect(haskellRunStartedConsoleLines()).toEqual(["[haskell-run] runghc Main.hs"]);
  });

  it("explains a rate limit in terms the learner can act on", () => {
    expect(haskellRunServiceErrorToConsoleLines("rate-limited")).toEqual([
      "[haskell-run error] Too many runs — wait a minute and try again",
    ]);
  });

  it("attaches the detail only for an invalid-source failure", () => {
    expect(
      haskellRunServiceErrorToConsoleLines("invalid-source", "Haskell lessons run one Main.hs"),
    ).toEqual([
      "[haskell-run error] This program can't run in a Haskell lesson",
      "Haskell lessons run one Main.hs",
    ]);
    expect(haskellRunServiceErrorToConsoleLines("timeout", "ignored")).toEqual([
      "[haskell-run error] The program took too long to compile and run",
    ]);
  });

  it("keeps every failure kind's copy pointed at what the learner should do next", () => {
    expect(haskellRunServiceErrorToConsoleLines("unauthenticated")).toEqual([
      "[haskell-run error] Sign in to run Haskell code. Your edits are kept",
    ]);
    expect(haskellRunServiceErrorToConsoleLines("disabled")).toEqual([
      "[haskell-run error] Live Run is currently disabled. Editing and playback still work",
    ]);
    expect(haskellRunServiceErrorToConsoleLines("unavailable")).toEqual([
      "[haskell-run error] The Haskell Playground service is unavailable right now — your code is unchanged, try again shortly",
    ]);
  });
});

describe("HASKELL_CONSOLE_TAG_PATTERN", () => {
  it("matches every tag this module emits", () => {
    for (const line of [
      ...haskellRunStartedConsoleLines(),
      ...haskellRunServiceErrorToConsoleLines("timeout"),
      "[haskell-warn] The compiler reported warnings",
      "[haskell-run] (no output)",
    ]) {
      expect(HASKELL_CONSOLE_TAG_PATTERN.test(line)).toBe(true);
    }
  });

  it("leaves a printed list alone", () => {
    // `print [1,2,3]` is the most ordinary line a Haskell program can emit, and
    // the panel colours whatever this matches and dims the rest of the line.
    expect(HASKELL_CONSOLE_TAG_PATTERN.test("[1,2,3]")).toBe(false);
    expect(HASKELL_CONSOLE_TAG_PATTERN.test("[[1,2],[3]]")).toBe(false);
    expect(HASKELL_CONSOLE_TAG_PATTERN.test("[error: bad input]")).toBe(false);
  });
});
