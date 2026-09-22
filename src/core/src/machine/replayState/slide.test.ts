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
    isResync: true,
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

describe("slide replay before the first event", () => {
  // The deck was opened mid-recording, so it did not exist before 500ms.
  const slideEvents: SlideEvent[] = [
    { type: "slide_open", timestamp: 500, slideId: "one", indexv: 0 },
  ];
  const closedDeck = {
    slideIndex: -1,
    slideState: { isOpen: false, isMaximized: false, currentSlideId: null, indexv: 0 },
  };

  it("closes the deck when a resync lands before it was opened", () => {
    expect(
      getSlideReplayResult({
        slideEvents,
        slides,
        currentTime: 100,
        lastAppliedIndex: -1,
        isResync: true,
      }),
    ).toEqual({ applications: [closedDeck], nextIndex: -1 });
  });

  it("applies nothing on a tick that has not reached the first event", () => {
    expect(
      getSlideReplayResult({
        slideEvents,
        slides,
        currentTime: 100,
        lastAppliedIndex: -1,
        isResync: false,
      }),
    ).toEqual({ applications: [], nextIndex: -1 });
  });

  it("closes the deck once when a tick rewinds to before the first event", () => {
    expect(
      getSlideReplayResult({
        slideEvents,
        slides,
        currentTime: 100,
        lastAppliedIndex: 0,
        isResync: false,
      }),
    ).toEqual({ applications: [closedDeck], nextIndex: -1 });
  });
});
