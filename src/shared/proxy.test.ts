import { afterEach, describe, expect, it, vi } from "vitest";
import { isPubliclyRoutableHost, proxyUrl, readProxyBody } from "./proxy";

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
    ["100.64.0.1", false],
    ["192.0.0.1", false],
    ["198.18.0.1", false],
    ["999.1.1.1", false],
    ["8.8.8.8", true],
    ["::1", false],
    ["fe80::1", false],
    ["fd00::1", false],
    ["ff00::1", false],
    // IPv4-mapped IPv6. The URL parser re-serializes these in hex, so the
    // textual prefix checks never saw them and the dotted-quad guard was
    // skipped because the string contains ":".
    ["::ffff:127.0.0.1", false],
    ["::ffff:7f00:1", false], // 127.0.0.1, as `new URL()` normalizes it
    ["::ffff:a9fe:a9fe", false], // 169.254.169.254 (cloud metadata)
    ["::ffff:a00:5", false], // 10.0.0.5
    ["::ffff:c0a8:1", false], // 192.168.0.1
    ["[::ffff:7f00:1]", false], // bracketed, as URL.hostname reports it
    ["::ffff:808:808", true], // 8.8.8.8 stays reachable
    // fe80::/10 is fe80–febf, not only the literal "fe80:" text.
    ["fea0::1", false],
    ["febf::1", false],
    ["2001:4860:4860::8888", true],
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
    const bytes = new Uint8Array([1, 2, 3]);
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(
        async () =>
          ({
            ok: true,
            status: 200,
            url: "https://example.com/x.png",
            headers: new Headers({ "content-type": "image/png" }),
            body: new ReadableStream({
              start: (controller) => {
                controller.enqueue(bytes);
                controller.close();
              },
            }),
          }) as unknown as Response,
      ),
    );
    const result = await proxyUrl("https://example.com/x.png");
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("image/png");
    expect(await readProxyBody(result.body!, 100)).toEqual(bytes);
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

  it("validates a redirect target before issuing the next request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(
        async () =>
          ({
            ok: false,
            status: 302,
            url: "https://example.com/x.png",
            headers: new Headers({ location: "https://169.254.169.254/latest/meta-data" }),
          }) as unknown as Response,
      ),
    );
    const result = await proxyUrl("https://example.com/x.png");
    expect(result.status).toBe(400);
  });

  it("follows an allowed redirect manually", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: new Headers({ location: "/image.png" }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "image/png" }),
        body: new ReadableStream({ start: (controller) => controller.close() }),
      } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await proxyUrl("https://example.com/start");
    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://example.com/start",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://example.com/image.png",
      expect.objectContaining({ redirect: "manual" }),
    );
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
