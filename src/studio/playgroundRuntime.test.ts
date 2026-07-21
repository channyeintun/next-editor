import { describe, expect, it } from "vite-plus/test";
import { createWorkspaceFile } from "../starters/shared";
import { StudioActionError } from "./async";
import {
  PlaygroundTerminalError,
  preparePlaygroundRun,
  runErrorPrefixFor,
} from "./playgroundRuntime";
import type { StudioRuntime } from "./plan";

type Transient = ("rate-limited" | "timeout" | "unavailable")[];

function goRuntime(transientErrorKinds: Transient = []): StudioRuntime {
  return {
    kind: "go-playground",
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
    defaultMode: "fixture",
    fixture: {
      latencyMs: 5,
      transientErrorKinds,
      result: { status: "success", stdout: "hello rust\n", stderr: "" },
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
  });
});
