import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedImageHost, proxySlideImage } from "./imageProxy";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isAllowedImageHost", () => {
  it.each([
    ["docs.google.com", true],
    ["lh3.googleusercontent.com", true],
    ["googleusercontent.com", true],
    ["DOCS.GOOGLE.COM", true],
    ["googleusercontent.com.evil.com", false],
    ["evilgoogleusercontent.com", false],
    ["example.com", false],
    ["google.com", false],
  ])("%s -> %s", (host, expected) => {
    expect(isAllowedImageHost(host)).toBe(expected);
  });
});

describe("proxySlideImage", () => {
  it("rejects a missing url param", async () => {
    const result = await proxySlideImage(null);
    expect(result.status).toBe(400);
  });

  it("rejects an invalid url", async () => {
    const result = await proxySlideImage("not a url");
    expect(result.status).toBe(400);
  });

  it("rejects a non-https url", async () => {
    const result = await proxySlideImage("http://docs.google.com/slides-images-rt/x");
    expect(result.status).toBe(400);
  });

  it("rejects a disallowed host", async () => {
    const result = await proxySlideImage("https://evil.com/x.png");
    expect(result.status).toBe(400);
  });

  it("proxies an allowed host with an image content-type", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(
        async () =>
          ({
            ok: true,
            status: 200,
            url: "https://docs.google.com/slides-images-rt/x",
            headers: new Headers({ "content-type": "image/png" }),
            arrayBuffer: async () => bytes,
          }) as unknown as Response,
      ),
    );
    const result = await proxySlideImage("https://docs.google.com/slides-images-rt/x");
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
            url: "https://docs.google.com/slides-images-rt/x",
            headers: new Headers(),
          }) as unknown as Response,
      ),
    );
    const result = await proxySlideImage("https://docs.google.com/slides-images-rt/x");
    expect(result.status).toBe(502);
  });

  it("rejects a non-image content-type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(
        async () =>
          ({
            ok: true,
            status: 200,
            url: "https://docs.google.com/slides-images-rt/x",
            headers: new Headers({ "content-type": "text/html" }),
            arrayBuffer: async () => new ArrayBuffer(0),
          }) as unknown as Response,
      ),
    );
    const result = await proxySlideImage("https://docs.google.com/slides-images-rt/x");
    expect(result.status).toBe(400);
  });

  it("rejects when the final (redirected) response url is off-allowlist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(
        async () =>
          ({
            ok: true,
            status: 200,
            url: "https://evil.com/x.png",
            headers: new Headers({ "content-type": "image/png" }),
            arrayBuffer: async () => new ArrayBuffer(0),
          }) as unknown as Response,
      ),
    );
    const result = await proxySlideImage("https://docs.google.com/slides-images-rt/x");
    expect(result.status).toBe(400);
  });

  it("surfaces a 502 when the upstream fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(async () => {
        throw new Error("network down");
      }),
    );
    const result = await proxySlideImage("https://docs.google.com/slides-images-rt/x");
    expect(result.status).toBe(502);
  });
});
