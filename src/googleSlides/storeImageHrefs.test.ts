import { afterEach, describe, expect, it, vi } from "vitest";
import { storeImageHrefs } from "./storeImageHrefs";

afterEach(() => {
  vi.restoreAllMocks();
});

const IMG_A = "https://lh3.googleusercontent.com/a.png";
const IMG_B = "https://docs.google.com/slides-images-rt/b=s2048";

type StoredImage = { url: string; path?: string; error?: string };

/** Stubs fetch to answer /api/slide-images with per-URL results. */
function mockIngest(resolve: (url: string) => StoredImage) {
  const spy = vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>(
    async (_input, init) => {
      const { urls } = JSON.parse(String(init?.body)) as { urls: string[] };
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: urls.map(resolve) }),
      } as unknown as Response;
    },
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("storeImageHrefs", () => {
  it("makes no request and returns svgs unchanged when nothing is Google-hosted", async () => {
    const spy = vi.fn<() => Promise<Response>>();
    vi.stubGlobal("fetch", spy);

    const svgs = ['<image href="https://example.com/photo.jpg"/>', "<svg></svg>"];
    expect(await storeImageHrefs(svgs)).toEqual(svgs);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rewrites stored images to /media paths", async () => {
    mockIngest((url) => ({ url, path: `slide-images/hash-of-${url.length}` }));

    const [svg] = await storeImageHrefs([`<image xlink:href="${IMG_A}"/>`]);
    expect(svg).toBe(`<image xlink:href="/media/slide-images/hash-of-${IMG_A.length}"/>`);
  });

  it("dedupes a URL repeated across slides into one requested entry", async () => {
    const spy = mockIngest((url) => ({ url, path: "slide-images/x" }));

    const svgs = await storeImageHrefs([
      `<image href="${IMG_A}"/>`,
      `<image href="${IMG_A}"/><image href="${IMG_B}"/>`,
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    const { urls } = JSON.parse(String(spy.mock.calls[0][1]?.body)) as { urls: string[] };
    expect(urls).toEqual([IMG_A, IMG_B]);
    expect(svgs[0]).toContain("/media/slide-images/x");
    expect(svgs[1]).not.toContain(IMG_A);
  });

  it("falls back to the proxy href for a URL the route rejects", async () => {
    mockIngest((url) =>
      url === IMG_A ? { url, path: "slide-images/a" } : { url, error: "Unsupported content type." },
    );

    const [svg] = await storeImageHrefs([`<image href="${IMG_A}"/><image href="${IMG_B}"/>`]);
    expect(svg).toContain('href="/media/slide-images/a"');
    expect(svg).toContain(`href="/api/proxy?url=${encodeURIComponent(IMG_B)}"`);
  });

  it("falls back to proxy hrefs for everything when the route is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401 }) as unknown as Response),
    );

    const [svg] = await storeImageHrefs([`<image href="${IMG_A}"/>`]);
    expect(svg).toBe(`<image href="/api/proxy?url=${encodeURIComponent(IMG_A)}"/>`);
  });

  it("chunks more than 8 unique URLs into multiple requests", async () => {
    const spy = mockIngest((url) => ({ url, path: `slide-images/${new URL(url).pathname}` }));

    const urls = Array.from({ length: 9 }, (_, i) => `https://lh3.googleusercontent.com/i${i}`);
    const svgs = urls.map((url) => `<image href="${url}"/>`);
    const result = await storeImageHrefs(svgs);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.every((svg, i) => svg.includes(`/media/slide-images//i${i}`))).toBe(true);
  });
});
