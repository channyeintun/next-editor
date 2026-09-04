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
// Verified live upstream bodies (zig-play.dev, Zig 0.16.0, 2026-08-18; the
// unhandled-error and non-zero-exit bodies recaptured 2026-09-03). These are
// transcribed from real responses, not invented: the whole point of the
// normalizer is that this service reports a compile failure, a runtime panic
// and a plain non-zero exit with the same HTTP status, so the fixtures have to
// be the real thing.
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
  "/tmp/playground959960108/play.zig:2:19: 0x11d204c in boom (play.zig)\n" +
  "fn boom() !void { return error.OutOfCoffee; }\n" +
  "                  ^\n" +
  "/tmp/playground959960108/play.zig:5:5: 0x11d20ac in main (play.zig)\n" +
  "    try boom();\n" +
  "    ^\n";

// `std.debug.print("usage: prog <n>\n", .{}); std.process.exit(2);` — the
// program built and ran, and the upstream still answers 400 with nothing but
// the program's own output.
const UPSTREAM_NONZERO_EXIT = "usage: prog <n>\n";

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

  it("reads a plain non-zero exit as a runtime error, not a failed build", () => {
    // The upstream answers 400 for any non-zero exit, so a program that ran,
    // printed, and called std.process.exit(2) arrives with nothing but its own
    // output. Calling that a compile error tells the learner their code does
    // not build — and caches that verdict for an hour.
    expect(classifyFailure(UPSTREAM_NONZERO_EXIT)).toEqual({
      status: "runtime-error",
      exitDetail: "Program exited with a non-zero status",
    });
  });

  it("does not report a service failure as the learner's compile error", () => {
    // Captured from the upstream when it could not resolve a toolchain: same
    // 400, but the body is its own log, and nothing about the learner's code.
    const serviceDump =
      "  Error   \n" +
      '2026/09/03 03:12:51 ERRO Get "https://ziglang.org/download/index.json": dial tcp: ' +
      "lookup ziglang.org on 108.61.10.10:53: network is unreachable\n\n" +
      "If you're experiencing a bug, run zvm upgrade.\n";

    expect(classifyFailure(serviceDump).status).toBe("runtime-error");
  });

  it("does not read the learner's own echoed source as a runtime signature", () => {
    // A diagnostic echoes the offending line verbatim, so the body of a
    // genuine compile failure can contain text shaped like a runtime signal.
    const echoedErrorSet =
      "main.zig:2:6: error: expected '.', found ':'\n" + "error: OutOfMemory\n" + "     ^\n";
    const echoedAddress =
      "main.zig:3:19: error: expected type 'u8', found '*const [18:0]u8'\n" +
      'const x: u8 = "value: 0xff in hex";\n' +
      "              ^\n";

    expect(classifyFailure(echoedErrorSet)).toEqual({ status: "compile-error" });
    expect(classifyFailure(echoedAddress)).toEqual({ status: "compile-error" });
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

  it("reports a silent non-zero exit as a runtime error", () => {
    // A program that exits non-zero without printing gets a 400 with an empty
    // body. That is a real outcome of a program that ran, not a build failure
    // and not a service fault, and it must never be cached.
    expect(normalizeUpstreamRunResponse(400, "   \n")).toEqual({
      status: "runtime-error",
      output: "   \n",
      exitDetail: "Program exited with a non-zero status",
    });
  });

  it("keeps a plain non-zero exit out of the compile-error bucket", () => {
    const result = normalizeUpstreamRunResponse(400, UPSTREAM_NONZERO_EXIT);

    expect(result?.status).toBe("runtime-error");
    expect(result?.output).toBe("usage: prog <n>\n");
    expect(result?.compileErrors).toBeUndefined();
  });

  it("truncates output too large to show instead of losing the whole run", () => {
    const result = normalizeUpstreamRunResponse(200, "x".repeat(300 * 1024));

    expect(result?.status).toBe("success");
    expect(result?.output.endsWith("[output truncated]")).toBe(true);
  });

  it("rejects a status that describes no program outcome", () => {
    expect(normalizeUpstreamRunResponse(500, "boom")).toBeNull();
    expect(normalizeUpstreamRunResponse(429, "Too many requests")).toBeNull();
  });
});

