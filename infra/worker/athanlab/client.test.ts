import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ATHANLAB_API_BASE,
  athanLabFetch,
  describeAthanLabError,
  guardStream,
  isTransientError,
  readAthanLabError,
  requestJsonWithRetries,
  requestOnce,
  requestWithRetries,
  speechJobOf,
  type AthanLabRequestInit,
  type RetryContext,
} from "./client";

const API_KEY = "ak_live_0123456789abcdef0123456789abcdef";
const JOB_ID = "8f14e45fceea167a5a36dedd4bea2543";

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function errorResponse(
  status: number,
  error: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      error: {
        type: "api_error",
        param: null,
        request_id: "req_0123456789abcdef01234567",
        doc_url: "https://athanlab.com/docs#errors",
        ...error,
      },
    }),
    { status, headers: { "Content-Type": "application/json", ...headers } },
  );
}

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(responses: Array<() => Response>) {
  const queue = [...responses];
  const fetchSpy = vi.fn<FetchFn>(async () => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra request");
    return next();
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

const POLL: AthanLabRequestInit = {
  method: "GET",
  path: `/speech/${JOB_ID}`,
  accept: "application/json",
  timeoutMs: 15_000,
};

function contextOf(overrides: Partial<RetryContext> = {}): RetryContext {
  return {
    apiKey: API_KEY,
    deadline: Date.now() + 240_000,
    budget: { used: 0, limit: 45 },
    ...overrides,
  };
}

/** Run `work` on fake timers, reporting how much fake time it took. */
async function timed<T>(work: () => Promise<T>): Promise<{ result: T; elapsedMs: number }> {
  vi.useFakeTimers();
  const startedAt = Date.now();
  let settled = false;
  const pending = work().finally(() => (settled = true));
  while (!settled) await vi.advanceTimersByTimeAsync(250);
  return { result: await pending, elapsedMs: Date.now() - startedAt };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("athanLabFetch", () => {
  it("sends the key only in X-API-Key and never follows a redirect", async () => {
    const fetchSpy = stubFetch([() => okJson({ object: "speech" }, 202)]);

    const { response, done } = await athanLabFetch(API_KEY, {
      method: "POST",
      path: "/speech",
      accept: "application/json",
      body: '{"text":"x"}',
      idempotencyKey: "ne1:abc",
      timeoutMs: 30_000,
    });
    done();

    expect(response.status).toBe(202);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(`${ATHANLAB_API_BASE}/speech`);
    expect(String(url)).not.toContain(API_KEY);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(init?.body).toBe('{"text":"x"}');
    expect(init?.headers).toEqual({
      Accept: "application/json",
      "X-API-Key": API_KEY,
      "Content-Type": "application/json",
      "Idempotency-Key": "ne1:abc",
    });
  });

  it("gives up on response headers after the timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchFn>(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );

    const rejection = athanLabFetch(API_KEY, POLL).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await rejection).toMatchObject({ message: "AthanLab did not answer in time" });
  });
});

describe("readAthanLabError", () => {
  it("reads AthanLab's envelope into validated fields", async () => {
    const error = await readAthanLabError(
      errorResponse(
        429,
        {
          code: "concurrency_limit",
          message: "This account already has the maximum number of jobs running.",
          retryable: true,
          details: { active_jobs: 2, max_concurrent_jobs: 2, job_id: "../../x" },
        },
        { "Retry-After": "7" },
      ),
      API_KEY,
    );

    expect(error).toEqual({
      status: 429,
      code: "concurrency_limit",
      message: "This account already has the maximum number of jobs running.",
      parsed: true,
      retryable: true,
      retryAfterSeconds: 7,
      requestId: "req_0123456789abcdef01234567",
      details: { activeJobs: 2, maxConcurrentJobs: 2 },
    });
    expect(describeAthanLabError(error)).toBe(
      "This account already has the maximum number of jobs running. (2 of 2 jobs running)",
    );
  });

  it("redacts the key and anything key-shaped, flattens and bounds the message", async () => {
    const error = await readAthanLabError(
      errorResponse(400, {
        code: "Not A Code!",
        message: `bad key ${API_KEY}\n\u001b[31m and ak_live_ffffffffffffffffffffffffffffffff ${"x".repeat(400)}`,
        retryable: false,
        details: { required_scope: "speech:write" },
      }),
      API_KEY,
    );

    expect(error.code).toBeNull();
    expect(error.message).toMatch(/^bad key \[redacted\] \[31m and \[redacted\] x+…$/);
    expect(error.message?.length).toBe(200);
    expect(error.details).toEqual({ requiredScope: "speech:write" });
  });

  it("keeps only the status and Retry-After of a body that is not AthanLab's envelope", async () => {
    const error = await readAthanLabError(
      new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        headers: { "Content-Type": "text/html", "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" },
      }),
      API_KEY,
    );

    expect(error).toMatchObject({
      status: 502,
      parsed: false,
      code: null,
      message: null,
      retryable: false,
      retryAfterSeconds: null,
    });
    expect(describeAthanLabError(error)).toBe("HTTP 502");
  });
});

