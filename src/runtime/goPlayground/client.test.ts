import { afterEach, describe, expect, it, vi } from "vitest";
import { GoPlaygroundClient, GoPlaygroundServiceError } from "./client";
import type { GoPlaygroundRunResult } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SOURCE = 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("hi") }\n';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function captureServiceError(promise: Promise<unknown>): Promise<GoPlaygroundServiceError> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof GoPlaygroundServiceError)) {
    throw new Error("expected the run to reject with a GoPlaygroundServiceError");
  }
  return error;
}

describe("GoPlaygroundClient", () => {
  it("posts the source to the first-party route and returns the parsed result", async () => {
    const result: GoPlaygroundRunResult = { status: "success", output: "hi\n", exitCode: 0 };
    const spy = vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>(async () =>
      jsonResponse(result),
    );
    vi.stubGlobal("fetch", spy);

    await expect(new GoPlaygroundClient().run(SOURCE)).resolves.toEqual(result);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("/api/go-playground/run");
    expect(JSON.parse(String(init?.body))).toEqual({ source: SOURCE });
  });

  it("drops unknown extra fields from the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "success", output: "", exitCode: 0, Surprise: "field" }),
      ),
    );

    await expect(new GoPlaygroundClient().run(SOURCE)).resolves.toEqual({
      status: "success",
      output: "",
      exitCode: 0,
    });
  });

  it.each([
    [401, "unauthenticated"],
    [503, "disabled"],
    [429, "rate-limited"],
    [504, "timeout"],
    [400, "invalid-source"],
    [413, "invalid-source"],
    [502, "unavailable"],
  ] as const)("maps HTTP %d to a %s service error", async (status, kind) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "nope" }, status)),
    );

    const error = await captureServiceError(new GoPlaygroundClient().run(SOURCE));
    expect(error.kind).toBe(kind);
  });

  it("treats a malformed success payload as unavailable, not an empty run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "success", output: 42 })),
    );

    const error = await captureServiceError(new GoPlaygroundClient().run(SOURCE));
    expect(error.kind).toBe("unavailable");
  });

  it.each([
    { status: "success", output: "", exitCode: 2 },
    { status: "compile-error", output: "", compileErrors: "" },
    { status: "vet-error", output: "", vetErrors: "warning", exitCode: 2 },
    { status: "runtime-error", output: "panic", exitCode: 0 },
  ])("rejects an impossible normalized result: $status", async (payload) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(payload)),
    );

    const error = await captureServiceError(new GoPlaygroundClient().run(SOURCE));
    expect(error.kind).toBe("unavailable");
  });

  it("aborts the in-flight request when a newer run supersedes it", async () => {
    const spy = vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>(
      (_input, init) =>
        new Promise((resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
          if (spy.mock.calls.length > 1) {
            resolve(jsonResponse({ status: "success", output: "second\n", exitCode: 0 }));
          }
        }),
    );
    vi.stubGlobal("fetch", spy);

    const client = new GoPlaygroundClient();
    const first = client.run(SOURCE);
    const second = client.run(`${SOURCE}\n`);

    expect((await captureServiceError(first)).kind).toBe("aborted");
    await expect(second).resolves.toMatchObject({ output: "second\n" });
  });

  it("rejects with an aborted error when abort() is called", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );

    const client = new GoPlaygroundClient();
    const pending = client.run(SOURCE);
    client.abort();

    expect((await captureServiceError(pending)).kind).toBe("aborted");
  });
});
