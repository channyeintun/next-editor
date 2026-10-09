import { describe, expect, it } from "vite-plus/test";
import { describeRunnerOutput, dockTabStateClassName } from "./runtimeDockHelpers";

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
