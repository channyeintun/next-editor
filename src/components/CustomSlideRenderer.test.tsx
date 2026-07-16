import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import CustomSlideRenderer from "./CustomSlideRenderer";
import type { Slide } from "../types/slides";

function htmlSlide(id: string, content: string): Slide {
  return { id, content, contentType: "html", order: 0 };
}

function markdownSlide(id: string, content: string): Slide {
  return { id, content, contentType: "markdown", order: 0 };
}

function googleSlide(id: string): Slide {
  return {
    id,
    content: '<svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg"><rect id="r1"/></svg>',
    contentType: "google-svg",
    order: 0,
    steps: [],
  };
}

describe("CustomSlideRenderer", () => {
  it("renders HTML slide content in a script-disabled iframe", () => {
    const slides = [htmlSlide("a", "<h1>Hello</h1>")];
    const { container } = render(
      <CustomSlideRenderer slides={slides} currentSlideIndex={0} currentVerticalIndex={0} />,
    );
    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("sandbox")).toBe("");
    expect(iframe?.srcdoc).toContain("<h1>Hello</h1>");
  });

  it("removes executable HTML from untrusted slide content", () => {
    const slides = [
      htmlSlide(
        "a",
        '<h1 onclick="window.__slideXss = true">Hello</h1><script>window.__slideXss = true</script><a href="javascript:alert(1)">bad</a>',
      ),
    ];
    const { container } = render(
      <CustomSlideRenderer slides={slides} currentSlideIndex={0} currentVerticalIndex={0} />,
    );
    const srcDoc = container.querySelector("iframe")?.srcdoc ?? "";
    expect(srcDoc).not.toContain("<script>");
    expect(srcDoc).not.toContain("onclick=");
    expect(srcDoc).not.toContain("javascript:");
  });

  it("sanitizes raw HTML embedded in markdown", () => {
    const slides = [markdownSlide("a", "# Title\n\n<img src=x onerror=alert(1)>")];
    const { container } = render(
      <CustomSlideRenderer slides={slides} currentSlideIndex={0} currentVerticalIndex={0} />,
    );
    const srcDoc = container.querySelector("iframe")?.srcdoc ?? "";
    expect(srcDoc).toContain("<h1>Title</h1>");
    expect(srcDoc).not.toContain("onerror=");
  });

  it("renders markdown slide content as HTML", () => {
    const slides = [markdownSlide("a", "# Title\n\nBody text")];
    const { container } = render(
      <CustomSlideRenderer slides={slides} currentSlideIndex={0} currentVerticalIndex={0} />,
    );
    const srcDoc = container.querySelector("iframe")?.srcdoc ?? "";
    expect(srcDoc).toContain("<h1>Title</h1>");
    expect(srcDoc).toContain("<p>Body text</p>");
  });

  it("renders google-svg slide content", () => {
    const slides = [googleSlide("a")];
    const { container } = render(
      <CustomSlideRenderer slides={slides} currentSlideIndex={0} currentVerticalIndex={0} />,
    );
    expect(container.querySelector("iframe")?.srcdoc).toContain("<svg");
  });

  it("shows a placeholder when the current index has no slide", () => {
    const { container } = render(
      <CustomSlideRenderer slides={[]} currentSlideIndex={0} currentVerticalIndex={0} />,
    );
    expect(container.textContent).toContain("No slides to display");
  });

  it("updates the step in place without remounting the isolated document", () => {
    const slides = [googleSlide("a")];
    const { container, rerender } = render(
      <CustomSlideRenderer slides={slides} currentSlideIndex={0} currentVerticalIndex={0} />,
    );
    const iframeBefore = container.querySelector("iframe");

    rerender(
      <CustomSlideRenderer slides={slides} currentSlideIndex={0} currentVerticalIndex={1} />,
    );
    const iframeAfter = container.querySelector("iframe");

    expect(iframeAfter).toBe(iframeBefore);
  });

  it("keeps slide CSS out of the host document", () => {
    const slides = [htmlSlide("a", "<style>body{display:none}</style><p>Slide</p>")];
    const { container } = render(
      <div data-testid="host-sentinel">
        Host
        <CustomSlideRenderer slides={slides} currentSlideIndex={0} currentVerticalIndex={0} />
      </div>,
    );

    expect(container.querySelector("style")).toBeNull();
    expect(container.querySelector('[data-testid="host-sentinel"]')).not.toBeNull();
    expect(container.querySelector("iframe")?.srcdoc).not.toContain("body{display:none}");
  });
});
