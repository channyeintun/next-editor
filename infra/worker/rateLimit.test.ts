import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { checkRateLimit } from "./rateLimit";
import { countingRateLimiter, refusingRateLimiter } from "./testing/rateLimit";

const OPTIONS = { key: "user:user-1", label: "Test Playground" };

describe("checkRateLimit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is allowed when the binding admits the call, charged to the given key", async () => {
    const limiter = countingRateLimiter(1);

    expect(await checkRateLimit(limiter, OPTIONS)).toBe("allowed");
    expect(limiter.keys).toEqual(["user:user-1"]);
  });

  it("is limited when the binding refuses the call", async () => {
    expect(await checkRateLimit(refusingRateLimiter(), OPTIONS)).toBe("limited");
  });

  // Fails closed, so a configuration outage cannot turn a route into an
  // unlimited proxy in front of a third-party service.
  it("is unavailable when the binding is missing", async () => {
    expect(await checkRateLimit(undefined, OPTIONS)).toBe("unavailable");
  });

  it("is unavailable when the binding throws, without logging the key", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing: RateLimit = {
      async limit() {
        throw new Error("rate limiter unavailable");
      },
    };

    expect(await checkRateLimit(failing, { key: "ip:203.0.113.7", label: "Test Playground" })).toBe(
      "unavailable",
    );
    expect(consoleError).toHaveBeenCalledWith("Test Playground rate-limit check failed");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("203.0.113.7");
  });
});
