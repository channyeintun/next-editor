import { describe, expect, it } from "vite-plus/test";
import {
  API_CLIENT_CANCEL_MESSAGE_TYPE,
  API_CLIENT_REQUEST_MESSAGE_TYPE,
  API_CLIENT_RESPONSE_MESSAGE_TYPE,
  MAX_API_CLIENT_RETAINED_BODY_BYTES,
  MAX_API_CLIENT_RESPONSE_BYTES,
  createApiClientProxyScript,
  normalizeApiClientResultPayload,
  truncateUtf8,
} from "./apiClientBridge";

const SETUP_MARKER = "__TEST_API_CLIENT_PROXY__";

interface InstalledProxy {
  dispatch: (data: unknown) => void;
  parentPostMessage: ReturnType<typeof vi.fn>;
}

function installProxy(fetchImplementation: typeof fetch): InstalledProxy {
  let messageHandler: ((event: { source: object; data: unknown }) => void) | null = null;
  const parentPostMessage = vi.fn();
  const parent = { postMessage: parentPostMessage };
  const frameWindow = {
    parent,
    addEventListener: (
      type: string,
      handler: (event: { source: object; data: unknown }) => void,
    ) => {
      if (type === "message") messageHandler = handler;
    },
  };
  const script = createApiClientProxyScript(SETUP_MARKER);
  const execute = new Function(
    "window",
    "fetch",
    "performance",
    "AbortController",
    "TextDecoder",
    script,
  );
  execute(frameWindow, fetchImplementation, performance, AbortController, TextDecoder);

  return {
    dispatch: (data) => {
      if (!messageHandler) throw new Error("Expected proxy message listener");
      messageHandler({ source: parent, data });
    },
    parentPostMessage,
  };
}

function responseWithReader(
  reader: {
    read: () => Promise<{ done: boolean; value?: Uint8Array }>;
    cancel: (reason?: unknown) => Promise<void>;
    releaseLock: () => void;
  },
  contentLength: string | null = null,
): Response {
  return {
    status: 200,
    statusText: "OK",
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-length" ? contentLength : null),
      entries: () => [["content-type", "text/plain"]][Symbol.iterator](),
    },
    body: { getReader: () => reader },
  } as unknown as Response;
}

