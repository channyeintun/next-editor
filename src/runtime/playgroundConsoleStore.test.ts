import { describe, expect, it } from "vite-plus/test";
import { createRuntimePanelStore } from "../stores/runtimePanelStore";
import { ASM_CONSOLE_TAG_PATTERN, asmRunStartedConsoleLines } from "./asmPlayground/console";
import {
  GO_CONSOLE_TAG_PATTERN,
  goFormatStartedConsoleLines,
  goRunStartedConsoleLines,
} from "./goPlayground/console";
import {
  HASKELL_CONSOLE_TAG_PATTERN,
  haskellRunStartedConsoleLines,
} from "./haskellPlayground/console";
import {
  KITE_CONSOLE_TAG_PATTERN,
  kiteFormatStartedConsoleLines,
  kiteRunStartedConsoleLines,
} from "./kitePlayground/console";
import {
  KOTLIN_CONSOLE_TAG_PATTERN,
  kotlinRunStartedConsoleLines,
} from "./kotlinPlayground/console";
import {
  RUST_CONSOLE_TAG_PATTERN,
  rustFormatStartedConsoleLines,
  rustRunStartedConsoleLines,
} from "./rustPlayground/console";
import {
  ZIG_CONSOLE_TAG_PATTERN,
  zigFormatStartedConsoleLines,
  zigRunStartedConsoleLines,
} from "./zigPlayground/console";
import {
  MAX_RUNNER_CONSOLE_LINES,
  appendRunnerConsoleLines,
  beginRunnerOperation,
  clearRunnerConsole,
  resetRunnerConsoleForProject,
} from "./playgroundConsoleStore";

describe("beginRunnerOperation", () => {
  it("separates a new operation from the output before it", () => {
    const store = createRuntimePanelStore();
    beginRunnerOperation(store, ["[go-run] go run main.go"]);
    appendRunnerConsoleLines(store, ["hello"]);
    beginRunnerOperation(store, ["[go-run] go run main.go"]);
    appendRunnerConsoleLines(store, ["again"]);

    expect(store.getSnapshot().context.consoleLines).toEqual([
      "[go-run] go run main.go",
      "hello",
      "",
      "[go-run] go run main.go",
      "again",
    ]);
  });

  it("ignores an empty start", () => {
    const store = createRuntimePanelStore();
    appendRunnerConsoleLines(store, ["earlier output"]);
    beginRunnerOperation(store, []);

    expect(store.getSnapshot().context.consoleLines).toEqual(["earlier output"]);
  });
});

