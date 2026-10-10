import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { UserRow } from "../db/types";
import type { Env } from "./env";
import {
  callUpstream,
  isCacheableRunResult,
  playgroundRateLimitKey,
  sortLessonFiles,
  writeCachedValue,
} from "./playgroundProxy";

describe("playgroundRateLimitKey", () => {
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

  const app = new Hono<{ Bindings: Env }>();
  app.get("/key", async (c) => c.text(await playgroundRateLimitKey(c)));

  async function keyFor(
    user: UserRow | null,
    clientIp: string | null,
    cookie = "ne_session=session-1",
  ): Promise<string> {
    const headers: Record<string, string> = { Cookie: cookie };
    if (clientIp !== null) headers["CF-Connecting-IP"] = clientIp;
    const response = await app.request("http://localhost/key", { headers }, {
      DB: dbWithSessionUser(user),
    } as Env);
    return response.text();
  }

  it("charges a signed-in learner to their user id, whatever their address", async () => {
    expect(await keyFor(USER, "203.0.113.7")).toBe("user:user-1");
    expect(await keyFor(USER, null)).toBe("user:user-1");
  });

  it("charges a signed-out learner to their IPv4 address", async () => {
    expect(await keyFor(null, "203.0.113.7")).toBe("ip:203.0.113.7");
    // No session cookie at all is signed out too.
    expect(await keyFor(null, "198.51.100.2", "")).toBe("ip:198.51.100.2");
  });

  // One IPv6 client usually holds a whole /64; keying the full address would
  // hand it a fresh budget for every address in it.
  it("charges a signed-out IPv6 learner to their /64", async () => {
    expect(await keyFor(null, "2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("ip:2001:db8:1:2::/64");
    expect(await keyFor(null, "2001:0DB8:0001:0002::9")).toBe("ip:2001:db8:1:2::/64");
    expect(await keyFor(null, "2001:db8::1")).toBe("ip:2001:db8:0:0::/64");
    expect(await keyFor(null, "::ffff:192.0.2.1")).toBe("ip:0:0:0:0::/64");
  });

  it("shares one key among signed-out callers with no usable address", async () => {
    expect(await keyFor(null, null)).toBe("ip:unknown");
    expect(await keyFor(null, "  ")).toBe("ip:unknown");
    expect(await keyFor(null, "2001:db8::1::2")).toBe("ip:unknown");
    expect(await keyFor(null, "2001:db8:zz::1")).toBe("ip:unknown");
  });
});

describe("writeCachedValue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fakeKv(put: (key: string, value: string) => Promise<void>) {
    return { put: vi.fn<(key: string, value: string) => Promise<void>>(put) };
  }

  it("awaits the write when there is no waitUntil", async () => {
    let stored: string | undefined;
    const cache = fakeKv(async (_key, value) => {
      stored = value;
    });

    await writeCachedValue(cache as unknown as KVNamespace, "k", { ok: true }, 60, "Test");

    expect(stored).toBe('{"ok":true}');
    expect(cache.put).toHaveBeenCalledWith("k", '{"ok":true}', { expirationTtl: 60 });
  });

  it("hands the write to waitUntil instead of waiting for it", async () => {
    let finishPut: () => void = () => {};
    const cache = fakeKv(
      () =>
        new Promise<void>((resolve) => {
          finishPut = resolve;
        }),
    );
    const pending: Promise<unknown>[] = [];

    // Resolves although the KV write has not finished.
    await writeCachedValue(cache as unknown as KVNamespace, "k", { ok: true }, 60, "Test", (p) =>
      pending.push(p),
    );

    expect(pending).toHaveLength(1);
    finishPut();
    await expect(pending[0]).resolves.toBeUndefined();
  });

  it("hands waitUntil a write that resolves even when the write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cache = fakeKv(async () => {
      throw new Error("KV unavailable");
    });
    const pending: Promise<unknown>[] = [];

    await writeCachedValue(cache as unknown as KVNamespace, "k", 1, 60, "Test", (p) =>
      pending.push(p),
    );

    await expect(pending[0]).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith("Test cache write failed");
  });
});

