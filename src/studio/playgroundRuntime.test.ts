import { describe, expect, it } from "vite-plus/test";
import { createWorkspaceFile } from "../starters/shared";
import { StudioActionError } from "./async";
import { fixtureRunConsoleLines } from "./fixtureConsoleLines";
import {
  PlaygroundTerminalError,
  preparePlaygroundRun,
  runErrorPrefixFor,
} from "./playgroundRuntime";
import {
  isPlaygroundRuntime,
  isPlaygroundRuntimeKind,
  runtimeDockStartsCollapsed,
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

    // The runner panel's refusal line, word for word: one rule, one message.
    expect(() => prepare(rustRuntime(), projectWith("main.rs", "lib.rs"))).toThrow(
      "[rust-run error] Rust lessons run a single main.rs file",
    );
    expect(() => prepare(rustRuntime(), projectWith("other.rs"))).toThrow(
      /run a single main\.rs file/,
    );
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
      /run a single Main\.hs file/,
    );
    expect(() => prepare(haskellRuntime(), projectWith("Other.hs"))).toThrow(
      /run a single Main\.hs file/,
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
  });

  it("lets the asm and Kite clients pick the entry, refusing what they would refuse", async () => {
    // No linker in the page, so siblings are never one program: a lone file
    // runs, several only run when one of them is the named entry — at the root
    // or in a folder, the client's rule. A fixture run never reaches the
    // client, so it asks the client's own pick and fails the way the learner's
    // dock does: the started line, then the client's refusal as a terminal error.
    await expect(prepare(asmRuntime(), projectWith("only.asm")).run()).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      prepare(asmRuntime(), projectWith("src/main.asm", "b.asm")).run(),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      prepare(kiteRuntime(), projectWith("src/main.kite", "src/util.kite")).run(),
    ).resolves.toMatchObject({ ok: true });

    const refusal = async (runtime: StudioRuntime, ...paths: string[]) => {
      const failure = await prepare(runtime, projectWith(...paths))
        .run()
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PlaygroundTerminalError);
      const terminal = failure as PlaygroundTerminalError;
      expect(terminal.attempts).toBe(1);
      return terminal.consoleLines;
    };

    expect(await refusal(asmRuntime(), "notes.md")).toEqual([
      "[asm-run error] This program can't run in an assembly lesson",
      "Add a main.asm file to run this lesson",
    ]);
    const ambiguousAsm = await refusal(asmRuntime(), "a.asm", "b.asm");
    expect(ambiguousAsm[0]).toBe("[asm-run error] This program can't run in an assembly lesson");
    expect(ambiguousAsm[1]).toMatch(/^Name the file this lesson runs `main\.asm`/);
    expect(await refusal(kiteRuntime(), "notes.md")).toEqual([
      "[kite-run error] This program can't run in a Kite lesson",
      "Add a .kite file to run this lesson",
    ]);
    const ambiguousKite = await refusal(kiteRuntime(), "a.kite", "b.kite");
    expect(ambiguousKite[0]).toBe("[kite-run error] This program can't run in a Kite lesson");
    expect(ambiguousKite[1]).toMatch(/^Name the file this lesson runs `main\.kite`/);
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
    expect(() => prepare(goRuntime(), projectWith("notes.md"))).toThrow(
      "[go-run error] Add at least one .go file to run this lesson",
    );
    expect(() => prepare(kotlinRuntime(), projectWith("notes.md"))).toThrow(
      "[kotlin-run error] Add at least one .kt file to run this lesson",
    );
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

/**
 * Minimal valid fixture per kind — a Record, so a new kind fails to compile.
 * "Valid" is the runner contract's answer, not just the field types: Go reports
 * `exitCode: 0` on every success, so a fixture without one is a result no live
 * run returns.
 */
const PLAYGROUND_FIXTURE_INPUTS: Record<StudioPlaygroundRuntimeKind, unknown> = {
  "go-playground": { latencyMs: 5, result: { status: "success", output: "", exitCode: 0 } },
  "kotlin-playground": { latencyMs: 5, result: { status: "success", output: "" } },
  "rust-playground": { latencyMs: 5, result: { status: "success", stdout: "", stderr: "" } },
  "zig-playground": { latencyMs: 5, result: { status: "success", output: "" } },
  "haskell-playground": { latencyMs: 5, result: { status: "success", stdout: "", stderr: "" } },
  "kite-playground": { latencyMs: 5, result: { status: "success", stdout: "", stderr: "" } },
  "asm-playground": { latencyMs: 5, result: { status: "success", stdout: "", stderr: "" } },
};

