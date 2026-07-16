import { render } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import GoogleSvgSlide from "./GoogleSvgSlide";
import type { DeckStep } from "../googleSlides/types";

const minimalSvg =
  '<svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg"><rect id="r1" width="10" height="10"/></svg>';

describe("GoogleSvgSlide", () => {
  it("renders SVG in a script-disabled isolated document", () => {
    const { container } = render(<GoogleSvgSlide content={minimalSvg} stepsRevealed={0} />);

    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(iframe?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe?.srcdoc).toContain(minimalSvg);
    expect(iframe?.srcdoc).toContain("Content-Security-Policy");
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

    expect(container.querySelector("iframe")?.srcdoc).toContain('id="r1"');
  });

  it("removes active SVG content while retaining drawable elements", () => {
    const { container } = render(
      <GoogleSvgSlide
        content={
          '<svg viewBox="0 0 10 10"><script>alert(1)</script><rect id="r1" onclick="alert(1)"/><foreignObject><div>bad</div></foreignObject></svg>'
        }
        stepsRevealed={0}
      />,
    );
    const srcDoc = container.querySelector("iframe")?.srcdoc ?? "";
    expect(srcDoc).toContain('id="r1"');
    expect(srcDoc).not.toContain("onclick=");
    expect(srcDoc).not.toContain("<script>");
    expect(srcDoc).not.toContain("foreignObject");
  });
});
