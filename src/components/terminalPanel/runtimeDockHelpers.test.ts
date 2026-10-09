import { describe, expect, it } from "vite-plus/test";
import {
  ANSI,
  colorizeTaggedLine,
  describeRunnerOutput,
  dockContentSizeClassName,
  dockRootSizeClassName,
  dockTabStateClassName,
} from "./runtimeDockHelpers";

describe("describeRunnerOutput", () => {
  it("shows the runner's output", () => {
    expect(
      describeRunnerOutput({ output: "ready on :5173", errorMessage: null, status: "ready" }),
    ).toBe("ready on :5173");
  });

  it("follows the output with a runtime error", () => {
    expect(
      describeRunnerOutput({ output: "compiling", errorMessage: "port in use", status: "error" }),
    ).toBe("compiling\n\nRuntime error\nport in use");
  });

  it("shows a runtime error on its own when there is no output", () => {
    expect(
      describeRunnerOutput({ output: null, errorMessage: "boot failed", status: "error" }),
    ).toBe("Runtime error\nboot failed");
  });

  it("says what the runtime is doing while there is neither output nor error", () => {
    expect(describeRunnerOutput({ output: null, errorMessage: null, status: "installing" })).toBe(
      "Installing dependencies inside the WebContainer...",
    );
    expect(describeRunnerOutput({ output: "", errorMessage: "", status: "starting" })).toBe(
      "Starting the workspace dev server...",
    );
    expect(describeRunnerOutput({ output: null, errorMessage: null, status: "idle" })).toBe(
      "Waiting for runtime output...",
    );
  });

  it("collapses runs of blank lines and trims the text", () => {
    expect(
      describeRunnerOutput({
        output: "\n  one\n\n\n\ntwo  \n\n\n",
        errorMessage: null,
        status: "ready",
      }),
    ).toBe("one\n\ntwo");
  });

  it("falls back to waiting when the output is only whitespace", () => {
    expect(describeRunnerOutput({ output: "\n\n  \n", errorMessage: null, status: "ready" })).toBe(
      "Waiting for runner output...",
    );
  });
});

describe("dockTabStateClassName", () => {
  it("underlines and lights the active tab, and dims the others until hovered", () => {
    expect(dockTabStateClassName(true)).toBe("border-b border-b-[#64a3ff] bg-[#171b22] text-white");
    expect(dockTabStateClassName(false)).toBe("text-slate-300 hover:bg-[#171b22] hover:text-white");
  });
});

describe("dock size classes", () => {
  it("grows the dock and its content into the column while the dock fills it", () => {
    expect(dockRootSizeClassName(true)).toBe("min-h-0 flex-1");
    expect(dockContentSizeClassName(true)).toBe("min-h-0 flex-1");
  });

  it("keeps the dock's own height and the content's fixed height otherwise", () => {
    expect(dockRootSizeClassName(false)).toBe("shrink-0");
    expect(dockContentSizeClassName(false)).toBe("h-72");
  });
});

describe("colorizeTaggedLine", () => {
  const TAG = /^\[(?:run|run error)\]/;
  const pick = (prefix: string) => (prefix.includes("error") ? ANSI.red : ANSI.green);

  it("colours the tag, then dims the rest of the line", () => {
    expect(colorizeTaggedLine("[run] Program exited.", TAG, pick)).toBe(
      "\u001b[92m[run]\u001b[0m\u001b[90m Program exited.\u001b[0m",
    );
    expect(colorizeTaggedLine("[run error] timed out", TAG, pick)).toBe(
      `${ANSI.red}[run error]${ANSI.reset}${ANSI.dim} timed out${ANSI.reset}`,
    );
  });

  it("returns an untagged line verbatim", () => {
    expect(colorizeTaggedLine("hello, world", TAG, pick)).toBe("hello, world");
  });

  it("leaves a line alone when its bracketed start is not one of the tags", () => {
    expect(colorizeTaggedLine("[1 2 3]", TAG, pick)).toBe("[1 2 3]");
  });

  it("passes the tag as written to the colour picker", () => {
    const seen: string[] = [];
    colorizeTaggedLine("[Runtime] ready", /^\[[^\]]+\]/, (prefix) => {
      seen.push(prefix);
      return ANSI.cyan;
    });
    expect(seen).toEqual(["[Runtime]"]);
  });
});
