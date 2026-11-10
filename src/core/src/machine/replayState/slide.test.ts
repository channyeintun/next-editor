import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import type { Slide, SlideEvent } from "../../slides";
import { getSlideReplayResult, getSlideViewChangeIndex } from "./slide";

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

describe("slide replay of a tick behind the cursor", () => {
  const slideEvents: SlideEvent[] = [
    { type: "slide_open", timestamp: 0, slideId: "one", indexv: 0 },
    { type: "slide_change", timestamp: 100, slideId: "two", indexv: 0 },
    { type: "slide_change", timestamp: 200, slideId: "one", indexv: 0 },
  ];

  it("shows the slide at the tick once instead of replaying every hop from the start", () => {
    // Replaying from index 0 applied the open on "one" and then the hop to "two".
    expect(
      getSlideReplayResult({
        slideEvents,
        slides,
        currentTime: 150,
        lastAppliedIndex: 2,
        isResync: false,
      }),
    ).toEqual({
      applications: [
        {
          slideIndex: 1,
          slideState: {
            isOpen: true,
            isMaximized: false,
            currentSlideId: "two",
            indexv: 0,
          },
        },
      ],
      nextIndex: 1,
    });
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

describe("slide replay of a tick across many events", () => {
  /** The same event, counting how often replay reads the field `key` from it. */
  function counted<T extends object>(target: T, key: string, reads: { count: number }): T {
    const value = (target as Record<string, unknown>)[key];
    return Object.defineProperty({ ...target }, key, {
      enumerable: true,
      get() {
        reads.count += 1;
        return value;
      },
    });
  }

  it("reads each crossed event a bounded number of times, not once per earlier event", () => {
    // A lesson file can carry any number of slide events on one timestamp, and one
    // tick crosses them all. Each close used to scan back to the start of the track
    // for the slide it shows: n(n+3)/2 reads, two million for these 2,000 events.
    const reads = { count: 0 };
    const slideEvents: SlideEvent[] = Array.from({ length: 2_000 }, () =>
      counted({ type: "slide_close", timestamp: 1_000 }, "slideId", reads),
    );

    const result = getSlideReplayResult({
      slideEvents,
      slides: [],
      currentTime: 1_000,
      lastAppliedIndex: -1,
      isResync: false,
    });

    expect(result.nextIndex).toBe(slideEvents.length - 1);
    expect(result.applications).toHaveLength(slideEvents.length);
    expect(result.applications.at(-1)).toEqual({
      slideIndex: -1,
      slideState: { isOpen: false, isMaximized: false, currentSlideId: null, indexv: 0 },
    });
    expect(reads.count).toBeLessThanOrEqual(4 * slideEvents.length);
  });

  it("finds the vertical index of each crossed event without rescanning the track", () => {
    // An event with no vertical index of its own takes the one last set for its
    // slide. None was ever set here, so that lookup also ran back to the start.
    const reads = { count: 0 };
    const slideEvents: SlideEvent[] = Array.from({ length: 2_000 }, (_, index) =>
      counted(
        { type: "slide_change", timestamp: 1_000, slideId: index % 2 ? "one" : "two" },
        "indexv",
        reads,
      ),
    );

    const result = getSlideReplayResult({
      slideEvents,
      slides,
      currentTime: 1_000,
      lastAppliedIndex: -1,
      isResync: false,
    });

    expect(result.applications).toHaveLength(slideEvents.length);
    expect(reads.count).toBeLessThanOrEqual(4 * slideEvents.length);
  });

  it("looks each crossed slide up in the deck without scanning the deck", () => {
    // The deck comes from the lesson file too. Every crossed event used to search
    // it from the front: events x slides id comparisons, a million here.
    const reads = { count: 0 };
    const deck: Slide[] = Array.from({ length: 500 }, (_, index) =>
      counted(
        { id: `slide-${index}`, order: index, content: "", contentType: "html" },
        "id",
        reads,
      ),
    );
    const slideEvents: SlideEvent[] = Array.from({ length: 2_000 }, () => ({
      type: "slide_change",
      timestamp: 1_000,
      slideId: "slide-499",
      indexv: 0,
    }));

    const result = getSlideReplayResult({
      slideEvents,
      slides: deck,
      currentTime: 1_000,
      lastAppliedIndex: -1,
      isResync: false,
    });

    expect(result.applications).toHaveLength(slideEvents.length);
    expect(result.applications[0]?.slideIndex).toBe(499);
    expect(reads.count).toBeLessThanOrEqual(4 * deck.length);

    // A seek asks whether each slide it passes is still in the deck.
    reads.count = 0;
    const gone: SlideEvent[] = Array.from({ length: 2_000 }, (_, index) => ({
      type: "slide_change",
      timestamp: index,
      slideId: `gone-${index}`,
    }));
    getSlideReplayResult({
      slideEvents: gone,
      slides: deck,
      currentTime: 5_000,
      lastAppliedIndex: -1,
      isResync: true,
    });
    expect(reads.count).toBeLessThanOrEqual(4 * deck.length);
  });

  // The deck state at an event, read straight off the track: each part of it is the
  // latest earlier event that set it. Slow, and what the replay must keep showing.
  function stateByScanningBack(slideEvents: SlideEvent[], eventIndex: number) {
    const lastBefore = (matches: (event: SlideEvent) => boolean) =>
      slideEvents.slice(0, eventIndex + 1).findLast(matches);
    const slideEvent = slideEvents[eventIndex];
    const slideId = slideEvent.slideId || lastBefore((event) => Boolean(event.slideId))?.slideId;
    const visibility = lastBefore(
      (event) => event.type === "slide_open" || event.type === "slide_close",
    );
    const view = lastBefore(
      (event) => event.type !== "slide_change" && event.type !== "slide_interaction",
    );
    const isOpen = visibility?.type === "slide_open";
    return {
      isOpen,
      isMaximized:
        isOpen &&
        (view?.type === "slide_maximize" ||
          (view?.type === "slide_open" && (view.isMaximized ?? false))),
      currentSlideId: slideId || null,
      indexv:
        slideEvent.type === "slide_close"
          ? 0
          : (slideEvent.indexv ??
            lastBefore(
              (event) => (slideId ? event.slideId === slideId : true) && event.indexv != null,
            )?.indexv),
    };
  }

  it("applies, for every crossed event, the state a scan back from it finds", () => {
    const arbEvent = fc.record(
      {
        gap: fc.nat({ max: 2 }),
        type: fc.constantFrom<SlideEvent["type"]>(
          "slide_open",
          "slide_close",
          "slide_change",
          "slide_maximize",
          "slide_minimize",
          "slide_interaction",
        ),
        slideId: fc.constantFrom("one", "two", "gone", ""),
        isMaximized: fc.boolean(),
        indexv: fc.nat({ max: 2 }),
      },
      { requiredKeys: ["gap", "type"] },
    );

    fc.assert(
      fc.property(
        fc.array(arbEvent, { maxLength: 30 }),
        fc.constantFrom(undefined, [], slides),
        fc.array(fc.nat({ max: 8 }), { maxLength: 6 }),
        (steps, deck, tickGaps) => {
          let time = 0;
          const slideEvents: SlideEvent[] = steps.map(({ gap, ...event }) => {
            time += gap;
            return { ...event, timestamp: time };
          });
          const expected = slideEvents.flatMap((slideEvent, index) => {
            const slideState = stateByScanningBack(slideEvents, index);
            if (slideEvent.type === "slide_close") return [{ slideIndex: -1, slideState }];
            const slideIndex =
              deck?.findIndex((slide) => slide.id === slideState.currentSlideId) ?? -1;
            return slideIndex < 0 ? [] : [{ slideIndex, slideState }];
          });

          // Ticks of any length, starting over on the same track, apply every placed event.
          const applied: unknown[] = [];
          let lastAppliedIndex = -1;
          let currentTime = -1;
          for (const gap of [...tickGaps, time + 1]) {
            currentTime += gap;
            const result = getSlideReplayResult({
              slideEvents,
              slides: deck,
              currentTime,
              lastAppliedIndex,
              isResync: false,
            });
            applied.push(...result.applications);
            lastAppliedIndex = result.nextIndex;
          }
          expect(applied).toEqual(expected);
        },
      ),
    );
  });
});

describe("getSlideViewChangeIndex", () => {
  it("marks opening, closing, maximizing and minimizing, not navigation", () => {
    const events: SlideEvent[] = [
      { type: "slide_open", timestamp: 0, slideId: "one", isMaximized: true },
      { type: "slide_change", timestamp: 10, slideId: "two" },
      // Opening a deck that is already open as it leaves it is navigation too.
      { type: "slide_open", timestamp: 20, slideId: "one", isMaximized: true },
      { type: "slide_minimize", timestamp: 30, slideId: "one" },
      { type: "slide_interaction", timestamp: 40, slideId: "one" },
      { type: "slide_close", timestamp: 50, slideId: "one" },
    ];

    expect(events.map((_, index) => getSlideViewChangeIndex(events, index))).toEqual([
      0, 0, 0, 3, 3, 5,
    ]);
  });

  it("changes exactly where the replayed deck is shown differently", () => {
    const slideEvent = fc.record({
      type: fc.constantFrom<SlideEvent["type"]>(
        "slide_open",
        "slide_close",
        "slide_change",
        "slide_maximize",
        "slide_minimize",
      ),
      slideId: fc.constantFrom("one", "two"),
      isMaximized: fc.option(fc.boolean(), { nil: undefined }),
    });

    fc.assert(
      fc.property(fc.array(slideEvent, { minLength: 1, maxLength: 12 }), (records) => {
        const events: SlideEvent[] = records.map((record, index) => ({
          ...record,
          timestamp: index * 10,
        }));
        const shownAt = (index: number) => {
          const state = getSlideReplayResult({
            slideEvents: events,
            slides,
            currentTime: index * 10,
            lastAppliedIndex: -1,
            isResync: true,
          }).applications[0]!.slideState;
          return `${state.isOpen}/${state.isMaximized}`;
        };

        const closed = "false/false";
        events.forEach((_, index) => {
          const changedAt = getSlideViewChangeIndex(events, index);
          const before = changedAt > 0 ? shownAt(changedAt - 1) : closed;
          const fromChange = changedAt >= 0 ? shownAt(changedAt) : closed;
          // The deck is shown as the latest change left it (closed before any)...
          expect(shownAt(index)).toBe(fromChange);
          // ...and that change did change it.
          expect(changedAt < 0 || fromChange !== before).toBe(true);
        });
      }),
    );
  });
});
