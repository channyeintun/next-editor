import { describe, expect, it } from "vite-plus/test";
import {
  API_CLIENT_REQUEST_MESSAGE_TYPE,
  API_CLIENT_RESPONSE_MESSAGE_TYPE,
  createApiClientProxyScript,
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

  it("embeds the request and response message types", () => {
    const script = createApiClientProxyScript(SETUP_MARKER);

    expect(script).toContain(JSON.stringify(API_CLIENT_REQUEST_MESSAGE_TYPE));
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
});
