import { afterEach, describe, expect, it, vi } from "vitest";
import { HaskellPlaygroundClient, HaskellPlaygroundServiceError } from "./client";
import type { HaskellPlaygroundFile, HaskellPlaygroundRunResult } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SOURCE = 'main :: IO ()\nmain = putStrLn "hi"\n';
const FILES: HaskellPlaygroundFile[] = [{ path: "Main.hs", content: SOURCE }];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function captureServiceError(
  promise: Promise<unknown>,
): Promise<HaskellPlaygroundServiceError> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof HaskellPlaygroundServiceError)) {
    throw new Error("expected the request to reject with a HaskellPlaygroundServiceError");
  }
  return error;
}

describe("HaskellPlaygroundClient", () => {
  it("posts the Haskell file to the first-party route and returns the parsed result", async () => {
    const result: HaskellPlaygroundRunResult = { status: "success", stdout: "hi\n", stderr: "" };
    const spy = vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>(async () =>
      jsonResponse(result),
    );
    vi.stubGlobal("fetch", spy);

    await expect(new HaskellPlaygroundClient().run(FILES)).resolves.toEqual(result);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("/api/haskell-playground/run");
    expect(JSON.parse(String(init?.body))).toEqual({ files: FILES });
  });

  it("drops unknown extra fields from the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        // `timesecs` is a real upstream field the runner has no use for; it is
        // dropped by the same rebuild that drops anything else unrecognized.
        jsonResponse({
          status: "success",
          stdout: "",
          stderr: "",
          timesecs: 0.31,
          Surprise: "field",
        }),
      ),
    );

    await expect(new HaskellPlaygroundClient().run(FILES)).resolves.toEqual({
      status: "success",
      stdout: "",
      stderr: "",
    });
  });

  it("keeps GHC's warnings separate from the program's own streams", async () => {
    // The three-stream split is the whole reason this contract is not Zig's:
    // ghcout is the compiler talking, sout/serr are the program talking.
    const result: HaskellPlaygroundRunResult = {
      status: "success",
      stdout: "5\n",
      stderr: "",
      warnings: "Main.hs:6:10: warning: [GHC-06201] Pattern match(es) are non-exhaustive\n",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(result)),
    );

    await expect(new HaskellPlaygroundClient().run(FILES)).resolves.toEqual(result);
  });

  it("accepts a runtime error that also carries warnings", async () => {
    // `print (head [])` is the shape that proves the naive "no output means it
    // never compiled" reading wrong: it exits 1 with an empty stdout and a
    // -Wx-partial *warning* in ghcout, and it is a runtime error.
    const result: HaskellPlaygroundRunResult = {
      status: "runtime-error",
      stdout: "",
      stderr: "Main: Prelude.head: empty list\n",
      warnings: "Main.hs:2:8: warning: [GHC-63394] In the use of 'head'\n",
      exitDetail: "Exited with status 1",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(result)),
    );

    await expect(new HaskellPlaygroundClient().run(FILES)).resolves.toEqual(result);
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

    const error = await captureServiceError(new HaskellPlaygroundClient().run(FILES));
    expect(error.kind).toBe(kind);
  });

  it("treats a malformed success payload as unavailable, not an empty run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "success", stdout: 42, stderr: "" })),
    );

    const error = await captureServiceError(new HaskellPlaygroundClient().run(FILES));
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
      exitDetail: "Exited with status 1",
    },
    // A compile error means the program never ran, so it can carry neither of
    // the program's own streams.
    { status: "compile-error", stdout: "before\n", stderr: "", compileErrors: "bad" },
    { status: "compile-error", stdout: "", stderr: "boom\n", compileErrors: "bad" },
    // For a compile error the whole of ghcout is the error text, so there is
    // no separate warning channel left to fill.
    {
      status: "compile-error",
      stdout: "",
      stderr: "",
      compileErrors: "bad",
      warnings: "Main.hs:6:10: warning: [GHC-06201] …",
    },
    { status: "runtime-error", stdout: "", stderr: "" },
    {
      status: "runtime-error",
      stdout: "",
      stderr: "",
      exitDetail: "Exited with status 1",
      compileErrors: "bad",
    },
    { status: "success", stdout: "", stderr: "", warnings: "  " },
    {
      status: "runtime-error",
      stdout: "",
      stderr: "",
      exitDetail: "Exited with status 1",
      warnings: "\n",
    },
  ])("rejects an impossible normalized result: %#", async (payload) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(payload)),
    );

    const error = await captureServiceError(new HaskellPlaygroundClient().run(FILES));
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

    const client = new HaskellPlaygroundClient();
    const first = client.run(FILES);
    const second = client.run([{ path: "Main.hs", content: `${SOURCE}\n-- edited\n` }]);

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

    const client = new HaskellPlaygroundClient();
    const pending = client.run(FILES);
    client.abort();

    expect((await captureServiceError(pending)).kind).toBe("aborted");
  });
});
