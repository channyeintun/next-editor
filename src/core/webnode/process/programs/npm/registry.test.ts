// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isPmError } from "./errors";
import { createRegistryClient } from "./registry";
import type { FetchLike } from "./registry";

/** A 200 response whose body sends some bytes and then fails, as a dropped connection does. */
function droppedBody(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
        controller.error(new TypeError("network error"));
      },
    }),
    { status: 200 },
  );
}

/** A fetch that never answers until its signal aborts it. */
const stalled: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

describe("registry requests", () => {
  it("retries a body that fails mid-stream", async () => {
    let calls = 0;
    const fetch: FetchLike = async (url) => {
      calls++;
      if (calls % 2 === 1) {
        return droppedBody();
      }
      return url.endsWith(".tgz")
        ? new Response(new Uint8Array([1, 2, 3]))
        : new Response(JSON.stringify({ name: "x", version: "1.0.0", dist: { tarball: "t" } }));
    };
    const client = createRegistryClient({ fetch, registry: "https://r.test", retryDelayMs: 1 });
    const tarball = await client.tarball("https://r.test/x/-/x-1.0.0.tgz", { cache: false });
    expect(tarball.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls).toBe(2);
    expect((await client.packument("x")).name).toBe("x");
    expect(calls).toBe(4);
    expect((await client.version("x", "1.0.0"))?.version).toBe("1.0.0");
    expect(calls).toBe(6);
  });

  it("times a stalled request out and reports it after the retries", async () => {
    let calls = 0;
    const fetch: FetchLike = (url, init) => {
      calls++;
      return stalled(url, init);
    };
    const client = createRegistryClient({
      fetch,
      registry: "https://r.test",
      retryDelayMs: 1,
      packumentTimeoutMs: 20,
      tarballTimeoutMs: 20,
    });
    for (const pending of [client.packument("x"), client.tarball("https://r.test/x.tgz")]) {
      const error = await pending.catch((caught: unknown) => caught);
      expect(isPmError(error) && error.code).toBe("EFETCH");
      expect(String((error as Error).message)).toMatch(/timed out after 0\.02 s/);
    }
    expect(calls).toBe(6);
  });

  it("restarts the timeout while a body keeps arriving", async () => {
    // Four chunks 15 ms apart: 60 ms in all, longer than the 30 ms timeout,
    // but never 30 ms without progress.
    const fetch: FetchLike = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let i = 0; i < 4; i++) {
              await new Promise((resolve) => setTimeout(resolve, 15));
              controller.enqueue(new Uint8Array([i]));
            }
            controller.close();
          },
        }),
      );
    const client = createRegistryClient({
      fetch,
      registry: "https://r.test",
      retries: 0,
      tarballTimeoutMs: 30,
    });
    expect((await client.tarball("https://r.test/x.tgz")).bytes).toEqual(
      new Uint8Array([0, 1, 2, 3]),
    );
  });

  it("does not retry a body that is not JSON", async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      return new Response("<html>");
    };
    const client = createRegistryClient({ fetch, registry: "https://r.test", retryDelayMs: 1 });
    await expect(client.packument("x")).rejects.toMatchObject({ code: "EJSONPARSE" });
    expect(calls).toBe(1);
  });
});
