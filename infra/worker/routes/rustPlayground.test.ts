import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeUpstreamExecuteResponse,
  normalizeUpstreamFormatResponse,
  rustPlaygroundRoute,
} from "./rustPlayground";
import type { Env } from "../env";
import type { UserRow } from "../../db/types";
import { countingRateLimiter, refusingRateLimiter } from "../testing/rateLimit";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SOURCE = 'fn main() {\n    println!("hi");\n}\n';
const FILES = [{ path: "main.rs", content: SOURCE }];

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
function memoryKv(): KVNamespace {
  const values = new Map<string, string>();
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
    RUST_PLAYGROUND_ENABLED: "true",
    RUST_RUN_RATE_LIMITER: countingRateLimiter(Infinity),
    RUST_FORMAT_RATE_LIMITER: countingRateLimiter(Infinity),
    ...overrides,
  } as Env;
}

function runRequest(env: Env, body: BodyInit | null = JSON.stringify({ files: FILES })) {
  return rustPlaygroundRoute.request(
    "http://localhost/run",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "ne_session=session-1" },
      body,
    },
    env,
  );
}

function formatRequest(env: Env, body: BodyInit | null = JSON.stringify({ files: FILES })) {
  return rustPlaygroundRoute.request(
    "http://localhost/format",
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

// Verified live upstream shapes (play.rust-lang.org, 2026-07-19).
const CARGO_NOISE =
  "   Compiling playground v0.0.1 (/playground)\n" +
  "    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.86s\n" +
  "     Running `target/debug/playground`\n";
const UPSTREAM_SUCCESS = {
  success: true,
  exitDetail: "Exited with status 0",
  stdout: "hi\n",
  stderr: CARGO_NOISE,
};

describe("rustPlaygroundRoute", () => {
  it("fails closed when the kill switch is not enabled", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv({ RUST_PLAYGROUND_ENABLED: undefined }));

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

  it.each([
    { label: "no files at all", files: [] },
    {
      label: "a second file",
      files: [...FILES, { path: "extra.rs", content: "fn extra() {}\n" }],
    },
    { label: "a lone lib.rs", files: [{ path: "lib.rs", content: "fn main() {}\n" }] },
  ])("rejects $label instead of exactly one main.rs", async ({ files }) => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv(), JSON.stringify({ files }));

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects the program over the size limit before proxying", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const oversized = `// ${"x".repeat(64 * 1024)}`;
    const response = await runRequest(
      makeEnv(),
      JSON.stringify({ files: [{ path: "main.rs", content: oversized }] }),
    );

    expect(response.status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns 429 once the per-user budget is spent", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv({ RUST_RUN_RATE_LIMITER: refusingRateLimiter() }));

    expect(response.status).toBe(429);
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails closed when the rate-limit binding is missing", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv({ RUST_RUN_RATE_LIMITER: undefined }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Rust Playground execution policy is unavailable",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("runs uncached when CACHE is absent", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv({ CACHE: undefined }));

    expect(response.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("proxies the pinned execute config with a unique user agent, and strips cargo noise", async () => {
    const spy = stubUpstream({
      success: true,
      exitDetail: "Exited with status 0",
      stdout: "out line\n",
      stderr: `${CARGO_NOISE}warning: unused variable: \`x\`\nerr line\n`,
    });

    const response = await runRequest(makeEnv());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "success",
      stdout: "out line\n",
      stderr: "warning: unused variable: `x`\nerr line\n",
    });

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://play.rust-lang.org/execute");
    expect(JSON.parse(String(init?.body))).toEqual({
      channel: "stable",
      mode: "debug",
      edition: "2024",
      crateType: "bin",
      tests: false,
      code: SOURCE,
      backtrace: false,
    });
    expect(new Headers(init?.headers).get("User-Agent")).toContain("NextEditor-RustPlayground");
  });

  it("returns compiler diagnostics as a normal run result, not an HTTP failure", async () => {
    stubUpstream({
      success: false,
      exitDetail: "Exited with status 101",
      stdout: "",
      stderr:
        "   Compiling playground v0.0.1 (/playground)\n" +
        "error: cannot find macro `printn` in this scope\n" +
        " --> src/main.rs:1:13\n" +
        'error: could not compile `playground` (bin "playground") due to 1 previous error\n',
    });

    const response = await runRequest(makeEnv());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "compile-error",
      stdout: "",
      stderr: "",
      compileErrors:
        "error: cannot find macro `printn` in this scope\n" +
        " --> src/main.rs:1:13\n" +
        'error: could not compile `playground` (bin "playground") due to 1 previous error\n',
    });
  });

  it("maps a panic to runtime-error with the exit detail", async () => {
    stubUpstream({
      success: false,
      exitDetail: "Exited with status 101",
      stdout: "before\n",
      stderr: `${CARGO_NOISE}\nthread 'main' (13) panicked at src/main.rs:1:33:\nboom\n`,
    });

    const response = await runRequest(makeEnv());
    expect(await response.json()).toEqual({
      status: "runtime-error",
      stdout: "before\n",
      stderr: "thread 'main' (13) panicked at src/main.rs:1:33:\nboom\n",
      exitDetail: "Exited with status 101",
    });
  });

  it("maps the upstream execution deadline (HTTP 500) to a bounded 504", async () => {
    stubUpstream({ error: "The operation timed out: deadline has elapsed" }, 500);
    expect((await runRequest(makeEnv())).status).toBe(504);
  });

  it("treats invalid upstream JSON as an upstream error, not an empty run", async () => {
    stubUpstream("<html>gateway</html>");
    expect((await runRequest(makeEnv())).status).toBe(502);
  });

  it("treats an invalid upstream field type as an upstream error", async () => {
    stubUpstream({ success: "true", stdout: "", stderr: "" });
    expect((await runRequest(makeEnv())).status).toBe(502);
  });

  it("bounds the upstream response before parsing JSON", async () => {
    stubUpstream({
      success: true,
      exitDetail: "Exited with status 0",
      stdout: "x".repeat(2 * 1024 * 1024),
      stderr: "",
    });
    expect((await runRequest(makeEnv())).status).toBe(502);
  });

  it("returns 502 for a non-timeout upstream HTTP failure", async () => {
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

  it("serves an identical request from the cache without a second upstream call", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const env = makeEnv();

    const first = await runRequest(env);
    const second = await runRequest(env);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(await second.json()).toEqual(await first.json());
  });

  it("does not spend the budget on a run served from the cache", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const limiter = countingRateLimiter(10);
    const env = makeEnv({ RUST_RUN_RATE_LIMITER: limiter });
    const statuses: number[] = [];

    // Same source every time, so only the first run reaches the upstream and
    // the 10/minute ceiling never applies to the other eleven.
    for (let index = 0; index < 12; index++) {
      statuses.push((await runRequest(env)).status);
    }

    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(limiter.keys).toEqual([USER.id]);
  });

  it("does not cache runtime errors", async () => {
    const spy = stubUpstream({
      success: false,
      exitDetail: "Exited with status 101",
      stdout: "",
      stderr: `${CARGO_NOISE}panic\n`,
    });
    const env = makeEnv();

    await runRequest(env);
    await runRequest(env);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("formats main.rs through the Playground format endpoint", async () => {
    const formatted = 'fn main() {\n    println!("x");\n}\n';
    const spy = stubUpstream({
      success: true,
      exitDetail: "Exited with status 0",
      code: formatted,
      stdout: "",
      stderr: "",
    });

    const response = await formatRequest(
      makeEnv(),
      JSON.stringify({ files: [{ path: "main.rs", content: 'fn main(){println!("x");}' }] }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ files: [{ path: "main.rs", content: formatted }] });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://play.rust-lang.org/format");
    expect(JSON.parse(String(init?.body))).toEqual({
      channel: "stable",
      edition: "2024",
      code: 'fn main(){println!("x");}',
    });
  });

  it("applies the kill switch and authentication boundary to formatting", async () => {
    const spy = stubUpstream({ success: true, code: SOURCE, stdout: "", stderr: "" });

    const disabled = await formatRequest(makeEnv({ RUST_PLAYGROUND_ENABLED: undefined }));
    const signedOut = await formatRequest(makeEnv({ DB: dbWithSessionUser(null) }));

    expect(disabled.status).toBe(503);
    expect(signedOut.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns rustfmt syntax diagnostics without changing them into a service failure", async () => {
    stubUpstream({
      success: false,
      exitDetail: "Exited with status 1",
      code: "fn main() { let x = ; }",
      stdout: "",
      stderr: "error: expected expression, found `;`\n --> /playground/src/main.rs:1:21\n",
    });

    const response = await formatRequest(makeEnv());

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "error: expected expression, found `;`\n --> /playground/src/main.rs:1:21\n",
    });
  });

  it("rate-limits formatting independently from Run", async () => {
    const spy = stubUpstream({ success: true, code: SOURCE, stdout: "", stderr: "" });

    const response = await formatRequest(
      makeEnv({ RUST_FORMAT_RATE_LIMITER: refusingRateLimiter() }),
    );

    expect(response.status).toBe(429);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("normalizeUpstreamExecuteResponse", () => {
  it("ignores unknown fields and tolerates a missing exitDetail", () => {
    expect(
      normalizeUpstreamExecuteResponse({
        success: true,
        stdout: "done\n",
        stderr: "",
        someFutureField: { nested: true },
      }),
    ).toEqual({ status: "success", stdout: "done\n", stderr: "" });
  });

  it("rejects non-object payloads and wrong field types", () => {
    expect(normalizeUpstreamExecuteResponse(null)).toBeNull();
    expect(normalizeUpstreamExecuteResponse("success")).toBeNull();
    expect(normalizeUpstreamExecuteResponse({ success: true, stdout: "", stderr: 1 })).toBeNull();
    expect(
      normalizeUpstreamExecuteResponse({ success: true, stdout: "", stderr: "", exitDetail: 0 }),
    ).toBeNull();
  });

  it("rejects a failed run with no diagnostics instead of inventing an outcome", () => {
    expect(
      normalizeUpstreamExecuteResponse({ success: false, exitDetail: "", stdout: "", stderr: "" }),
    ).toBeNull();
  });

  // The Running check must stay on one line. `^\s+` let it run across blank
  // lines: a failed build whose diagnostics hold "\n\nRunning `" read as a
  // program that had started, and a long run of blank lines made the match
  // retry from every line start, costing quadratic Worker CPU.
  it("classifies a build failure by a Running line on one line only", () => {
    expect(
      normalizeUpstreamExecuteResponse({
        success: false,
        exitDetail: "",
        stdout: "",
        stderr: "error: \n\nRunning `not-cargo`\n",
      }),
    ).toMatchObject({ status: "compile-error" });
  });

  it("classifies a failed build with a long run of blank lines in linear time", () => {
    const startedAt = performance.now();
    const result = normalizeUpstreamExecuteResponse({
      success: false,
      exitDetail: "",
      stdout: "",
      stderr: `error: ${"\n".repeat(50_000)}aborting\n`,
    });

    expect(result).toMatchObject({ status: "compile-error" });
    // About 3 s with the old pattern on a desktop machine; well under 1 ms now.
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("keeps rustc warnings in stderr while stripping cargo status lines", () => {
    expect(
      normalizeUpstreamExecuteResponse({
        success: true,
        exitDetail: "Exited with status 0",
        stdout: "ok\n",
        stderr: `${CARGO_NOISE}warning: unused variable\n`,
      }),
    ).toEqual({ status: "success", stdout: "ok\n", stderr: "warning: unused variable\n" });
  });
});

describe("normalizeUpstreamFormatResponse", () => {
  it("rejects malformed payloads", () => {
    expect(normalizeUpstreamFormatResponse(null)).toBeNull();
    expect(normalizeUpstreamFormatResponse({ success: true, code: 42 })).toBeNull();
    expect(normalizeUpstreamFormatResponse({ success: false, stderr: "" })).toBeNull();
  });

  it("normalizes an upstream formatting error as source feedback", () => {
    expect(normalizeUpstreamFormatResponse({ success: false, stderr: "error: bad" })).toEqual({
      kind: "source-error",
      error: "error: bad",
    });
  });
});
