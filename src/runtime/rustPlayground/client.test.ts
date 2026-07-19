import { afterEach, describe, expect, it, vi } from "vitest";
import { RustPlaygroundClient, RustPlaygroundServiceError } from "./client";
import type { RustPlaygroundFile, RustPlaygroundRunResult } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SOURCE = 'fn main() {\n    println!("hi");\n}\n';
const FILES: RustPlaygroundFile[] = [{ path: "main.rs", content: SOURCE }];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function captureServiceError(promise: Promise<unknown>): Promise<RustPlaygroundServiceError> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof RustPlaygroundServiceError)) {
    throw new Error("expected the request to reject with a RustPlaygroundServiceError");
  }
  return error;
}

describe("RustPlaygroundClient", () => {
  it("posts the Rust file to the first-party route and returns the parsed result", async () => {
    const result: RustPlaygroundRunResult = { status: "success", stdout: "hi\n", stderr: "" };
    const spy = vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>(async () =>
      jsonResponse(result),
    );
    vi.stubGlobal("fetch", spy);

    await expect(new RustPlaygroundClient().run(FILES)).resolves.toEqual(result);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("/api/rust-playground/run");
    expect(JSON.parse(String(init?.body))).toEqual({ files: FILES });
  });

  it("drops unknown extra fields from the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: "success", stdout: "", stderr: "", Surprise: "field" }),
      ),
    );

    await expect(new RustPlaygroundClient().run(FILES)).resolves.toEqual({
      status: "success",
      stdout: "",
      stderr: "",
    });
  });

  it("posts the file for formatting and returns the normalized formatted source", async () => {
    const formattedFiles = [{ path: "main.rs", content: 'fn main() {\n    println!("hi");\n}\n' }];
    const spy = vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>(async () =>
      jsonResponse({ files: formattedFiles }),
    );
    vi.stubGlobal("fetch", spy);

    await expect(new RustPlaygroundClient().format(FILES)).resolves.toEqual({
      files: formattedFiles,
    });

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("/api/rust-playground/format");
    expect(JSON.parse(String(init?.body))).toEqual({ files: FILES });
  });

  it("rejects a format response with a different file set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ files: [{ path: "other.rs", content: SOURCE }] })),
    );

    const error = await captureServiceError(new RustPlaygroundClient().format(FILES));
    expect(error.kind).toBe("unavailable");
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

    const error = await captureServiceError(new RustPlaygroundClient().run(FILES));
    expect(error.kind).toBe(kind);
  });

  it("treats a malformed success payload as unavailable, not an empty run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "success", stdout: 42, stderr: "" })),
    );

    const error = await captureServiceError(new RustPlaygroundClient().run(FILES));
    expect(error.kind).toBe("unavailable");
  });

  it.each([
    { status: "success", stdout: "", stderr: "", compileErrors: "boom" },
    { status: "success", stdout: "", stderr: "", exitDetail: "Exited with status 1" },
    { status: "compile-error", stdout: "", stderr: "", compileErrors: "" },
    {
      status: "compile-error",
      stdout: "",
      stderr: "",
      compileErrors: "bad",
      exitDetail: "Exited with status 101",
    },
    { status: "runtime-error", stdout: "", stderr: "" },
    {
      status: "runtime-error",
      stdout: "",
      stderr: "",
      exitDetail: "Exited with status 101",
      compileErrors: "bad",
    },
  ])("rejects an impossible normalized result: %#", async (payload) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(payload)),
    );

    const error = await captureServiceError(new RustPlaygroundClient().run(FILES));
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
            resolve(jsonResponse({ status: "success", stdout: "second\n", stderr: "" }));
          }
        }),
    );
    vi.stubGlobal("fetch", spy);

    const client = new RustPlaygroundClient();
    const first = client.run(FILES);
    const second = client.run([{ path: "main.rs", content: `${SOURCE}\n// edited\n` }]);

    expect((await captureServiceError(first)).kind).toBe("aborted");
    await expect(second).resolves.toMatchObject({ stdout: "second\n" });
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

    const client = new RustPlaygroundClient();
    const pending = client.run(FILES);
    client.abort();

    expect((await captureServiceError(pending)).kind).toBe("aborted");
  });
});
