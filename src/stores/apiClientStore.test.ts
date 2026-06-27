import { describe, expect, it } from "vite-plus/test";
import {
  createApiClientStore,
  selectBody,
  selectHeaders,
  selectHistory,
  selectMethod,
  selectPath,
  selectResult,
  selectSending,
} from "./apiClientStore";

function ctx(store: ReturnType<typeof createApiClientStore>) {
  return store.getSnapshot().context;
}

describe("apiClientStore", () => {
  it("has sensible defaults", () => {
    const store = createApiClientStore();
    const c = ctx(store);

    expect(selectMethod(c)).toBe("GET");
    expect(selectPath(c)).toBe("/");
    expect(selectHeaders(c)).toEqual([]);
    expect(selectBody(c)).toBe("");
    expect(selectSending(c)).toBe(false);
    expect(selectResult(c)).toBeNull();
    expect(selectHistory(c)).toEqual([]);
  });

  it("setMethod updates method", () => {
    const store = createApiClientStore();
    store.trigger.setMethod({ method: "POST" });

    expect(selectMethod(ctx(store))).toBe("POST");
  });

  it("setPath updates path", () => {
    const store = createApiClientStore();
    store.trigger.setPath({ path: "/api/time" });

    expect(selectPath(ctx(store))).toBe("/api/time");
  });

  it("setBody updates body", () => {
    const store = createApiClientStore();
    store.trigger.setBody({ body: '{"key":"value"}' });

    expect(selectBody(ctx(store))).toBe('{"key":"value"}');
  });

  it("addHeader / updateHeader / removeHeader", () => {
    const store = createApiClientStore();
    store.trigger.addHeader();

    expect(selectHeaders(ctx(store))).toEqual([{ key: "", value: "", enabled: true }]);

    store.trigger.updateHeader({ index: 0, key: "Content-Type", value: "application/json" });

    expect(selectHeaders(ctx(store))[0]).toEqual({
      key: "Content-Type",
      value: "application/json",
      enabled: true,
    });

    store.trigger.removeHeader({ index: 0 });

    expect(selectHeaders(ctx(store))).toEqual([]);
  });

  it("markSending / receiveResult lifecycle", () => {
    const store = createApiClientStore();
    store.trigger.setPath({ path: "/api/time" });
    store.trigger.markSending();

    expect(selectSending(ctx(store))).toBe(true);
    expect(selectResult(ctx(store))).toBeNull();

    const result = {
      ok: true as const,
      response: {
        status: 200,
        statusText: "OK",
        headers: [["content-type", "text/html"]] as [string, string][],
        body: "<p>Hello</p>",
        durationMs: 42,
      },
    };

    store.trigger.receiveResult({ id: "req-1", result });

    expect(selectSending(ctx(store))).toBe(false);
    expect(selectResult(ctx(store))).toEqual(result);
    expect(selectHistory(ctx(store))).toHaveLength(1);
    expect(selectHistory(ctx(store))[0].method).toBe("GET");
    expect(selectHistory(ctx(store))[0].path).toBe("/api/time");
  });

  it("caps history at 25 entries", () => {
    const store = createApiClientStore();

    for (let i = 0; i < 30; i++) {
      store.trigger.receiveResult({
        id: `req-${i}`,
        result: {
          ok: true,
          response: {
            status: 200,
            statusText: "OK",
            headers: [],
            body: "",
            durationMs: 1,
          },
        },
      });
    }

    expect(selectHistory(ctx(store))).toHaveLength(25);
  });

  it("selectFromHistory restores method, path, and result", () => {
    const store = createApiClientStore();
    store.trigger.setMethod({ method: "POST" });
    store.trigger.setPath({ path: "/api/data" });

    const result = {
      ok: true as const,
      response: {
        status: 201,
        statusText: "Created",
        headers: [] as [string, string][],
        body: "{}",
        durationMs: 10,
      },
    };

    store.trigger.receiveResult({ id: "req-h", result });

    store.trigger.setMethod({ method: "GET" });
    store.trigger.setPath({ path: "/other" });

    const entry = selectHistory(ctx(store))[0];
    store.trigger.selectFromHistory({ entry });

    expect(selectMethod(ctx(store))).toBe("POST");
    expect(selectPath(ctx(store))).toBe("/api/data");
    expect(selectResult(ctx(store))).toEqual(result);
  });

  it("reset returns to initial state", () => {
    const store = createApiClientStore();
    store.trigger.setMethod({ method: "DELETE" });
    store.trigger.setPath({ path: "/api/item/1" });
    store.trigger.reset();

    expect(selectMethod(ctx(store))).toBe("GET");
    expect(selectPath(ctx(store))).toBe("/");
    expect(selectHistory(ctx(store))).toEqual([]);
  });
});
