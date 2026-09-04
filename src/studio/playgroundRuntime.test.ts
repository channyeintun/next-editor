import { describe, expect, it } from "vite-plus/test";
import { createWorkspaceFile } from "../starters/shared";
import { StudioActionError } from "./async";
import {
  PlaygroundTerminalError,
  preparePlaygroundRun,
  runErrorPrefixFor,
} from "./playgroundRuntime";
import {
  runtimeDockStartsCollapsed,
  runtimeNeedsSession,
  studioRuntimeSchema,
  type StudioPlaygroundRuntimeKind,
  type StudioRuntime,
} from "./plan";

type Transient = ("rate-limited" | "timeout" | "unavailable")[];

function goRuntime(transientErrorKinds: Transient = []): StudioRuntime {
  return {
    kind: "go-playground",
    dockStartsCollapsed: false,
    defaultMode: "fixture",
    fixture: {
      latencyMs: 5,
      transientErrorKinds,
      result: { status: "success", output: "ok\n", exitCode: 0 },
    },
  };
}

function kotlinRuntime(): StudioRuntime {
  return {
    kind: "kotlin-playground",
    dockStartsCollapsed: false,
    defaultMode: "fixture",
    fixture: {
      latencyMs: 5,
      transientErrorKinds: [],
      result: { status: "success", output: "hello kotlin\n" },
    },
  };
}

function rustRuntime(transientErrorKinds: Transient = []): StudioRuntime {
  return {
    kind: "rust-playground",
    dockStartsCollapsed: false,
    defaultMode: "fixture",
    fixture: {
      latencyMs: 5,
      transientErrorKinds,
      result: { status: "success", stdout: "hello rust\n", stderr: "" },
    },
  };
}

function asmRuntime(): StudioRuntime {
  return {
    kind: "asm-playground",
    dockStartsCollapsed: false,
    defaultMode: "fixture",
    fixture: {
      latencyMs: 5,
      transientErrorKinds: [],
      result: {
        status: "success",
        stdout: "hi\n",
        stderr: "",
        exitCode: 0,
        registers: [{ name: "rax", value: "1" }],
      },
    },
  };
}

function kiteRuntime(transientErrorKinds: Transient = []): StudioRuntime {
  return {
    kind: "kite-playground",
    dockStartsCollapsed: false,
    defaultMode: "fixture",
    fixture: {
      latencyMs: 5,
      // The kite fixture schema admits only "unavailable"; the engine can still
      // hand this kind's error table a "timeout" it never declared, because the
      // retry engine synthesizes that kind from its own deadline.
      transientErrorKinds: transientErrorKinds as "unavailable"[],
      result: { status: "success", stdout: "hello kite\n", stderr: "" },
    },
  };
}

function haskellRuntime(transientErrorKinds: Transient = []): StudioRuntime {
  return {
    kind: "haskell-playground",
    dockStartsCollapsed: false,
    defaultMode: "fixture",
    fixture: {
      latencyMs: 5,
      transientErrorKinds,
      // GHC reports its own diagnostics on a third channel, so a clean run
      // pins stdout/stderr and simply carries no `warnings`.
      result: { status: "success", stdout: "hello haskell\n", stderr: "" },
    },
  };
}

function projectWith(...paths: string[]) {
  return {
    files: Object.fromEntries(paths.map((path) => [path, createWorkspaceFile(path, "content")])),
  };
}

function prepare(runtime: StudioRuntime, project: { files: Record<string, unknown> }) {
  if (runtime.kind === "none" || runtime.kind === "webcontainer") {
    throw new Error("test misuse");
  }
  return preparePlaygroundRun({
    runtime,
    mode: "fixture",
    project: project as Parameters<typeof preparePlaygroundRun>[0]["project"],
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  });
}

