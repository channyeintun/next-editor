import { describe, expect, it } from "vitest";
import {
  ASM_CONSOLE_TAG_PATTERN,
  asmRegisterConsoleLines,
  asmRunResultToConsoleLines,
  asmRunServiceErrorToConsoleLines,
  asmRunStartedConsoleLines,
} from "./console";
import { OPERATION_START_PREFIXES } from "../playgroundConsoleStore";

describe("asm console lines", () => {
  it("opens with the command a person would run on their own machine", () => {
    const [line] = asmRunStartedConsoleLines();
    expect(line).toContain("nasm -f elf64 main.asm");
    // The shared store gives a blank separator to lines it recognizes as the
    // start of an operation; a prefix missing there drops it for asm only.
    expect(OPERATION_START_PREFIXES.some((prefix) => line.startsWith(prefix))).toBe(true);
  });

  it("shows program output then the exit status", () => {
    expect(
      asmRunResultToConsoleLines({
        status: "success",
        stdout: "one\ntwo\n",
        stderr: "",
        exitCode: 0,
      }),
    ).toEqual(["one", "two", "[asm-run] Program exited with status 0"]);
  });

  it("keeps a non-zero exit visible", () => {
    expect(
      asmRunResultToConsoleLines({ status: "success", stdout: "", stderr: "", exitCode: 3 }),
    ).toEqual(["[asm-run] (no output)", "[asm-run] Program exited with status 3"]);
  });

  it("prints the assembler's own diagnostics under a failure line", () => {
    expect(
      asmRunResultToConsoleLines({
        status: "assemble-error",
        stdout: "",
        stderr: "",
        assembleErrors: "main.asm:4:9: error: nope\n  jmp gone\n        ^",
      }),
    ).toEqual([
      "[asm-run error] Assembly failed",
      "main.asm:4:9: error: nope",
      "  jmp gone",
      "        ^",
    ]);
  });

  it("keeps what a faulting program printed before it stopped", () => {
    expect(
      asmRunResultToConsoleLines({
        status: "runtime-error",
        stdout: "before\n",
        stderr: "",
        exitDetail: "The program divided by zero (main.asm:9)",
      }),
    ).toEqual(["before", "[asm-run error] The program divided by zero (main.asm:9)"]);
  });

  it("lists the registers it was given, four to a line, in hex", () => {
    const lines = asmRegisterConsoleLines({
      status: "success",
      stdout: "",
      stderr: "",
      registers: [
        { name: "rax", value: "60" },
        { name: "rdx", value: "255" },
        { name: "rsi", value: "4202496" },
        { name: "rdi", value: "1" },
        { name: "rsp", value: "16" },
      ],
    });

    expect(lines).toEqual([
      "[asm-run] rax=0x3c  rdx=0xff  rsi=0x402000  rdi=0x1",
      "[asm-run] rsp=0x10",
    ]);
  });

  it("says nothing when the program changed no register", () => {
    expect(
      asmRegisterConsoleLines({ status: "success", stdout: "", stderr: "", registers: [] }),
    ).toEqual([]);
  });

  it("renders more lines than a spread call can carry", () => {
    // 256 KiB of two-byte lines is ~131,000 lines, past the ~125,000-argument
    // spread-call limit — reachable from one runaway `write` loop.
    const lines = asmRunResultToConsoleLines({
      status: "success",
      stdout: "7\n".repeat(130_000),
      stderr: "",
      exitCode: 0,
    });

    expect(lines).toHaveLength(130_001);
    expect(lines[0]).toBe("7");
    expect(lines[130_000]).toBe("[asm-run] Program exited with status 0");
  });

  it("trims trailing newlines without backtracking over the ones before them", () => {
    // The blank-line-per-iteration loop followed by a summary: the shape that
    // made the old /\n+$/ trim quadratic. Under that trim this takes over 5s.
    const lines = asmRunResultToConsoleLines({
      status: "success",
      stdout: `${"\n".repeat(60_000)}done\n`,
      stderr: "",
      exitCode: 0,
    });

    expect(lines).toHaveLength(60_002);
    expect(lines[60_000]).toBe("done");
  }, 2_000);

  it("has no line for being signed out, throttled, or cut off", () => {
    // Two kinds, not six: there is no service to be any of those things.
    expect(asmRunServiceErrorToConsoleLines("unavailable")).toEqual([
      "[asm-run error] The assembler stopped unexpectedly — your code is unchanged, try again",
    ]);
    expect(asmRunServiceErrorToConsoleLines("invalid-source", "Name it main.asm")).toEqual([
      "[asm-run error] This program can't run in an assembly lesson",
      "Name it main.asm",
    ]);
  });

  it("still yields a string for a kind the studio engine can synthesize", () => {
    // liveAttempt (src/studio/playgroundRuntime.ts:172) turns its own deadline
    // into a "timeout" kind and casts it in, so this call really happens with a
    // kind outside the union. Without the fallback the store would be handed
    // `undefined` and `lines[0].startsWith(...)` would throw.
    const lines = asmRunServiceErrorToConsoleLines(
      "timeout" as never,
      "No response within 15000ms",
    );

    expect(lines).toEqual([
      "[asm-run error] The run could not be completed (No response within 15000ms)",
    ]);
  });
});

describe("ASM_CONSOLE_TAG_PATTERN", () => {
  it("matches every tag this module emits, register rows included", () => {
    for (const line of [
      ...asmRunStartedConsoleLines(),
      ...asmRunServiceErrorToConsoleLines("unavailable"),
      ...asmRegisterConsoleLines({
        status: "success",
        stdout: "",
        stderr: "",
        registers: [{ name: "rax", value: "60" }],
      }),
      "[asm-run] (no output)",
    ]) {
      expect(ASM_CONSOLE_TAG_PATTERN.test(line)).toBe(true);
    }
  });

  it("leaves a bracketed line the program printed itself alone", () => {
    // The panel colours what this matches and dims the rest of the line, so a
    // program's own output must not look like something the runner said.
    expect(ASM_CONSOLE_TAG_PATTERN.test("[0x402000] = 7")).toBe(false);
    expect(ASM_CONSOLE_TAG_PATTERN.test("[error: bad input]")).toBe(false);
  });
});
