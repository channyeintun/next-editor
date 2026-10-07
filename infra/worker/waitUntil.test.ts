import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { requestWaitUntil } from "./waitUntil";

function appReportingWaitUntil() {
  const app = new Hono();
  app.get("/", (c) => {
    const waitUntil = requestWaitUntil(c);
    waitUntil?.(Promise.resolve("work"));
    return c.json({ hasWaitUntil: waitUntil !== undefined });
  });
  return app;
}

describe("requestWaitUntil", () => {
  it("hands work to the request's ExecutionContext", async () => {
    const handed: Promise<unknown>[] = [];
    const executionContext = {
      waitUntil: (promise: Promise<unknown>) => handed.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    };

    const response = await appReportingWaitUntil().request(
      "https://nexteditor.dev/",
      undefined,
      {},
      executionContext as unknown as ExecutionContext,
    );

    expect(await response.json()).toEqual({ hasWaitUntil: true });
    expect(handed).toHaveLength(1);
    await expect(handed[0]).resolves.toBe("work");
  });

  // app.request() without one, as in this suite: Hono throws on
  // c.executionCtx, and callers fall back to awaiting the work.
  it("is undefined when the request has no ExecutionContext", async () => {
    const response = await appReportingWaitUntil().request("https://nexteditor.dev/");

    expect(await response.json()).toEqual({ hasWaitUntil: false });
  });
});
