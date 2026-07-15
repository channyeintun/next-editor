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
  it("renders html slide content", () => {
    const slides = [htmlSlide("a", "<h1>Hello</h1>")];
    const { container } = render(
      <CustomSlideRenderer slides={slides} currentSlideIndex={0} currentVerticalIndex={0} />,
    );
    expect(container.querySelector("h1")?.textContent).toBe("Hello");
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
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("h1")?.getAttribute("onclick")).toBeNull();
    expect(container.querySelector("a")?.getAttribute("href")).toBeNull();
  });

  it("sanitizes raw HTML embedded in markdown", () => {
    const slides = [markdownSlide("a", "# Title\n\n<img src=x onerror=alert(1)>")];
    const { container } = render(
      <CustomSlideRenderer slides={slides} currentSlideIndex={0} currentVerticalIndex={0} />,
    );
    expect(container.querySelector("img")?.getAttribute("onerror")).toBeNull();
  });

  it("renders markdown slide content as HTML", () => {
    const slides = [markdownSlide("a", "# Title\n\nBody text")];
    const { container } = render(
      <CustomSlideRenderer slides={slides} currentSlideIndex={0} currentVerticalIndex={0} />,
    );
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelector("p")?.textContent).toBe("Body text");
  });

  it("renders google-svg slide content", () => {
    const slides = [googleSlide("a")];
    const { container } = render(
      <CustomSlideRenderer slides={slides} currentSlideIndex={0} currentVerticalIndex={0} />,
    );
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("shows a placeholder when the current index has no slide", () => {
    const { container } = render(
      <CustomSlideRenderer slides={[]} currentSlideIndex={0} currentVerticalIndex={0} />,
    );
    expect(container.textContent).toContain("No slides to display");
  });

  it("updates the step in place without remounting the SVG", () => {
    const slides = [googleSlide("a")];
    const { container, rerender } = render(
      <CustomSlideRenderer slides={slides} currentSlideIndex={0} currentVerticalIndex={0} />,
    );
    const svgBefore = container.querySelector("svg");

    rerender(
      <CustomSlideRenderer slides={slides} currentSlideIndex={0} currentVerticalIndex={1} />,
    );
    const svgAfter = container.querySelector("svg");

    // Same slide, only the step advanced: the SVG element must not have
    // been torn down and recreated (that would reset the step animator).
    expect(svgAfter).toBe(svgBefore);
  });
});