describe("preparePlaygroundRun", () => {
  it("runs a Go fixture and formats its console lines", async () => {
    const prepared = prepare(goRuntime(), projectWith("main.go"));
    expect(prepared.startedLines[0]).toBe("[go-run] go run main.go");
    const outcome = await prepared.run();
    expect(outcome.ok).toBe(true);
    expect(outcome.resultLines).toEqual(["ok", "[go-run] Program exited"]);
  });

  it("runs a Kotlin fixture through the same engine", async () => {
    const prepared = prepare(kotlinRuntime(), projectWith("Main.kt"));
    expect(prepared.startedLines[0]).toBe("[kotlin-run] kotlin Main.kt");
    const outcome = await prepared.run();
    expect(outcome.ok).toBe(true);
    expect(outcome.resultLines.at(-1)).toMatch(/\[kotlin-run\]/);
  });

  it("runs a Rust fixture and enforces the single-main.rs shape", async () => {
    const prepared = prepare(rustRuntime(), projectWith("main.rs"));
    expect(prepared.startedLines[0]).toBe("[rust-run] cargo run");
    const outcome = await prepared.run();
    expect(outcome.ok).toBe(true);
    expect(outcome.resultLines).toEqual(["hello rust", "[rust-run] Program exited"]);

    expect(() => prepare(rustRuntime(), projectWith("main.rs", "lib.rs"))).toThrow(
      /exactly one main.rs/,
    );
    expect(() => prepare(rustRuntime(), projectWith("other.rs"))).toThrow(/exactly one main.rs/);
  });

  it("runs a Haskell fixture and enforces the single-Main.hs shape", async () => {
    const prepared = prepare(haskellRuntime(), projectWith("Main.hs"));
    expect(prepared.startedLines[0]).toBe("[haskell-run] runghc Main.hs");
    const outcome = await prepared.run();
    expect(outcome.ok).toBe(true);
    expect(outcome.resultLines).toEqual(["hello haskell", "[haskell-run] Program exited"]);

    // One module named Main, so a sibling source and a differently named entry
    // are both unrunnable — the playground has no cabal file to describe them.
    expect(() => prepare(haskellRuntime(), projectWith("Main.hs", "Lib.hs"))).toThrow(
      /exactly one Main\.hs/,
    );
    expect(() => prepare(haskellRuntime(), projectWith("Other.hs"))).toThrow(
      /exactly one Main\.hs/,
    );
  });

  it("runs an asm fixture with the registers after the program's own output", async () => {
    // The recorded console has to be the console the runner panel builds, and
    // the panel appends the register rows after the run's output. A reordered
    // (or dropped) register block would replay a lesson no live run produces.
    const prepared = prepare(asmRuntime(), projectWith("main.asm"));
    expect(prepared.startedLines[0]).toBe(
      "[asm-run] nasm -f elf64 main.asm && ld -o main main.o && ./main",
    );
    const outcome = await prepared.run();
    expect(outcome.ok).toBe(true);
    expect(outcome.resultLines).toEqual([
      "hi",
      "[asm-run] Program exited with status 0",
      "[asm-run] rax=0x1",
    ]);

    // No linker in the page, so siblings are never one program: a lone file
    // runs, several only run when one of them is the named entry.
    expect(() => prepare(asmRuntime(), projectWith("notes.md"))).toThrow(/Add a main\.asm file/);
    expect(() => prepare(asmRuntime(), projectWith("only.asm"))).not.toThrow();
    expect(() => prepare(asmRuntime(), projectWith("a.asm", "b.asm"))).toThrow(
      /Name the file this lesson runs main\.asm/,
    );
  });

  it("still writes an error line for a kind the language's own table lacks", async () => {
    // The retry engine synthesizes "timeout" from its deadline for every kind,
    // including the in-page runners whose tables have no such entry. An
    // unguarded lookup yields `undefined`, and appendRunnerConsoleLines throws
    // a TypeError on it — a crashed render carrying no error line at all.
    const failure = await prepare(kiteRuntime(["timeout", "timeout"]), projectWith("main.kite"))
      .run()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlaygroundTerminalError);
    const terminal = failure as PlaygroundTerminalError;
    expect(terminal.consoleLines.every((line) => typeof line === "string")).toBe(true);
    expect(terminal.consoleLines[0]).toMatch(/^\[kite-run error\]/);
  });

  it("rejects empty workspaces per kind", () => {
    expect(() => prepare(goRuntime(), projectWith("notes.md"))).toThrow(/at least one .go/);
    expect(() => prepare(kotlinRuntime(), projectWith("notes.md"))).toThrow(/at least one .kt/);
  });

  it("survives one transient failure with a silent retry", async () => {
    const outcome = await prepare(goRuntime(["unavailable"]), projectWith("main.go")).run();
    expect(outcome.attempts).toBe(2);
    expect(outcome.transientFailures).toEqual([
      expect.objectContaining({ attempt: 1, kind: "unavailable" }),
    ]);
    expect(outcome.ok).toBe(true);
  });

  it("fails terminally when every attempt is transient, carrying console lines", async () => {
    const failure = await prepare(rustRuntime(["timeout", "timeout"]), projectWith("main.rs"))
      .run()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlaygroundTerminalError);
    const terminal = failure as PlaygroundTerminalError;
    expect(terminal.attempts).toBe(2);
    expect(terminal.consoleLines[0]).toMatch(/^\[rust-run error\]/);
  });

  it("does not retry program failures (terminal result, not transient)", async () => {
    const runtime = goRuntime();
    if (runtime.kind !== "go-playground") throw new Error("unreachable");
    runtime.fixture.result = { status: "compile-error", output: "", compileErrors: "boom" };
    const outcome = await prepare(runtime, projectWith("main.go")).run();
    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(1);
    expect(outcome.resultLines[0]).toBe("[go-run error] Build failed");
  });

  it("aborts between attempts when the render is cancelled", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8);
    const runtime = goRuntime(["unavailable"]);
    if (runtime.kind !== "go-playground") throw new Error("unreachable");
    const prepared = preparePlaygroundRun({
      runtime,
      mode: "fixture",
      project: projectWith("main.go") as Parameters<typeof preparePlaygroundRun>[0]["project"],
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    await expect(prepared.run()).rejects.toThrow(StudioActionError);
  });
});

