import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "./types";

vi.mock("@cloudflare/containers", () => ({
  Container: class {
    ctx: unknown;
    env: unknown;
    sleepAfter = "5m";
    constructor(ctx: unknown, env: unknown) { this.ctx = ctx; this.env = env; }
    async stop() {}
  },
}));

let RuntimeGoSessionDO: typeof import("./sessionDo").RuntimeGoSessionDO;

beforeAll(async () => { RuntimeGoSessionDO = (await import("./sessionDo")).RuntimeGoSessionDO; });

describe("session lifecycle accounting", () => {
  it("finalizes quota usage exactly once when the container stops", async () => {
    const values = new Map<string, unknown>();
    const storage = {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, value); },
    };
    const batches: unknown[][] = [];
    const statement = { bind() { return this; } };
    const env = { RUNTIME_QUOTAS: {
      prepare: () => statement,
      batch: async (items: unknown[]) => { batches.push(items); return []; },
    } } as unknown as Env;
    const session = new RuntimeGoSessionDO({ storage } as never, env);
    const configured = await session.fetch(new Request("http://do/__runtime/configure", {
      method: "PUT",
      body: JSON.stringify({ sessionId: "sid", userId: "user", createdAt: Date.now()-61_000, idleTimeoutSeconds: 45 }),
    }));
    expect(configured.status).toBe(204);
    expect(session.sleepAfter).toBe("45s");
    await session.onStop({ exitCode: 0, reason: "runtime_signal" });
    await session.onStop({ exitCode: 0, reason: "runtime_signal" });
    expect(batches).toHaveLength(1);
    expect(values.get("usageFinalized")).toBe(true);
  });
});