describe("sortLessonFiles", () => {
  it("puts the entry file first, then the rest lexicographically, without mutating", () => {
    const files = [
      { path: "util.go", content: "u" },
      { path: "Zed.go", content: "z" },
      { path: "main.go", content: "m" },
      { path: "a.go", content: "a" },
    ];

    expect(sortLessonFiles(files, "main.go").map((file) => file.path)).toEqual([
      "main.go",
      "Zed.go",
      "a.go",
      "util.go",
    ]);
    expect(files[0]?.path).toBe("util.go");
  });

  it("orders lexicographically when the entry file is absent", () => {
    expect(
      sortLessonFiles([{ path: "b.kt" }, { path: "A.kt" }], "Main.kt").map((file) => file.path),
    ).toEqual(["A.kt", "b.kt"]);
  });
});

describe("callUpstream", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

  /** A response whose body breaks off after its first chunk. */
  function brokenBody(): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
          controller.error(new TypeError("connection reset"));
        },
      }),
    );
  }

  it("sends the request with the timer's signal and hands back any response", async () => {
    const fetchSpy = vi.fn<FetchFn>(async () => new Response("busy", { status: 503 }));
    vi.stubGlobal("fetch", fetchSpy);

    const call = await callUpstream(
      "https://upstream.test/run",
      { method: "POST", body: "x" },
      1000,
    );

    expect(call.kind).toBe("response");
    if (call.kind !== "response") return;
    expect(call.response.status).toBe(503);
    expect(await call.readBody(1024)).toEqual({ status: "ok", text: "busy" });
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("https://upstream.test/run");
    expect(init).toMatchObject({ method: "POST", body: "x" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("is a timeout when fetch throws a TimeoutError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchFn>(async () => {
        throw new DOMException("The operation timed out", "TimeoutError");
      }),
    );

    expect(await callUpstream("https://upstream.test", {}, 1000)).toEqual({ kind: "timeout" });
  });

  it("is a timeout when fetch throws after the timer fired", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchFn>(async () => {
        throw new TypeError("aborted");
      }),
    );

    expect(await callUpstream("https://upstream.test", {}, 1000)).toEqual({ kind: "timeout" });
  });

  it("is unreachable when fetch throws anything else", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchFn>(async () => {
        throw new TypeError("network connection lost");
      }),
    );

    expect(await callUpstream("https://upstream.test", {}, 1000)).toEqual({ kind: "unreachable" });
  });

  it("reads a body that breaks off after the timer fired as a timeout", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchFn>(async () => brokenBody()),
    );

    const call = await callUpstream("https://upstream.test", {}, 1000);

    expect(call.kind === "response" && (await call.readBody(1024))).toEqual({ status: "timeout" });
  });

  it("passes the bounded read through otherwise", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchFn>(async () => brokenBody()),
    );
    const broken = await callUpstream("https://upstream.test", {}, 1000);
    expect(broken.kind === "response" && (await broken.readBody(1024))).toEqual({
      status: "read-error",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn<FetchFn>(async () => new Response("x".repeat(2048))),
    );
    const tooLarge = await callUpstream("https://upstream.test", {}, 1000);
    expect(tooLarge.kind === "response" && (await tooLarge.readBody(1024))).toEqual({
      status: "too-large",
    });
  });
});

describe("isCacheableRunResult", () => {
  it("keeps only success and compile-error", () => {
    expect(isCacheableRunResult({ status: "success" })).toBe(true);
    expect(isCacheableRunResult({ status: "compile-error" })).toBe(true);
    expect(isCacheableRunResult({ status: "runtime-error" })).toBe(false);
    expect(isCacheableRunResult({ status: "timeout" })).toBe(false);
  });
});
