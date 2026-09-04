import { describe, expect, it } from "vite-plus/test";
import { createRuntimePanelStore } from "../stores/runtimePanelStore";
import { ASM_CONSOLE_TAG_PATTERN } from "./asmPlayground/console";
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
  OPERATION_START_PREFIXES,
  appendRunnerConsoleLines,
  clearRunnerConsole,
  resetRunnerConsoleForProject,
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
    ["runghc", haskellRunStartedConsoleLines()],
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
    appendRunnerConsoleLines(store, ["[go-run] go run main.go", "hello"]);
    clearRunnerConsole(store, "go-runner");
    appendRunnerConsoleLines(store, ["[go-run] go run main.go", "hello"]);

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

  it("recognizes every operation-start line the shared store knows about", () => {
    const unmatched = OPERATION_START_PREFIXES.filter(
      (prefix) => !TAG_PATTERNS.some((pattern) => pattern.test(prefix)),
    );

    expect(unmatched, "operation-start prefixes no runner panel would colour").toEqual([]);
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
