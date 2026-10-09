import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  SLIDE_ANIMATION_INIT_MESSAGE_TYPE,
  SLIDE_ANIMATION_REVEAL_MESSAGE_TYPE,
  createSandboxedSlideDocument,
} from "./sandboxedSlideDocument";

const svgWithId = '<svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg"><g id="a"/></svg>';

const steps = [
  [{ elementId: "a", delayMs: 0, durationMs: 500, tracks: [{ kind: "opacity", from: 0, to: 1 }] }],
  [{ elementId: "b", delayMs: 0, durationMs: 500, tracks: [{ kind: "scale", from: 0, to: 1 }] }],
];

let removeBridgeListener: (() => void) | null = null;

afterEach(() => {
  removeBridgeListener?.();
  removeBridgeListener = null;
  document.body.innerHTML = "";
});

// Runs the generated bridge script in this realm, the way the slide frame does.
// jsdom's top-level `parent` is `window`, so messages sourced from `window` pass
// the bridge's parent check.
function runBridge(): void {
  const html = createSandboxedSlideDocument(svgWithId, "image/svg+xml", { animationBridge: true });
  const script = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector("script[nonce]")?.textContent;
  expect(script).toBeTruthy();
  document.body.innerHTML = '<svg><g id="a"></g><g id="b"></g></svg>';
  const addEventListener = vi.spyOn(window, "addEventListener");
  window.eval(script ?? "");
  const [type, listener] = addEventListener.mock.calls[0];
  addEventListener.mockRestore();
  removeBridgeListener = () => window.removeEventListener(type, listener);
}

function post(data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { source: window, data }));
}

function styleOf(id: string): CSSStyleDeclaration {
  const element = document.getElementById(id) as unknown as SVGElement;
  return element.style;
}

describe("slide animation bridge", () => {
  it("snaps to the revealed steps on INIT", () => {
    runBridge();
    post({ type: SLIDE_ANIMATION_INIT_MESSAGE_TYPE, steps, stepsRevealed: 1 });
    expect(styleOf("a").opacity).toBe("1");
    expect(styleOf("b").transform).toBe("scale(0)");
  });

  it("keeps unrevealed steps hidden on INIT", () => {
    runBridge();
    post({ type: SLIDE_ANIMATION_INIT_MESSAGE_TYPE, steps, stepsRevealed: 0 });
    expect(styleOf("a").opacity).toBe("0");
  });

  it("snaps a multi-step REVEAL jump and a backward step", () => {
    runBridge();
    post({ type: SLIDE_ANIMATION_INIT_MESSAGE_TYPE, steps, stepsRevealed: 0 });
    post({ type: SLIDE_ANIMATION_REVEAL_MESSAGE_TYPE, stepsRevealed: 2 });
    expect(styleOf("a").opacity).toBe("1");
    expect(styleOf("b").transform).toBe("scale(1)");
    post({ type: SLIDE_ANIMATION_REVEAL_MESSAGE_TYPE, stepsRevealed: 0 });
    expect(styleOf("a").opacity).toBe("0");
  });

  it("animates a single forward REVEAL step with requestAnimationFrame", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    runBridge();
    post({ type: SLIDE_ANIMATION_INIT_MESSAGE_TYPE, steps, stepsRevealed: 0 });
    expect(raf).not.toHaveBeenCalled();
    post({ type: SLIDE_ANIMATION_REVEAL_MESSAGE_TYPE, stepsRevealed: 1 });
    expect(raf).toHaveBeenCalledOnce();
    expect(styleOf("a").opacity).toBe("0");
    raf.mockRestore();
  });

  it("ignores messages from anything but the parent", () => {
    runBridge();
    post({ type: SLIDE_ANIMATION_INIT_MESSAGE_TYPE, steps, stepsRevealed: 0 });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: SLIDE_ANIMATION_REVEAL_MESSAGE_TYPE, stepsRevealed: 2 },
      }),
    );
    expect(styleOf("a").opacity).toBe("0");
  });
});
