import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
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

describe("slide replay of a slide deleted during the take", () => {
  // The deck is saved at finalize, so "gone" is no longer in it.
  const slideEvents: SlideEvent[] = [
    { type: "slide_open", timestamp: 0, slideId: "one", indexv: 0 },
    { type: "slide_change", timestamp: 100, slideId: "gone", indexv: 0 },
    { type: "slide_close", timestamp: 200, slideId: "one" },
  ];
  const openOnOne = {
    slideIndex: 0,
    slideState: {
      isOpen: true,
      isMaximized: false,
      currentSlideId: "one",
      indexv: 0,
      currentInteraction: undefined,
    },
  };

  it("keeps the last placed slide on a tick across the deleted slide", () => {
    const opened = getSlideReplayResult({
      slideEvents,
      slides,
      currentTime: 0,
      lastAppliedIndex: -1,
      isResync: true,
    });
    expect(opened.applications).toEqual([openOnOne]);
    expect(
      getSlideReplayResult({
        slideEvents,
        slides,
        currentTime: 150,
        lastAppliedIndex: opened.nextIndex,
        isResync: false,
      }),
    ).toEqual({ applications: [], nextIndex: 1 });
  });

  it("shows the same slide when a seek lands on the deleted slide", () => {
    // Before the fix, a seek from 250 back to 150 applied nothing and left the
    // deck closed, while playing from 0 to 150 showed slide "one".
    expect(
      getSlideReplayResult({
        slideEvents,
        slides,
        currentTime: 150,
        lastAppliedIndex: -1,
        isResync: true,
      }),
    ).toEqual({ applications: [openOnOne], nextIndex: 1 });
  });

  it("closes the deck on a seek when no earlier event can be placed", () => {
    expect(
      getSlideReplayResult({
        slideEvents: [{ type: "slide_open", timestamp: 0, slideId: "gone", indexv: 0 }],
        slides,
        currentTime: 50,
        lastAppliedIndex: -1,
        isResync: true,
      }).applications,
    ).toEqual([
      {
        slideIndex: -1,
        slideState: { isOpen: false, isMaximized: false, currentSlideId: null, indexv: 0 },
      },
    ]);
  });
});

describe("slide replay resync", () => {
  const closedDeck = {
    slideIndex: -1,
    slideState: { isOpen: false, isMaximized: false, currentSlideId: null, indexv: 0 },
  };

  it("places only closes when the recording has no deck", () => {
    const slideEvents: SlideEvent[] = [
      { type: "slide_open", timestamp: 0, slideId: "one", indexv: 0 },
      { type: "slide_close", timestamp: 100, slideId: "one" },
      { type: "slide_open", timestamp: 200, slideId: "one", indexv: 0 },
    ];
    for (const deck of [undefined, []]) {
      expect(
        getSlideReplayResult({
          slideEvents,
          slides: deck,
          currentTime: 250,
          lastAppliedIndex: -1,
          isResync: true,
        }).applications,
      ).toEqual([{ slideIndex: -1, slideState: expect.objectContaining({ isOpen: false }) }]);
    }
  });

  it("keeps the deck closed across a long track that names no slide", () => {
    // Lessons recorded before the preview frames were filtered carry thousands of these.
    const slideEvents: SlideEvent[] = Array.from({ length: 5_000 }, (_, index) => ({
      type: "slide_interaction",
      timestamp: index,
    }));
    expect(
      getSlideReplayResult({
        slideEvents,
        slides,
        currentTime: 10_000,
        lastAppliedIndex: -1,
        isResync: true,
      }),
    ).toEqual({ applications: [closedDeck], nextIndex: 4_999 });
  });

  it("shows what playing from the start shows", () => {
    const arbEvent = fc.record(
      {
        gap: fc.nat({ max: 3 }),
        type: fc.constantFrom<SlideEvent["type"]>(
          "slide_open",
          "slide_close",
          "slide_change",
          "slide_maximize",
          "slide_minimize",
          "slide_interaction",
        ),
        slideId: fc.constantFrom("one", "two", "gone"),
        isMaximized: fc.boolean(),
        indexv: fc.nat({ max: 2 }),
      },
      { requiredKeys: ["gap", "type"] },
    );
    fc.assert(
      fc.property(
        fc.array(arbEvent, { maxLength: 30 }),
        fc.constantFrom(undefined, [], slides),
        (steps, deck) => {
          let time = 0;
          const slideEvents: SlideEvent[] = steps.map(({ gap, ...event }) => {
            time += gap;
            return { ...event, timestamp: time };
          });
          for (let currentTime = -1; currentTime <= time + 1; currentTime += 1) {
            const played = getSlideReplayResult({
              slideEvents,
              slides: deck,
              currentTime,
              lastAppliedIndex: -1,
              isResync: false,
            });
            const sought = getSlideReplayResult({
              slideEvents,
              slides: deck,
              currentTime,
              lastAppliedIndex: -1,
              isResync: true,
            });
            expect(sought.nextIndex).toBe(played.nextIndex);
            expect(sought.applications).toEqual([played.applications.at(-1) ?? closedDeck]);
          }
        },
      ),
    );
  });
});
