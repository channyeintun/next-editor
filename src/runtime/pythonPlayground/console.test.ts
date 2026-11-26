import { describe, expect, it } from "vite-plus/test";
import {
  PYTHON_CONSOLE_TAG_PATTERN,
  pythonRunResultToConsoleLines,
  pythonRunServiceErrorToConsoleLines,
  pythonRunStartedConsoleLines,
} from "./console";

const file = (path: string) => ({ path, content: "" });

describe("pythonRunStartedConsoleLines", () => {
  it("names the script the run starts from, as the command a person would type", () => {
    expect(pythonRunStartedConsoleLines([file("main.py"), file("helpers.py")])).toEqual([
      "[python-run] python main.py",
    ]);
    expect(pythonRunStartedConsoleLines([file("scores.csv"), file("report.py")])).toEqual([
      "[python-run] python report.py",
    ]);
    expect(pythonRunStartedConsoleLines([file("app/main.py"), file("app/db.py")])).toEqual([
      "[python-run] python app/main.py",
    ]);
  });

  it("names main.py for a workspace the client is about to refuse", () => {
    expect(pythonRunStartedConsoleLines([])).toEqual(["[python-run] python main.py"]);
    expect(pythonRunStartedConsoleLines([file("a.py"), file("b.py")])).toEqual([
      "[python-run] python main.py",
    ]);
  });
});

describe("pythonRunResultToConsoleLines", () => {
  it("prints a clean run's output and says it exited", () => {
    expect(pythonRunResultToConsoleLines({ status: "success", output: "one\ntwo\n" })).toEqual([
      "one",
      "two",
      "[python-run] Program exited",
    ]);
  });

  it("says so when a program printed nothing", () => {
    expect(pythonRunResultToConsoleLines({ status: "success", output: "" })).toEqual([
      "[python-run] (no output)",
      "[python-run] Program exited",
    ]);
  });

  it("prints a failed run's traceback as output, then its exit status", () => {
    expect(
      pythonRunResultToConsoleLines({
        status: "runtime-error",
        output: "before\nTraceback (most recent call last):\nZeroDivisionError: division by zero\n",
        exitCode: 1,
      }),
    ).toEqual([
      "before",
      "Traceback (most recent call last):",
      "ZeroDivisionError: division by zero",
      "[python-run error] Program exited with status 1",
    ]);
  });

  it("puts the hint between the traceback it explains and the exit line", () => {
    expect(
      pythonRunResultToConsoleLines({
        status: "runtime-error",
        output: "EOFError: EOF when reading a line\n",
        exitCode: 1,
        hint: "input() has nothing to read",
      }),
    ).toEqual([
      "EOFError: EOF when reading a line",
      "[python-run] input() has nothing to read",
      "[python-run error] Program exited with status 1",
    ]);
  });

  it("gives the runner's reason when it stopped the program", () => {
    expect(
      pythonRunResultToConsoleLines({
        status: "runtime-error",
        output: "spam\n",
        exitDetail: "The program printed too much",
      }),
    ).toEqual(["spam", "[python-run error] The program printed too much"]);
  });

  it("renders the most a program may print without overflowing a call", () => {
    const lines = pythonRunResultToConsoleLines({
      status: "success",
      output: "x\n".repeat(131_072),
    });
    expect(lines).toHaveLength(131_073);
  });

  it("colours its own lines and none of the program's", () => {
    const lines = pythonRunResultToConsoleLines({
      status: "runtime-error",
      output: "[1, 2, 3]\n['python-run']\n",
      exitCode: 2,
      hint: "a hint",
    });
    expect(lines.map((line) => PYTHON_CONSOLE_TAG_PATTERN.test(line))).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });
});

describe("pythonRunServiceErrorToConsoleLines", () => {
  it("says why a workspace cannot run, with the client's own detail", () => {
    expect(
      pythonRunServiceErrorToConsoleLines("invalid-source", "Add a .py file to run this lesson"),
    ).toEqual([
      "[python-run error] This program can't run in a Python lesson",
      "Add a .py file to run this lesson",
    ]);
  });

  it("keeps a failed load to one line: its detail tells a learner nothing to change", () => {
    expect(pythonRunServiceErrorToConsoleLines("unavailable", "chunk failed")).toEqual([
      "[python-run error] Python could not be loaded — your code is unchanged, try again shortly",
    ]);
  });
});
