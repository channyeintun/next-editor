import { afterEach, describe, expect, it, vi } from "vitest";
import { haskellPlaygroundRoute, normalizeUpstreamRunResponse } from "./haskellPlayground";
import type { Env } from "../env";
import type { UserRow } from "../../db/types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SOURCE = 'main :: IO ()\nmain = putStrLn "Hello, Haskell!"\n';
const FILES = [{ path: "Main.hs", content: SOURCE }];

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
    HASKELL_PLAYGROUND_ENABLED: "true",
    ...overrides,
  } as Env;
}

function runRequest(env: Env, body: BodyInit | null = JSON.stringify({ files: FILES })) {
  return haskellPlaygroundRoute.request(
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

// ---------------------------------------------------------------------------
// Verified live upstream bodies (play.haskell.org, GHC 9.12.4, opt O1,
// 2026-08-23). Transcribed from real responses, not invented: the reason this
// normalizer exists is that a non-zero exit code alone cannot separate "it
// never built" from "it built, ran, and died", so the fixtures have to be the
// real thing — in particular RUNTIME_ERROR_WITH_WARNING, which is the case the
// naive "nothing on stdout, so it must be a compile error" rule gets wrong.
// ---------------------------------------------------------------------------

const UPSTREAM_SUCCESS = {
  ec: 0,
  ghcout: "",
  sout: "Hello, Haskell!\n",
  serr: "",
  timesecs: 0.834,
};

const MISSING_SIGNATURE_WARNING =
  "Main.hs:6:10: warning: [GHC-06201] [-Wmissing-signatures]\n" +
  "    Top-level binding with no type signature: greet :: String -> String\n" +
  "  |\n" +
  '6 | greet name = "Hello, " ++ name\n' +
  "  |          ^^^^^\n";

const UPSTREAM_SUCCESS_WITH_WARNINGS = {
  ec: 0,
  ghcout: MISSING_SIGNATURE_WARNING,
  sout: "Hello, Ada\n",
  serr: "",
  timesecs: 1.104,
};

const UPSTREAM_COMPILE_ERROR = {
  ec: 1,
  ghcout:
    "Main.hs:2:22: error: [GHC-83865]\n" +
    "    • Couldn't match type ‘[Char]’ with ‘Int’\n" +
    "      Expected: Int\n" +
    "        Actual: String\n" +
    '    • In the second argument of ‘(+)’, namely ‘"2"’\n' +
    '      In the first argument of ‘print’, namely ‘(1 + "2")’\n' +
    "  |\n" +
    '2 | main = print (1 + "2")\n' +
    "  |                      ^^^\n",
  sout: "",
  serr: "",
  timesecs: 0.612,
};

const UPSTREAM_RUNTIME_ERROR = {
  ec: 1,
  ghcout: "",
  sout: "starting\n",
  serr:
    "Main: boom\n" +
    "CallStack (from HasCallStack):\n" +
    "  error, called at Main.hs:4:8 in main:Main\n",
  timesecs: 0.907,
};

// `print (head [])`: it COMPILES (with only a -Wx-partial warning), runs,
// prints nothing on stdout, and exits 1. Exit-code-plus-empty-stdout would
// call this a compile error; only the absence of an "error:" diagnostic in
// ghcout gets it right.
const UPSTREAM_RUNTIME_ERROR_WITH_WARNINGS = {
  ec: 1,
  ghcout:
    "Main.hs:2:14: warning: [GHC-63394] [-Wx-partial]\n" +
    "    In the use of ‘head’\n" +
    "    (imported from Prelude, but defined in GHC.List):\n" +
    '    "This is a partial function, it throws an error on empty lists."\n' +
    "  |\n" +
    "2 | main = print (head [])\n" +
    "  |                    ^^^^\n",
  sout: "",
  serr:
    "Main: Prelude.head: empty list\n" +
    "CallStack (from HasCallStack):\n" +
    "  error, called at libraries/base/GHC/List.hs:1646:3 in base:GHC.List\n" +
    "  badHead, called at libraries/base/GHC/List.hs:81:28 in base:GHC.List\n" +
    "  head, called at Main.hs:2:14 in main:Main\n",
  timesecs: 0.688,
};

const UPSTREAM_TIMEOUT = { err: "timeout" };
const UPSTREAM_BACKEND_ERROR = { err: "backend" };

describe("normalizeUpstreamRunResponse", () => {
  it("reads a clean run as a success with both streams", () => {
    expect(normalizeUpstreamRunResponse(UPSTREAM_SUCCESS)).toEqual({
      kind: "result",
      result: { status: "success", stdout: "Hello, Haskell!\n", stderr: "" },
    });
  });

  it("drops timesecs and any unknown upstream field", () => {
    expect(
      normalizeUpstreamRunResponse({ ...UPSTREAM_SUCCESS, someFutureField: { nested: true } }),
    ).toEqual({
      kind: "result",
      result: { status: "success", stdout: "Hello, Haskell!\n", stderr: "" },
    });
  });

  it("keeps compiler warnings out of the program's own streams", () => {
    // ghcout is GHC's channel; sout/serr belong to the program. Collapsing
    // them would erase a split the upstream really made.
    expect(normalizeUpstreamRunResponse(UPSTREAM_SUCCESS_WITH_WARNINGS)).toEqual({
      kind: "result",
      result: {
        status: "success",
        stdout: "Hello, Ada\n",
        stderr: "",
        warnings: MISSING_SIGNATURE_WARNING,
      },
    });
  });

  it("turns an error diagnostic into a compile error with nothing having run", () => {
    const normalized = normalizeUpstreamRunResponse(UPSTREAM_COMPILE_ERROR);

    expect(normalized?.kind).toBe("result");
    const result = normalized && "result" in normalized ? normalized.result : null;
    expect(result?.status).toBe("compile-error");
    expect(result?.stdout).toBe("");
    expect(result?.stderr).toBe("");
    expect(result?.compileErrors).toContain("Main.hs:2:22: error: [GHC-83865]");
    // The whole of ghcout is the failure text here — no warnings channel.
    expect(result?.warnings).toBeUndefined();
    expect(result?.exitDetail).toBeUndefined();
  });

  it("keeps what a crashed program printed before it died", () => {
    expect(normalizeUpstreamRunResponse(UPSTREAM_RUNTIME_ERROR)).toEqual({
      kind: "result",
      result: {
        status: "runtime-error",
        stdout: "starting\n",
        stderr: UPSTREAM_RUNTIME_ERROR.serr,
        exitDetail: "Exited with status 1",
      },
    });
  });

  it("reads a warned-but-compiled program that dies as a runtime error", () => {
    // The crux. Empty stdout plus a non-zero exit looks exactly like a failed
    // build; the ghcout diagnostic is a warning, not an error, so it ran.
    const normalized = normalizeUpstreamRunResponse(UPSTREAM_RUNTIME_ERROR_WITH_WARNINGS);

    expect(normalized?.kind).toBe("result");
    const result = normalized && "result" in normalized ? normalized.result : null;
    expect(result?.status).toBe("runtime-error");
    expect(result?.stdout).toBe("");
    expect(result?.stderr).toContain("Prelude.head: empty list");
    expect(result?.exitDetail).toBe("Exited with status 1");
    expect(result?.warnings).toContain("[-Wx-partial]");
    expect(result?.compileErrors).toBeUndefined();
  });

  it("does not read a warning as an error just because the exit code is non-zero", () => {
    // Guards the regex itself: "warning:" must not satisfy the error test even
    // when the word "error" appears in the warning's prose.
    const normalized = normalizeUpstreamRunResponse({
      ec: 2,
      ghcout: "Main.hs:1:1: warning: [GHC-00000] this throws an error on empty lists\n",
      sout: "",
      serr: "Main: nope\n",
      timesecs: 0.1,
    });

    expect(normalized).toEqual({
      kind: "result",
      result: {
        status: "runtime-error",
        stdout: "",
        stderr: "Main: nope\n",
        exitDetail: "Exited with status 2",
        warnings: "Main.hs:1:1: warning: [GHC-00000] this throws an error on empty lists\n",
      },
    });
  });

  it("ignores a stale error diagnostic when the program exited cleanly", () => {
    // ec === 0 is decisive: the build produced a binary, so ghcout is advisory.
    const normalized = normalizeUpstreamRunResponse({
      ec: 0,
      ghcout: "Main.hs:1:1: error: [GHC-83865] impossible\n",
      sout: "done\n",
      serr: "",
      timesecs: 0.2,
    });

    expect(normalized).toEqual({
      kind: "result",
      result: {
        status: "success",
        stdout: "done\n",
        stderr: "",
        warnings: "Main.hs:1:1: error: [GHC-83865] impossible\n",
      },
    });
  });

  it("reports the upstream run deadline as its own outcome, not a bad payload", () => {
    expect(normalizeUpstreamRunResponse(UPSTREAM_TIMEOUT)).toEqual({ kind: "timeout" });
  });

  it("rejects every other service report", () => {
    expect(normalizeUpstreamRunResponse(UPSTREAM_BACKEND_ERROR)).toBeNull();
    expect(normalizeUpstreamRunResponse({ err: "something added later" })).toBeNull();
    expect(normalizeUpstreamRunResponse({ err: 42 })).toBeNull();
  });

  it("rejects payloads that describe no outcome at all", () => {
    expect(normalizeUpstreamRunResponse(null)).toBeNull();
    expect(normalizeUpstreamRunResponse("Service busy, please try again later")).toBeNull();
    expect(normalizeUpstreamRunResponse([UPSTREAM_SUCCESS])).toBeNull();
    expect(normalizeUpstreamRunResponse({})).toBeNull();
  });

  it("rejects a field with an unexpected type instead of reporting an empty run", () => {
    expect(normalizeUpstreamRunResponse({ ...UPSTREAM_SUCCESS, ec: "0" })).toBeNull();
    expect(normalizeUpstreamRunResponse({ ...UPSTREAM_SUCCESS, ec: 1.5 })).toBeNull();
    expect(normalizeUpstreamRunResponse({ ...UPSTREAM_SUCCESS, ghcout: null })).toBeNull();
    expect(normalizeUpstreamRunResponse({ ...UPSTREAM_SUCCESS, sout: ["hi"] })).toBeNull();
    expect(normalizeUpstreamRunResponse({ ...UPSTREAM_SUCCESS, serr: 0 })).toBeNull();
  });

  it("bounds every stream it forwards", () => {
    const huge = "x".repeat(300 * 1024);
    const normalized = normalizeUpstreamRunResponse({
      ec: 0,
      ghcout: huge,
      sout: huge,
      serr: huge,
      timesecs: 1,
    });
    const result = normalized && "result" in normalized ? normalized.result : null;

    for (const stream of [result?.stdout, result?.stderr, result?.warnings]) {
      expect(stream).toMatch(/\n\[output truncated\]$/);
      expect(stream?.length).toBe(256 * 1024 + "\n[output truncated]".length);
    }
  });
});

describe("haskellPlaygroundRoute", () => {
  it("fails closed when the kill switch is not enabled", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv({ HASKELL_PLAYGROUND_ENABLED: undefined }));

    expect(response.status).toBe(503);
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails closed for any value other than the exact string true", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv({ HASKELL_PLAYGROUND_ENABLED: "TRUE" }));

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

  it("rejects unknown fields inside the file object", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(
      makeEnv(),
      JSON.stringify({ files: [{ path: "Main.hs", content: SOURCE, mode: 420 }] }),
    );

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    { label: "no files at all", files: [] },
    { label: "a second module", files: [...FILES, { path: "Helper.hs", content: "x = 1\n" }] },
    { label: "a lowercase main.hs", files: [{ path: "main.hs", content: SOURCE }] },
    { label: "literate Haskell", files: [{ path: "Main.lhs", content: SOURCE }] },
    { label: "a nested path", files: [{ path: "src/Main.hs", content: SOURCE }] },
  ])("rejects $label instead of exactly one Main.hs", async ({ files }) => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv(), JSON.stringify({ files }));

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a non-string content before proxying", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(
      makeEnv(),
      JSON.stringify({ files: [{ path: "Main.hs", content: 42 }] }),
    );

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects the program over the size limit before proxying", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const oversized = `-- ${"x".repeat(64 * 1024)}`;
    const response = await runRequest(
      makeEnv(),
      JSON.stringify({ files: [{ path: "Main.hs", content: oversized }] }),
    );

    expect(response.status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
  });

  it("proxies the pinned GHC version, opt level, and output mode with a unique user agent", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "success",
      stdout: "Hello, Haskell!\n",
      stderr: "",
    });

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://play.haskell.org/submit");
    expect(JSON.parse(String(init?.body))).toEqual({
      code: SOURCE,
      version: "9.12.4",
      opt: "O1",
      output: "run",
    });
    expect(new Headers(init?.headers).get("User-Agent")).toContain("NextEditor-HaskellPlayground");
  });

  it("returns compiler diagnostics as a normal run result, not an HTTP failure", async () => {
    stubUpstream(UPSTREAM_COMPILE_ERROR);
    const response = await runRequest(makeEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "compile-error",
      stdout: "",
      stderr: "",
      compileErrors: UPSTREAM_COMPILE_ERROR.ghcout,
    });
  });

  it("returns 429 once the per-user minute window is exhausted", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    // Freeze the clock: the seeded key and the route's own key are computed at
    // different moments, and a minute boundary between them would leave the
    // seeded count invisible and let the request through.
    vi.spyOn(Date, "now").mockReturnValue(1_770_000_000_000);
    const windowKey = `hp:rl:${USER.id}:${Math.floor(Date.now() / 60_000)}`;
    const response = await runRequest(makeEnv({ CACHE: memoryKv({ [windowKey]: "6" }) }));

    expect(response.status).toBe(429);
    expect(spy).not.toHaveBeenCalled();
  });

  it("limits runs per user below what the shared community pool can absorb", async () => {
    stubUpstream(UPSTREAM_SUCCESS);
    // Freeze the clock so the loop cannot straddle a minute boundary and reset
    // the fixed window halfway through.
    vi.spyOn(Date, "now").mockReturnValue(1_770_000_000_000);
    const env = makeEnv();
    const statuses: number[] = [];

    // Distinct sources so the cache cannot absorb the repeats.
    for (let index = 0; index < 8; index++) {
      const response = await runRequest(
        env,
        JSON.stringify({ files: [{ path: "Main.hs", content: `${SOURCE}-- ${index}\n` }] }),
      );
      statuses.push(response.status);
    }

    expect(statuses.filter((status) => status === 200)).toHaveLength(6);
    expect(statuses.filter((status) => status === 429)).toHaveLength(2);
  });

  it("fails closed when the rate-limit store is missing", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv({ CACHE: undefined }));

    expect(response.status).toBe(502);
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails closed when the rate-limit store throws", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const failingKv = {
      get: async () => {
        throw new Error("KV unavailable");
      },
      put: async () => undefined,
    } as unknown as KVNamespace;

    const response = await runRequest(makeEnv({ CACHE: failingKv }));

    expect(response.status).toBe(502);
    expect(spy).not.toHaveBeenCalled();
  });

  it("serves an identical request from the cache without a second upstream call", async () => {
    // Matters more here than elsewhere: every run occupies one worker of a
    // small shared pool for seconds of real compile time.
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const env = makeEnv();

    const first = await runRequest(env);
    const second = await runRequest(env);

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("caches a compile error, which is just as deterministic as a success", async () => {
    const spy = stubUpstream(UPSTREAM_COMPILE_ERROR);
    const env = makeEnv();

    await runRequest(env);
    const second = await runRequest(env);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(await second.json()).toMatchObject({ status: "compile-error" });
  });

  it("does not cache a runtime error", async () => {
    const spy = stubUpstream(UPSTREAM_RUNTIME_ERROR);
    const env = makeEnv();

    await runRequest(env);
    await runRequest(env);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("keeps warnings on the round trip through the cache", async () => {
    stubUpstream(UPSTREAM_SUCCESS_WITH_WARNINGS);
    const env = makeEnv();

    await runRequest(env);
    const second = await runRequest(env);

    expect(await second.json()).toEqual({
      status: "success",
      stdout: "Hello, Ada\n",
      stderr: "",
      warnings: MISSING_SIGNATURE_WARNING,
    });
  });

  it("maps the upstream run deadline to a bounded 504", async () => {
    // The upstream answers HTTP 200 with {"err":"timeout"} after its own 5s
    // limit; that is the program's outcome, not a broken service.
    stubUpstream(UPSTREAM_TIMEOUT);
    expect((await runRequest(makeEnv())).status).toBe(504);
  });

  it("maps any other upstream error report to 502", async () => {
    stubUpstream(UPSTREAM_BACKEND_ERROR);
    expect((await runRequest(makeEnv())).status).toBe(502);
  });

  it("maps upstream backpressure to 502 rather than blaming the learner", async () => {
    // 503 "Service busy" means the shared worker pool is saturated by other
    // traffic; a 429 would tell the learner they ran too often, which is not
    // what happened.
    const spy = stubUpstream("Service busy, please try again later\n", 503);
    const response = await runRequest(makeEnv());

    expect(response.status).toBe(502);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("returns 502 for an unparseable upstream body", async () => {
    stubUpstream("<html>gateway</html>");
    expect((await runRequest(makeEnv())).status).toBe(502);
  });

  it("returns 502 for an upstream HTTP failure", async () => {
    stubUpstream("Invalid JSON", 400);
    expect((await runRequest(makeEnv())).status).toBe(502);
  });

  it("bounds the upstream response before parsing JSON", async () => {
    stubUpstream({ ec: 0, ghcout: "", sout: "x".repeat(2 * 1024 * 1024), serr: "", timesecs: 1 });
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

  it("reports an unreachable upstream as 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Network connection lost");
      }),
    );

    expect((await runRequest(makeEnv())).status).toBe(502);
  });
});
