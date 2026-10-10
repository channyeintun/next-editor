import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { putProviderCredential } from "../../db/providerCredentials";
import { KEY_CHECK_PAUSE_FAILURES } from "../athanlab/breaker";
import { keyVaultOf, sealApiKey } from "../athanlab/keyVault";
import { insertSignedInUser, openSqliteD1, type SqliteD1 } from "../../db/testing";
import type { Env } from "../env";
import { countingRateLimiter, refusingRateLimiter } from "../testing/rateLimit";
import { athanlabRoute, athanlabTtsRoute } from "./athanlab";

const USER_ID = "user-1";
const SESSION_ID = "session-1";
const SECRET = btoa(String.fromCharCode(...new Uint8Array(32).map((_, index) => 7 * index + 3)));
const OTHER_SECRET = btoa("o".repeat(32));
const API_KEY = "ak_live_0123456789abcdef0123456789abcdef";
const OTHER_KEY = "ak_live_ffffffffffffffffffffffffffff9999";
const JOB_ID = "8f14e45fceea167a5a36dedd4bea2543";
const SECOND_JOB_ID = "c9f0f895fb98ab9159f51fd0297e236d";
const VOICE_ID = "athanlab-default-female-v1";
const TEXT = "မင်္ဂလာပါ။ ဒီနေ့ Rust အကြောင်း ပြောမယ်။";
const WAV = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 87, 65, 86, 69]);
const API = "https://api.athanlab.com/api/v1";

// ---------------------------------------------------------------------------
// Environment

let database: SqliteD1;

beforeEach(() => {
  database = openSqliteD1();
  insertSignedInUser(database.sqlite, USER_ID, SESSION_ID);
});

const consoleOutput: unknown[][] = [];

/** Silence and capture every console line, to prove no key or text is logged. */
function captureConsole() {
  consoleOutput.length = 0;
  for (const method of ["error", "warn", "log", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args);
    });
  }
}

beforeEach(captureConsole);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: database.db,
    ATHANLAB_KEY_ENCRYPTION_SECRET: SECRET,
    ATHANLAB_KEY_RATE_LIMITER: countingRateLimiter(Infinity),
    ATHANLAB_API_RATE_LIMITER: countingRateLimiter(Infinity),
    ...overrides,
  } as Env;
}

function call(path: string, env: Env, init: RequestInit = { method: "GET" }) {
  const headers = new Headers(init.headers);
  headers.set("Cookie", `ne_session=${SESSION_ID}`);
  return athanlabRoute.request(`https://nexteditor.dev${path}`, { ...init, headers }, env);
}

function putKey(env: Env, apiKey: unknown = API_KEY) {
  return call("/key", env, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
}

function postTts(env: Env, body: unknown = { text: `  ${TEXT}\n`, voiceId: VOICE_ID }) {
  return athanlabTtsRoute.request(
    "https://nexteditor.dev/",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "audio/wav",
        Cookie: `ne_session=${SESSION_ID}`,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    env,
  );
}

/** Store a sealed key the way PUT /key does, without the verification calls. */
async function storeKey(env: Env, apiKey = API_KEY, userId = USER_ID) {
  const vault = keyVaultOf(env);
  if (!vault) throw new Error("expected a key vault");
  const sealed = await sealApiKey(vault, userId, apiKey);
  await putProviderCredential(env.DB, {
    userId,
    provider: "athanlab",
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    keyVersion: sealed.keyVersion,
    keyHint: apiKey.slice(-4),
    now: 1_000,
  });
}

function credentialRow() {
  return database.sqlite.prepare("SELECT * FROM user_provider_credentials").get() as
    | Record<string, unknown>
    | undefined;
}

function breakerRow() {
  return database.sqlite.prepare("SELECT * FROM provider_auth_breaker").get() as
    | { window_started_at: number; failures: number; blocked_until: number }
    | undefined;
}

function setBreaker(row: { failures?: number; blockedUntil?: number }) {
  database.sqlite
    .prepare(
      "INSERT INTO provider_auth_breaker (provider, window_started_at, failures, blocked_until) VALUES ('athanlab', ?, ?, ?)",
    )
    .run(Date.now(), row.failures ?? 0, row.blockedUntil ?? 0);
}

// ---------------------------------------------------------------------------
// A stand-in for AthanLab

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface AthanLabCall {
  method: string;
  /** Path under the API base, or the full URL of any other host. */
  path: string;
  url: string;
  headers: Headers;
  body: string | undefined;
  /** The request's abort signal: the per-phase timeout. */
  signal: AbortSignal | undefined;
  at: number;
}

type Reply = (request: AthanLabCall) => Response | Promise<Response>;

/**
 * Answer requests by "METHOD path" (path relative to the API base, with its
 * query). An array answers its calls in order. A request nobody expected is
 * recorded and answered 418, which no code path treats as transient.
 */
function stubAthanLab(routes: Record<string, Reply | Reply[]> = {}) {
  const replies = new Map(
    Object.entries(routes).map(([route, reply]) => [
      route,
      Array.isArray(reply) ? [...reply] : reply,
    ]),
  );
  const calls: AthanLabCall[] = [];
  const unexpected: string[] = [];
  const fetchSpy = vi.fn<FetchFn>(async (input, init) => {
    const url = new URL(String(input));
    const path = url.href.startsWith(API) ? url.href.slice(API.length) : url.href;
    const request: AthanLabCall = {
      method: init?.method ?? "GET",
      path,
      url: url.href,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
      signal: init?.signal ?? undefined,
      at: Date.now(),
    };
    calls.push(request);
    const route = `${request.method} ${path}`;
    const reply = replies.get(route);
    const next = Array.isArray(reply) ? reply.shift() : reply;
    if (!next) {
      unexpected.push(route);
      return new Response("unexpected request", { status: 418 });
    }
    return next(request);
  });
  vi.stubGlobal("fetch", fetchSpy);
  return { calls, unexpected, fetchSpy };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function athanlabError(
  status: number,
  code: string,
  options: {
    retryable?: boolean;
    message?: string;
    retryAfter?: string;
    details?: Record<string, unknown>;
  } = {},
): Reply {
  return () =>
    json(
      {
        error: {
          type: "api_error",
          code,
          message: options.message ?? `AthanLab says ${code}`,
          param: null,
          retryable: options.retryable ?? false,
          request_id: "req_0123456789abcdef01234567",
          doc_url: `https://athanlab.com/docs#errors-${code}`,
          ...(options.details ? { details: options.details } : {}),
        },
      },
      status,
      options.retryAfter ? { "Retry-After": options.retryAfter } : {},
    );
}

function jobBody(
  status: string,
  options: { id?: string; error?: Record<string, unknown> | null } = {},
) {
  const id = options.id ?? JOB_ID;
  return {
    object: "speech",
    id,
    status,
    created_at: "2026-10-08T00:00:00.000Z",
    completed_at: status === "processing" ? null : "2026-10-08T00:00:05.000Z",
    progress: status === "succeeded" ? 1 : status === "processing" ? 0.4 : null,
    input: { characters: 40, voice_id: VOICE_ID, output_format: "wav", number_mode: "smart" },
    usage: { characters_charged: 40, characters_refunded: 0 },
    audio:
      status === "succeeded"
        ? {
            format: "wav",
            duration_seconds: 2.5,
            url: "https://evil.example/steal-the-key",
            expires_at: "2026-11-07T00:00:00.000Z",
          }
        : null,
    error: options.error ?? null,
    metadata: { source: "next-editor-studio" },
  };
}

function accepted(
  status = "processing",
  options: {
    id?: string;
    replayed?: boolean;
    retryAfter?: string;
    error?: Record<string, unknown> | null;
  } = {},
): Reply {
  return () =>
    json({ ...jobBody(status, options), balance: { spendable_chars: 9_000 } }, 202, {
      "Retry-After": options.retryAfter ?? "2",
      // Absolute on purpose: the Worker must never follow it.
      Location: `https://evil.example/api/v1/speech/${options.id ?? JOB_ID}`,
      ...(options.replayed ? { "Idempotent-Replayed": "true" } : {}),
    });
}

function polled(status: string, options: { id?: string; error?: Record<string, unknown> } = {}) {
  return () => json(jobBody(status, options));
}

function wav(bytes: Uint8Array = WAV, headers: Record<string, string> = {}): Reply {
  return () =>
    new Response(bytes.slice().buffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(bytes.byteLength),
        ...headers,
      },
    });
}

