import { describe, expect, it } from "vite-plus/test";
import { sanitizeSlideContent } from "./sanitizeSlideContent";

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

describe("sanitizeSlideContent inline images", () => {
  it("swaps a fetched image's href for its data: URL on image elements only", () => {
    const sanitized = sanitizeSlideContent(
      `<svg ${SVG_NS}><image xlink:href="/media/a"/><a xlink:href="/media/a"><rect/></a></svg>`,
      "image/svg+xml",
      new Map([["/media/a", PNG_DATA_URL]]),
    );

    expect(sanitized).toContain(`<image xlink:href="${PNG_DATA_URL}"`);
    expect(sanitized).toContain('<a xlink:href="/media/a"');
  });

  it("holds a swapped-in URL to the rule for authored data: URLs", () => {
    const sanitized = sanitizeSlideContent(
      `<svg ${SVG_NS}><image href="/media/a"/><image href="/media/b"/></svg>`,
      "image/svg+xml",
      new Map([
        ["/media/a", "data:text/html,<script>alert(1)</script>"],
        ["/media/b", "data:image/bmp;base64,Qk0="],
      ]),
    );

    expect(sanitized).toContain('<image href="/media/a"');
    expect(sanitized).toContain('<image href="/media/b"');
    expect(sanitized).not.toContain("data:");
  });

  it("does not bring back a URL the sanitizer removed", () => {
    const sanitized = sanitizeSlideContent(
      `<svg ${SVG_NS}><image href="javascript:alert(1)"/></svg>`,
      "image/svg+xml",
      new Map([["javascript:alert(1)", PNG_DATA_URL]]),
    );

    expect(sanitized).not.toContain("href=");
  });
});

describe("sanitizeSlideContent XLink attributes", () => {
  // SVG honors any prefix bound to the XLink namespace, so `x:href` is the
  // same link as `xlink:href` and has to face the same URL check.
  const CUSTOM_XLINK = 'xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xlink"';

  it("removes an unsafe href written under a custom XLink prefix", () => {
    const sanitized = sanitizeSlideContent(
      `<svg ${CUSTOM_XLINK}><a x:href="javascript:alert(1)"><rect/></a><a x:href="data:text/html,x"><rect/></a></svg>`,
      "image/svg+xml",
    );

    expect(sanitized).not.toContain("javascript:");
    expect(sanitized).not.toContain("data:");
    expect(sanitized).not.toContain("x:href=");
  });

  it("keeps a safe href under a custom XLink prefix and an inlined image href", () => {
    const sanitized = sanitizeSlideContent(
      `<svg ${CUSTOM_XLINK}><a x:href="https://example.com"><rect/></a><image x:href="/media/a"/></svg>`,
      "image/svg+xml",
      new Map([["/media/a", PNG_DATA_URL]]),
    );

    expect(sanitized).toContain('<a x:href="https://example.com"');
    expect(sanitized).toContain(`<image x:href="${PNG_DATA_URL}"`);
  });

  it("still checks plain href and xlink:href", () => {
    const sanitized = sanitizeSlideContent(
      `<svg ${SVG_NS}><a href="javascript:alert(1)"><rect/></a><a xlink:href="data:text/html,x"><rect/></a><a href="https://example.com"><rect/></a></svg>`,
      "image/svg+xml",
    );

    expect(sanitized).not.toContain("javascript:");
    expect(sanitized).not.toContain("data:");
    expect(sanitized).toContain('<a href="https://example.com"');
  });
});

describe("sanitizeSlideContent style attributes", () => {
  it.each([
    "width: expression(alert(1))",
    "@import 'x.css'",
    "-moz-binding: url(x.xml#y)",
    "behavior: url(x); binding : x",
    "background: url( ' javascript:alert(1))",
    "background: url('vbscript:x')",
    "background: URL(JavaScript:x)",
  ])("removes a style that can run code: %s", (style) => {
    const sanitized = sanitizeSlideContent(`<p style="${style}">x</p>`, "text/html");

    expect(sanitized).toBe("<p>x</p>");
  });

  it("keeps an ordinary style", () => {
    const sanitized = sanitizeSlideContent(
      '<p style="color: red; background: url(&quot;/a.png&quot;)">x</p>',
      "text/html",
    );

    expect(sanitized).toBe('<p style="color: red; background: url(&quot;/a.png&quot;)">x</p>');
  });

  // A lesson's slides arrive from its .ne unbounded, and this runs on the main
  // thread while the slide renders. A backtracking check on one long run of word
  // characters, or of spaces after "url(", grew with the square of its length.
  it.each([
    ["a run of word characters", "a".repeat(50_000)],
    ["spaces after url(", `url(${" ".repeat(50_000)}`],
    ["a quote and spaces after url(", `url(&quot;${" ".repeat(50_000)}`],
  ])("checks a long style in linear time: %s", (_label, style) => {
    for (const mimeType of ["text/html", "image/svg+xml"] as const) {
      const content =
        mimeType === "text/html"
          ? `<div style="${style}"></div>`
          : `<svg xmlns="http://www.w3.org/2000/svg"><rect style="${style}"/></svg>`;
      const started = performance.now();
      const sanitized = sanitizeSlideContent(content, mimeType);
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(sanitized).toContain("style=");
    }
  });
});
