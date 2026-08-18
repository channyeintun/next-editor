import { describe, expect, it } from "vite-plus/test";
import { createRuntimePanelStore } from "../stores/runtimePanelStore";
import { goFormatStartedConsoleLines, goRunStartedConsoleLines } from "./goPlayground/console";
import {
  kiteFormatStartedConsoleLines,
  kiteRunStartedConsoleLines,
} from "./kitePlayground/console";
import { kotlinRunStartedConsoleLines } from "./kotlinPlayground/console";
import {
  rustFormatStartedConsoleLines,
  rustRunStartedConsoleLines,
} from "./rustPlayground/console";
import { zigFormatStartedConsoleLines, zigRunStartedConsoleLines } from "./zigPlayground/console";
import {
  MAX_RUNNER_CONSOLE_LINES,
  OPERATION_START_PREFIXES,
  appendRunnerConsoleLines,
} from "./playgroundConsoleStore";
import { isPlaygroundRuntimeKind, studioRuntimeSchema } from "../studio/plan";
import { runErrorPrefixFor } from "../studio/playgroundRuntime";

describe("appendRunnerConsoleLines", () => {
  it("appends lines and inserts a separator before a new operation", () => {
    const store = createRuntimePanelStore();
    appendRunnerConsoleLines(store, ["[go-run] go run main.go", "hello"]);
    appendRunnerConsoleLines(store, ["[go-run] go run main.go", "again"]);

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
    appendRunnerConsoleLines(store, ["[go-run] go run main.go"]);
    appendRunnerConsoleLines(store, ["program output"]);
    expect(store.getSnapshot().context.consoleLines).toEqual([
      "[go-run] go run main.go",
      "program output",
    ]);
  });

  it("ignores empty appends and caps the recorded scrollback", () => {
    const store = createRuntimePanelStore();
    appendRunnerConsoleLines(store, []);
    expect(store.getSnapshot().context.consoleLines).toEqual([]);

    appendRunnerConsoleLines(
      store,
      Array.from({ length: MAX_RUNNER_CONSOLE_LINES + 50 }, (_, index) => `line ${index}`),
    );
    const lines = store.getSnapshot().context.consoleLines;
    expect(lines).toHaveLength(MAX_RUNNER_CONSOLE_LINES);
    expect(lines.at(-1)).toBe(`line ${MAX_RUNNER_CONSOLE_LINES + 49}`);
  });

  // The studio driver appends every language's run lines through this one
  // module, so a language whose prefix is missing here loses the separator on
  // the rendered path while its own panel still inserts one.
  it.each([
    ["go run", goRunStartedConsoleLines(["main.go"])],
    ["gofmt", goFormatStartedConsoleLines(["main.go"])],
    ["kotlin run", kotlinRunStartedConsoleLines(["Main.kt"])],
    ["cargo run", rustRunStartedConsoleLines()],
    ["rustfmt", rustFormatStartedConsoleLines()],
    ["kitec run", kiteRunStartedConsoleLines()],
    ["kitec fmt", kiteFormatStartedConsoleLines()],
    ["zig run", zigRunStartedConsoleLines()],
    ["zig fmt", zigFormatStartedConsoleLines()],
  ])("separates a new %s operation", (_label, startedLines) => {
    const store = createRuntimePanelStore();
    appendRunnerConsoleLines(store, ["earlier output"]);
    appendRunnerConsoleLines(store, startedLines);

    expect(store.getSnapshot().context.consoleLines).toEqual([
      "earlier output",
      "",
      ...startedLines,
    ]);
  });

  // The list above is hand-written, which is exactly how Zig shipped without
  // a separator: its console module was added, its runner worked, and the
  // omission was invisible until a lesson ran twice. This derives the set of
  // playground languages from the plan schema instead, so a language added
  // later fails here rather than losing its separator quietly.
  it("has a start prefix for every playground runtime the schema allows", () => {
    const kinds = studioRuntimeSchema.options
      .map((option) => option.shape.kind.value as string)
      .filter((kind) => isPlaygroundRuntimeKind(kind));

    expect(kinds.length).toBeGreaterThan(0);

    const missing = kinds.filter((kind) => {
      // runErrorPrefixFor gives "[go-run error]"; the run prefix shares its head.
      const head = runErrorPrefixFor(kind).replace(" error]", "]");
      return !OPERATION_START_PREFIXES.some((prefix) => prefix.startsWith(head));
    });

    expect(missing, "playground runtimes with no console separator prefix").toEqual([]);
  });
});
