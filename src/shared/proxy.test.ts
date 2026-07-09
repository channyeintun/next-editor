import { afterEach, describe, expect, it, vi } from "vitest";
import { isPubliclyRoutableHost, proxyUrl } from "./proxy";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isPubliclyRoutableHost", () => {
  it.each([
    ["docs.google.com", true],
    ["example.com", true],
    ["localhost", false],
    ["my-box.local", false],
    ["127.0.0.1", false],
    ["10.0.0.5", false],
    ["172.16.0.1", false],
    ["172.31.255.255", false],
    ["172.32.0.1", true],
    ["192.168.1.1", false],
    ["169.254.169.254", false],
    ["8.8.8.8", true],
    ["::1", false],
    ["fe80::1", false],
    ["fd00::1", false],
  ])("%s -> %s", (host, expected) => {
    expect(isPubliclyRoutableHost(host)).toBe(expected);
  });
});

describe("proxyUrl", () => {
  it("rejects a missing url param", async () => {
    const result = await proxyUrl(null);
    expect(result.status).toBe(400);
  });

  it("rejects an invalid url", async () => {
    const result = await proxyUrl("not a url");
    expect(result.status).toBe(400);
  });

  it("rejects a non-https url", async () => {
    const result = await proxyUrl("http://example.com/x.png");
    expect(result.status).toBe(400);
  });

  it("rejects a private/loopback host", async () => {
    const result = await proxyUrl("https://127.0.0.1/x");
    expect(result.status).toBe(400);
  });

  it("proxies an allowed host, passing through the upstream content-type", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(
        async () =>
          ({
            ok: true,
            status: 200,
            url: "https://example.com/x.png",
            headers: new Headers({ "content-type": "image/png" }),
            arrayBuffer: async () => bytes,
          }) as unknown as Response,
      ),
    );
    const result = await proxyUrl("https://example.com/x.png");
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("image/png");
    expect(result.body).toBe(bytes);
  });

  it("rejects a non-2xx upstream response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(
        async () =>
          ({
            ok: false,
            status: 404,
            url: "https://example.com/x.png",
            headers: new Headers(),
          }) as unknown as Response,
      ),
    );
    const result = await proxyUrl("https://example.com/x.png");
    expect(result.status).toBe(502);
  });

  it("rejects when the final (redirected) response url lands in private network space", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(
        async () =>
          ({
            ok: true,
            status: 200,
            url: "https://169.254.169.254/latest/meta-data",
            headers: new Headers({ "content-type": "text/plain" }),
            arrayBuffer: async () => new ArrayBuffer(0),
          }) as unknown as Response,
      ),
    );
    const result = await proxyUrl("https://example.com/x.png");
    expect(result.status).toBe(400);
  });

  it("surfaces a 502 when the upstream fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(async () => {
        throw new Error("network down");
      }),
    );
    const result = await proxyUrl("https://example.com/x.png");
    expect(result.status).toBe(502);
  });
});