describe("createApiClientProxyScript", () => {
  it("returns a non-empty string", () => {
    const script = createApiClientProxyScript(SETUP_MARKER);

    expect(typeof script).toBe("string");
    expect(script.length).toBeGreaterThan(0);
  });

  it("embeds the setup marker", () => {
    const script = createApiClientProxyScript(SETUP_MARKER);

    expect(script).toContain(JSON.stringify(SETUP_MARKER));
  });

  it("embeds the request, cancellation, and response message types", () => {
    const script = createApiClientProxyScript(SETUP_MARKER);

    expect(script).toContain(JSON.stringify(API_CLIENT_REQUEST_MESSAGE_TYPE));
    expect(script).toContain(JSON.stringify(API_CLIENT_CANCEL_MESSAGE_TYPE));
    expect(script).toContain(JSON.stringify(API_CLIENT_RESPONSE_MESSAGE_TYPE));
  });

  it("is guarded by the marker so re-execution is a no-op", () => {
    const script = createApiClientProxyScript(SETUP_MARKER);

    expect(script).toContain(`if(window[marker])return`);
  });

  it("wraps everything in an IIFE", () => {
    const script = createApiClientProxyScript(SETUP_MARKER);

    expect(script).toMatch(/^\(function\(\)\{/);
    expect(script).toMatch(/\}\)\(\);$/);
  });

  it("bounds streamed response reads and cancels oversized bodies", () => {
    const script = createApiClientProxyScript(SETUP_MARKER);

    expect(script).toContain(`var maxBytes=${MAX_API_CLIENT_RESPONSE_BYTES}`);
    expect(script).toContain('response.headers.get("content-length")');
    expect(script).toContain("response.body.getReader()");
    expect(script).toContain('reader.cancel("response limit reached")');
    expect(script).not.toContain("response.text()");
  });

  it("accepts requests only from the parent and aborts by request id", () => {
    const script = createApiClientProxyScript(SETUP_MARKER);

    expect(script).toContain("e.source!==window.parent");
    expect(script).toContain("new AbortController()");
    expect(script).toContain("controllers.get(payload.id)");
    expect(script).toContain("active.abort()");
  });

  it("rejects an oversized declared body before reading it", async () => {
    const reader = {
      read: vi.fn(async () => ({ done: true })),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    };
    const proxy = installProxy(
      vi.fn<typeof fetch>(async () =>
        responseWithReader(reader, String(MAX_API_CLIENT_RESPONSE_BYTES + 1)),
      ),
    );

    proxy.dispatch({
      type: API_CLIENT_REQUEST_MESSAGE_TYPE,
      payload: { id: "declared", method: "GET", path: "/large", headers: {} },
    });

    await vi.waitFor(() => expect(proxy.parentPostMessage).toHaveBeenCalledTimes(1));
    expect(reader.read).not.toHaveBeenCalled();
    expect(reader.cancel).toHaveBeenCalledWith("declared response exceeds limit");
    expect(proxy.parentPostMessage.mock.calls[0]?.[0].payload).toMatchObject({
      id: "declared",
      ok: true,
      body: "",
      truncated: true,
    });
  });

  it("caps a chunked body and cancels the remaining stream", async () => {
    const oversizedChunk = new Uint8Array(MAX_API_CLIENT_RESPONSE_BYTES + 32).fill(97);
    const reader = {
      read: vi
        .fn<() => Promise<{ done: boolean; value?: Uint8Array }>>()
        .mockResolvedValueOnce({ done: false, value: oversizedChunk })
        .mockResolvedValue({ done: true }),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    };
    const proxy = installProxy(vi.fn<typeof fetch>(async () => responseWithReader(reader)));

    proxy.dispatch({
      type: API_CLIENT_REQUEST_MESSAGE_TYPE,
      payload: { id: "chunked", method: "GET", path: "/stream", headers: {} },
    });

    await vi.waitFor(() => expect(proxy.parentPostMessage).toHaveBeenCalledTimes(1));
    const payload = proxy.parentPostMessage.mock.calls[0]?.[0].payload;
    expect(payload.body).toHaveLength(MAX_API_CLIENT_RESPONSE_BYTES);
    expect(payload.truncated).toBe(true);
    expect(reader.cancel).toHaveBeenCalledWith("response limit reached");
  });

  it("aborts an endless request by id without posting a late result", async () => {
    let signal: AbortSignal | null = null;
    const fetchImplementation = vi.fn<typeof fetch>((_input, init) => {
      signal = init?.signal ?? null;
      return new Promise<Response>(() => {});
    });
    const proxy = installProxy(fetchImplementation);

    proxy.dispatch({
      type: API_CLIENT_REQUEST_MESSAGE_TYPE,
      payload: { id: "endless", method: "GET", path: "/endless", headers: {} },
    });
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(1));
    proxy.dispatch({
      type: API_CLIENT_CANCEL_MESSAGE_TYPE,
      payload: { id: "endless" },
    });

    expect(signal?.aborted).toBe(true);
    expect(proxy.parentPostMessage).not.toHaveBeenCalled();
  });
});

describe("normalizeApiClientResultPayload", () => {
  it("rejects malformed messages and independently caps forged preview bodies", () => {
    expect(normalizeApiClientResultPayload({ id: "bad", ok: true })).toBeNull();

    const normalized = normalizeApiClientResultPayload({
      id: "forged",
      ok: true,
      status: 200,
      statusText: "OK",
      headers: [["content-type", "text/plain"]],
      body: "x".repeat(MAX_API_CLIENT_RESPONSE_BYTES + 100),
      durationMs: 5,
    });

    expect(normalized?.ok).toBe(true);
    if (!normalized?.ok) throw new Error("Expected normalized response");
    expect(normalized.body).toHaveLength(MAX_API_CLIENT_RESPONSE_BYTES);
    expect(normalized.truncated).toBe(true);
  });

  it("enforces the response limit in UTF-8 bytes", () => {
    const body = "🙂".repeat(Math.ceil(MAX_API_CLIENT_RESPONSE_BYTES / 4) + 10);
    const normalized = normalizeApiClientResultPayload({
      id: "unicode",
      ok: true,
      status: 200,
      statusText: "OK",
      headers: [],
      body,
      durationMs: 5,
    });

    if (!normalized?.ok) throw new Error("Expected normalized response");
    expect(new TextEncoder().encode(normalized.body).byteLength).toBe(
      MAX_API_CLIENT_RESPONSE_BYTES,
    );
    expect(normalized.truncated).toBe(true);
  });

  it("does not split surrogate pairs at the durable retention boundary", () => {
    const body = `${"a".repeat(MAX_API_CLIENT_RETAINED_BODY_BYTES - 2)}🙂tail`;
    const truncated = truncateUtf8(body, MAX_API_CLIENT_RETAINED_BODY_BYTES);

    expect(truncated.value.endsWith("🙂")).toBe(false);
    expect(new TextEncoder().encode(truncated.value).byteLength).toBeLessThanOrEqual(
      MAX_API_CLIENT_RETAINED_BODY_BYTES,
    );
    expect(truncated.truncated).toBe(true);
  });
});