/** Answer after `ms` of (real or fake) time. */
function delayed(reply: Reply, ms: number): Reply {
  return async (request) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return reply(request);
  };
}

/** Answer only once `gate` resolves. */
function gated(reply: Reply, gate: Promise<void>): Reply {
  return async (request) => {
    await gate;
    return reply(request);
  };
}

/**
 * 200 JSON headers, then part of a body and nothing more: the body errors only
 * when the request's timeout aborts it, as a stalled fetch body does.
 */
function stalledBody(): Reply {
  return (request) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"object":"speech",'));
          request.signal?.addEventListener("abort", () => controller.error(request.signal?.reason));
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

/** 202 JSON headers, then a body that breaks off mid-stream. */
function brokenBody(): Reply {
  return () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('{"object":"speech","id":"8f14'));
          controller.error(new Error("connection reset"));
        },
      }),
      { status: 202, headers: { "Content-Type": "application/json" } },
    );
}

const SUBMIT = "POST /speech";
const POLL = `GET /speech/${JOB_ID}`;
const DOWNLOAD = `GET /speech/${JOB_ID}/audio?format=wav`;

/** Run a request whose phases sleep, on fake timers, until it settles. */
async function settle<T>(run: () => T | Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    let settled = false;
    const pending = Promise.resolve(run()).finally(() => {
      settled = true;
    });
    while (!settled) {
      await vi.advanceTimersByTimeAsync(250);
      // Let real I/O (WebCrypto) finish between steps of fake time.
      await new Promise((resolve) => setImmediate(resolve));
    }
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

function expectNoSecretsIn(...texts: string[]) {
  const logged = JSON.stringify(consoleOutput);
  for (const text of [...texts, logged]) {
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(API_KEY.slice(8));
    expect(text).not.toContain(OTHER_KEY);
    expect(text).not.toContain(TEXT);
  }
}

// ---------------------------------------------------------------------------
// Configuration and the key

describe("AthanLab routes without configuration", () => {
  it("require a signed-in user", async () => {
    stubAthanLab();
    const response = await athanlabRoute.request(
      "https://nexteditor.dev/key",
      { method: "GET" },
      makeEnv(),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "not signed in" });
  });

  it("fail closed without a valid encryption secret, except DELETE /key", async () => {
    const { fetchSpy } = stubAthanLab();
    for (const secret of [undefined, "not-base64", btoa("short")]) {
      const env = makeEnv({ ATHANLAB_KEY_ENCRYPTION_SECRET: secret });
      for (const response of [
        await call("/key", env),
        await putKey(env),
        await call("/voices", env),
        await call(`/voices/${VOICE_ID}/sample`, env),
        await call("/usage", env),
        await postTts(env),
      ]) {
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          error: "AthanLab narration is not configured on this server",
          code: "not_configured",
        });
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("deletes a stored key without the vault, idempotently", async () => {
    await storeKey(makeEnv());
    const env = makeEnv({ ATHANLAB_KEY_ENCRYPTION_SECRET: undefined });

    const first = await call("/key", env, { method: "DELETE" });
    const second = await call("/key", env, { method: "DELETE" });

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ connected: false });
    expect(await second.json()).toEqual({ connected: false });
    expect(credentialRow()).toBeUndefined();
  });
});

describe("GET /api/studio/athanlab/key", () => {
  it("reports no key, a connected key, an invalidated key and an unreadable key", async () => {
    const { fetchSpy } = stubAthanLab();
    const env = makeEnv();

    expect(await (await call("/key", env)).json()).toEqual({ connected: false });

    await storeKey(env);
    expect(await (await call("/key", env)).json()).toEqual({
      connected: true,
      hint: "…cdef",
      updatedAt: 1_000,
    });

    database.sqlite.prepare("UPDATE user_provider_credentials SET invalidated_at = 5").run();
    expect(await (await call("/key", env)).json()).toEqual({
      connected: false,
      invalid: true,
      hint: "…cdef",
      updatedAt: 1_000,
    });

    // Sealed under a secret this Worker no longer has.
    await storeKey(makeEnv({ ATHANLAB_KEY_ENCRYPTION_SECRET: OTHER_SECRET }));
    expect(await (await call("/key", env)).json()).toEqual({ connected: false, stale: true });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats a row sealed for another user as unreadable", async () => {
    stubAthanLab();
    const env = makeEnv();
    insertSignedInUser(database.sqlite, "user-2", "session-2");
    await storeKey(env, API_KEY, "user-2");
    database.sqlite.prepare("UPDATE user_provider_credentials SET user_id = ?").run(USER_ID);

    expect(await (await call("/key", env)).json()).toEqual({ connected: false, stale: true });
  });
});