describe("runErrorPrefixFor", () => {
  it("labels error prefixes per kind", () => {
    expect(runErrorPrefixFor("go-playground")).toBe("[go-run error]");
    expect(runErrorPrefixFor("kotlin-playground")).toBe("[kotlin-run error]");
    expect(runErrorPrefixFor("rust-playground")).toBe("[rust-run error]");
    expect(runErrorPrefixFor("haskell-playground")).toBe("[haskell-run error]");
    expect(runErrorPrefixFor("zig-playground")).toBe("[zig-run error]");
    expect(runErrorPrefixFor("kite-playground")).toBe("[kite-run error]");
    expect(runErrorPrefixFor("asm-playground")).toBe("[asm-run error]");
  });
});

/** Minimal valid fixture per kind — a Record, so a new kind fails to compile. */
const PLAYGROUND_FIXTURE_INPUTS: Record<StudioPlaygroundRuntimeKind, unknown> = {
  "go-playground": { latencyMs: 5, result: { status: "success", output: "" } },
  "kotlin-playground": { latencyMs: 5, result: { status: "success", output: "" } },
  "rust-playground": { latencyMs: 5, result: { status: "success", stdout: "", stderr: "" } },
  "zig-playground": { latencyMs: 5, result: { status: "success", output: "" } },
  "haskell-playground": { latencyMs: 5, result: { status: "success", stdout: "", stderr: "" } },
  "kite-playground": { latencyMs: 5, result: { status: "success", stdout: "", stderr: "" } },
  "asm-playground": { latencyMs: 5, result: { status: "success", stdout: "", stderr: "" } },
};

describe("studioRuntimeSchema", () => {
  it("keeps an authored dockStartsCollapsed on every Playground kind", () => {
    // The runtime objects are not strict, so a kind that omits the field has an
    // authored `dockStartsCollapsed: true` stripped by zod and renders with the
    // dock open — no error, no diagnostic, nothing to notice until someone
    // watches the recording.
    const dropped = Object.entries(PLAYGROUND_FIXTURE_INPUTS)
      .filter(([kind, fixture]) => {
        const parsed = studioRuntimeSchema.parse({
          kind,
          dockStartsCollapsed: true,
          defaultMode: "fixture",
          fixture,
        });
        return !runtimeDockStartsCollapsed(parsed);
      })
      .map(([kind]) => kind);

    // `dropped` names the offending kinds, so an empty-array diff identifies them.
    expect(dropped).toEqual([]);
  });
});

describe("runtimeNeedsSession", () => {
  it("gates the proxied playgrounds and only those", () => {
    // Kite and asm run in the page: gating them would lock a lesson behind a
    // sign-in for a service it never calls.
    const kinds = [
      "go-playground",
      "kotlin-playground",
      "rust-playground",
      "zig-playground",
      "haskell-playground",
      "kite-playground",
      "asm-playground",
      "webcontainer",
      "none",
    ] as const;

    // One table so a wrong answer names the kind in the diff.
    expect(Object.fromEntries(kinds.map((kind) => [kind, runtimeNeedsSession(kind)]))).toEqual({
      "go-playground": true,
      "kotlin-playground": true,
      "rust-playground": true,
      "zig-playground": true,
      "haskell-playground": true,
      "kite-playground": false,
      "asm-playground": false,
      webcontainer: false,
      none: false,
    });
  });
});
