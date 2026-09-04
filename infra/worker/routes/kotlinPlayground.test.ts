import { afterEach, describe, expect, it, vi } from "vitest";
import { kotlinPlaygroundRoute, normalizeUpstreamRunResponse } from "./kotlinPlayground";
import type { Env } from "../env";
import type { UserRow } from "../../db/types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SOURCE = 'fun main() {\n    println("hi")\n}\n';
const FILES = [{ path: "Main.kt", content: SOURCE }];

const USER: UserRow = {
  id: "user-1",
  google_sub: "sub",
  email: "user@example.com",
  name: "User",
  avatar_url: null,
  username: "user",
  created_at: 0,
};

function dbWithSessionUser(user: UserRow | null): D1Database {
  return {
    prepare: () => ({ bind: () => ({ first: async () => user }) }),
  } as unknown as D1Database;
}

/** In-memory KV covering the get/put subset the route uses. */
function memoryKv(seed: Record<string, string> = {}): KVNamespace {
  const values = new Map(Object.entries(seed));
  return {
    get: async (key: string, type?: unknown) => {
      const value = values.get(key) ?? null;
      if (value === null) return null;
      return type === "json" || (type as { type?: string })?.type === "json"
        ? JSON.parse(value)
        : value;
    },
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
  } as unknown as KVNamespace;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: dbWithSessionUser(USER),
    CACHE: memoryKv(),
    KOTLIN_PLAYGROUND_ENABLED: "true",
    ...overrides,
  } as Env;
}

function runRequest(env: Env, body: BodyInit | null = JSON.stringify({ files: FILES })) {
  return kotlinPlaygroundRoute.request(
    "http://localhost/run",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "ne_session=session-1" },
      body,
    },
    env,
  );
}

