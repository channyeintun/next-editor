import { describe, expect, it } from "vite-plus/test";
import {
  API_CLIENT_CANCEL_MESSAGE_TYPE,
  API_CLIENT_REQUEST_MESSAGE_TYPE,
  API_CLIENT_RESPONSE_MESSAGE_TYPE,
  MAX_API_CLIENT_RESPONSE_BYTES,
  createApiClientProxyScript,
  normalizeApiClientResultPayload,
} from "./apiClientBridge";

const SETUP_MARKER = "__TEST_API_CLIENT_PROXY__";

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
});