describe("PUT /api/studio/athanlab/key", () => {
  function verifyingAthanLab(overrides: Record<string, Reply | Reply[]> = {}) {
    return stubAthanLab({
      "GET /voices": () => json({ data: [], default_voice_id: null }),
      "GET /speech?limit=1": () => json({ object: "list", data: [], next_cursor: null }),
      [SUBMIT]: () =>
        json({
          object: "speech.quote",
          characters: 10,
          dispatches: 1,
          spendable: 4_200,
          sufficient: true,
        }),
      "GET /usage": () => json({ spendable: 4_200 }),
      ...overrides,
    });
  }

  it("rejects a malformed key without contacting AthanLab", async () => {
    const { fetchSpy } = stubAthanLab();
    const env = makeEnv();

    for (const apiKey of [
      "",
      "ak_test_0123456789abcdef0123456789abcdef",
      "ak_live_0123456789abcdef0123456789abcde",
      "ak_live_0123456789abcdef0123456789abcdef0",
      "ak_live_0123456789abcdef0123456789abcdeg",
      "Bearer ak_live_0123456789abcdef0123456789abcdef",
    ]) {
      const response = await putKey(env, apiKey);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error:
          "That is not an AthanLab API key (it starts with ak_live_ followed by 32 characters)",
        code: "invalid_format",
      });
    }

    for (const body of [
      "not json",
      JSON.stringify({ apiKey: API_KEY, extra: true }),
      JSON.stringify({ key: API_KEY }),
      JSON.stringify({ apiKey: 42 }),
      JSON.stringify([API_KEY]),
    ]) {
      const response = await call("/key", env, { method: "PUT", body });
      expect(response.status).toBe(400);
    }
    const oversized = await call("/key", env, {
      method: "PUT",
      body: JSON.stringify({ apiKey: "x".repeat(2_000) }),
    });
    expect(oversized.status).toBe(413);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(credentialRow()).toBeUndefined();
  });

  it("verifies with free calls only, seals the key, and never returns it", async () => {
    const athanlab = verifyingAthanLab();
    const env = makeEnv();

    const response = await putKey(env, `  ${API_KEY}\n`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      connected: true,
      hint: "…cdef",
      updatedAt: expect.any(Number),
      quote: { spendable: 4_200, sufficient: true },
    });
    expect(athanlab.calls.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /voices",
      "GET /speech?limit=1",
      SUBMIT,
      "GET /usage",
    ]);
    const dryRun = athanlab.calls[2];
    expect(dryRun.body).toBe(JSON.stringify({ text: "မင်္ဂလာပါ။", dry_run: true }));
    expect(dryRun.headers.get("idempotency-key")).toBeNull();
    for (const request of athanlab.calls) {
      expect(request.headers.get("x-api-key")).toBe(API_KEY);
      expect(request.url).not.toContain("ak_live_");
    }

    const row = credentialRow();
    expect(row).toMatchObject({ provider: "athanlab", key_version: 1, key_hint: "cdef" });
    expect(String(row?.ciphertext)).not.toContain("ak_live_");
    expect(atob(String(row?.ciphertext))).not.toContain("ak_live_");
    expect(text).not.toContain("ak_live_");
    expectNoSecretsIn(text);

    expect(await (await call("/key", env)).json()).toMatchObject({
      connected: true,
      hint: "…cdef",
    });
  });

  it("names AthanLab's default voice in the dry run, else the first listed voice", async () => {
    const withDefault = verifyingAthanLab({
      "GET /voices": () =>
        json({
          data: [{ id: VOICE_ID, name: "Thiri", category: "x", source: "athanlab" }],
          default_voice_id: "athanlab-default-male-v2",
        }),
    });
    expect((await putKey(makeEnv())).status).toBe(200);
    expect(JSON.parse(String(submits(withDefault.calls)[0].body))).toEqual({
      text: "မင်္ဂလာပါ။",
      voice_id: "athanlab-default-male-v2",
      dry_run: true,
    });

    // While AthanLab's default is unset, a key must not fail for want of one.
    const withoutDefault = verifyingAthanLab({
      "GET /voices": () =>
        json({
          data: [{ id: "../../usage" }, { name: "no id" }, { id: "my.voice:1", source: "user" }],
          default_voice_id: null,
        }),
    });
    expect((await putKey(makeEnv())).status).toBe(200);
    expect(JSON.parse(String(submits(withoutDefault.calls)[0].body))).toMatchObject({
      voice_id: "my.voice:1",
    });
  });

  it("accepts upper-case hex, since AthanLab does not document the case", async () => {
    verifyingAthanLab();

    const response = await putKey(makeEnv(), "ak_live_0123456789ABCDEF0123456789ABCDEF");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connected: true, hint: "…CDEF" });
  });

  it("replaces an invalidated key and clears the invalidation", async () => {
    verifyingAthanLab();
    const env = makeEnv();
    await storeKey(env, OTHER_KEY);
    database.sqlite.prepare("UPDATE user_provider_credentials SET invalidated_at = 5").run();

    expect((await putKey(env)).status).toBe(200);

    expect(credentialRow()).toMatchObject({
      invalidated_at: null,
      key_hint: "cdef",
      created_at: 1_000,
    });
  });

  it("counts a rejected key in the breaker and stops at the first failure", async () => {
    const athanlab = stubAthanLab({
      "GET /voices": athanlabError(401, "invalid_api_key", {
        message: `The API key ${API_KEY} is invalid, revoked or expired.`,
      }),
    });

    const response = await putKey(makeEnv());
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toEqual({
      error: "AthanLab rejected this API key",
      code: "invalid_api_key",
    });
    expect(athanlab.calls).toHaveLength(1);
    expect(breakerRow()).toMatchObject({ failures: 1, blocked_until: 0 });
    expect(credentialRow()).toBeUndefined();
    expectNoSecretsIn(text);
  });

  it("names the missing scope", async () => {
    verifyingAthanLab({
      [SUBMIT]: athanlabError(403, "scope_missing", {
        details: { required_scope: "speech:write" },
      }),
    });
    const withDetails = await putKey(makeEnv());
    expect(withDetails.status).toBe(400);
    expect(await withDetails.json()).toEqual({
      error:
        "This AthanLab key is missing the speech:write permission — create a key with speech:write, speech:read and voices:read",
      code: "scope_missing",
    });

    // Without details, the scope of the step that failed.
    verifyingAthanLab({ "GET /speech?limit=1": athanlabError(403, "scope_missing") });
    expect(await (await putKey(makeEnv())).json()).toMatchObject({
      error: expect.stringContaining("missing the speech:read permission"),
    });
    expect(credentialRow()).toBeUndefined();
  });

  it("explains maintenance, other refusals, and a missing plan", async () => {
    verifyingAthanLab({
      [SUBMIT]: athanlabError(503, "api_read_only", { retryable: true, retryAfter: "60" }),
    });
    const readOnly = await putKey(makeEnv());
    expect(readOnly.status).toBe(503);
    expect(await readOnly.json()).toEqual({
      error: "AthanLab is in maintenance — try again later",
      code: "api_read_only",
    });

    verifyingAthanLab({
      [SUBMIT]: athanlabError(402, "plan_required", {
        message: "Creating jobs through the API requires an active Max plan.",
      }),
    });
    const noPlan = await putKey(makeEnv());
    expect(noPlan.status).toBe(400);
    expect(await noPlan.json()).toEqual({
      error: "AthanLab: Creating jobs through the API requires an active Max plan.",
      code: "plan_required",
    });
  });

  it("stores the key even when usage cannot be read", async () => {
    verifyingAthanLab({ "GET /usage": athanlabError(403, "scope_missing") });

    expect((await putKey(makeEnv())).status).toBe(200);
    expect(credentialRow()).toBeDefined();
  });

  it("pauses key checks after too many failed authentications, before contacting AthanLab", async () => {
    const { fetchSpy } = stubAthanLab();
    setBreaker({ failures: KEY_CHECK_PAUSE_FAILURES });

    const response = await putKey(makeEnv());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "AthanLab key checks are paused for a few minutes — try again soon",
      code: "key_checks_paused",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("admits only as many concurrent key checks as the breaker has room for", async () => {
    // Twenty people paste wrong keys at once, with one slot left in the window.
    setBreaker({ failures: KEY_CHECK_PAUSE_FAILURES - 1 });
    const athanlab = stubAthanLab({
      "GET /voices": delayed(athanlabError(401, "invalid_api_key"), 50),
    });
    const env = makeEnv();
    const users = Array.from({ length: 20 }, (_, index) => `racer-${index}`);
    for (const user of users) insertSignedInUser(database.sqlite, user, `session-${user}`);

    const responses = await Promise.all(
      users.map((user, index) =>
        athanlabRoute.request(
          "https://nexteditor.dev/key",
          {
            method: "PUT",
            headers: { "Content-Type": "application/json", Cookie: `ne_session=session-${user}` },
            body: JSON.stringify({ apiKey: `ak_live_${index.toString(16).padStart(32, "0")}` }),
          },
          env,
        ),
      ),
    );
    const codes = await Promise.all(
      responses.map(async (response) => ((await response.json()) as { code: string }).code),
    );

    expect(athanlab.calls).toHaveLength(1);
    expect(codes.filter((code) => code === "invalid_api_key")).toHaveLength(1);
    expect(codes.filter((code) => code === "key_checks_paused")).toHaveLength(19);
    expect(breakerRow()?.failures).toBe(KEY_CHECK_PAUSE_FAILURES);
  });

  it("holds a key check's slot while it runs, and hands it back unless AthanLab answers 401", async () => {
    setBreaker({ failures: KEY_CHECK_PAUSE_FAILURES - 1 });
    let answerVoices!: () => void;
    const athanlab = verifyingAthanLab({
      "GET /voices": gated(
        () => json({ data: [], default_voice_id: null }),
        new Promise<void>((resolve) => {
          answerVoices = resolve;
        }),
      ),
    });
    const env = makeEnv();

    const running = putKey(env);
    await vi.waitFor(() => expect(athanlab.calls).toHaveLength(1));
    expect(breakerRow()?.failures).toBe(KEY_CHECK_PAUSE_FAILURES);
    const meanwhile = await putKey(env, OTHER_KEY);
    expect(meanwhile.status).toBe(503);
    expect(await meanwhile.json()).toMatchObject({ code: "key_checks_paused" });
    expect(athanlab.calls).toHaveLength(1);

    answerVoices();
    expect((await running).status).toBe(200);
    expect(breakerRow()?.failures).toBe(KEY_CHECK_PAUSE_FAILURES - 1);

    // A check that fails for any reason but a 401 hands its slot back too…
    verifyingAthanLab({ [SUBMIT]: athanlabError(402, "plan_required") });
    expect((await putKey(env)).status).toBe(400);
    verifyingAthanLab({ "GET /voices": () => new Response("bad gateway", { status: 502 }) });
    expect((await putKey(env)).status).toBe(503);
    expect(breakerRow()?.failures).toBe(KEY_CHECK_PAUSE_FAILURES - 1);

    // …and a 401 keeps it as the recorded failure, once.
    verifyingAthanLab({ "GET /voices": athanlabError(401, "invalid_api_key") });
    expect((await putKey(env)).status).toBe(400);
    expect(breakerRow()?.failures).toBe(KEY_CHECK_PAUSE_FAILURES);
    const { fetchSpy } = stubAthanLab();
    expect(await (await putKey(env)).json()).toMatchObject({ code: "key_checks_paused" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps a key check's slot when AthanLab's answer never arrives", async () => {
    // A timed-out or dropped call may still have reached AthanLab and counted
    // there as a failed authentication.
    setBreaker({ failures: KEY_CHECK_PAUSE_FAILURES - 1 });
    stubAthanLab({
      "GET /voices": () => {
        throw new TypeError("network connection lost");
      },
    });
    const env = makeEnv();

    const response = await putKey(env);

    expect(response.status).toBe(503);
    expect(breakerRow()?.failures).toBe(KEY_CHECK_PAUSE_FAILURES);
    const { fetchSpy } = stubAthanLab();
    expect(await (await putKey(env, OTHER_KEY)).json()).toMatchObject({
      code: "key_checks_paused",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a key check when the breaker cannot reserve its slot", async () => {
    database = openSqliteD1({
      failWhen: (sql) => sql.includes("provider_auth_breaker") && sql.includes("RETURNING"),
    });
    insertSignedInUser(database.sqlite, USER_ID, SESSION_ID);
    const { fetchSpy } = stubAthanLab();

    const response = await putKey(makeEnv());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "AthanLab narration is temporarily unavailable — try again soon",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(credentialRow()).toBeUndefined();
  });

  it("charges the per-user key budget and fails closed without one", async () => {
    const { fetchSpy } = stubAthanLab();
    const limiter = countingRateLimiter(0);

    const refused = await putKey(makeEnv({ ATHANLAB_KEY_RATE_LIMITER: limiter }));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: "Too many AthanLab requests — wait a minute",
      code: "rate_limited",
      retryAfterSeconds: 60,
    });
    expect(limiter.keys).toEqual([`user:${USER_ID}`]);

    const missing = await putKey(makeEnv({ ATHANLAB_KEY_RATE_LIMITER: undefined }));
    expect(missing.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers 503 when the rate limiter itself fails, without logging the user", async () => {
    const { fetchSpy } = stubAthanLab();
    const failing: RateLimit = {
      async limit() {
        throw new Error("rate limiter unavailable");
      },
    };

    const response = await putKey(makeEnv({ ATHANLAB_KEY_RATE_LIMITER: failing }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "AthanLab narration is temporarily unavailable — try again soon",
    });
    expect(consoleOutput).toContainEqual(["AthanLab rate-limit check failed"]);
    expect(JSON.stringify(consoleOutput)).not.toContain(USER_ID);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("records auth_blocked and then fails every route fast", async () => {
    const athanlab = stubAthanLab({
      "GET /voices": athanlabError(429, "auth_blocked", { retryable: true, retryAfter: "600" }),
    });
    const env = makeEnv();

    const blocked = await putKey(env);
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toEqual({
      error: "AthanLab is temporarily refusing requests from Next Editor — try again in 10 min",
      code: "auth_blocked",
      retryAfterSeconds: 600,
    });
    expect(breakerRow()?.blocked_until).toBeGreaterThan(Date.now() + 590_000);

    await storeKey(env);
    for (const response of [
      await putKey(env),
      await call("/voices", env),
      await call(`/voices/${VOICE_ID}/sample`, env),
      await call("/usage", env),
      await postTts(env),
    ]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "auth_blocked" });
    }
    expect(athanlab.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Routes that send the stored key

describe("stored-key routes", () => {
  it("need a stored, valid, readable key before contacting AthanLab", async () => {
    const { fetchSpy } = stubAthanLab();
    const env = makeEnv();

    const missing = await call("/voices", env);
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({
      error: "Connect your AthanLab API key first",
      code: "key_missing",
    });

    await storeKey(makeEnv({ ATHANLAB_KEY_ENCRYPTION_SECRET: OTHER_SECRET }));
    const stale = await postTts(env);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: "Your saved AthanLab key can no longer be read — connect it again",
      code: "key_stale",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("invalidates a key AthanLab rejects and never sends it again", async () => {
    const athanlab = stubAthanLab({ "GET /voices": athanlabError(401, "invalid_api_key") });
    const env = makeEnv();
    await storeKey(env);

    const rejected = await call("/voices", env);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({
      error:
        "AthanLab rejected your saved API key — it may have expired or been revoked. Connect a new key.",
      code: "key_invalid",
    });
    expect(credentialRow()?.invalidated_at).toEqual(expect.any(Number));
    expect(breakerRow()?.failures).toBe(1);

    for (const response of [
      await call("/voices", env),
      await call("/usage", env),
      await call(`/voices/${VOICE_ID}/sample`, env),
      await postTts(env),
    ]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "key_invalid" });
    }
    expect(athanlab.calls).toHaveLength(1);
    expect(await (await call("/key", env)).json()).toMatchObject({
      connected: false,
      invalid: true,
    });
  });

  it("send a revoked key once, however many requests carry it at once", async () => {
    const athanlab = stubAthanLab({
      "GET /usage": delayed(athanlabError(401, "invalid_api_key"), 50),
    });
    const env = makeEnv();
    await storeKey(env);

    const responses = await Promise.all(Array.from({ length: 30 }, () => call("/usage", env)));

    expect(athanlab.calls).toHaveLength(1);
    for (const response of responses) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "key_invalid" });
    }
    expect(breakerRow()?.failures).toBe(1);
    expect(credentialRow()).toMatchObject({
      invalidated_at: expect.any(Number),
      probe_token: null,
      probe_until: null,
    });
  });

  it("never send a key the user replaced, even from requests that decrypted it first", async () => {
    let answerOldKey!: () => void;
    const oldKeyAnswered = new Promise<void>((resolve) => {
      answerOldKey = resolve;
    });
    const rejectOldKey = gated(athanlabError(401, "invalid_api_key"), oldKeyAnswered);
    const athanlab = stubAthanLab({
      "GET /usage": (request) =>
        request.headers.get("X-API-Key") === API_KEY
          ? rejectOldKey(request)
          : json({ spendable: 1 }),
    });
    const env = makeEnv();
    await storeKey(env);

    // Every request decrypts the revoked key; one holds the lease and is in flight…
    const running = Promise.all(Array.from({ length: 10 }, () => call("/usage", env)));
    await vi.waitFor(() => expect(athanlab.calls).toHaveLength(1));
    // …when the user connects a new key, before AthanLab rejects the old one.
    await storeKey(env, OTHER_KEY);
    await new Promise((resolve) => setTimeout(resolve, 500));
    answerOldKey();
    const responses = await running;

    const oldKeyCalls = athanlab.calls.filter(
      (request) => request.headers.get("X-API-Key") === API_KEY,
    );
    expect(oldKeyCalls).toHaveLength(1);
    const codes = await Promise.all(
      responses.map(async (response) => ((await response.json()) as { code: string }).code),
    );
    expect(codes.filter((code) => code === "key_invalid")).toHaveLength(1);
    expect(codes.filter((code) => code === "key_busy")).toHaveLength(9);
    expect(breakerRow()?.failures).toBe(1);
    // The replacement stays usable, and the next request sends it.
    expect(credentialRow()).toMatchObject({ invalidated_at: null, key_hint: "9999" });
    expect((await call("/usage", env)).status).toBe(200);
    expect(athanlab.calls.at(-1)?.headers.get("X-API-Key")).toBe(OTHER_KEY);
  });

  it("make a request that waited for the lease honor a block its holder met", async () => {
    let answerHolder!: () => void;
    const holderAnswered = new Promise<void>((resolve) => {
      answerHolder = resolve;
    });
    const athanlab = stubAthanLab({
      "GET /usage": gated(
        athanlabError(429, "auth_blocked", { retryable: true, retryAfter: "600" }),
        holderAnswered,
      ),
    });
    const env = makeEnv();
    await storeKey(env);

    const holder = call("/usage", env);
    await vi.waitFor(() => expect(athanlab.calls).toHaveLength(1));
    const waiter = call("/usage", env);
    await new Promise((resolve) => setTimeout(resolve, 300));
    answerHolder();

    for (const response of [await holder, await waiter]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "auth_blocked" });
    }
    expect(athanlab.calls).toHaveLength(1);
    expect(credentialRow()).toMatchObject({ probe_token: null, probe_until: null });
  });

  it("let each request through once the one before it has been answered", async () => {
    const athanlab = stubAthanLab({
      "GET /voices": delayed(() => json({ data: [], default_voice_id: null }), 20),
      "GET /usage": [
        delayed(() => json({ spendable: 1 }), 20),
        delayed(() => json({ spendable: 2 }), 20),
      ],
    });
    const env = makeEnv();
    await storeKey(env);

    // The Studio panel loads voices and the balance together.
    const [voices, usage] = await Promise.all([call("/voices", env), call("/usage", env)]);
    expect(voices.status).toBe(200);
    expect(usage.status).toBe(200);
    expect(credentialRow()).toMatchObject({ probe_token: null, probe_until: null });

    // Released after the answer: the next request goes straight through.
    const startedAt = Date.now();
    expect((await call("/usage", env)).status).toBe(200);
    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(athanlab.calls).toHaveLength(3);
    expect(credentialRow()).toMatchObject({ probe_token: null, probe_until: null });
  });

  it("answer key_busy, without contacting AthanLab, while the lease stays taken", async () => {
    const { fetchSpy } = stubAthanLab();
    const env = makeEnv();
    await storeKey(env);
    database.sqlite
      .prepare("UPDATE user_provider_credentials SET probe_token = 'other', probe_until = ?")
      .run(Date.now() + 60_000);

    let waitedMs = 0;
    const response = await settle(async () => {
      const startedAt = Date.now();
      const answer = await call("/usage", env);
      waitedMs = Date.now() - startedAt;
      return answer;
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Another request is checking your AthanLab key with AthanLab — try again in a moment",
      code: "key_busy",
      retryAfterSeconds: 2,
    });
    expect(waitedMs).toBeGreaterThanOrEqual(5_000);
    expect(waitedMs).toBeLessThan(6_000);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(credentialRow()?.probe_token).toBe("other");
  });

  it("take over a lease its holder never released", async () => {
    const athanlab = stubAthanLab({ "GET /usage": () => json({ spendable: 1 }) });
    const env = makeEnv();
    await storeKey(env);
    database.sqlite
      .prepare("UPDATE user_provider_credentials SET probe_token = 'stalled', probe_until = ?")
      .run(Date.now() - 1);

    expect((await call("/usage", env)).status).toBe(200);
    expect(athanlab.calls).toHaveLength(1);
    expect(credentialRow()).toMatchObject({ probe_token: null, probe_until: null });
  });

  it("refuse the request when the lease cannot be taken", async () => {
    database = openSqliteD1({ failWhen: (sql) => sql.includes("SET probe_token = ?") });
    insertSignedInUser(database.sqlite, USER_ID, SESSION_ID);
    const { fetchSpy } = stubAthanLab();
    const env = makeEnv();
    await storeKey(env);

    const response = await call("/voices", env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "AthanLab narration is temporarily unavailable — try again soon",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("charge the per-user API budget and fail closed without one", async () => {
    const { fetchSpy } = stubAthanLab();
    const env = makeEnv({ ATHANLAB_API_RATE_LIMITER: refusingRateLimiter() });
    await storeKey(env);

    for (const response of [
      await call("/voices", env),
      await call("/usage", env),
      await call(`/voices/${VOICE_ID}/sample`, env),
      await postTts(env),
    ]) {
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({
        error: "Too many AthanLab requests — wait a minute",
        code: "rate_limited",
        retryAfterSeconds: 60,
      });
    }
    const missing = await call("/voices", makeEnv({ ATHANLAB_API_RATE_LIMITER: undefined }));
    expect(missing.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("GET /api/studio/athanlab/voices", () => {
  it("lists only voices whose ids are safe to send back", async () => {
    stubAthanLab({
      "GET /voices": () =>
        json({
          data: [
            {
              id: VOICE_ID,
              name: "Thiri",
              category: "narration",
              source: "athanlab",
              is_default: true,
            },
            {
              id: "../../usage",
              name: "Path",
              category: "x",
              source: "athanlab",
              is_default: false,
            },
            { id: "has space", name: "Space", category: "x", source: "user", is_default: false },
            {
              id: "x".repeat(129),
              name: "Long id",
              category: "x",
              source: "user",
              is_default: false,
            },
            {
              id: "voice-from-elsewhere",
              name: "Odd",
              category: "x",
              source: "partner",
              is_default: false,
            },
            {
              id: "my.voice:1",
              name: `  Mine\n${"n".repeat(200)}`,
              category: 7,
              source: "user",
              is_default: "yes",
            },
          ],
          default_voice_id: VOICE_ID,
        }),
    });
    const env = makeEnv();
    await storeKey(env);

    const response = await call("/voices", env);
    const body = (await response.json()) as {
      voices: Array<{
        id: string;
        name: string;
        category: string;
        source: string;
        isDefault: boolean;
      }>;
      defaultVoiceId: string | null;
    };

    expect(response.status).toBe(200);
    expect(body.defaultVoiceId).toBe(VOICE_ID);
    expect(body.voices.map((voice) => voice.id)).toEqual([VOICE_ID, "my.voice:1"]);
    expect(body.voices[0]).toEqual({
      id: VOICE_ID,
      name: "Thiri",
      category: "narration",
      source: "athanlab",
      isDefault: true,
    });
    expect(body.voices[1]).toMatchObject({ category: "", source: "user", isDefault: false });
    expect(body.voices[1].name).toHaveLength(120);
    expect(body.voices[1].name.startsWith("Mine n")).toBe(true);
  });

  it("drops a default voice that is not listed, and caps the list", async () => {
    stubAthanLab({
      "GET /voices": () =>
        json({
          data: Array.from({ length: 250 }, (_, index) => ({
            id: `voice-${index}`,
            name: `Voice ${index}`,
            category: "x",
            source: "user",
            is_default: false,
          })),
          default_voice_id: "../../usage",
        }),
    });
    const env = makeEnv();
    await storeKey(env);

    const body = (await (await call("/voices", env)).json()) as {
      voices: unknown[];
      defaultVoiceId: string | null;
    };

    expect(body.voices).toHaveLength(200);
    expect(body.defaultVoiceId).toBeNull();
  });
});

describe("GET /api/studio/athanlab/voices/:id/sample", () => {
  const SAMPLE_URL = "https://cdn.athanlab.com/samples/thiri.mp3?sig=abc";
  const MP3 = new Uint8Array([73, 68, 51, 4, 0, 0, 0]);

  function previewing(url: unknown, sample: Reply | null = null) {
    return stubAthanLab({
      [`GET /voices/${VOICE_ID}/preview`]: () =>
        json({ id: VOICE_ID, name: "Thiri", url, expires_in: 3600 }),
      ...(sample ? { [`GET ${SAMPLE_URL}`]: sample } : {}),
    });
  }

  it("streams the sample from this origin without sending the key to the sample host", async () => {
    const athanlab = previewing(
      SAMPLE_URL,
      () =>
        new Response(MP3.slice().buffer, {
          status: 200,
          headers: { "Content-Type": "audio/mpeg; charset=binary", "Content-Length": "7" },
        }),
    );
    const env = makeEnv();
    await storeKey(env);

    const response = await call(`/voices/${VOICE_ID}/sample`, env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(MP3);
    expect(athanlab.calls[0].headers.get("x-api-key")).toBe(API_KEY);
    expect(athanlab.calls[1].url).toBe(SAMPLE_URL);
    expect(athanlab.calls[1].headers.get("x-api-key")).toBeNull();
  });

  it("refuses a preview URL that is not plain https", async () => {
    const env = makeEnv();
    await storeKey(env);

    for (const url of [
      "http://cdn.athanlab.com/samples/thiri.mp3",
      "https://user:pass@cdn.athanlab.com/samples/thiri.mp3",
      "javascript:alert(1)",
      "/relative/sample.mp3",
      42,
    ]) {
      const athanlab = previewing(url);
      const response = await call(`/voices/${VOICE_ID}/sample`, env);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: "This AthanLab voice sample could not be loaded",
        code: "sample_unavailable",
      });
      expect(athanlab.calls).toHaveLength(1);
    }
  });

  it("refuses a sample that is not audio, is too large, or redirects off https", async () => {
    const env = makeEnv();
    await storeKey(env);

    for (const sample of [
      () =>
        new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } }),
      () =>
        new Response("x", {
          status: 200,
          headers: { "Content-Type": "audio/mpeg", "Content-Length": String(11 * 1024 * 1024) },
        }),
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "http://cdn.athanlab.com/samples/thiri.mp3" },
        }),
      () => new Response("gone", { status: 404, headers: { "Content-Type": "audio/mpeg" } }),
    ]) {
      previewing(SAMPLE_URL, sample);
      const response = await call(`/voices/${VOICE_ID}/sample`, env);
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ code: "sample_unavailable" });
    }
  });

  it("errors a sample stream that runs past 10 MiB without a declared length", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    previewing(SAMPLE_URL, () => {
      let sent = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent++ < 12) controller.enqueue(chunk);
            else controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "audio/mpeg" } },
      );
    });
    const env = makeEnv();
    await storeKey(env);

    const response = await call(`/voices/${VOICE_ID}/sample`, env);

    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow("larger than expected");
  });

  it("validates the voice id before anything else", async () => {
    const { fetchSpy } = stubAthanLab();
    const response = await call("/voices/bad%20id/sample", makeEnv());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_voice" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("GET /api/studio/athanlab/usage", () => {
  it("maps AthanLab's usage and links only AthanLab's own upgrade page", async () => {
    const usage = {
      plan: "max",
      entitled: false,
      upgrade_url: "https://athanlab.com/pricing?plan=max",
      monthly: {
        limit: 100_000,
        used: 2_500,
        remaining: 97_500,
        resets_at: "2026-11-01T00:00:00Z",
      },
      tokens: { balance: 1_200 },
      spendable: 98_700,
      active_jobs: 0,
      max_concurrent_jobs: 2,
      key: {
        id: "key_1",
        monthly_char_budget: 50_000,
        used_this_month: 2_500,
        remaining: 47_500,
        resets_at: null,
      },
    };
    const env = makeEnv();
    await storeKey(env);

    stubAthanLab({ "GET /usage": () => json(usage) });
    expect(await (await call("/usage", env)).json()).toEqual({
      available: true,
      spendable: 98_700,
      entitled: false,
      upgradeUrl: "https://athanlab.com/pricing?plan=max",
      monthly: {
        limit: 100_000,
        used: 2_500,
        remaining: 97_500,
        resetsAt: "2026-11-01T00:00:00.000Z",
      },
      tokens: { balance: 1_200 },
      key: { monthlyCharBudget: 50_000, remaining: 47_500 },
    });

    for (const upgradeUrl of [
      "https://evil.example/pricing",
      "http://athanlab.com/pricing",
      "https://athanlab.com.evil.example/",
      "https://user@athanlab.com/pricing",
    ]) {
      stubAthanLab({ "GET /usage": () => json({ ...usage, upgrade_url: upgradeUrl }) });
      expect(await (await call("/usage", env)).json()).toMatchObject({ upgradeUrl: null });
    }
  });

  it("reports invalid numbers as null", async () => {
    const env = makeEnv();
    await storeKey(env);
    stubAthanLab({
      "GET /usage": () =>
        json({
          entitled: "yes",
          spendable: -1,
          monthly: { limit: 1.5, used: "10", remaining: null, resets_at: "soon" },
          tokens: {},
          key: { monthly_char_budget: null, remaining: Number.MAX_SAFE_INTEGER + 2 },
        }),
    });

    expect(await (await call("/usage", env)).json()).toEqual({
      available: true,
      spendable: null,
      entitled: null,
      upgradeUrl: null,
      monthly: { limit: null, used: null, remaining: null, resetsAt: null },
      tokens: { balance: null },
      key: { monthlyCharBudget: null, remaining: null },
    });
  });

  it("is simply unavailable for a key without usage:read", async () => {
    const env = makeEnv();
    await storeKey(env);
    stubAthanLab({ "GET /usage": athanlabError(403, "scope_missing") });

    const response = await call("/usage", env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false });
  });
});

