import { describe, expect, it } from "vite-plus/test";
import {
  serviceErrorConsoleLines,
  splitOutputLines,
  summarizeFilePaths,
} from "./playgroundConsole";

describe("splitOutputLines", () => {
  it("drops trailing newlines and keeps every blank line inside the output", () => {
    expect(splitOutputLines("one\n\ntwo\n\n\n")).toEqual(["one", "", "two"]);
    expect(splitOutputLines("\n\n")).toEqual([]);
    expect(splitOutputLines("")).toEqual([]);
  });
});

describe("summarizeFilePaths", () => {
  it("names up to four files, then three and a count", () => {
    expect(summarizeFilePaths(["a.go", "b.go", "c.go", "d.go"])).toBe("a.go b.go c.go d.go");
    expect(summarizeFilePaths(["a.go", "b.go", "c.go", "d.go", "e.go"])).toBe(
      "a.go b.go c.go … (5 files)",
    );
  });
});

describe("serviceErrorConsoleLines", () => {
  const LINES = {
    "invalid-source": "[x-run error] This program can't run here",
    timeout: "[x-run error] The program took too long",
  };

  it("adds the service's detail only for a program it refused", () => {
    expect(serviceErrorConsoleLines(LINES, "invalid-source", "line 3: bad import")).toEqual([
      "[x-run error] This program can't run here",
      "line 3: bad import",
    ]);
    expect(serviceErrorConsoleLines(LINES, "timeout", "after 10s")).toEqual([
      "[x-run error] The program took too long",
    ]);
    expect(serviceErrorConsoleLines(LINES, "invalid-source")).toEqual([
      "[x-run error] This program can't run here",
    ]);
  });
});
