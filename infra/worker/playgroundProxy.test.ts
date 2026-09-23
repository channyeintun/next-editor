import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkPlaygroundRateLimit } from "./playgroundProxy";

const OPTIONS = { userId: "user-1", keyPrefix: "zp:rl", limit: 4, label: "Test Playground" };

/**
 * KV stand-in that enforces Workers KV's one-write-per-key-per-second limit the
 * way production does: the second write inside a second throws
 * "KV PUT failed: 429 Too Many Requests" (the local fakes elsewhere never do).
 */
function createKvWithWriteLimit() {
  const store = new Map<string, string>();
  const lastWriteAt = new Map<string, number>();
  const kv = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      const previous = lastWriteAt.get(key);
      if (previous !== undefined && Date.now() - previous < 1000) {
        throw new Error("KV PUT failed: 429 Too Many Requests");
      }
      lastWriteAt.set(key, Date.now());
      store.set(key, value);
    },
  };
  return kv as unknown as KVNamespace;
}

function advance(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}

describe("checkPlaygroundRateLimit", () => {
  // Pinned to the start of a minute so every call below lands in one window.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("charges calls a second apart until the window is spent", async () => {
    const kv = createKvWithWriteLimit();
    const decisions = [];
    for (let call = 0; call < 5; call++) {
      decisions.push(await checkPlaygroundRateLimit(kv, OPTIONS));
      advance(1000);
    }
    expect(decisions).toEqual(["allowed", "allowed", "allowed", "allowed", "limited"]);
  });

  // A learner pressing Format and then Run inside one second is calling too
  // fast, not facing a policy outage: the store just answered the read.
  it("refuses a second call inside a second as limited, not unavailable", async () => {
    const kv = createKvWithWriteLimit();

    expect(await checkPlaygroundRateLimit(kv, OPTIONS)).toBe("allowed");
    advance(200);
    expect(await checkPlaygroundRateLimit(kv, OPTIONS)).toBe("limited");
  });

  it("fails closed when the store itself fails", async () => {
    const failingGet = {
      async get() {
        throw new Error("KV GET failed: 500 Internal Server Error");
      },
    } as unknown as KVNamespace;
    expect(await checkPlaygroundRateLimit(failingGet, OPTIONS)).toBe("unavailable");

    const failingPut = {
      async get() {
        return null;
      },
      async put() {
        throw new Error("KV PUT failed: 500 Internal Server Error");
      },
    } as unknown as KVNamespace;
    expect(await checkPlaygroundRateLimit(failingPut, OPTIONS)).toBe("unavailable");
    expect(await checkPlaygroundRateLimit(null, OPTIONS)).toBe("unavailable");
  });
});
