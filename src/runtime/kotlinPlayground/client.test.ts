import { afterEach, describe, expect, it, vi } from "vitest";
import { KotlinPlaygroundClient, KotlinPlaygroundServiceError } from "./client";
import type { KotlinPlaygroundFile, KotlinPlaygroundRunResult } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SOURCE = 'fun main() {\n    println("hi")\n}\n';
const FILES: KotlinPlaygroundFile[] = [{ path: "Main.kt", content: SOURCE }];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function captureServiceError(
  promise: Promise<unknown>,
): Promise<KotlinPlaygroundServiceError> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof KotlinPlaygroundServiceError)) {
    throw new Error("expected the request to reject with a KotlinPlaygroundServiceError");
  }
  return error;
}

describe("KotlinPlaygroundClient", () => {
  it("posts all Kotlin files to the first-party route and returns the parsed result", async () => {
    const result: KotlinPlaygroundRunResult = { status: "success", output: "hi\n" };
    const spy = vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>(async () =>
      jsonResponse(result),
    );
    vi.stubGlobal("fetch", spy);

    await expect(new KotlinPlaygroundClient().run(FILES)).resolves.toEqual(result);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("/api/kotlin-playground/run");
    expect(JSON.parse(String(init?.body))).toEqual({ files: FILES });
  });

  it("drops unknown extra fields from the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "success", output: "", Surprise: "field" })),
    );

    await expect(new KotlinPlaygroundClient().run(FILES)).resolves.toEqual({
      status: "success",
      output: "",
    });
  });

  it.each([
    [401, "unauthenticated"],
    [503, "disabled"],
    [429, "rate-limited"],
    [504, "timeout"],
    [400, "invalid-source"],
    [413, "invalid-source"],
    [422, "invalid-source"],
    [502, "unavailable"],
  ] as const)("maps HTTP %d to a %s service error", async (status, kind) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "nope" }, status)),
    );

    const error = await captureServiceError(new KotlinPlaygroundClient().run(FILES));
    expect(error.kind).toBe(kind);
  });

  it("treats a malformed success payload as unavailable, not an empty run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "success", output: 42 })),
    );

    const error = await captureServiceError(new KotlinPlaygroundClient().run(FILES));
    expect(error.kind).toBe("unavailable");
  });

  it.each([
    { status: "success", output: "", compileErrors: "boom" },
    { status: "success", output: "", exception: "boom" },
    { status: "compile-error", output: "", compileErrors: "" },
    { status: "compile-error", output: "", compileErrors: "bad", exception: "boom" },
    { status: "runtime-error", output: "" },
    { status: "runtime-error", output: "", exception: "boom", compileErrors: "bad" },
    { status: "success", output: "", warnings: "  " },
  ])("rejects an impossible normalized result: %#", async (payload) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(payload)),
    );

    const error = await captureServiceError(new KotlinPlaygroundClient().run(FILES));
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
            resolve(jsonResponse({ status: "success", output: "second\n" }));
          }
        }),
    );
    vi.stubGlobal("fetch", spy);

    const client = new KotlinPlaygroundClient();
    const first = client.run(FILES);
    const second = client.run([...FILES, { path: "Helper.kt", content: "fun helper() = 1\n" }]);

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

    const client = new KotlinPlaygroundClient();
    const pending = client.run(FILES);
    client.abort();

    expect((await captureServiceError(pending)).kind).toBe("aborted");
  });
});
