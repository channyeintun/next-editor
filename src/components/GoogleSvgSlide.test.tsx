import { render } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import GoogleSvgSlide from "./GoogleSvgSlide";
import type { DeckStep } from "../googleSlides/types";

const minimalSvg =
  '<svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg"><rect id="r1" width="10" height="10"/></svg>';

describe("GoogleSvgSlide", () => {
  it("renders SVG in normal flow without absolute positioning, and applies correct SVG styles", () => {
    const { container } = render(<GoogleSvgSlide content={minimalSvg} stepsRevealed={0} />);

    const rootDiv = container.firstChild as HTMLElement;
    expect(rootDiv).toBeInstanceOf(HTMLDivElement);

    // Assert no absolute positioning or inset-0 classes
    expect(rootDiv.className).not.toContain("absolute");
    expect(rootDiv.className).not.toContain("inset-0");
    expect(rootDiv.style.position).not.toBe("absolute");

    // Find the injected SVG
    const svg = rootDiv.querySelector("svg");
    expect(svg).toBeInstanceOf(SVGSVGElement);

    if (!svg) {
      throw new Error("SVG element not found");
    }

    // Assert width is 100% and height is not 100%
    expect(svg.style.width).toBe("100%");
    expect(svg.style.height).not.toBe("100%");
    expect(svg.style.height).toBe("");

    // Assert width and height attributes are removed
    expect(svg.getAttribute("width")).toBeNull();
    expect(svg.getAttribute("height")).toBeNull();

    // Assert preserveAspectRatio is set
    expect(svg.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
  });

  it("renders with steps and stepsRevealed without crashing", () => {
    const steps: DeckStep[] = [
      [
        {
          elementId: "r1",
          durationMs: 300,
          delayMs: 0,
          tracks: [
            {
              kind: "opacity",
              from: 0,
              to: 1,
            },
          ],
        },
      ],
    ];

    const { container } = render(
      <GoogleSvgSlide content={minimalSvg} steps={steps} stepsRevealed={1} />,
    );

    const rootDiv = container.firstChild as HTMLElement;
    expect(rootDiv).toBeInstanceOf(HTMLDivElement);

    const svg = rootDiv.querySelector("svg");
    expect(svg).toBeInstanceOf(SVGSVGElement);
  });

  it("removes active SVG content while retaining drawable elements", () => {
    const { container } = render(
      <GoogleSvgSlide
        content={'<svg viewBox="0 0 10 10"><script>alert(1)</script><rect id="r1" onclick="alert(1)"/><foreignObject><div>bad</div></foreignObject></svg>'}
        stepsRevealed={0}
      />,
    );
    expect(container.querySelector("rect#r1")).not.toBeNull();
    expect(container.querySelector("rect#r1")?.getAttribute("onclick")).toBeNull();
    expect(container.querySelector("script, foreignObject")).toBeNull();
  });
});