describe("isTransientError", () => {
  async function errorOf(response: Response) {
    return readAthanLabError(response, API_KEY);
  }

  it("follows retryable, and falls back on the status only without an envelope", async () => {
    expect(
      isTransientError(
        await errorOf(errorResponse(503, { code: "server_restarting", retryable: true })),
      ),
    ).toBe(true);
    expect(isTransientError(await errorOf(new Response("oops", { status: 524 })))).toBe(true);
    expect(isTransientError(await errorOf(new Response("oops", { status: 501 })))).toBe(false);
    // A 503 that AthanLab itself calls final stays final.
    expect(
      isTransientError(
        await errorOf(errorResponse(503, { code: "api_disabled", retryable: false })),
      ),
    ).toBe(false);
  });

  it("never treats a 429 as transient on its status alone", async () => {
    expect(
      isTransientError(
        await errorOf(errorResponse(429, { code: "key_budget_exceeded", retryable: false })),
      ),
    ).toBe(false);
    expect(isTransientError(await errorOf(new Response("slow down", { status: 429 })))).toBe(false);
  });
});

describe("requestWithRetries", () => {
  it("waits AthanLab's Retry-After, however long, then succeeds", async () => {
    const fetchSpy = stubFetch([
      () =>
        errorResponse(
          503,
          { code: "capacity_unavailable", retryable: true },
          { "Retry-After": "12" },
        ),
      () => okJson({ id: JOB_ID }),
    ]);

    const { result, elapsedMs } = await timed(() => requestWithRetries(contextOf(), POLL));

    expect(result.kind).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(elapsedMs).toBeGreaterThanOrEqual(12_000);
    expect(elapsedMs).toBeLessThan(13_000);
  });

  it("waits at least a second even when Retry-After says 0", async () => {
    stubFetch([
      () => errorResponse(429, { code: "rate_limited", retryable: true }, { "Retry-After": "0" }),
      () => okJson({ id: JOB_ID }),
    ]);

    const { elapsedMs } = await timed(() => requestWithRetries(contextOf(), POLL));

    expect(elapsedMs).toBeGreaterThanOrEqual(1_000);
  });

  it("backs off 1 s then 2 s without Retry-After and stops at the third failure", async () => {
    const fetchSpy = stubFetch([
      () => {
        throw new TypeError("network connection lost");
      },
      () => new Response("error code: 524", { status: 524 }),
      () => errorResponse(500, { code: "internal_error", message: "boom", retryable: true }),
    ]);
    const context = contextOf();

    const { result, elapsedMs } = await timed(() => requestWithRetries(context, POLL));

    expect(result).toMatchObject({ kind: "unavailable", retryAfterSeconds: 4 });
    expect(result.kind === "unavailable" && result.error?.code).toBe("internal_error");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(context.budget.used).toBe(3);
    expect(elapsedMs).toBeGreaterThanOrEqual(3_000);
    expect(elapsedMs).toBeLessThan(4_000);
  });

  it("does not wait past 30 s or past the deadline", async () => {
    const tooLong = stubFetch([
      () => errorResponse(503, { code: "server_busy", retryable: true }, { "Retry-After": "31" }),
    ]);
    expect(await requestWithRetries(contextOf(), POLL)).toMatchObject({
      kind: "unavailable",
      retryAfterSeconds: 31,
    });
    expect(tooLong).toHaveBeenCalledTimes(1);

    const pastDeadline = stubFetch([
      () => errorResponse(503, { code: "server_busy", retryable: true }, { "Retry-After": "5" }),
    ]);
    expect(
      await requestWithRetries(contextOf({ deadline: Date.now() + 4_000 }), POLL),
    ).toMatchObject({ kind: "unavailable", retryAfterSeconds: 5 });
    expect(pastDeadline).toHaveBeenCalledTimes(1);
  });

  it("never retries auth_blocked or a final error", async () => {
    stubFetch([
      () => errorResponse(429, { code: "auth_blocked", retryable: true }, { "Retry-After": "600" }),
    ]);
    const blocked = await requestWithRetries(contextOf(), POLL);
    expect(blocked.kind === "rejected" && blocked.error.code).toBe("auth_blocked");

    const fetchSpy = stubFetch([
      () => errorResponse(429, { code: "key_budget_exceeded", retryable: false }),
    ]);
    const budget = await requestWithRetries(contextOf(), POLL);
    expect(budget.kind === "rejected" && budget.error.code).toBe("key_budget_exceeded");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("spends one subrequest per attempt and keeps the reserve", async () => {
    const fetchSpy = stubFetch([]);
    const context = contextOf({ budget: { used: 42, limit: 45 } });

    expect(await requestWithRetries(context, POLL, 3)).toEqual({ kind: "out_of_budget" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(context.budget.used).toBe(42);
  });
});

describe("requestJsonWithRetries", () => {
  /** An ok response whose body breaks off after its first chunk. */
  function brokenBody(): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":'));
        controller.error(new TypeError("connection reset"));
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  }

  it("reads the JSON body as part of the attempt", async () => {
    const fetchSpy = stubFetch([() => okJson({ id: JOB_ID, status: "processing" })]);

    const outcome = await requestJsonWithRetries(contextOf(), POLL, 0, 1024);

    expect(outcome).toMatchObject({
      kind: "ok",
      payload: { id: JOB_ID, status: "processing" },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("asks again, after the shared backoff, when the body breaks off", async () => {
    const fetchSpy = stubFetch([brokenBody, () => okJson({ id: JOB_ID })]);
    const context = contextOf();

    const { result, elapsedMs } = await timed(() => requestJsonWithRetries(context, POLL, 0, 1024));

    expect(result).toMatchObject({ kind: "ok", payload: { id: JOB_ID } });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(context.budget.used).toBe(2);
    expect(elapsedMs).toBeGreaterThanOrEqual(1_000);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("stops at the third broken body", async () => {
    const fetchSpy = stubFetch([brokenBody, brokenBody, brokenBody]);

    const { result } = await timed(() => requestJsonWithRetries(contextOf(), POLL, 0, 1024));

    expect(result).toEqual({ kind: "unavailable", error: null, retryAfterSeconds: 4 });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("answers a whole body that is too large or not JSON without asking again", async () => {
    const tooLarge = stubFetch([() => okJson({ id: JOB_ID, padding: "x".repeat(2048) })]);
    expect(await requestJsonWithRetries(contextOf(), POLL, 0, 1024)).toMatchObject({
      kind: "ok",
      payload: undefined,
    });
    expect(tooLarge).toHaveBeenCalledTimes(1);

    const notJson = stubFetch([() => new Response("<html>", { status: 200 })]);
    expect(await requestJsonWithRetries(contextOf(), POLL, 0, 1024)).toMatchObject({
      kind: "ok",
      payload: undefined,
    });
    expect(notJson).toHaveBeenCalledTimes(1);
  });

  it("follows the shared rule for errors, the deadline and the reserve", async () => {
    stubFetch([
      () => errorResponse(429, { code: "auth_blocked", retryable: true }, { "Retry-After": "600" }),
    ]);
    const blocked = await requestJsonWithRetries(contextOf(), POLL, 0, 1024);
    expect(blocked.kind === "rejected" && blocked.error.code).toBe("auth_blocked");

    const pastDeadline = stubFetch([
      () => errorResponse(503, { code: "server_busy", retryable: true }, { "Retry-After": "5" }),
    ]);
    expect(
      await requestJsonWithRetries(contextOf({ deadline: Date.now() + 4_000 }), POLL, 0, 1024),
    ).toMatchObject({ kind: "unavailable", retryAfterSeconds: 5 });
    expect(pastDeadline).toHaveBeenCalledTimes(1);

    const untouched = stubFetch([]);
    const context = contextOf({ budget: { used: 42, limit: 45 } });
    expect(await requestJsonWithRetries(context, POLL, 3, 1024)).toEqual({ kind: "out_of_budget" });
    expect(untouched).not.toHaveBeenCalled();
  });
});

describe("requestOnce", () => {
  it("reports a transient failure with the wait AthanLab asked for, without retrying", async () => {
    const fetchSpy = stubFetch([
      () => errorResponse(503, { code: "api_read_only", retryable: true }, { "Retry-After": "60" }),
    ]);

    const outcome = await requestOnce(API_KEY, POLL);

    expect(outcome).toMatchObject({ kind: "unavailable", retryAfterSeconds: 60 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("suggests 5 s after a failed fetch, and rejects auth_blocked", async () => {
    stubFetch([
      () => {
        throw new TypeError("network connection lost");
      },
    ]);
    expect(await requestOnce(API_KEY, POLL)).toEqual({
      kind: "unavailable",
      error: null,
      retryAfterSeconds: 5,
    });

    stubFetch([
      () => errorResponse(429, { code: "auth_blocked", retryable: true }, { "Retry-After": "600" }),
    ]);
    const blocked = await requestOnce(API_KEY, POLL);
    expect(blocked.kind === "rejected" && blocked.error.code).toBe("auth_blocked");
  });
});

describe("speechJobOf", () => {
  it("keeps the id, status and job error, and drops every URL", () => {
    expect(
      speechJobOf(
        {
          object: "speech",
          id: JOB_ID,
          status: "failed",
          audio: { url: "https://evil.example/steal" },
          error: { code: "generation_failed", message: `failed for ${API_KEY}`, retryable: true },
        },
        API_KEY,
      ),
    ).toEqual({
      id: JOB_ID,
      status: "failed",
      error: { code: "generation_failed", message: "failed for [redacted]", retryable: true },
    });
  });

  it("refuses a job without a well-formed id or status", () => {
    for (const payload of [
      null,
      { id: "../../usage", status: "succeeded" },
      { id: JOB_ID.toUpperCase(), status: "succeeded" },
      { id: JOB_ID, status: "done" },
    ]) {
      expect(speechJobOf(payload, API_KEY)).toBeNull();
    }
  });
});

describe("guardStream", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  function streamOf(chunks: Uint8Array[], options: { hang?: boolean } = {}) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (!options.hang) controller.close();
      },
    });
  }

  const guard = { maxBytes: 8, idleTimeoutMs: 30_000, expectedBytes: null };

  it("passes a body through unchanged", async () => {
    const body = guardStream(streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]), {
      ...guard,
      expectedBytes: 3,
    });

    expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("errors past the byte cap even without a Content-Length", async () => {
    const body = guardStream(streamOf([new Uint8Array(5), new Uint8Array(5)]), guard);

    await expect(new Response(body).arrayBuffer()).rejects.toThrow("larger than expected");
  });

  it("errors on a body that ends short of its Content-Length, or is empty", async () => {
    const short = guardStream(streamOf([new Uint8Array(3)]), { ...guard, expectedBytes: 6 });
    await expect(new Response(short).arrayBuffer()).rejects.toThrow("ended early");

    const empty = guardStream(streamOf([]), guard);
    await expect(new Response(empty).arrayBuffer()).rejects.toThrow("was empty");
  });

  it("errors when no chunk arrives for the idle timeout", async () => {
    vi.useFakeTimers();
    const body = guardStream(streamOf([new Uint8Array(2)], { hang: true }), guard);

    const read = new Response(body).arrayBuffer().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await read).toMatchObject({ message: "AthanLab audio download stalled" });
    expect(console.error).toHaveBeenCalledWith("AthanLab audio stream failed", {
      reason: "stalled",
      receivedBytes: 2,
    });
  });

  it("stops watching for a stall once the reader goes away", async () => {
    vi.useFakeTimers();
    const body = guardStream(streamOf([], { hang: true }), guard);

    await body.cancel("browser closed the connection");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(console.error).not.toHaveBeenCalled();
  });
});
