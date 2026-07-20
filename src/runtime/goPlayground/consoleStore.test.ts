import { describe, expect, it } from "vite-plus/test";
import { createRuntimePanelStore } from "../../stores/runtimePanelStore";
import { MAX_GO_CONSOLE_LINES, appendGoConsoleLines } from "./consoleStore";

describe("appendGoConsoleLines", () => {
  it("appends lines and inserts a separator before a new operation", () => {
    const store = createRuntimePanelStore();
    appendGoConsoleLines(store, ["[go-run] go run main.go", "hello"]);
    appendGoConsoleLines(store, ["[go-run] go run main.go", "again"]);

    expect(store.getSnapshot().context.consoleLines).toEqual([
      "[go-run] go run main.go",
      "hello",
      "",
      "[go-run] go run main.go",
      "again",
    ]);
  });

  it("does not separate continuation output", () => {
    const store = createRuntimePanelStore();
    appendGoConsoleLines(store, ["[go-run] go run main.go"]);
    appendGoConsoleLines(store, ["program output"]);
    expect(store.getSnapshot().context.consoleLines).toEqual([
      "[go-run] go run main.go",
      "program output",
    ]);
  });

  it("ignores empty appends and caps the recorded scrollback", () => {
    const store = createRuntimePanelStore();
    appendGoConsoleLines(store, []);
    expect(store.getSnapshot().context.consoleLines).toEqual([]);

    appendGoConsoleLines(
      store,
      Array.from({ length: MAX_GO_CONSOLE_LINES + 50 }, (_, index) => `line ${index}`),
    );
    const lines = store.getSnapshot().context.consoleLines;
    expect(lines).toHaveLength(MAX_GO_CONSOLE_LINES);
    expect(lines.at(-1)).toBe(`line ${MAX_GO_CONSOLE_LINES + 49}`);
  });
});
