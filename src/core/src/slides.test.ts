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

  // A frame from an older recording may carry the interaction it was taken during;
  // nothing replays it, so it must not make a frame differ.
  it("ignores an older recording's currentInteraction", () => {
    const next = {
      ...base,
      currentInteraction: {
        type: "scroll",
        timestamp: 40,
        target: { tagName: "DIV" },
        data: { scrollTop: 120 },
      },
    } as SlidePreviewState;
    expect(slidePreviewStateChanged(base, next)).toBe(false);
  });
});
