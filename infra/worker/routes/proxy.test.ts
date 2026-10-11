import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Env } from "../env";
import { countingRateLimiter, refusingRateLimiter } from "../testing/rateLimit";
import { proxyRoute } from "./proxy";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubUpstream(headers: HeadersInit) {
  const fetchSpy = vi.fn<() => Promise<Response>>(
    async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers }),
  );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { PROXY_RATE_LIMITER: countingRateLimiter(Infinity), ...overrides } as Env;
}

function proxy(url: string, env = makeEnv(), headers: Record<string, string> = {}) {
  return proxyRoute.request(
    `https://nexteditor.dev/?url=${encodeURIComponent(url)}`,
    { headers },
    env,
  );
}

describe("proxyRoute", () => {
  it("relays the upstream's content type", async () => {
    stubUpstream({ "content-type": "image/png" });

    const response = await proxy("https://example.com/avatar.png");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  // Upstreams that send no Content-Type must still reach the browser as an
  // inert octet stream, not with an empty type.
  it("labels an untyped upstream body application/octet-stream", async () => {
    stubUpstream({});

    const response = await proxy("https://example.com/recording.ne");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
  });

  // Anonymous callers must not get an unthrottled open relay.
  it("charges a signed-out caller to their address", async () => {
    stubUpstream({ "content-type": "image/png" });
    const limiter = countingRateLimiter(Infinity);

    await proxy("https://example.com/avatar.png", makeEnv({ PROXY_RATE_LIMITER: limiter }), {
      "CF-Connecting-IP": "203.0.113.7",
    });

    expect(limiter.keys).toEqual(["ip:203.0.113.7"]);
  });

  it("refuses a caller over its budget without fetching", async () => {
    const fetchSpy = stubUpstream({ "content-type": "image/png" });

    const response = await proxy(
      "https://example.com/avatar.png",
      makeEnv({ PROXY_RATE_LIMITER: refusingRateLimiter() }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toEqual({ error: "rate limit exceeded; retry in a minute" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed without fetching when the limiter binding is missing", async () => {
    const fetchSpy = stubUpstream({ "content-type": "image/png" });

    const response = await proxy(
      "https://example.com/avatar.png",
      makeEnv({ PROXY_RATE_LIMITER: undefined }),
    );

    expect(response.status).toBe(502);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
