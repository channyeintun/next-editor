import { afterEach, describe, expect, it, vi } from "vitest";
import { inlineProxiedImages } from "./inlineImages";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchOk(bytes: number[], contentType = "image/png") {
  vi.stubGlobal(
    "fetch",
    vi.fn<() => Promise<Response>>(async () => {
      const blob = new Blob([new Uint8Array(bytes)], { type: contentType });
      return { ok: true, status: 200, blob: async () => blob } as unknown as Response;
    }),
  );
}

describe("inlineProxiedImages", () => {
  it("replaces a Google-hosted image href with a data URL from the proxy", async () => {
    mockFetchOk([1, 2, 3]);
    const svg =
      '<svg><image xlink:href="https://docs.google.com/slides-images-rt/AOd6-abc=s2048" /></svg>';

    const result = await inlineProxiedImages(svg);

    expect(result).toContain('xlink:href="data:image/png;base64,');
    expect(result).not.toContain("docs.google.com/slides-images-rt");
  });

  it("replaces a googleusercontent.com-hosted image href", async () => {
    mockFetchOk([1, 2, 3]);
    const svg = '<svg><image href="https://lh3.googleusercontent.com/photo.jpg" /></svg>';

    const result = await inlineProxiedImages(svg);

    expect(result).toContain('href="data:image/png;base64,');
  });

  it("leaves data: URIs untouched", async () => {
    const fetchSpy = vi.fn<() => Promise<Response>>();
    vi.stubGlobal("fetch", fetchSpy);
    const svg = '<svg><image href="data:image/png;base64,AAAA" /></svg>';

    const result = await inlineProxiedImages(svg);

    expect(result).toBe(svg);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaves an unrelated external host untouched", async () => {
    const fetchSpy = vi.fn<() => Promise<Response>>();
    vi.stubGlobal("fetch", fetchSpy);
    const svg = '<svg><image href="https://example.com/photo.jpg" /></svg>';

    const result = await inlineProxiedImages(svg);

    expect(result).toBe(svg);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaves the href unchanged when the fetch fails, without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(
        async () => ({ ok: false, status: 404 }) as unknown as Response,
      ),
    );
    const svg = '<svg><image href="https://docs.google.com/slides-images-rt/broken=s2048" /></svg>';

    const result = await inlineProxiedImages(svg);

    expect(result).toBe(svg);
  });

  it("inlines multiple distinct images while tolerating one failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<(input: string) => Promise<Response>>(async (input: string) => {
        if (input.includes("broken")) {
          return { ok: false, status: 404 } as unknown as Response;
        }
        const blob = new Blob([new Uint8Array(3).fill(9)], { type: "image/jpeg" });
        return { ok: true, status: 200, blob: async () => blob } as unknown as Response;
      }),
    );
    const svg =
      "<svg>" +
      '<image href="https://docs.google.com/slides-images-rt/good1=s2048" />' +
      '<image href="https://docs.google.com/slides-images-rt/broken=s2048" />' +
      '<image href="https://docs.google.com/slides-images-rt/good2=s2048" />' +
      "</svg>";

    const result = await inlineProxiedImages(svg);

    expect(result).toContain("broken=s2048");
    expect((result.match(/data:image\/jpeg;base64,/g) ?? []).length).toBe(2);
  });

  it("dedupes identical hrefs into a single fetch", async () => {
    const fetchSpy = vi.fn<() => Promise<Response>>(async () => {
      const blob = new Blob([new Uint8Array(1)], { type: "image/png" });
      return { ok: true, status: 200, blob: async () => blob } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchSpy);
    const url = "https://docs.google.com/slides-images-rt/same=s2048";
    const svg = `<svg><image href="${url}" /><image xlink:href="${url}" /></svg>`;

    await inlineProxiedImages(svg);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
