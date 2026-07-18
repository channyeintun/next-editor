import { describe, expect, it } from "vitest";
import type { Slide, SlideEvent } from "../../slides";
import { getSlideReplayResult } from "./slide";

const slides: Slide[] = [
  { id: "one", order: 0, content: "one", contentType: "html" },
  { id: "two", order: 1, content: "two", contentType: "html" },
];

function replay(slideEvents: SlideEvent[]) {
  return getSlideReplayResult({
    slideEvents,
    slides,
    currentTime: 1_000,
    lastAppliedIndex: -1,
    isSeeking: true,
  }).applications[0]?.slideState;
}

describe("slide replay visibility", () => {
  it("retains a shared slide change without inferring that the presentation is open", () => {
    expect(replay([{ type: "slide_change", timestamp: 100, slideId: "two", indexv: 0 }])).toEqual({
      isOpen: false,
      isMaximized: false,
      currentSlideId: "two",
      indexv: 0,
      currentInteraction: undefined,
    });
  });

  it("keeps the retained slide closed after a later shared slide change", () => {
    expect(
      replay([
        {
          type: "slide_open",
          timestamp: 0,
          slideId: "one",
          isMaximized: true,
          indexv: 0,
        },
        { type: "slide_close", timestamp: 50, slideId: "one" },
        { type: "slide_change", timestamp: 100, slideId: "two", indexv: 0 },
      ]),
    ).toMatchObject({
      isOpen: false,
      isMaximized: false,
      currentSlideId: "two",
    });
  });

  it("preserves a recorded open and maximized view across slide changes", () => {
    expect(
      replay([
        {
          type: "slide_open",
          timestamp: 0,
          slideId: "one",
          isMaximized: true,
          indexv: 0,
        },
        { type: "slide_change", timestamp: 100, slideId: "two", indexv: 0 },
      ]),
    ).toMatchObject({
      isOpen: true,
      isMaximized: true,
      currentSlideId: "two",
    });
  });
});