// ---------------------------------------------------------------------------
// Synthesis

const CANONICAL_BODY = JSON.stringify({
  text: TEXT,
  voice_id: VOICE_ID,
  output_format: "wav",
  number_mode: "smart",
  metadata: { source: "next-editor-studio" },
});
const IDEMPOTENCY_BASE = `ne1:${createHash("sha256").update(`${USER_ID}\n${CANONICAL_BODY}`).digest("hex")}`;

function submits(calls: AthanLabCall[]) {
  return calls.filter((request) => request.method === "POST");
}

describe("POST /api/studio/tts/athanlab", () => {
  async function readyEnv(overrides: Partial<Env> = {}) {
    const env = makeEnv(overrides);
    await storeKey(env);
    return env;
  }

  it("rejects malformed requests without contacting AthanLab", async () => {
    const { fetchSpy } = stubAthanLab();
    const env = await readyEnv();

    for (const body of [
      "not json",
      { text: TEXT },
      { text: TEXT, voiceId: VOICE_ID, seed: 1 },
      { text: "   ", voiceId: VOICE_ID },
      { text: "က".repeat(5_001), voiceId: VOICE_ID },
      { text: TEXT, voiceId: "../../usage" },
      { text: TEXT, voiceId: null },
    ]) {
      expect((await postTts(env, body)).status).toBe(400);
    }
    expect((await postTts(env, { text: "x".repeat(70_000), voiceId: VOICE_ID })).status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the canonical body once, keyed by its hash, honors Retry-After, and streams the WAV", async () => {
    const athanlab = stubAthanLab({
      [SUBMIT]: accepted("processing", { retryAfter: "4" }),
      [POLL]: [polled("processing"), polled("succeeded")],
      [DOWNLOAD]: wav(),
    });
    const env = await readyEnv();

    const response = await settle(() => postTts(env));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(WAV);

    const [submit, firstPoll, secondPoll, download] = athanlab.calls;
    expect(submit.body).toBe(CANONICAL_BODY);
    expect(submit.headers.get("idempotency-key")).toBe(IDEMPOTENCY_BASE);
    expect(submit.headers.get("content-type")).toBe("application/json");
    expect(firstPoll.at - submit.at).toBeGreaterThanOrEqual(4_000);
    expect(firstPoll.at - submit.at).toBeLessThan(4_500);
    expect(secondPoll.at - firstPoll.at).toBeGreaterThanOrEqual(3_000);
    expect(download.headers.get("accept")).toBe("audio/wav");
    // Only URLs built from the base and the validated id: never Location or audio.url.
    expect(athanlab.calls.map((request) => request.url)).toEqual([
      `${API}/speech`,
      `${API}/speech/${JOB_ID}`,
      `${API}/speech/${JOB_ID}`,
      `${API}/speech/${JOB_ID}/audio?format=wav`,
    ]);
    for (const request of athanlab.calls) {
      expect(request.headers.get("x-api-key")).toBe(API_KEY);
    }
    expect(athanlab.unexpected).toEqual([]);
  });

  it("downloads a replayed finished job without polling", async () => {
    const athanlab = stubAthanLab({
      [SUBMIT]: accepted("succeeded", { replayed: true }),
      [DOWNLOAD]: wav(),
    });

    const response = await settle(async () => postTts(await readyEnv()));

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(WAV);
    expect(athanlab.calls.map((request) => `${request.method} ${request.path}`)).toEqual([
      SUBMIT,
      DOWNLOAD,
    ]);
  });

  it("moves to the next attempt key after a retryable failure", async () => {
    const athanlab = stubAthanLab({
      [SUBMIT]: [
        accepted("failed", {
          error: {
            code: "generation_failed",
            message: "Speech generation failed.",
            retryable: true,
          },
        }),
        accepted("processing", { id: SECOND_JOB_ID }),
      ],
      [`GET /speech/${SECOND_JOB_ID}`]: polled("succeeded", { id: SECOND_JOB_ID }),
      [`GET /speech/${SECOND_JOB_ID}/audio?format=wav`]: wav(),
    });

    const response = await settle(async () => postTts(await readyEnv()));

    expect(response.status).toBe(200);
    expect(
      submits(athanlab.calls).map((request) => request.headers.get("idempotency-key")),
    ).toEqual([IDEMPOTENCY_BASE, `${IDEMPOTENCY_BASE}.r1`]);
    expect(submits(athanlab.calls).every((request) => request.body === CANONICAL_BODY)).toBe(true);
  });

  it("moves past a replayed cancelled job", async () => {
    const athanlab = stubAthanLab({
      [SUBMIT]: [accepted("cancelled", { replayed: true }), accepted("succeeded")],
      [DOWNLOAD]: wav(),
    });

    const response = await settle(async () => postTts(await readyEnv()));

    expect(response.status).toBe(200);
    expect(
      submits(athanlab.calls).map((request) => request.headers.get("idempotency-key")),
    ).toEqual([IDEMPOTENCY_BASE, `${IDEMPOTENCY_BASE}.r1`]);
  });

  it("starts at most three fresh jobs per request", async () => {
    const failed = accepted("failed", {
      error: { code: "interrupted", message: "The job was interrupted.", retryable: true },
    });
    const athanlab = stubAthanLab({
      [SUBMIT]: [
        // Replays of earlier requests' jobs are free and do not count.
        accepted("failed", {
          replayed: true,
          error: { code: "interrupted", message: "The job was interrupted.", retryable: true },
        }),
        failed,
        failed,
        failed,
        failed,
      ],
    });

    const response = await settle(async () => postTts(await readyEnv()));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "AthanLab could not speak this dialog: The job was interrupted.",
      code: "interrupted",
    });
    expect(submits(athanlab.calls)).toHaveLength(4);
  });

  it("never goes past the r7 attempt key", async () => {
    const replayedFailure = accepted("failed", {
      replayed: true,
      error: { code: "generation_failed", message: "failed", retryable: true },
    });
    const athanlab = stubAthanLab({ [SUBMIT]: Array.from({ length: 10 }, () => replayedFailure) });

    const response = await settle(async () => postTts(await readyEnv()));

    expect(response.status).toBe(502);
    expect(
      submits(athanlab.calls).map((request) => request.headers.get("idempotency-key")),
    ).toEqual([
      IDEMPOTENCY_BASE,
      ...Array.from({ length: 7 }, (_, index) => `${IDEMPOTENCY_BASE}.r${index + 1}`),
    ]);
  });

  it("reports a job that failed for good", async () => {
    stubAthanLab({
      [SUBMIT]: accepted("processing"),
      [POLL]: polled("failed", {
        error: {
          code: "input_rejected",
          message: "The text could not be turned into speech.",
          retryable: false,
        },
      }),
    });

    const response = await settle(async () => postTts(await readyEnv()));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "AthanLab could not speak this dialog: The text could not be turned into speech.",
      code: "input_rejected",
    });
  });

  it("treats key_budget_exceeded as final, without retrying", async () => {
    const athanlab = stubAthanLab({
      [SUBMIT]: athanlabError(429, "key_budget_exceeded", {
        message: "This API key has reached its monthly character budget.",
        retryAfter: "3600",
      }),
    });

    const response = await settle(async () => postTts(await readyEnv()));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "This API key has reached its monthly character budget.",
      code: "key_budget_exceeded",
    });
    expect(athanlab.calls).toHaveLength(1);
  });

  it("passes on AthanLab's refusals as final", async () => {
    for (const [status, code] of [
      [402, "insufficient_characters"],
      [403, "scope_missing"],
      [404, "voice_not_found"],
      [422, "unspeakable_text"],
      [400, "validation_error"],
    ] as const) {
      stubAthanLab({ [SUBMIT]: athanlabError(status, code, { message: `refused: ${code}` }) });
      const response = await settle(async () => postTts(await readyEnv()));
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: `refused: ${code}`, code });
    }
  });

  it("waits out a retryable 503 and submits the same key again", async () => {
    const athanlab = stubAthanLab({
      [SUBMIT]: [
        athanlabError(503, "capacity_unavailable", { retryable: true, retryAfter: "6" }),
        accepted("succeeded"),
      ],
      [DOWNLOAD]: wav(),
    });

    const response = await settle(async () => postTts(await readyEnv()));

    expect(response.status).toBe(200);
    const [first, second] = submits(athanlab.calls);
    expect(second.at - first.at).toBeGreaterThanOrEqual(6_000);
    expect(second.headers.get("idempotency-key")).toBe(first.headers.get("idempotency-key"));
    expect(second.body).toBe(first.body);
  });

  it("reports AthanLab as unavailable after three transient failures", async () => {
    const athanlab = stubAthanLab({
      [SUBMIT]: [
        () => new Response("bad gateway", { status: 502 }),
        athanlabError(500, "internal_error", { retryable: true, message: "Internal error." }),
        athanlabError(503, "server_restarting", {
          retryable: true,
          message: "The server is restarting.",
        }),
      ],
    });

    const response = await settle(async () => postTts(await readyEnv()));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "AthanLab: The server is restarting.",
      code: "server_restarting",
      retryAfterSeconds: 4,
    });
    expect(athanlab.calls).toHaveLength(3);
  });

  it("leaves a slow job running and asks the browser to come back", async () => {
    const athanlab = stubAthanLab({
      [SUBMIT]: accepted("processing"),
      [POLL]: polled("processing"),
    });

    const response = await settle(async () => postTts(await readyEnv()));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "AthanLab is still generating this dialog",
      code: "still_processing",
      retryAfterSeconds: 5,
    });
    expect(athanlab.calls.some((request) => request.path.includes("/cancel"))).toBe(false);
    expect(
      athanlab.calls.every((request) => request.method === "GET" || request.path === "/speech"),
    ).toBe(true);
    const polls = athanlab.calls.filter((request) => request.path === `/speech/${JOB_ID}`);
    const lastPoll = polls[polls.length - 1];
    // Within the 240 s deadline, polling every 3 s, then 5 s, then 10 s.
    expect(lastPoll.at - athanlab.calls[0].at).toBeLessThanOrEqual(240_000);
    expect(polls[polls.length - 1].at - polls[polls.length - 2].at).toBe(10_000);
    expect(athanlab.calls.length).toBeLessThanOrEqual(42);
  });

  it("re-attaches to the running job on the browser's next request", async () => {
    const athanlab = stubAthanLab({
      [SUBMIT]: [accepted("processing"), accepted("succeeded", { replayed: true })],
      [POLL]: polled("processing"),
      [DOWNLOAD]: wav(),
    });
    const env = await readyEnv();

    expect((await settle(() => postTts(env))).status).toBe(503);
    const second = await settle(() => postTts(env));

    expect(second.status).toBe(200);
    expect(
      new Set(submits(athanlab.calls).map((request) => request.headers.get("idempotency-key"))),
    ).toEqual(new Set([IDEMPOTENCY_BASE]));
  });

  it("keeps submits and polls within the subrequest budget, reserving the download", async () => {
    const replayedFailure = accepted("failed", {
      replayed: true,
      error: { code: "generation_failed", message: "failed", retryable: true },
    });
    const athanlab = stubAthanLab({
      [SUBMIT]: [
        ...Array.from({ length: 7 }, () => replayedFailure),
        accepted("processing", { replayed: true }),
      ],
      [POLL]: polled("processing"),
    });

    const response = await settle(async () => postTts(await readyEnv()));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "still_processing" });
    expect(athanlab.calls).toHaveLength(42);
  });

  it("invalidates the key on a 401 and records the failure", async () => {
    stubAthanLab({ [SUBMIT]: athanlabError(401, "invalid_api_key") });

    const response = await settle(async () => postTts(await readyEnv()));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "key_invalid" });
    expect(credentialRow()).toMatchObject({
      invalidated_at: expect.any(Number),
      probe_token: null,
    });
    expect(breakerRow()?.failures).toBe(1);
  });

  it("holds the key's lease through the first submit, retries included, and not while polling", async () => {
    const leaseAt: Record<string, unknown> = {};
    const athanlab = stubAthanLab({
      [SUBMIT]: [
        (request) => {
          leaseAt.firstAttempt = credentialRow()?.probe_token;
          return athanlabError(503, "capacity_unavailable", { retryable: true })(request);
        },
        (request) => {
          leaseAt.retry = credentialRow()?.probe_token;
          return accepted("processing")(request);
        },
      ],
      [POLL]: () => {
        leaseAt.poll = credentialRow()?.probe_token;
        return polled("succeeded")();
      },
      [DOWNLOAD]: wav(),
    });

    const response = await settle(async () => postTts(await readyEnv()));

    expect(response.status).toBe(200);
    expect(athanlab.calls).toHaveLength(4);
    expect(leaseAt.firstAttempt).toEqual(expect.any(String));
    expect(leaseAt.retry).toBe(leaseAt.firstAttempt);
    expect(leaseAt.poll).toBeNull();
  });

  it("asks again for a poll whose body stalls after the headers", async () => {
    const athanlab = stubAthanLab({
      [SUBMIT]: accepted("processing"),
      [POLL]: [stalledBody(), polled("succeeded")],
      [DOWNLOAD]: wav(),
    });

    const response = await settle(async () => postTts(await readyEnv()));

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(WAV);
    const [, stalled, retried] = athanlab.calls;
    // The 15 s poll timeout ends the stalled body, then the 1 s first backoff.
    expect(retried.at - stalled.at).toBeGreaterThanOrEqual(16_000);
    expect(retried.at - stalled.at).toBeLessThan(17_000);
    expect(athanlab.unexpected).toEqual([]);
  });

  it("submits again, with the same idempotency key, after a body that breaks off", async () => {
    const athanlab = stubAthanLab({
      [SUBMIT]: [brokenBody(), accepted("succeeded")],
      [DOWNLOAD]: wav(),
    });

    const response = await settle(async () => postTts(await readyEnv()));

    expect(response.status).toBe(200);
    const [first, second] = submits(athanlab.calls);
    expect(second.headers.get("idempotency-key")).toBe(IDEMPOTENCY_BASE);
    expect(first.headers.get("idempotency-key")).toBe(IDEMPOTENCY_BASE);
    expect(second.body).toBe(first.body);
  });

  it("gives up after three broken bodies in a row, like any transient failure", async () => {
    const athanlab = stubAthanLab({
      [SUBMIT]: accepted("processing"),
      [POLL]: [brokenBody(), brokenBody(), brokenBody()],
    });

    const response = await settle(async () => postTts(await readyEnv()));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "AthanLab: no response (the connection failed or timed out)",
      code: "unavailable",
      retryAfterSeconds: 4,
    });
    expect(athanlab.calls).toHaveLength(4);
  });

  it("records auth_blocked from a synthesis without retrying it", async () => {
    const athanlab = stubAthanLab({
      [SUBMIT]: athanlabError(429, "auth_blocked", { retryable: true, retryAfter: "30" }),
    });

    const response = await settle(async () => postTts(await readyEnv()));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "auth_blocked", retryAfterSeconds: 60 });
    expect(athanlab.calls).toHaveLength(1);
    expect(breakerRow()?.blocked_until).toBeGreaterThan(0);
  });

  it("moves past one idempotency conflict, and only one", async () => {
    const conflict = athanlabError(409, "idempotency_conflict", {
      details: { job_id: SECOND_JOB_ID },
    });
    const once = stubAthanLab({ [SUBMIT]: [conflict, accepted("succeeded")], [DOWNLOAD]: wav() });
    expect((await settle(async () => postTts(await readyEnv()))).status).toBe(200);
    expect(submits(once.calls)[1].headers.get("idempotency-key")).toBe(`${IDEMPOTENCY_BASE}.r1`);
    expect(JSON.stringify(consoleOutput)).toContain(SECOND_JOB_ID);

    const twice = stubAthanLab({ [SUBMIT]: [conflict, conflict] });
    const response = await settle(async () => postTts(makeEnv()));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "idempotency_conflict" });
    expect(twice.calls).toHaveLength(2);
  });

  it("moves to the next attempt key when the audio has expired", async () => {
    const athanlab = stubAthanLab({
      [SUBMIT]: [
        accepted("succeeded", { replayed: true }),
        accepted("succeeded", { id: SECOND_JOB_ID }),
      ],
      [DOWNLOAD]: athanlabError(410, "audio_expired"),
      [`GET /speech/${SECOND_JOB_ID}/audio?format=wav`]: wav(),
    });

    const response = await settle(async () => postTts(await readyEnv()));

    expect(response.status).toBe(200);
    expect(submits(athanlab.calls)[1].headers.get("idempotency-key")).toBe(
      `${IDEMPOTENCY_BASE}.r1`,
    );
  });

  it("retries a download that is not ready yet", async () => {
    const athanlab = stubAthanLab({
      [SUBMIT]: accepted("succeeded"),
      [DOWNLOAD]: [
        athanlabError(409, "job_not_finished", { retryable: true, retryAfter: "2" }),
        wav(),
      ],
    });

    const response = await settle(async () => postTts(await readyEnv()));

    expect(response.status).toBe(200);
    expect(athanlab.calls).toHaveLength(3);
  });

  it("fails a download that ends short of its Content-Length", async () => {
    stubAthanLab({
      [SUBMIT]: accepted("succeeded"),
      [DOWNLOAD]: wav(WAV, { "Content-Length": "100" }),
    });

    const response = await settle(async () => postTts(await readyEnv()));

    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow("ended early");
  });

  it("refuses audio that is not WAV, or is empty", async () => {
    stubAthanLab({
      [SUBMIT]: accepted("succeeded"),
      [DOWNLOAD]: () =>
        new Response("ID3", { status: 200, headers: { "Content-Type": "audio/mpeg" } }),
    });
    const notWav = await settle(async () => postTts(await readyEnv()));
    expect(notWav.status).toBe(502);
    expect(await notWav.json()).toEqual({
      error: 'AthanLab returned "audio/mpeg" instead of WAV audio',
      code: "unexpected_response",
    });

    stubAthanLab({
      [SUBMIT]: accepted("succeeded"),
      [DOWNLOAD]: wav(new Uint8Array(0)),
    });
    const empty = await settle(async () => postTts(makeEnv()));
    expect(empty.status).toBe(502);
  });

  it("refuses a submit response without a well-formed job", async () => {
    const athanlab = stubAthanLab({
      [SUBMIT]: () => json({ object: "speech", id: "../../usage", status: "processing" }, 202),
    });

    const response = await settle(async () => postTts(await readyEnv()));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "unexpected_response" });
    expect(athanlab.calls).toHaveLength(1);
  });

  it("never puts the key or the text in a response body or a log line", async () => {
    const echo = `Rejected ${API_KEY} for text ${TEXT}`;
    const env = await readyEnv();
    const bodies: string[] = [];

    stubAthanLab({
      [SUBMIT]: athanlabError(422, "unspeakable_text", { message: echo }),
    });
    bodies.push(await (await settle(() => postTts(env))).text());

    stubAthanLab({
      [SUBMIT]: accepted("processing"),
      [POLL]: polled("failed", {
        error: { code: "input_rejected", message: echo, retryable: false },
      }),
    });
    bodies.push(await (await settle(() => postTts(env))).text());

    stubAthanLab({
      [SUBMIT]: athanlabError(503, "server_busy", {
        message: echo,
        retryable: true,
        retryAfter: "120",
      }),
    });
    bodies.push(await (await settle(() => postTts(env))).text());

    stubAthanLab({ "GET /voices": athanlabError(500, "internal_error", { message: echo }) });
    bodies.push(await (await call("/voices", env)).text());

    stubAthanLab({ "GET /voices": athanlabError(401, "invalid_api_key", { message: echo }) });
    bodies.push(await (await putKey(env, OTHER_KEY)).text());

    expect(bodies.every((body) => body.includes("[redacted]") || !body.includes("Rejected"))).toBe(
      true,
    );
    // AthanLab's own message may quote the text back; the key never survives.
    for (const body of bodies) {
      expect(body).not.toContain(API_KEY);
      expect(body).not.toContain(OTHER_KEY);
    }
    const logged = JSON.stringify(consoleOutput);
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain(OTHER_KEY);
    expect(logged).not.toContain(TEXT);
    expect(logged).not.toContain("Rejected");
  });
});
