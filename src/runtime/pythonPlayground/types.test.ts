import { describe, expect, it } from "vite-plus/test";
import { parsePythonPlaygroundRunResult } from "./types";

describe("parsePythonPlaygroundRunResult", () => {
  it.each([
    [{ status: "success", output: "hi\n" }],
    [{ status: "success", output: "", exitCode: 0 }],
    [{ status: "runtime-error", output: "Traceback…\n", exitCode: 1 }],
    [{ status: "runtime-error", output: "Traceback…\n", exitCode: 1, hint: "no keyboard" }],
    [{ status: "runtime-error", output: "spam\n", exitDetail: "printed too much" }],
  ])("accepts %j as it is", (result) => {
    expect(parsePythonPlaygroundRunResult(result)).toEqual(result);
  });

  it("drops fields the contract does not name", () => {
    expect(
      parsePythonPlaygroundRunResult({ status: "success", output: "hi\n", stdout: "hi\n" }),
    ).toEqual({ status: "success", output: "hi\n" });
  });

  it.each([
    ["no object", null],
    ["an unknown status", { status: "compile-error", output: "" }],
    ["output that is not text", { status: "success", output: 3 }],
    ["a clean run with a failing status", { status: "success", output: "", exitCode: 1 }],
    ["a clean run the runner stopped", { status: "success", output: "", exitDetail: "stopped" }],
    ["a failed run that ended no way at all", { status: "runtime-error", output: "" }],
    ["a failed run that exited 0", { status: "runtime-error", output: "", exitCode: 0 }],
    [
      "a failed run that both exited and was stopped",
      { status: "runtime-error", output: "", exitCode: 1, exitDetail: "stopped" },
    ],
    ["a blank reason for stopping", { status: "runtime-error", output: "", exitDetail: " " }],
    ["a status that is not a whole number", { status: "runtime-error", output: "", exitCode: 1.5 }],
    ["a hint on a clean run", { status: "success", output: "", hint: "no keyboard" }],
    [
      "a hint on a run the runner stopped",
      { status: "runtime-error", output: "", exitDetail: "stopped", hint: "no keyboard" },
    ],
    ["a blank hint", { status: "runtime-error", output: "", exitCode: 1, hint: "" }],
  ])("refuses %s", (_label, result) => {
    expect(parsePythonPlaygroundRunResult(result)).toBeNull();
  });
});