describe("appendRunnerConsoleLines", () => {
  it("does not separate continuation output", () => {
    const store = createRuntimePanelStore();
    beginRunnerOperation(store, ["[go-run] go run main.go"]);
    appendRunnerConsoleLines(store, ["program output"]);
    expect(store.getSnapshot().context.consoleLines).toEqual([
      "[go-run] go run main.go",
      "program output",
    ]);
  });

  // Only the caller knows a batch starts an operation, so the store never
  // guesses from the text: a program that prints a started line of its own
  // stays where it printed it.
  it("never separates, even a line that reads like a started line", () => {
    const store = createRuntimePanelStore();
    appendRunnerConsoleLines(store, ["earlier output"]);
    appendRunnerConsoleLines(store, ["[go-run] go run main.go"]);

    expect(store.getSnapshot().context.consoleLines).toEqual([
      "earlier output",
      "[go-run] go run main.go",
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
});

describe("clearRunnerConsole", () => {
  it("empties the console and drops that surface's recorded scroll position", () => {
    const store = createRuntimePanelStore();
    appendRunnerConsoleLines(store, ["[go-run] go run main.go", "hello"]);
    store.trigger.setTerminalScrollLines({
      terminalScrollLines: { "go-runner": 12, "rust-runner": 3 },
    });

    clearRunnerConsole(store, "go-runner");

    const context = store.getSnapshot().context;
    expect(context.consoleLines).toEqual([]);
    // A scroll position left over from a longer console replays as a scroll
    // into rows that no longer exist; another surface's is none of our business.
    expect(context.terminalScrollLines).toEqual({ "rust-runner": 3 });
  });

  it("leaves the next run's output unseparated, as if the console were new", () => {
    const store = createRuntimePanelStore();
    beginRunnerOperation(store, ["[go-run] go run main.go", "hello"]);
    clearRunnerConsole(store, "go-runner");
    beginRunnerOperation(store, ["[go-run] go run main.go", "hello"]);

    expect(store.getSnapshot().context.consoleLines).toEqual(["[go-run] go run main.go", "hello"]);
  });

  it("is a no-op on an already empty console", () => {
    const store = createRuntimePanelStore();
    const before = store.getSnapshot().context;

    clearRunnerConsole(store, "go-runner");

    expect(store.getSnapshot().context).toBe(before);
  });
});

describe("resetRunnerConsoleForProject", () => {
  it("clears the console and every surface's recorded scroll position", () => {
    const store = createRuntimePanelStore();
    appendRunnerConsoleLines(store, ["[go-run] go run main.go", "hello"]);
    store.trigger.setTerminalScrollLines({
      terminalScrollLines: { "go-runner": 12, "rust-runner": 3 },
    });

    resetRunnerConsoleForProject(store);

    const context = store.getSnapshot().context;
    expect(context.consoleLines).toEqual([]);
    // Wider than clearRunnerConsole on purpose: at a lesson boundary an entry
    // left by another language's runner is stale too.
    expect(context.terminalScrollLines).toEqual({});
  });

  it("is a no-op on a console that is already empty", () => {
    const store = createRuntimePanelStore();
    const before = store.getSnapshot().context;

    resetRunnerConsoleForProject(store);

    expect(store.getSnapshot().context).toBe(before);
  });
});

// Each runner panel colours a console line by matching it against its own
// module's tag pattern. A pattern loose enough to match any `[...]` head paints
// the learner's own output as if the runner had said it, and a pattern that has
// drifted from the tags its module emits silently drops their colour — Go's
// once matched [go-run] and [go-vet] but not [gofmt].
describe("runner console tag patterns", () => {
  const TAG_PATTERNS = [
    GO_CONSOLE_TAG_PATTERN,
    KOTLIN_CONSOLE_TAG_PATTERN,
    RUST_CONSOLE_TAG_PATTERN,
    KITE_CONSOLE_TAG_PATTERN,
    ZIG_CONSOLE_TAG_PATTERN,
    HASKELL_CONSOLE_TAG_PATTERN,
    ASM_CONSOLE_TAG_PATTERN,
  ];

  // Every Run and Format opens with its language's started lines, which the
  // panel colours through that language's own pattern.
  it.each([
    ["go run", goRunStartedConsoleLines(["main.go"]), GO_CONSOLE_TAG_PATTERN],
    ["gofmt", goFormatStartedConsoleLines(["main.go"]), GO_CONSOLE_TAG_PATTERN],
    ["kotlin run", kotlinRunStartedConsoleLines(["Main.kt"]), KOTLIN_CONSOLE_TAG_PATTERN],
    ["cargo run", rustRunStartedConsoleLines(), RUST_CONSOLE_TAG_PATTERN],
    ["rustfmt", rustFormatStartedConsoleLines(), RUST_CONSOLE_TAG_PATTERN],
    ["kitec run", kiteRunStartedConsoleLines(), KITE_CONSOLE_TAG_PATTERN],
    ["kitec fmt", kiteFormatStartedConsoleLines(), KITE_CONSOLE_TAG_PATTERN],
    ["zig run", zigRunStartedConsoleLines(), ZIG_CONSOLE_TAG_PATTERN],
    ["zig fmt", zigFormatStartedConsoleLines(), ZIG_CONSOLE_TAG_PATTERN],
    ["runghc", haskellRunStartedConsoleLines(), HASKELL_CONSOLE_TAG_PATTERN],
    ["nasm", asmRunStartedConsoleLines(), ASM_CONSOLE_TAG_PATTERN],
  ])("colours every line of a %s start", (_label, startedLines, pattern) => {
    expect(startedLines.length).toBeGreaterThan(0);
    const uncoloured = startedLines.filter((line) => !pattern.test(line));

    expect(uncoloured, "started lines the runner panel would not colour").toEqual([]);
  });

  it.each([
    ["a Go slice", "[1 2 3]"],
    ["a Kotlin or Rust list", "[1, 2, 3]"],
    ["a Haskell list of lists", "[[1,2],[3]]"],
    ["a bracketed message the program printed itself", "[error: bad input]"],
  ])("leaves %s undecorated", (_label, line) => {
    const matched = TAG_PATTERNS.filter((pattern) => pattern.test(line));

    expect(matched, "tag patterns that would colour program output").toEqual([]);
  });
});
