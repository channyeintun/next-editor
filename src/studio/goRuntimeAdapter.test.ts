import { describe, expect, it } from "vite-plus/test";
import { GoPlaygroundClient } from "../runtime/goPlayground/client";
import { StudioActionError } from "./async";
import { GoRunTerminalError, runGoWithRetry, type GoRunAdapterInput } from "./goRuntimeAdapter";

function fixtureInput(overrides: {
  transientErrorKinds?: ("rate-limited" | "timeout" | "unavailable")[];
  status?: "success" | "compile-error";
  signal?: AbortSignal;
}): GoRunAdapterInput {
  return {
    mode: "fixture",
    fixture: {
      latencyMs: 5,
      transientErrorKinds: overrides.transientErrorKinds ?? [],
      result: { status: overrides.status ?? "success", output: "ok\n", exitCode: 0 },
    },
    files: [{ path: "main.go", content: "package main\n" }],
    timeoutMs: 1_000,
    signal: overrides.signal ?? new AbortController().signal,
    getClient: () => {
      throw new Error("fixture mode must never construct a live client");
    },
    errorLinesFor: (kind, message) => [`[go-run error] ${kind}: ${message}`],
  };
}

describe("runGoWithRetry", () => {
  it("returns the pinned result on a clean first attempt", async () => {
    const outcome = await runGoWithRetry(fixtureInput({}));
    expect(outcome.attempts).toBe(1);
    expect(outcome.transientFailures).toEqual([]);
    expect(outcome.result.status).toBe("success");
  });

  it("survives one transient failure with a silent retry", async () => {
    const outcome = await runGoWithRetry(fixtureInput({ transientErrorKinds: ["unavailable"] }));
    expect(outcome.attempts).toBe(2);
    expect(outcome.transientFailures).toEqual([
      expect.objectContaining({ attempt: 1, kind: "unavailable" }),
    ]);
    expect(outcome.result.status).toBe("success");
  });

  it("fails terminally when every attempt is transient", async () => {
    await expect(
      runGoWithRetry(fixtureInput({ transientErrorKinds: ["unavailable", "rate-limited"] })),
    ).rejects.toThrow(GoRunTerminalError);
  });

  it("carries console lines and attempt count on terminal failure", async () => {
    const failure = await runGoWithRetry(
      fixtureInput({ transientErrorKinds: ["timeout", "timeout"] }),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GoRunTerminalError);
    const terminal = failure as GoRunTerminalError;
    expect(terminal.attempts).toBe(2);
    expect(terminal.consoleLines[0]).toMatch(/timeout/);
  });

  it("aborts between attempts when the render is cancelled", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8);
    await expect(
      runGoWithRetry(
        fixtureInput({ transientErrorKinds: ["unavailable"], signal: controller.signal }),
      ),
    ).rejects.toThrow(StudioActionError);
  });

  it("does not retry compile errors (terminal, not transient)", async () => {
    // A compile-error *result* is returned, not thrown — the driver turns it
    // into a failed action; the adapter must not burn retries on it.
    const outcome = await runGoWithRetry(fixtureInput({ status: "compile-error" }));
    expect(outcome.attempts).toBe(1);
    expect(outcome.result.status).toBe("compile-error");
  });

  it("never constructs a live client in fixture mode", async () => {
    // fixtureInput's getClient throws; reaching the result proves it was unused.
    const outcome = await runGoWithRetry(fixtureInput({}));
    expect(outcome.result.output).toBe("ok\n");
    expect(GoPlaygroundClient).toBeDefined();
  });
});
