import { beforeAll, describe, expect, it, vi } from "vitest";
import { signToken } from "./auth";
import type { Env } from "./types";

vi.mock("@cloudflare/containers", () => ({ Container: class {} }));

let worker: ExportedHandler<Env>;

beforeAll(async () => {
  vi.stubGlobal("DurableObject", class {});
  worker = (await import("./index")).default;
});

function quotaEnv(result: {
  count?: number;
  minutes?: number;
  reservationChanges?: number;
  reservationError?: Error;
  onConfigure?: (request: Request) => void | Promise<void>;
}): Env {
  const database = {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async first() {
          if (sql.includes("COUNT(*)")) return { count: result.count ?? 0 };
          if (sql.includes("runtime_daily_usage")) return { minutes: result.minutes ?? 0 };
          return null;
        },
        async run() {
          if (sql.startsWith("INSERT INTO runtime_sessions") && result.reservationError) {
            throw result.reservationError;
          }
          return { meta: { changes: sql.startsWith("INSERT INTO runtime_sessions")
            ? result.reservationChanges ?? 0
            : 1 } };
        },
      };
    },
  };
  const stub = {
    async fetch(request: Request) {
      await result.onConfigure?.(request);
      return new Response(null, { status: 204 });
    },
  };
  return {
    RUNTIME_SESSION_SECRET: "test secret with at least thirty-two bytes",
    MAX_CONCURRENT_SESSIONS: "2",
    MAX_DAILY_MINUTES: "120",
    PREVIEW_URL_TEMPLATE: "http://localhost/preview/{{sessionId}}/{{port}}",
    RUNTIME_QUOTAS: database as unknown as D1Database,
    RUNTIME_GO_SESSIONS: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => stub,
    } as unknown as DurableObjectNamespace,
  };
}

async function request(env: Env): Promise<Response> {
  const token = await signToken(env.RUNTIME_SESSION_SECRET, { userId: "user-1", exp: Date.now()/1000+60 });
  return worker.fetch!(new Request("http://worker/api/runtime/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ runtime: "go1.26.5" }),
  }) as never, env, {} as ExecutionContext);
}

describe("session quotas", () => {
  it("returns a structured concurrent-session quota error", async () => {
    const response = await request(quotaEnv({ count: 2, reservationChanges: 0 }));
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ code: "EQUOTA" });
  });

  it("returns a structured daily-minutes quota error", async () => {
    const response = await request(quotaEnv({ minutes: 120, reservationChanges: 0 }));
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      code: "EQUOTA",
      message: "Daily runtime minutes exhausted",
    });
  });

  it("rejects unsupported image selectors before provisioning", async () => {
    const env = quotaEnv({ count: 0 });
    const token = await signToken(env.RUNTIME_SESSION_SECRET, { userId: "user-1", exp: Date.now()/1000+60 });
    const response = await worker.fetch!(new Request("http://worker/api/runtime/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ runtime: "arbitrary-image" }),
    }) as never, env, {} as ExecutionContext);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "ERUNTIME" });
  });

  it("passes a validated custom workdir to the session object", async () => {
    let configuredBody: unknown;
    const env = quotaEnv({
      reservationChanges: 1,
      onConfigure: async (configureRequest) => { configuredBody = await configureRequest.json(); },
    });
    const token = await signToken(env.RUNTIME_SESSION_SECRET, { userId: "user-1", exp: Date.now()/1000+60 });
    const response = await worker.fetch!(new Request("http://worker/api/runtime/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ runtime: "go1.26.5", workdirName: "lesson-one" }),
    }) as never, env, {} as ExecutionContext);

    expect(response.status).toBe(201);
    expect(configuredBody).toMatchObject({ workdirName: "lesson-one" });
  });

  it("distinguishes bad input and infrastructure failures from authentication errors", async () => {
    const env = quotaEnv({ reservationChanges: 1 });
    const token = await signToken(env.RUNTIME_SESSION_SECRET, { userId: "user-1", exp: Date.now()/1000+60 });
    const malformed = await worker.fetch!(new Request("http://worker/api/runtime/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "null",
    }) as never, env, {} as ExecutionContext);
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ code: "EBADREQUEST" });

    const failed = await request(quotaEnv({ reservationError: new Error("D1 unavailable") }));
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toMatchObject({ code: "EINTERNAL" });
  });

  it("fails closed when the session signing secret is too short", async () => {
    const env = quotaEnv({ reservationChanges: 1 });
    env.RUNTIME_SESSION_SECRET = "short";
    const token = await signToken("short", { userId: "user-1", exp: Date.now()/1000+60 });
    const response = await worker.fetch!(new Request("http://worker/api/runtime/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "{}",
    }) as never, env, {} as ExecutionContext);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "ECONFIG" });
  });
});
