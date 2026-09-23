import { afterEach, describe, expect, it, vi } from "vitest";
import { checkPlaygroundRateLimit } from "./playgroundProxy";
import { countingRateLimiter, refusingRateLimiter } from "./testing/rateLimit";

const OPTIONS = { userId: "user-1", label: "Test Playground" };

describe("checkPlaygroundRateLimit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is allowed when the binding admits the call, keyed by the user id", async () => {
    const limiter = countingRateLimiter(1);

    expect(await checkPlaygroundRateLimit(limiter, OPTIONS)).toBe("allowed");
    expect(limiter.keys).toEqual(["user-1"]);
  });

  it("is limited when the binding refuses the call", async () => {
    expect(await checkPlaygroundRateLimit(refusingRateLimiter(), OPTIONS)).toBe("limited");
  });

  // Fails closed, so a configuration outage cannot turn a route into an
  // unlimited proxy in front of a third-party service.
  it("is unavailable when the binding is missing", async () => {
    expect(await checkPlaygroundRateLimit(undefined, OPTIONS)).toBe("unavailable");
  });

  it("is unavailable when the binding throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing: RateLimit = {
      async limit() {
        throw new Error("rate limiter unavailable");
      },
    };

    expect(await checkPlaygroundRateLimit(failing, OPTIONS)).toBe("unavailable");
    expect(consoleError).toHaveBeenCalledWith("Test Playground rate-limit check failed");
  });
});
