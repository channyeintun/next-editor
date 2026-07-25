import { createRef } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RuntimePreviewRenderer } from "./RuntimePreviewRenderer";

function renderFrame(allowSameOrigin: boolean) {
  const { container } = render(
    <RuntimePreviewRenderer
      iframeRef={createRef<HTMLIFrameElement>()}
      replayContainerRef={createRef<HTMLDivElement>()}
      isRrwebReplayActive={false}
      disablePointerEvents={false}
      allowSameOrigin={allowSameOrigin}
    />,
  );
  return container.querySelector("iframe");
}

describe("RuntimePreviewRenderer", () => {
  it("keeps allow-same-origin for locally authored content", () => {
    // The live runtime points this frame at a cross-origin WebContainer URL via
    // `src`, where the flag only preserves that frame's own origin.
    expect(renderFrame(true)?.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-forms",
    );
  });

  it("drops allow-same-origin once recorded content can reach the frame", () => {
    // An about:srcdoc document inherits the embedder's origin, so keeping the
    // flag while replaying HTML out of a `.ne` file would let a published
    // lesson run as first-party script on the app origin.
    const sandbox = renderFrame(false)?.getAttribute("sandbox");
    expect(sandbox).toBe("allow-scripts allow-forms");
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("remounts a distinct element when the trust mode flips", () => {
    // Changing `sandbox` on a live element does not re-apply to the document
    // already loaded in it, so the two modes must not share an element.
    expect(renderFrame(true)?.getAttribute("sandbox")).not.toBe(
      renderFrame(false)?.getAttribute("sandbox"),
    );
  });
});
