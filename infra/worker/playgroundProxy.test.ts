import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { UserRow } from "../db/types";
import type { Env } from "./env";
import { checkPlaygroundRateLimit, playgroundRateLimitKey } from "./playgroundProxy";
import { countingRateLimiter, refusingRateLimiter } from "./testing/rateLimit";

const OPTIONS = { key: "user:user-1", label: "Test Playground" };

describe("checkPlaygroundRateLimit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is allowed when the binding admits the call, charged to the given key", async () => {
    const limiter = countingRateLimiter(1);

    expect(await checkPlaygroundRateLimit(limiter, OPTIONS)).toBe("allowed");
    expect(limiter.keys).toEqual(["user:user-1"]);
  });

  it("is limited when the binding refuses the call", async () => {
    expect(await checkPlaygroundRateLimit(refusingRateLimiter(), OPTIONS)).toBe("limited");
  });

  // Fails closed, so a configuration outage cannot turn a route into an
  // unlimited proxy in front of a third-party service.
  it("is unavailable when the binding is missing", async () => {
    expect(await checkPlaygroundRateLimit(undefined, OPTIONS)).toBe("unavailable");
  });

  it("is unavailable when the binding throws, without logging the key", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing: RateLimit = {
      async limit() {
        throw new Error("rate limiter unavailable");
      },
    };

    expect(
      await checkPlaygroundRateLimit(failing, { key: "ip:203.0.113.7", label: "Test Playground" }),
    ).toBe("unavailable");
    expect(consoleError).toHaveBeenCalledWith("Test Playground rate-limit check failed");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("203.0.113.7");
  });
});

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
