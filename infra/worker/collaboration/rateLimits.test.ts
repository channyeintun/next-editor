import type { Redis } from "@upstash/redis";
import { describe, expect, it } from "vitest";
import {
  CollaborationRateLimitError,
  enforceCollaborationConnectionRateLimit,
  enforceCollaborationUpdateRateLimit,
} from "./rateLimits";

class MemoryRedis {
  readonly values = new Map<string, number>();

  async incr(key: string) {
    const next = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, next);
    return next;
  }

  async expire() {
    return 1;
  }
}

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000001";

function redis(fake: MemoryRedis): Redis {
  return fake as unknown as Redis;
}

describe("collaboration rate limits", () => {
  it("allows normal batched updates and rejects a per-user burst", async () => {
    const fake = new MemoryRedis();
    for (let count = 0; count < 30; count += 1) {
      await enforceCollaborationUpdateRateLimit(redis(fake), ROOM_ID, USER_ID);
    }
    await expect(
      enforceCollaborationUpdateRateLimit(redis(fake), ROOM_ID, USER_ID),
    ).rejects.toEqual(expect.objectContaining<Partial<CollaborationRateLimitError>>({
      scope: "update",
    }));
  });

  it("caps repeated SSE connection attempts per user", async () => {
    const fake = new MemoryRedis();
    for (let count = 0; count < 30; count += 1) {
      await enforceCollaborationConnectionRateLimit(redis(fake), USER_ID);
    }
    await expect(
      enforceCollaborationConnectionRateLimit(redis(fake), USER_ID),
    ).rejects.toEqual(expect.objectContaining<Partial<CollaborationRateLimitError>>({
      scope: "connection",
    }));
  });
});
