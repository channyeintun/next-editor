import { describe, expect, it } from "vite-plus/test";
import { parsePythonPlaygroundRunResult } from "./types";

describe("parsePythonPlaygroundRunResult", () => {
  it.each([
    [{ status: "success", output: "hi\n" }],
    [{ status: "success", output: "", exitCode: 0 }],
    [{ status: "runtime-error", output: "Traceback…\n", exitCode: 1 }],
    [{ status: "runtime-error", output: "Traceback…\n", exitCode: 1, hint: "nothing to read" }],
    [{ status: "runtime-error", output: "spam\n", exitDetail: "printed too much" }],
    // A session: each line the program read is echoed after its prompt.
    [{ status: "success", output: "Name: Chan\nAge: 29\nHello, Chan\n", stdin: ["Chan", "29"] }],
    [{ status: "success", output: "\n\n", stdin: ["", ""] }],
    [{ status: "runtime-error", output: "Name: Chan\nBoom\n", stdin: ["Chan"], exitCode: 1 }],
    // The runner cut the output, perhaps before an echo, so it is not held to one.
    [{ status: "runtime-error", output: "spam\n", stdin: ["Chan"], exitDetail: "too much" }],
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
    ["a hint on a clean run", { status: "success", output: "", hint: "nothing to read" }],
    [
      "a hint on a run the runner stopped",
      { status: "runtime-error", output: "", exitDetail: "stopped", hint: "nothing to read" },
    ],
    ["a blank hint", { status: "runtime-error", output: "", exitCode: 1, hint: "" }],
    ["input that is not a list", { status: "success", output: "Chan\n", stdin: "Chan" }],
    ["a list of input with no line in it", { status: "success", output: "", stdin: [] }],
    ["a line of input that is not text", { status: "success", output: "4\n", stdin: [4] }],
    ["two lines of input in one", { status: "success", output: "a\nb\n", stdin: ["a\nb"] }],
    // The line was changed in one field and not in the other.
    [
      "a line the output never echoes",
      { status: "success", output: "Name: Chan\n", stdin: ["Aung"] },
    ],
    [
      "lines the output echoes in another order",
      { status: "success", output: "one\ntwo\n", stdin: ["two", "one"] },
    ],
    [
      "a line echoed once but read twice",
      { status: "success", output: "yes\n", stdin: ["yes", "yes"] },
    ],
  ])("refuses %s", (_label, result) => {
    expect(parsePythonPlaygroundRunResult(result)).toBeNull();
  });
});
