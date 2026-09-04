import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  goPlaygroundRoute,
  normalizeUpstreamCompileResponse,
  normalizeUpstreamFormatResponse,
  serializeGoLessonFiles,
  validateGoLessonSource,
} from "./goPlayground";
import type { Env } from "../env";
import type { UserRow } from "../../db/types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SOURCE = 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("hi") }\n';
const HELPER_SOURCE = 'package main\n\nfunc message() string { return "hi" }\n';
const FILES = [{ path: "main.go", content: SOURCE }];
const TXTAR_SOURCE = `-- main.go --\n${SOURCE}`;

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
    GO_PLAYGROUND_ENABLED: "true",
    ...overrides,
  } as Env;
}

function runRequest(env: Env, body: BodyInit | null = JSON.stringify({ files: FILES })) {
  return goPlaygroundRoute.request(
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
  return goPlaygroundRoute.request(
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

describe("goPlaygroundRoute", () => {
  it("fails closed when the kill switch is not enabled", async () => {
    const spy = stubUpstream({});
    const response = await runRequest(makeEnv({ GO_PLAYGROUND_ENABLED: undefined }));

    expect(response.status).toBe(503);
    expect(spy).not.toHaveBeenCalled();
  });

  it("requires a signed-in user", async () => {
    const spy = stubUpstream({});
    const response = await runRequest(makeEnv({ DB: dbWithSessionUser(null) }));

    expect(response.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an invalid JSON body", async () => {
    const spy = stubUpstream({});
    const response = await runRequest(makeEnv(), "not json");

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects JSON null instead of throwing an internal error", async () => {
    const spy = stubUpstream({});
    const response = await runRequest(makeEnv(), "null");

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("bounds the request body before parsing JSON", async () => {
    const spy = stubUpstream({});
    const response = await runRequest(
      makeEnv(),
      JSON.stringify({ files: FILES, padding: "x".repeat(450 * 1024) }),
    );

    expect(response.status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts only the documented files field", async () => {
    const spy = stubUpstream({});
    const response = await runRequest(makeEnv(), JSON.stringify({ files: FILES, extra: true }));

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("requires at least one Go file", async () => {
    const spy = stubUpstream({});
    const response = await runRequest(makeEnv(), JSON.stringify({ files: [] }));

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects more files than the Playground limit", async () => {
    const spy = stubUpstream({});
    const files = Array.from({ length: 21 }, (_, index) => ({
      path: `file${index}.go`,
      content: "package main\n",
    }));
    const response = await runRequest(makeEnv(), JSON.stringify({ files }));

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects the serialized program over the size limit before proxying", async () => {
    const spy = stubUpstream({});
    const oversized = `package main\n// ${"x".repeat(64 * 1024)}`;
    const response = await runRequest(
      makeEnv(),
      JSON.stringify({ files: [{ path: "main.go", content: oversized }] }),
    );

    expect(response.status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
  });

  it("requires every file to use package main", async () => {
    const spy = stubUpstream({});
    const response = await runRequest(
      makeEnv(),
      JSON.stringify({
        files: [
          ...FILES,
          {
            path: "helper.go",
            content: "package library\n\nfunc Add(a, b int) int { return a + b }",
          },
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects third-party imports in any file before proxying", async () => {
    const spy = stubUpstream({});
    const moduleResponse = await runRequest(
      makeEnv(),
      JSON.stringify({
        files: [
          ...FILES,
          {
            path: "helper.go",
            content: 'package main\n\nimport "github.com/example/dependency"\n\nfunc helper() {}\n',
          },
        ],
      }),
    );

    expect(moduleResponse.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(["nested/helper.go", "helper.ts", "_helper.go", "helper test.go", "helper_test.go"])(
    "rejects unsupported Go lesson path %s",
    async (path) => {
      const spy = stubUpstream({});
      const response = await runRequest(
        makeEnv(),
        JSON.stringify({ files: [{ path, content: "package main\n" }] }),
      );

      expect(response.status).toBe(400);
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it("rejects duplicate paths and content containing txtar marker lines", async () => {
    const spy = stubUpstream({});
    const duplicateResponse = await runRequest(
      makeEnv(),
      JSON.stringify({ files: [...FILES, ...FILES] }),
    );
    const markerResponse = await runRequest(
      makeEnv(),
      JSON.stringify({
        files: [
          {
            path: "main.go",
            content: "package main\n\nvar text = `start\n-- injected.go --\nend`\n",
          },
        ],
      }),
    );

    expect(duplicateResponse.status).toBe(400);
    expect(markerResponse.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns 429 once the per-user minute window is exhausted", async () => {
    const spy = stubUpstream({});
    // Freeze the clock: the seeded key and the route's own key are computed at
    // different moments, and a minute boundary between them would leave the
    // seeded count invisible and let the request through.
    vi.spyOn(Date, "now").mockReturnValue(1_770_000_000_000);
    const windowKey = `gp:rl:${USER.id}:${Math.floor(Date.now() / 60_000)}`;
    const response = await runRequest(makeEnv({ CACHE: memoryKv({ [windowKey]: "10" }) }));

    expect(response.status).toBe(429);
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails closed when the rate-limit store is unavailable", async () => {
    const spy = stubUpstream({});
    const response = await runRequest(makeEnv({ CACHE: undefined }));

    expect(response.status).toBe(502);
    expect(spy).not.toHaveBeenCalled();
  });

  it("serializes multiple files as deterministic txtar before proxying", async () => {
    const spy = stubUpstream({ Events: [{ Message: "hi\n", Kind: "stdout" }], Status: 0 });
    const files = [
      { path: "helper.go", content: HELPER_SOURCE },
      { path: "main.go", content: SOURCE },
    ];

    const response = await runRequest(makeEnv(), JSON.stringify({ files }));

    expect(response.status).toBe(200);
    const form = new URLSearchParams(String(spy.mock.calls[0][1]?.body));
    expect(form.get("body")).toBe(`-- main.go --\n${SOURCE}-- helper.go --\n${HELPER_SOURCE}`);
    expect(form.get("body")).toBe(serializeGoLessonFiles(files));
  });

  it("proxies with the fixed form fields and unique user agent, and normalizes success", async () => {
    const spy = stubUpstream({
      Events: [
        { Message: "hi\n", Kind: "stdout" },
        { Message: "warn\n", Kind: "stderr" },
      ],
      Status: 0,
    });

    const response = await runRequest(makeEnv());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "success", output: "hi\nwarn\n", exitCode: 0 });

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://play.golang.org/compile");
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("version")).toBe("2");
    expect(form.get("withVet")).toBe("true");
    expect(form.get("body")).toBe(TXTAR_SOURCE);
    expect(new Headers(init?.headers).get("User-Agent")).toContain("NextEditor-GoPlayground");
  });

  it("returns compiler diagnostics as a normal run result, not an HTTP failure", async () => {
    stubUpstream({ Errors: "prog.go:5:2: undefined: fmt.Printn", Events: null, Status: 1 });

    const response = await runRequest(makeEnv());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "compile-error",
      output: "",
      compileErrors: "prog.go:5:2: undefined: fmt.Printn",
    });
  });

  it("keeps vet diagnostics separate from program output", async () => {
    stubUpstream({
      VetErrors: "prog.go:7:2: unreachable code",
      Events: [{ Message: "ran anyway\n", Kind: "stdout" }],
      Status: 0,
    });

    const response = await runRequest(makeEnv());
    expect(await response.json()).toEqual({
      status: "vet-error",
      output: "ran anyway\n",
      vetErrors: "prog.go:7:2: unreachable code",
      exitCode: 0,
    });
  });

  it("maps a non-zero exit status to runtime-error", async () => {
    stubUpstream({
      Events: [{ Message: "panic: boom\n", Kind: "stderr" }],
      Status: 2,
    });

    const response = await runRequest(makeEnv());
    expect(await response.json()).toEqual({
      status: "runtime-error",
      output: "panic: boom\n",
      exitCode: 2,
    });
  });

  it("treats invalid upstream JSON as an upstream error, not an empty run", async () => {
    stubUpstream("<html>gateway</html>");
    expect((await runRequest(makeEnv())).status).toBe(502);
  });

  it("treats an invalid upstream field type as an upstream error", async () => {
    stubUpstream({ Events: [{ Message: 42 }], Status: 0 });
    expect((await runRequest(makeEnv())).status).toBe(502);
  });

  it("bounds the upstream response before parsing JSON", async () => {
    stubUpstream({ Events: [{ Message: "x".repeat(2 * 1024 * 1024) }], Status: 0 });
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
    const spy = stubUpstream({ Events: [{ Message: "hi\n", Kind: "stdout" }], Status: 0 });
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
    const spy = stubUpstream({ Events: [{ Message: "hi\n", Kind: "stdout" }], Status: 0 });
    const env = makeEnv();
    const statuses: number[] = [];

    // Same source every time, so only the first run reaches the upstream and
    // the 10/minute ceiling never applies to the other eleven.
    for (let index = 0; index < 12; index++) {
      statuses.push((await runRequest(env)).status);
    }

    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not cache runtime errors", async () => {
    const spy = stubUpstream({ Events: [{ Message: "panic\n", Kind: "stderr" }], Status: 2 });
    const env = makeEnv();

    await runRequest(env);
    await runRequest(env);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("formats every submitted Go file through the Playground txtar endpoint", async () => {
    const unformattedFiles = [
      {
        path: "helper.go",
        content: 'package main\nfunc message()string{return "hi"}\n',
      },
      {
        path: "main.go",
        content: 'package main\nimport "fmt"\nfunc main(){fmt.Println(message())}\n',
      },
    ];
    const formattedFiles = [
      {
        path: "main.go",
        content: 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println(message()) }\n',
      },
      {
        path: "helper.go",
        content: 'package main\n\nfunc message() string { return "hi" }\n',
      },
    ];
    const spy = stubUpstream({
      Body: serializeGoLessonFiles(formattedFiles),
      Error: "",
    });

    const response = await formatRequest(makeEnv(), JSON.stringify({ files: unformattedFiles }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ files: formattedFiles });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://play.golang.org/fmt");
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("body")).toBe(serializeGoLessonFiles(unformattedFiles));
    expect(form.has("imports")).toBe(false);
  });

  it("applies the kill switch and authentication boundary to formatting", async () => {
    const spy = stubUpstream({ Body: TXTAR_SOURCE, Error: "" });

    const disabled = await formatRequest(makeEnv({ GO_PLAYGROUND_ENABLED: undefined }));
    const signedOut = await formatRequest(makeEnv({ DB: dbWithSessionUser(null) }));

    expect(disabled.status).toBe(503);
    expect(signedOut.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns gofmt syntax diagnostics without changing them into a service failure", async () => {
    stubUpstream({ Body: "", Error: "main.go:3:1: expected declaration, found '}'" });

    const response = await formatRequest(makeEnv());

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "main.go:3:1: expected declaration, found '}'",
    });
  });

  it("rejects a formatted archive that omits or adds lesson files", async () => {
    const files = [...FILES, { path: "helper.go", content: "package main\n\nfunc helper() {}\n" }];
    stubUpstream({ Body: TXTAR_SOURCE, Error: "" });

    const response = await formatRequest(makeEnv(), JSON.stringify({ files }));

    expect(response.status).toBe(502);
  });

  it("rate-limits formatting independently from Run", async () => {
    const spy = stubUpstream({ Body: TXTAR_SOURCE, Error: "" });
    vi.spyOn(Date, "now").mockReturnValue(1_770_000_000_000);
    const windowKey = `gp:fmt:rl:${USER.id}:${Math.floor(Date.now() / 60_000)}`;

    const response = await formatRequest(makeEnv({ CACHE: memoryKv({ [windowKey]: "20" }) }));

    expect(response.status).toBe(429);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not cache formatted source responses", async () => {
    const spy = stubUpstream({ Body: TXTAR_SOURCE, Error: "" });
    const env = makeEnv();

    await formatRequest(env);
    await formatRequest(env);

    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("normalizeUpstreamFormatResponse", () => {
  it("rejects malformed success payloads and mixed body/error responses", () => {
    expect(normalizeUpstreamFormatResponse({ Body: 42, Error: "" }, FILES)).toBeNull();
    expect(
      normalizeUpstreamFormatResponse({ Body: TXTAR_SOURCE, Error: "syntax error" }, FILES),
    ).toBeNull();
  });

  it("normalizes an upstream formatting error as source feedback", () => {
    expect(
      normalizeUpstreamFormatResponse({ Body: "", Error: "main.go:2:1: syntax error" }, FILES),
    ).toEqual({ kind: "source-error", error: "main.go:2:1: syntax error" });
  });
});

describe("normalizeUpstreamCompileResponse", () => {
  it("ignores unknown fields and preserves test fields for future support", () => {
    expect(
      normalizeUpstreamCompileResponse({
        Events: [],
        Status: 0,
        IsTest: true,
        TestsFailed: 2,
        SomeFutureField: { nested: true },
      }),
    ).toEqual({ status: "success", output: "", exitCode: 0, isTest: true, testsFailed: 2 });
  });

  it("rejects non-object payloads", () => {
    expect(normalizeUpstreamCompileResponse(null)).toBeNull();
    expect(normalizeUpstreamCompileResponse("Events")).toBeNull();
  });

  it("rejects invalid status and test metadata values", () => {
    expect(normalizeUpstreamCompileResponse({ Events: [], Status: -1 })).toBeNull();
    expect(normalizeUpstreamCompileResponse({ Events: [], Status: 0, IsTest: "true" })).toBeNull();
    expect(
      normalizeUpstreamCompileResponse({ Events: [], Status: 0, TestsFailed: 1.5 }),
    ).toBeNull();
  });

  it("ignores event metadata entries without a message", () => {
    expect(
      normalizeUpstreamCompileResponse({
        Events: [{ Kind: "start" }, { Kind: "stdout", Message: "done\n" }],
        Status: 0,
      }),
    ).toEqual({ status: "success", output: "done\n", exitCode: 0 });
  });

  it("preserves vet diagnostics without masking a non-zero runtime exit", () => {
    expect(
      normalizeUpstreamCompileResponse({
        VetErrors: "prog.go:7:2: unreachable code",
        Events: [{ Message: "panic: boom\n", Kind: "stderr" }],
        Status: 2,
      }),
    ).toEqual({
      status: "runtime-error",
      output: "panic: boom\n",
      vetErrors: "prog.go:7:2: unreachable code",
      exitCode: 2,
    });
  });
});

describe("validateGoLessonSource", () => {
  it("allows grouped standard-library imports", () => {
    expect(
      validateGoLessonSource(
        'package main\n\nimport (\n  "fmt"\n  alias "strings"\n)\n\nfunc main() {}\n',
      ),
    ).toBeNull();
  });

  it("does not let comments or strings spoof the package declaration", () => {
    expect(
      validateGoLessonSource('// package main\npackage library\nconst text = "package main"'),
    ).toBe("Every Go lesson file must use 'package main'");
  });

  it("rejects escaped and CGO import paths", () => {
    expect(validateGoLessonSource('package main\nimport "github.com\\x2fexample"')).toContain(
      "escape sequences",
    );
    expect(validateGoLessonSource('package main\nimport "C"')).toContain(
      "standard-library imports only",
    );
  });
});

// The Go Playground integration must stay independent of the preserved
// remote-runtime/ package (plan §4): nothing under src/ or infra/ may import
// from it.
describe("remote-runtime dependency boundary", () => {
  it("has no imports from remote-runtime/ anywhere in src/ or infra/", () => {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const offenders: string[] = [];

    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(path);
          continue;
        }
        if (!/\.(ts|tsx|js|mjs)$/.test(entry.name)) continue;
        const content = readFileSync(path, "utf-8");
        if (
          /(?:from\s+["']|import\s*\(\s*["']|require\s*\(\s*["'])[^"']*remote-runtime\//.test(
            content,
          )
        ) {
          offenders.push(path);
        }
      }
    };

    visit(join(repoRoot, "src"));
    visit(join(repoRoot, "infra"));

    expect(offenders).toEqual([]);
  });
});
