import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyRoute } from "./proxy";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubUpstream(headers: HeadersInit) {
  vi.stubGlobal(
    "fetch",
    vi.fn<() => Promise<Response>>(
      async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers }),
    ),
  );
}

function proxy(url: string) {
  return proxyRoute.request(`https://nexteditor.dev/?url=${encodeURIComponent(url)}`);
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
});
