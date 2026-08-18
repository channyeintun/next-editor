import { describe, expect, it } from "vitest";
import {
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
});
