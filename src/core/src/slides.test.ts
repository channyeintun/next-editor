import { describe, expect, it } from "vite-plus/test";
import { slidePreviewStateChanged, type SlidePreviewState } from "./slides";

describe("slidePreviewStateChanged", () => {
  const base: SlidePreviewState = {
    isOpen: true,
    isMaximized: false,
    currentSlideId: "slide-1",
    indexv: 0,
  };

  it("is false for two missing states and for equal states in different objects", () => {
    expect(slidePreviewStateChanged(undefined, undefined)).toBe(false);
    expect(slidePreviewStateChanged(base, { ...base })).toBe(false);
  });

  it("is true when the panel appears or goes away", () => {
    expect(slidePreviewStateChanged(undefined, base)).toBe(true);
    expect(slidePreviewStateChanged(base, undefined)).toBe(true);
  });

  it.each([
    ["isOpen", { isOpen: false }],
    ["isMaximized", { isMaximized: true }],
    ["currentSlideId", { currentSlideId: "slide-2" }],
    ["indexv", { indexv: 1 }],
  ] as [string, Partial<SlidePreviewState>][])(
    "reports a lone %s change as a change",
    (_field, change) => {
      expect(slidePreviewStateChanged(base, { ...base, ...change })).toBe(true);
    },
  );

  // Nothing replays the interaction from a frame, so it must not make a frame differ.
  it("ignores a currentInteraction-only difference", () => {
    const next: SlidePreviewState = {
      ...base,
      currentInteraction: {
        type: "scroll",
        timestamp: 40,
        target: { tagName: "DIV" },
        data: { scrollTop: 120 },
      },
    };
    expect(slidePreviewStateChanged(base, next)).toBe(false);
  });
});