function stubUpstream(payload: unknown, status = 200) {
  const spy = vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>(async () =>
    typeof payload === "string"
      ? new Response(payload, { status })
      : new Response(JSON.stringify(payload), { status }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

// Verified live upstream shapes (api.kotlinlang.org, 2026-07-19).
const UPSTREAM_SUCCESS = {
  errors: { "Main.kt": [] },
  exception: null,
  jvmByteCode: null,
  text: "<outStream>hi\n</outStream>",
};

describe("kotlinPlaygroundRoute", () => {
  it("fails closed when the kill switch is not enabled", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv({ KOTLIN_PLAYGROUND_ENABLED: undefined }));

    expect(response.status).toBe(503);
    expect(spy).not.toHaveBeenCalled();
  });

  it("requires a signed-in user", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv({ DB: dbWithSessionUser(null) }));

    expect(response.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an invalid JSON body", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv(), "not json");

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects JSON null instead of throwing an internal error", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv(), "null");

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("bounds the request body before parsing JSON", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(
      makeEnv(),
      JSON.stringify({ files: FILES, padding: "x".repeat(450 * 1024) }),
    );

    expect(response.status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts only the documented files field", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv(), JSON.stringify({ files: FILES, extra: true }));

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("requires at least one Kotlin file", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv(), JSON.stringify({ files: [] }));

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects more files than the lesson limit", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const files = Array.from({ length: 21 }, (_, index) => ({
      path: `File${index}.kt`,
      content: "fun main() {}\n",
    }));
    const response = await runRequest(makeEnv(), JSON.stringify({ files }));

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects the program over the size limit before proxying", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const oversized = `// ${"x".repeat(64 * 1024)}`;
    const response = await runRequest(
      makeEnv(),
      JSON.stringify({ files: [{ path: "Main.kt", content: oversized }] }),
    );

    expect(response.status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(["nested/Helper.kt", "Helper.ts", "_Helper.kt", "Helper file.kt"])(
    "rejects unsupported Kotlin lesson path %s",
    async (path) => {
      const spy = stubUpstream(UPSTREAM_SUCCESS);
      const response = await runRequest(
        makeEnv(),
        JSON.stringify({ files: [{ path, content: "fun main() {}\n" }] }),
      );

      expect(response.status).toBe(400);
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it("rejects duplicate paths", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv(), JSON.stringify({ files: [...FILES, ...FILES] }));

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns 429 once the per-user minute window is exhausted", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    // Freeze the clock: the seeded key and the route's own key are computed at
    // different moments, and a minute boundary between them would leave the
    // seeded count invisible and let the request through.
    vi.spyOn(Date, "now").mockReturnValue(1_770_000_000_000);
    const windowKey = `kp:rl:${USER.id}:${Math.floor(Date.now() / 60_000)}`;
    const response = await runRequest(makeEnv({ CACHE: memoryKv({ [windowKey]: "10" }) }));

    expect(response.status).toBe(429);
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails closed when the rate-limit store is unavailable", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv({ CACHE: undefined }));

    expect(response.status).toBe(502);
    expect(spy).not.toHaveBeenCalled();
  });

  it("proxies JSON with the pinned version, conf type, and unique user agent, and normalizes success", async () => {
    const spy = stubUpstream({
      errors: { "Main.kt": [] },
      exception: null,
      jvmByteCode: null,
      text: "<outStream>out line\n</outStream><errStream>err line\n</errStream>",
    });

    const response = await runRequest(makeEnv());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "success",
      output: "out line\nerr line\n",
    });

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://api.kotlinlang.org/api/2.4.10/compiler/run");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      args: "",
      files: [{ name: "Main.kt", text: SOURCE, publicId: "" }],
      confType: "java",
    });
    expect(new Headers(init?.headers).get("User-Agent")).toContain("NextEditor-KotlinPlayground");
  });

  it("sends multiple files Main.kt-first regardless of request order", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const files = [
      { path: "Helper.kt", content: "fun helper() = 1\n" },
      { path: "Main.kt", content: SOURCE },
    ];

    const response = await runRequest(makeEnv(), JSON.stringify({ files }));

    expect(response.status).toBe(200);
    const body = JSON.parse(String(spy.mock.calls[0][1]?.body));
    expect(body.files.map((file: { name: string }) => file.name)).toEqual(["Main.kt", "Helper.kt"]);
  });

  it("returns compiler diagnostics as a normal run result, not an HTTP failure", async () => {
    stubUpstream({
      errors: {
        "Main.kt": [
          {
            interval: { start: { line: 0, ch: 13 }, end: { line: 0, ch: 19 } },
            message: "Unresolved reference 'printn'.",
            severity: "ERROR",
            className: "File",
          },
        ],
      },
      exception: null,
      jvmByteCode: null,
      text: "",
    });

    const response = await runRequest(makeEnv());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "compile-error",
      output: "",
      compileErrors: "Main.kt:1:14: error: Unresolved reference 'printn'.",
    });
  });

  it("keeps compiler warnings separate from program output", async () => {
    stubUpstream({
      errors: {
        "Main.kt": [
          {
            interval: { start: { line: 0, ch: 31 }, end: { line: 0, ch: 39 } },
            message: "'fun readLine(): String?' is deprecated.",
            severity: "WARNING",
            className: "WARNING",
          },
        ],
      },
      exception: null,
      jvmByteCode: null,
      text: "<outStream>line=null\n</outStream>",
    });

    const response = await runRequest(makeEnv());
    expect(await response.json()).toEqual({
      status: "success",
      output: "line=null\n",
      warnings: "Main.kt:1:32: warning: 'fun readLine(): String?' is deprecated.",
    });
  });

  it("maps an uncaught exception to runtime-error with user frames only", async () => {
    stubUpstream({
      errors: { "Main.kt": [] },
      exception: {
        message: "boom",
        fullName: "java.lang.IllegalStateException",
        stackTrace: [
          { className: "MainKt", methodName: "main", fileName: "Main.kt", lineNumber: 2 },
          { className: "MainKt", methodName: "main", fileName: "Main.kt", lineNumber: -1 },
          {
            className: "jdk.internal.reflect.NativeMethodAccessorImpl",
            methodName: "invoke0",
            fileName: null,
            lineNumber: -2,
          },
        ],
        cause: null,
        localizedMessage: null,
      },
      jvmByteCode: null,
      text: "<outStream>before\n</outStream>",
    });

    const response = await runRequest(makeEnv());
    expect(await response.json()).toEqual({
      status: "runtime-error",
      output: "before\n",
      exception:
        "java.lang.IllegalStateException: boom\n" +
        "\tat MainKt.main(Main.kt:2)\n" +
        "\tat MainKt.main(Main.kt:-1)",
    });
  });

  it("promotes the sandbox kill notice to a runtime-error instead of a clean exit", async () => {
    stubUpstream({
      errors: { "Main.kt": [] },
      exception: null,
      jvmByteCode: null,
      text: "<errStream>Evaluation stopped while it's taking too long\u{fe0f}</errStream>",
    });

    const response = await runRequest(makeEnv());
    expect(await response.json()).toEqual({
      status: "runtime-error",
      output: "",
      exception: "Evaluation stopped while it's taking too long",
    });
  });

  it("treats invalid upstream JSON as an upstream error, not an empty run", async () => {
    stubUpstream("<html>gateway</html>");
    expect((await runRequest(makeEnv())).status).toBe(502);
  });

  it("treats an invalid upstream field type as an upstream error", async () => {
    stubUpstream({ errors: { "Main.kt": [{ message: 42, severity: "ERROR" }] }, text: "" });
    expect((await runRequest(makeEnv())).status).toBe(502);
  });

  it("bounds the upstream response before parsing JSON", async () => {
    stubUpstream({
      errors: {},
      exception: null,
      text: `<outStream>${"x".repeat(2 * 1024 * 1024)}</outStream>`,
    });
    expect((await runRequest(makeEnv())).status).toBe(502);
  });

  it("returns 502 for an upstream HTTP failure", async () => {
    stubUpstream({ error: "overloaded" }, 500);
    expect((await runRequest(makeEnv())).status).toBe(502);
  });

  it("returns a bounded 504 when the upstream request times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation timed out", "TimeoutError");
      }),
    );

    expect((await runRequest(makeEnv())).status).toBe(504);
  });

  it("keeps the 504 mapping when the timeout interrupts the response body", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(
      AbortSignal.abort(new DOMException("The operation timed out", "TimeoutError")),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull() {
                throw new DOMException("The operation timed out", "TimeoutError");
              },
            }),
          ),
      ),
    );

    expect((await runRequest(makeEnv())).status).toBe(504);
  });

  it("serves an identical request from the cache without a second upstream call", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const env = makeEnv();

    const first = await runRequest(env);
    const second = await runRequest(env);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(await second.json()).toEqual(await first.json());
  });

  it("does not spend the window on a run served from the cache", async () => {
    // Frozen so the loop cannot straddle a minute boundary and reset the
    // fixed window halfway through.
    vi.spyOn(Date, "now").mockReturnValue(1_770_000_000_000);
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const env = makeEnv();
    const statuses: number[] = [];

    // Same sources every time, so only the first run reaches the upstream and
    // the 10/minute ceiling never applies to the other eleven.
    for (let index = 0; index < 12; index++) {
      statuses.push((await runRequest(env)).status);
    }

    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not cache runtime errors", async () => {
    const spy = stubUpstream({
      errors: { "Main.kt": [] },
      exception: {
        message: "boom",
        fullName: "java.lang.IllegalStateException",
        stackTrace: [],
        cause: null,
      },
      text: "",
    });
    const env = makeEnv();

    await runRequest(env);
    await runRequest(env);

    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("normalizeUpstreamRunResponse", () => {
  it("ignores unknown fields and tolerates missing optional fields", () => {
    expect(
      normalizeUpstreamRunResponse({
        errors: {},
        text: "<outStream>done\n</outStream>",
        someFutureField: { nested: true },
      }),
    ).toEqual({ status: "success", output: "done\n" });
  });

  it("rejects non-object payloads", () => {
    expect(normalizeUpstreamRunResponse(null)).toBeNull();
    expect(normalizeUpstreamRunResponse("errors")).toBeNull();
  });

  it("rejects malformed diagnostics and exceptions", () => {
    expect(normalizeUpstreamRunResponse({ errors: { "Main.kt": "bad" }, text: "" })).toBeNull();
    expect(
      normalizeUpstreamRunResponse({
        errors: {},
        exception: { fullName: 42 },
        text: "",
      }),
    ).toBeNull();
    expect(normalizeUpstreamRunResponse({ errors: {}, text: 42 })).toBeNull();
  });

  it("keeps warnings alongside a compile error", () => {
    expect(
      normalizeUpstreamRunResponse({
        errors: {
          "Main.kt": [
            { message: "bad", severity: "ERROR" },
            { message: "meh", severity: "WARNING" },
          ],
        },
        text: "",
      }),
    ).toEqual({
      status: "compile-error",
      output: "",
      compileErrors: "Main.kt: error: bad",
      warnings: "Main.kt: warning: meh",
    });
  });

  it("preserves text outside stream markers instead of dropping it", () => {
    expect(normalizeUpstreamRunResponse({ errors: {}, text: "plain output" })).toEqual({
      status: "success",
      output: "plain output",
    });
  });

  it("renders exception cause chains", () => {
    expect(
      normalizeUpstreamRunResponse({
        errors: {},
        exception: {
          message: "outer",
          fullName: "java.lang.RuntimeException",
          stackTrace: [],
          cause: {
            message: "inner",
            fullName: "java.lang.IllegalArgumentException",
            stackTrace: [],
            cause: null,
          },
        },
        text: "",
      }),
    ).toEqual({
      status: "runtime-error",
      output: "",
      exception:
        "java.lang.RuntimeException: outer\nCaused by: java.lang.IllegalArgumentException: inner",
    });
  });

  it("does not misread user stderr next to a real exception as a kill notice", () => {
    expect(
      normalizeUpstreamRunResponse({
        errors: {},
        exception: {
          message: "boom",
          fullName: "java.lang.IllegalStateException",
          stackTrace: [],
          cause: null,
        },
        text: "<errStream>Evaluation stopped while it's taking too long</errStream>",
      }),
    ).toEqual({
      status: "runtime-error",
      output: "Evaluation stopped while it's taking too long",
      exception: "java.lang.IllegalStateException: boom",
    });
  });
});