describe("normalizeUpstreamFormatResponse", () => {
  it("returns the formatted source as main.zig", () => {
    const formatted = "pub fn main() void {}\n";
    expect(normalizeUpstreamFormatResponse(200, formatted, SOURCE)).toEqual({
      kind: "result",
      result: { files: [{ path: "main.zig", content: formatted }] },
    });
  });

  it("reports a parse failure as a source error, named for the learner's file", () => {
    const normalized = normalizeUpstreamFormatResponse(400, UPSTREAM_FMT_ERROR, SOURCE);

    expect(normalized?.kind).toBe("source-error");
    expect(normalized && "error" in normalized && normalized.error).toContain(
      "main.zig:1:27: error: expected ';' after declaration",
    );
  });

  it("refuses to blank the learner's file on an empty formatter response", () => {
    // The panel writes whatever comes back over main.zig, so an empty 200 has
    // to fail as a service error rather than emptying a real program.
    expect(normalizeUpstreamFormatResponse(200, "", SOURCE)).toBeNull();
    expect(normalizeUpstreamFormatResponse(200, "\n  \n", SOURCE)).toBeNull();
    // Blank source really does format to nothing, which is a valid result.
    expect(normalizeUpstreamFormatResponse(200, "", "   \n")).toEqual({
      kind: "result",
      result: { files: [{ path: "main.zig", content: "" }] },
    });
  });

  it("does not relay a page-sized 400 body as a diagnostic about main.zig", () => {
    expect(normalizeUpstreamFormatResponse(400, "<html>".repeat(20 * 1024), SOURCE)).toBeNull();
  });

  it("rejects an unexpected status", () => {
    expect(normalizeUpstreamFormatResponse(502, "nope", SOURCE)).toBeNull();
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

  it("rejects the program over the size limit before proxying", async () => {
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const response = await runRequest(
      makeEnv(),
      JSON.stringify({ files: [{ path: "main.zig", content: `// ${"x".repeat(64 * 1024)}` }] }),
    );

    expect(response.status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
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

  it("caches a compile error, which is as deterministic as a success", async () => {
    const spy = stubUpstream(UPSTREAM_COMPILE_ERROR, 400);
    const env = makeEnv();

    await runRequest(env);
    const second = await runRequest(env);

    expect(spy).toHaveBeenCalledTimes(1);
    await expect(second.json()).resolves.toMatchObject({ status: "compile-error" });
  });

  it("does not cache a runtime error", async () => {
    const spy = stubUpstream(UPSTREAM_PANIC, 400);
    const env = makeEnv();

    await runRequest(env);
    await runRequest(env);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not cache a program that merely exited non-zero", async () => {
    // The upstream reports this with the same 400 as a compile failure; if it
    // were classified as one, an hour of runs would be served the same verdict.
    const spy = stubUpstream(UPSTREAM_NONZERO_EXIT, 400);
    const env = makeEnv();

    const first = await runRequest(env);
    await runRequest(env);

    await expect(first.json()).resolves.toMatchObject({ status: "runtime-error" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("reports the upstream's own rate limit as backpressure, not the learner's fault", async () => {
    // Our per-user window sits below the upstream's per-IP budget, so hitting
    // that budget means somebody else spent it. A 429 would print "Too many
    // runs" at a learner who pressed Run once.
    const spy = stubUpstream("Too many requests.", 429);
    const response = await runRequest(makeEnv());

    expect(response.status).toBe(502);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("returns 502 for an unexpected upstream status", async () => {
    stubUpstream("boom", 500);
    expect((await runRequest(makeEnv())).status).toBe(502);
  });

  it("truncates a huge program output instead of reporting a service failure", async () => {
    // The read ceiling has to sit clear of the output cap: a body that
    // overflows it is discarded, and the learner is told the service broke.
    stubUpstream("x".repeat(400 * 1024));
    const big = await runRequest(makeEnv());

    expect(big.status).toBe(200);
    const payload = (await big.json()) as { status: string; output: string };
    expect(payload.status).toBe("success");
    expect(payload.output.endsWith("[output truncated]")).toBe(true);
  });

  it("returns 502 when the upstream body exceeds the read ceiling", async () => {
    stubUpstream("x".repeat(2 * 1024 * 1024));
    expect((await runRequest(makeEnv())).status).toBe(502);
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

  it("limits upstream calls per user below the upstream's shared budget", async () => {
    // Frozen so the six requests cannot straddle a minute boundary and reset
    // the fixed window halfway through.
    vi.spyOn(Date, "now").mockReturnValue(1_770_000_000_000);
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

    expect(statuses).toEqual([200, 200, 200, 200, 429, 429]);
  });

  it("returns 429 once the per-user minute window is exhausted", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_770_000_000_000);
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const windowKey = `zp:rl:${USER.id}:${Math.floor(Date.now() / 60_000)}`;
    const response = await runRequest(makeEnv({ CACHE: memoryKv({ [windowKey]: "4" }) }));

    expect(response.status).toBe(429);
    expect(spy).not.toHaveBeenCalled();
  });

  it("charges runs and formats to the same window, because the upstream does", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_770_000_000_000);
    const spy = stubUpstream("pub fn main() void {}\n");
    const windowKey = `zp:rl:${USER.id}:${Math.floor(Date.now() / 60_000)}`;
    const env = makeEnv({ CACHE: memoryKv({ [windowKey]: "3" }) });

    expect((await formatRequest(env)).status).toBe(200);
    // The format spent the last slot, so the run has to wait rather than
    // overrun the 5/minute budget /server/run and /server/fmt share.
    expect((await runRequest(env)).status).toBe(429);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not spend the window on a run served from the cache", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_770_000_000_000);
    const spy = stubUpstream(UPSTREAM_SUCCESS);
    const env = makeEnv();
    const statuses: number[] = [];

    for (let index = 0; index < 6; index++) {
      statuses.push((await runRequest(env)).status);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
    expect(spy).toHaveBeenCalledTimes(1);
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

  it("fails closed on /format when the kill switch is not enabled", async () => {
    const spy = stubUpstream("pub fn main() void {}\n");
    const response = await formatRequest(makeEnv({ ZIG_PLAYGROUND_ENABLED: undefined }));

    expect(response.status).toBe(503);
    expect(spy).not.toHaveBeenCalled();
  });

  it("requires a signed-in session on /format", async () => {
    const spy = stubUpstream("pub fn main() void {}\n");
    const response = await formatRequest(makeEnv({ DB: dbWithSessionUser(null) }));

    expect(response.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("serves a repeated format from the cache without calling upstream again", async () => {
    const formatted = "pub fn main() void {}\n";
    const spy = stubUpstream(formatted);
    const env = makeEnv();

    await formatRequest(env);
    const second = await formatRequest(env);

    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({
      files: [{ path: "main.zig", content: formatted }],
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite the learner's file when the formatter returns nothing", async () => {
    stubUpstream("");
    expect((await formatRequest(makeEnv())).status).toBe(502);
  });
});