/** The file each kind's fixture run compiles. */
const PLAYGROUND_ENTRY_PATHS: Record<StudioPlaygroundRuntimeKind, string> = {
  "go-playground": "main.go",
  "kotlin-playground": "Main.kt",
  "rust-playground": "main.rs",
  "zig-playground": "main.zig",
  "haskell-playground": "Main.hs",
  "kite-playground": "main.kite",
  "asm-playground": "main.asm",
};

describe("fixture runs", () => {
  it("print exactly the pinned result's fixtureRunConsoleLines on every kind", async () => {
    for (const [kind, fixture] of Object.entries(PLAYGROUND_FIXTURE_INPUTS)) {
      const runtime = studioRuntimeSchema.parse({ kind, defaultMode: "fixture", fixture });
      if (!isPlaygroundRuntime(runtime)) throw new Error(`${kind} is not a Playground runtime`);
      const outcome = await prepare(
        runtime,
        projectWith(PLAYGROUND_ENTRY_PATHS[runtime.kind]),
      ).run();
      // The kind rides along so a failing diff names the language.
      expect({ kind, ...outcome }).toEqual({
        kind,
        resultLines: fixtureRunConsoleLines(runtime),
        ok: true,
        status: "success",
        attempts: 1,
        transientFailures: [],
      });
    }
  });

  it("report a pinned program failure as not ok, with its status", async () => {
    const runtime = studioRuntimeSchema.parse({
      kind: "rust-playground",
      defaultMode: "fixture",
      fixture: {
        latencyMs: 5,
        result: { status: "compile-error", stdout: "", stderr: "", compileErrors: "boom" },
      },
    });
    if (!isPlaygroundRuntime(runtime)) throw new Error("not a Playground runtime");
    const outcome = await prepare(runtime, projectWith("main.rs")).run();
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe("compile-error");
    expect(outcome.resultLines).toEqual(fixtureRunConsoleLines(runtime));
  });
});

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

/**
 * A success carrying compile diagnostics, per kind: the shape every client's
 * `parse*RunResult` rejects, so no live run can produce it.
 */
const IMPOSSIBLE_FIXTURE_RESULTS: Record<StudioPlaygroundRuntimeKind, unknown> = {
  "go-playground": { status: "success", output: "", exitCode: 0, compileErrors: "boom" },
  "kotlin-playground": { status: "success", output: "", compileErrors: "boom" },
  "rust-playground": { status: "success", stdout: "", stderr: "", compileErrors: "boom" },
  "zig-playground": { status: "success", output: "", compileErrors: "boom" },
  "haskell-playground": { status: "success", stdout: "", stderr: "", compileErrors: "boom" },
  "kite-playground": { status: "success", stdout: "", stderr: "", compileErrors: "boom" },
  "asm-playground": { status: "success", stdout: "", stderr: "", assembleErrors: "boom" },
};

describe("run fixture schemas", () => {
  it("rejects a pinned result the live client would refuse", () => {
    // The fixture path hands `fixture.result` straight to the console
    // formatter, never through the client, so a result that breaks the runner
    // contract would render a green lesson replaying a console no live run can
    // produce.
    const accepted = Object.entries(IMPOSSIBLE_FIXTURE_RESULTS)
      .filter(
        ([kind, result]) =>
          studioRuntimeSchema.safeParse({
            kind,
            defaultMode: "fixture",
            fixture: { latencyMs: 5, result },
          }).success,
      )
      .map(([kind]) => kind);

    // `accepted` names the kinds that let it through, so the diff identifies them.
    expect(accepted).toEqual([]);
  });

  it("rejects an assemble-error asm fixture with no diagnostics to show", () => {
    // `asmRunResultToConsoleLines` would print a bare "Assembly failed" here;
    // `parseAsmPlaygroundRunResult` refuses the same value from a live run.
    const parsed = studioRuntimeSchema.safeParse({
      kind: "asm-playground",
      defaultMode: "fixture",
      fixture: { latencyMs: 5, result: { status: "assemble-error", stdout: "", stderr: "" } },
    });

    expect(parsed.success).toBe(false);
  });

  it("keeps accepting every minimal valid fixture", () => {
    const rejected = Object.entries(PLAYGROUND_FIXTURE_INPUTS)
      .filter(
        ([kind, fixture]) =>
          !studioRuntimeSchema.safeParse({ kind, defaultMode: "fixture", fixture }).success,
      )
      .map(([kind]) => kind);

    expect(rejected).toEqual([]);
  });
});

describe("isPlaygroundRuntimeKind", () => {
  it("names every Playground kind and nothing else", () => {
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
    expect(Object.fromEntries(kinds.map((kind) => [kind, isPlaygroundRuntimeKind(kind)]))).toEqual({
      "go-playground": true,
      "kotlin-playground": true,
      "rust-playground": true,
      "zig-playground": true,
      "haskell-playground": true,
      "kite-playground": true,
      "asm-playground": true,
      webcontainer: false,
      none: false,
    });
  });
});
