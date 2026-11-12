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

describe("sanitizeSlideContent style sheets", () => {
  // The HTML parser moves a <style> that precedes all body content into <head>.
  it("keeps a style sheet the slide opens with, ahead of its content", () => {
    const sanitized = sanitizeSlideContent(
      `<style>.row { left: 8vw; }</style><div class="row">Event</div>`,
      "text/html",
    );

    expect(sanitized).toBe(`<style>.row { left: 8vw; }</style><div class="row">Event</div>`);
  });

  it("keeps the style sheets of a whole authored document, in order", () => {
    const sanitized = sanitizeSlideContent(
      `<!doctype html><html><head><title>t</title><style>.a{}</style><style>.b{}</style></head>` +
        `<body><style>.c{}</style><p class="a">x</p></body></html>`,
      "text/html",
    );

    expect(sanitized).toBe(
      `<style>.a{}</style><style>.b{}</style><style>.c{}</style><p class="a">x</p>`,
    );
  });

  it("takes @import rules out of a style sheet and keeps the rest of it", () => {
    for (const content of [
      `<style>@import url("https://example.com/a.css");.a{color:red}</style><p>x</p>`,
      `<p>x</p><style>@IMPORT "https://example.com/a.css" screen;.a{color:red}</style>`,
    ]) {
      const sanitized = sanitizeSlideContent(content, "text/html");
      expect(sanitized).not.toContain("example.com");
      expect(sanitized).toContain("<style>.a{color:red}</style>");
    }
  });

  it("still drops everything else the parser files under head", () => {
    const sanitized = sanitizeSlideContent(
      `<base href="https://example.com/"><link rel="stylesheet" href="https://example.com/a.css">` +
        `<meta http-equiv="refresh" content="0"><script>alert(1)</script>` +
        `<style nonce="n" onload="alert(1)">.a{}</style><p>x</p>`,
      "text/html",
    );

    expect(sanitized).toBe(`<style>.a{}</style><p>x</p>`);
  });
});
