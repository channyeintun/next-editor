import { beforeAll, describe, expect, it, vi } from "vitest";
import { signToken } from "./auth";
import type { Env } from "./types";

vi.mock("@cloudflare/containers", () => ({ Container: class {} }));

let worker: ExportedHandler<Env>;

beforeAll(async () => {
  vi.stubGlobal("DurableObject", class {});
  worker = (await import("./index")).default;
});

function quotaEnv(result: { count?: number; minutes?: number }): Env {
  const statement = {
    bind() { return this; },
    async first() { return "count" in result ? { count: result.count } : { minutes: result.minutes }; },
    async run() { return {}; },
  };
  return {
    RUNTIME_SESSION_SECRET: "test secret",
    MAX_CONCURRENT_SESSIONS: "2",
    MAX_DAILY_MINUTES: "120",
    PREVIEW_URL_TEMPLATE: "http://localhost/preview/{{sessionId}}/{{port}}",
    RUNTIME_QUOTAS: { prepare: () => statement } as unknown as D1Database,
    RUNTIME_GO_SESSIONS: {} as DurableObjectNamespace,
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
    const response = await request(quotaEnv({ count: 2 }));
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ code: "EQUOTA" });
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
});
