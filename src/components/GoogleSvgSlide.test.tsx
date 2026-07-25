import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import GoogleSvgSlide from "./GoogleSvgSlide";
import type { DeckStep } from "../googleSlides/types";
import {
  SLIDE_ANIMATION_INIT_MESSAGE_TYPE,
  SLIDE_ANIMATION_REVEAL_MESSAGE_TYPE,
} from "../utils/sandboxedSlideDocument";

const minimalSvg =
  '<svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg"><rect id="r1" width="10" height="10"/></svg>';

describe("GoogleSvgSlide", () => {
  it("renders SVG in a script-enabled but unique-origin isolated document", () => {
    const { container } = render(<GoogleSvgSlide content={minimalSvg} stepsRevealed={0} />);

    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(iframe?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe?.srcdoc).toContain(minimalSvg);
    expect(iframe?.srcdoc).toContain("Content-Security-Policy");

    // The nonce is generated at runtime, not hardcoded, so assert the property
    // that matters: the CSP trusts exactly the nonce the bridge script carries,
    // and that value is not a guessable constant an authored slide could spell
    // out to get itself trusted.
    const nonce = /script-src 'nonce-([^']+)'/.exec(iframe?.srcdoc ?? "")?.[1];
    expect(nonce).toBeDefined();
    expect(nonce).not.toBe("next-editor-slide-animation");
    expect(iframe?.srcdoc).toContain(`<script nonce="${nonce}">`);
  });

  it("drops a document whose root element is itself forbidden", () => {
    // `<script>` parses as well-formed XML, so documentElement is the script
    // itself — it has no descendants for the element sweep to visit, and the
    // SVG branch returns root.outerHTML. Without a root-level check this was
    // re-emitted verbatim, and an authored `nonce` would have matched the CSP.
    const { container } = render(
      <GoogleSvgSlide
        content={'<script nonce="next-editor-slide-animation">alert(1)</script>'}
        stepsRevealed={0}
      />,
    );
    const srcDoc = container.querySelector("iframe")?.srcdoc ?? "";
    expect(srcDoc).not.toContain("alert(1)");
    expect(srcDoc).not.toContain('nonce="next-editor-slide-animation"');
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

  it("sends only animation state through the child-frame protocol", () => {
    const steps: DeckStep[] = [
      [
        {
          elementId: "r1",
          durationMs: 300,
          delayMs: 0,
          tracks: [{ kind: "opacity", from: 0, to: 1 }],
        },
      ],
    ];
    const { container, rerender } = render(
      <GoogleSvgSlide content={minimalSvg} steps={steps} stepsRevealed={0} />,
    );
    const iframe = container.querySelector("iframe");
    if (!iframe?.contentWindow) throw new Error("Expected iframe content window");
    const postMessage = vi.spyOn(iframe.contentWindow, "postMessage");

    fireEvent.load(iframe);
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: SLIDE_ANIMATION_INIT_MESSAGE_TYPE,
        steps,
        stepsRevealed: 0,
      },
      "*",
    );

    rerender(<GoogleSvgSlide content={minimalSvg} steps={steps} stepsRevealed={1} />);
    expect(postMessage).toHaveBeenCalledWith(
      { type: SLIDE_ANIMATION_REVEAL_MESSAGE_TYPE, stepsRevealed: 1 },
      "*",
    );
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
