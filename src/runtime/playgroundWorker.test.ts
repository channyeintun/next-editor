import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { explainWorkerStartFailure } from "./playgroundWorker";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("explainWorkerStartFailure", () => {
  it("calls the page outdated when the app's server answers", async () => {
    const fetchPage = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchPage);

    await expect(explainWorkerStartFailure()).resolves.toBe("outdated");

    // The front page, past the cache, and only its headers.
    const [url, init] = fetchPage.mock.calls[0];
    expect(url).toBe(`${window.location.origin}/`);
    expect(init).toMatchObject({ method: "HEAD", cache: "no-store" });
  });

  it("calls the server unreachable when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => Promise.reject(new TypeError("Failed to fetch"))),
    );

    await expect(explainWorkerStartFailure()).resolves.toBe("unreachable");
  });

  // A server that answers every request with an error is having an outage,
  // and a reload would not help: trying again later can.
  it("calls the server unreachable when it answers with an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })),
    );

    await expect(explainWorkerStartFailure()).resolves.toBe("unreachable");
  });

  it("stops waiting for a server that does not answer", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("", "AbortError")),
            );
          }),
      ),
    );

    const explained = explainWorkerStartFailure();
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(explained).resolves.toBe("unreachable");
  });
});
