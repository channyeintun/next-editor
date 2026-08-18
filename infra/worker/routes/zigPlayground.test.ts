import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyFailure,
  normalizeUpstreamFormatResponse,
  normalizeUpstreamRunResponse,
  scrubUpstreamPaths,
  zigPlaygroundRoute,
} from "./zigPlayground";
import type { Env } from "../env";
import type { UserRow } from "../../db/types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SOURCE =
  'const std = @import("std");\npub fn main() void {\n    std.debug.print("hi\\n", .{});\n}\n';
const FILES = [{ path: "main.zig", content: SOURCE }];

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
    ZIG_PLAYGROUND_ENABLED: "true",
    ...overrides,
  } as Env;
}

function runRequest(env: Env, body: BodyInit | null = JSON.stringify({ files: FILES })) {
  return zigPlaygroundRoute.request(
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
  return zigPlaygroundRoute.request(
    "http://localhost/format",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "ne_session=session-1" },
      body,
    },
    env,
  );
}

function stubUpstream(body: string, status = 200) {
  const spy = vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>(
    async () => new Response(body, { status }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

// ---------------------------------------------------------------------------
// Verified live upstream bodies (zig-play.dev, Zig 0.16.0, 2026-08-18). These
// are transcribed from real responses, not invented: the whole point of the
// normalizer is that this service reports a compile failure and a runtime
// panic with the same HTTP status, so the fixtures have to be the real thing.
// ---------------------------------------------------------------------------

const UPSTREAM_SUCCESS = "debug-print goes here\n";

const UPSTREAM_COMPILE_ERROR =
  "/tmp/playground3492866164/play.zig:4:20: error: root source file struct 'fs' has no member named 'File'\n" +
  "    var w = std.fs.File.stdout().writer(io, &buf);\n" +
  "                   ^~~~\n" +
  "/home/play/.zvm/0.16.0/lib/std/fs.zig:1:1: note: struct declared here\n" +
  "//! File System.\n" +
  "^~~~~~~~~~~~~~~~\n" +
  "referenced by:\n" +
  "    callMain [inlined]: /home/play/.zvm/0.16.0/lib/std/start.zig:698:59\n" +
  "    posixCallMainAndExit: /home/play/.zvm/0.16.0/lib/std/start.zig:590:38\n";

const UPSTREAM_PANIC =
  "before the crash\n" +
  "i=250\n" +
  "thread 10 panic: integer overflow\n" +
  "/tmp/playground2307843084/play.zig:5:23: 0x11d2d2c in main (play.zig)\n" +
  '    while (true) : (i += 10) std.debug.print("i={d}\\n", .{i});\n' +
  "                      ^\n" +
  "/home/play/.zvm/0.16.0/lib/std/start.zig:698:59: 0x11d2601 in callMain (std.zig)\n" +
  "    if (fn_info.params.len == 0) return wrapMain(root.main());\n" +
  "                                                          ^\n";

const UPSTREAM_UNHANDLED_ERROR =
  "before\n" +
  "error: OutOfCoffee\n" +
  "/tmp/playground9/play.zig:2:19: 0x102c4994b in boom (play.zig)\n" +
  "fn boom() !void { return error.OutOfCoffee; }\n" +
  "                  ^\n";

const UPSTREAM_FMT_ERROR =
  "<stdin>:1:27: error: expected ';' after declaration\n" + 'const std = @import("std")\n';

describe("scrubUpstreamPaths", () => {
  it("rewrites the sandbox scratch path to the file the learner sees", () => {
    // The directory number changes on every single run, so leaving it in would
    // make otherwise identical output uncacheable and unstable in a recording.
    expect(scrubUpstreamPaths("/tmp/playground2307843084/play.zig:5:23: oops")).toBe(
      "main.zig:5:23: oops",
    );
  });

  it("rewrites the version-pinned stdlib path", () => {
    expect(scrubUpstreamPaths("/home/play/.zvm/0.16.0/lib/std/start.zig:698:59")).toBe(
      "std/start.zig:698:59",
    );
  });

  it("rewrites the module name in stack frames", () => {
    expect(scrubUpstreamPaths("0x11d2d2c in main (play.zig)")).toBe("0x11d2d2c in main (main.zig)");
  });

  it("leaves output that mentions no server path untouched", () => {
    expect(scrubUpstreamPaths("Squares: { 1, 4, 9 }\n")).toBe("Squares: { 1, 4, 9 }\n");
  });
});

describe("classifyFailure", () => {
  // This is the crux: the upstream answers HTTP 400 for both, so only the text
  // separates "your program never built" from "your program ran and died".
  it("reads a compiler diagnostic as a compile error", () => {
    expect(classifyFailure(UPSTREAM_COMPILE_ERROR)).toEqual({ status: "compile-error" });
  });

  it("does not mistake the compiler's own reference trace for a stack trace", () => {
    // "referenced by:" frames name source locations but carry no code address.
    expect(UPSTREAM_COMPILE_ERROR).toContain("referenced by:");
    expect(classifyFailure(UPSTREAM_COMPILE_ERROR).status).toBe("compile-error");
  });

  it("reads a panic header as a runtime error and keeps the reason", () => {
    expect(classifyFailure(UPSTREAM_PANIC)).toEqual({
      status: "runtime-error",
      exitDetail: "panic: integer overflow",
    });
  });

  it("reads an error returned out of main as a runtime error", () => {
    expect(classifyFailure(UPSTREAM_UNHANDLED_ERROR)).toEqual({
      status: "runtime-error",
      exitDetail: "unhandled error: OutOfCoffee",
    });
  });

  it("falls back to a runtime error when only a stack trace survives", () => {
    expect(classifyFailure("main.zig:1:1: 0xdeadbeef in main (main.zig)\n")).toEqual({
      status: "runtime-error",
      exitDetail: "Program exited with an error",
    });
  });
});

describe("normalizeUpstreamRunResponse", () => {
  it("treats HTTP 200 as a successful run", () => {
    expect(normalizeUpstreamRunResponse(200, UPSTREAM_SUCCESS)).toEqual({
      status: "success",
      output: "debug-print goes here\n",
    });
  });

  it("turns a compile failure into diagnostics with no program output", () => {
    const result = normalizeUpstreamRunResponse(400, UPSTREAM_COMPILE_ERROR);

    expect(result?.status).toBe("compile-error");
    expect(result?.output).toBe("");
    expect(result?.compileErrors).toContain("main.zig:4:20: error:");
    expect(result?.compileErrors).not.toContain("/tmp/playground");
    expect(result?.compileErrors).not.toContain("/home/play/.zvm");
    expect(result?.exitDetail).toBeUndefined();
  });

  it("keeps the output a crashed program printed before it died", () => {
    const result = normalizeUpstreamRunResponse(400, UPSTREAM_PANIC);

    expect(result?.status).toBe("runtime-error");
    expect(result?.exitDetail).toBe("panic: integer overflow");
    // The pre-crash output and the trace both belong to the learner.
    expect(result?.output).toContain("before the crash");
    expect(result?.output).toContain("i=250");
    expect(result?.output).toContain("main.zig:5:23:");
    expect(result?.output).not.toContain("/tmp/playground");
    expect(result?.compileErrors).toBeUndefined();
  });

  it("rejects an empty failure body rather than reporting an empty run", () => {
    expect(normalizeUpstreamRunResponse(400, "   \n")).toBeNull();
  });

  it("rejects a status that describes no program outcome", () => {
    expect(normalizeUpstreamRunResponse(500, "boom")).toBeNull();
    expect(normalizeUpstreamRunResponse(429, "Too many requests")).toBeNull();
  });
});

describe("normalizeUpstreamFormatResponse", () => {
  it("returns the formatted source as main.zig", () => {
    const formatted = "pub fn main() void {}\n";
    expect(normalizeUpstreamFormatResponse(200, formatted)).toEqual({
      kind: "result",
      result: { files: [{ path: "main.zig", content: formatted }] },
    });
  });

  it("reports a parse failure as a source error, named for the learner's file", () => {
    const normalized = normalizeUpstreamFormatResponse(400, UPSTREAM_FMT_ERROR);

    expect(normalized?.kind).toBe("source-error");
    expect(normalized && "error" in normalized && normalized.error).toContain(
      "main.zig:1:27: error: expected ';' after declaration",
    );
  });

  it("rejects an unexpected status", () => {
    expect(normalizeUpstreamFormatResponse(502, "nope")).toBeNull();
  });
});

describe("zigPlaygroundRoute", () => {
  it("fails closed when the kill switch is not enabled", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv({ ZIG_PLAYGROUND_ENABLED: undefined }));

    expect(response.status).toBe(503);
    expect(spy).not.toHaveBeenCalled();
  });

  it("requires a signed-in session", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv({ DB: dbWithSessionUser(null) }));

    expect(response.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("runs a program and normalizes the upstream text response", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "success",
      output: "debug-print goes here\n",
    });

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://zig-play.dev/server/run");
    // The upstream protocol is the raw source as a text body, not JSON.
    expect(init?.body).toBe(SOURCE);
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("text/plain");
    expect(headers["X-Zig-Version"]).toBe("0.16.0");
  });

  it("rejects a workspace that is not exactly one main.zig", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(
      makeEnv(),
      JSON.stringify({ files: [{ path: "other.zig", content: SOURCE }] }),
    );

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("serves a repeated run from the cache without calling upstream again", async () => {
    // Matters more here than elsewhere: the upstream allows only 5 requests a
    // minute per IP, and every user of this Worker shares that budget.
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const env = makeEnv();

    await runRequest(env);
    const second = await runRequest(env);

    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({
      status: "success",
      output: "debug-print goes here\n",
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not cache a runtime error", async () => {
    const spy = stubUpstream(UPSTREAM_PANIC, 400);
    const env = makeEnv();

    await runRequest(env);
    await runRequest(env);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("passes the upstream's own rate limit through as a rate limit", async () => {
    const spy = stubUpstream("Too many requests.", 429);
    const response = await runRequest(makeEnv());

    expect(response.status).toBe(429);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("limits runs per user below the upstream's shared budget", async () => {
    stubUpstream(UPSTREAM_SUCCESS);
    const env = makeEnv();
    const statuses: number[] = [];

    // Distinct sources so the cache cannot absorb the repeats.
    for (let index = 0; index < 6; index++) {
      const response = await runRequest(
        env,
        JSON.stringify({ files: [{ path: "main.zig", content: `${SOURCE}// ${index}\n` }] }),
      );
      statuses.push(response.status);
    }

    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
  });

  it("fails closed when the rate-limit store is missing", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(makeEnv({ CACHE: undefined }));

    expect(response.status).toBe(502);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports an upstream timeout as 504", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      }),
    );

    const response = await runRequest(makeEnv());
    expect(response.status).toBe(504);
  });

  it("formats a program and returns it as main.zig", async () => {
    const formatted = "pub fn main() void {}\n";
    const spy = stubUpstream(formatted);
    const response = await formatRequest(makeEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      files: [{ path: "main.zig", content: formatted }],
    });
    expect(spy.mock.calls[0][0]).toBe("https://zig-play.dev/server/fmt");
  });

  it("reports an unformattable program as 422, not a service failure", async () => {
    stubUpstream(UPSTREAM_FMT_ERROR, 400);
    const response = await formatRequest(makeEnv());

    expect(response.status).toBe(422);
  });
});
