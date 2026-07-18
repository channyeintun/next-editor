import { describe, expect, it } from "vitest";
import {
  goRunResultToConsoleLines,
  goRunServiceErrorToConsoleLines,
  goRunStartedConsoleLines,
} from "./console";

describe("goRunStartedConsoleLines", () => {
  it("echoes the run action for the recorded console", () => {
    expect(goRunStartedConsoleLines("main.go")).toEqual(["[go-run] go run main.go"]);
  });
});

describe("goRunResultToConsoleLines", () => {
  it("renders successful output followed by the exit line", () => {
    expect(
      goRunResultToConsoleLines({ status: "success", output: "one\ntwo\n", exitCode: 0 }),
    ).toEqual(["one", "two", "[go-run] Program exited"]);
  });

  it("marks a run with no output explicitly", () => {
    expect(goRunResultToConsoleLines({ status: "success", output: "", exitCode: 0 })).toEqual([
      "[go-run] (no output)",
      "[go-run] Program exited",
    ]);
  });

  it("shows compiler diagnostics before anything else", () => {
    expect(
      goRunResultToConsoleLines({
        status: "compile-error",
        output: "",
        compileErrors: "prog.go:5:2: undefined: x\nprog.go:6:1: syntax error",
      }),
    ).toEqual([
      "[go-run error] Build failed",
      "prog.go:5:2: undefined: x",
      "prog.go:6:1: syntax error",
    ]);
  });

  it("keeps vet diagnostics prefixed and separate from program output", () => {
    expect(
      goRunResultToConsoleLines({
        status: "vet-error",
        output: "still ran\n",
        vetErrors: "prog.go:7:2: unreachable code",
        exitCode: 0,
      }),
    ).toEqual([
      "[go-vet] Vet found issues that need attention",
      "[go-vet] prog.go:7:2: unreachable code",
      "still ran",
      "[go-run] Program exited",
    ]);
  });

  it("reports panics and non-zero exits as errors with the exit status", () => {
    expect(
      goRunResultToConsoleLines({
        status: "runtime-error",
        output: "panic: boom\n",
        exitCode: 2,
      }),
    ).toEqual(["panic: boom", "[go-run error] Program exited with status 2"]);
  });

  it("shows vet diagnostics without hiding a runtime failure", () => {
    expect(
      goRunResultToConsoleLines({
        status: "runtime-error",
        output: "panic: boom\n",
        vetErrors: "prog.go:7:2: unreachable code",
        exitCode: 2,
      }),
    ).toEqual([
      "[go-vet] Vet found issues that need attention",
      "[go-vet] prog.go:7:2: unreachable code",
      "panic: boom",
      "[go-run error] Program exited with status 2",
    ]);
  });
});

describe("goRunServiceErrorToConsoleLines", () => {
  it("keeps service failures retryable-sounding and source-preserving", () => {
    const [line] = goRunServiceErrorToConsoleLines("unavailable");
    expect(line).toContain("your code is unchanged");
  });

  it("appends the server detail only for invalid-source rejections", () => {
    expect(goRunServiceErrorToConsoleLines("invalid-source", "needs package main")).toHaveLength(2);
    expect(goRunServiceErrorToConsoleLines("timeout", "ignored detail")).toHaveLength(1);
  });
});
