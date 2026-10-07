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
