import { describe, expect, it } from "vitest";
import { proxyImageHrefs } from "./proxyImageHrefs";

describe("proxyImageHrefs", () => {
  it("rewrites a docs.google.com image href to the proxy route", () => {
    const svg =
      '<svg><image xlink:href="https://docs.google.com/slides-images-rt/AOd6-abc=s2048" /></svg>';

    const result = proxyImageHrefs(svg);

    expect(result).toBe(
      '<svg><image xlink:href="/api/slide-image?url=' +
        encodeURIComponent("https://docs.google.com/slides-images-rt/AOd6-abc=s2048") +
        '" /></svg>',
    );
  });

  it("rewrites a googleusercontent.com-hosted image href", () => {
    const svg = '<svg><image href="https://lh3.googleusercontent.com/photo.jpg" /></svg>';

    const result = proxyImageHrefs(svg);

    expect(result).toContain('href="/api/slide-image?url=');
    expect(result).toContain(encodeURIComponent("https://lh3.googleusercontent.com/photo.jpg"));
  });

  it("leaves data: URIs untouched", () => {
    const svg = '<image href="data:image/png;base64,AAAA"/>';
    expect(proxyImageHrefs(svg)).toBe(svg);
  });

  it("leaves an unrelated external host untouched", () => {
    const svg = '<image href="https://example.com/photo.jpg"/>';
    expect(proxyImageHrefs(svg)).toBe(svg);
  });

  it("rewrites multiple distinct images independently", () => {
    const svg =
      "<svg>" +
      '<image href="https://docs.google.com/slides-images-rt/a=s2048" />' +
      '<image href="https://example.com/untouched.png" />' +
      '<image href="https://lh3.googleusercontent.com/b.jpg" />' +
      "</svg>";

    const result = proxyImageHrefs(svg);

    expect(result).toContain(
      encodeURIComponent("https://docs.google.com/slides-images-rt/a=s2048"),
    );
    expect(result).toContain('href="https://example.com/untouched.png"');
    expect(result).toContain(encodeURIComponent("https://lh3.googleusercontent.com/b.jpg"));
  });
});
