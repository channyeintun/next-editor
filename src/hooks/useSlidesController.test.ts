import { describe, expect, it } from "vite-plus/test";
import type { IframeInteractionEvent, SlideEvent, SlidePreviewState } from "../types/slides";
import { nextSlidePreviewState } from "./useSlidesController";

const closed: SlidePreviewState = {
  isOpen: false,
  isMaximized: false,
  currentSlideId: "one",
  indexv: 0,
};

const open: SlidePreviewState = {
  isOpen: true,
  isMaximized: true,
  currentSlideId: "one",
  indexv: 2,
};

function event(type: SlideEvent["type"], fields: Partial<SlideEvent> = {}): SlideEvent {
  return { type, timestamp: 1, ...fields };
}

const next = (prev: SlidePreviewState, slideEvent: SlideEvent, retainSlideOnClose = false) =>
  nextSlidePreviewState(prev, slideEvent, { retainSlideOnClose });

describe("nextSlidePreviewState", () => {
  it("opens maximized on the event's slide and step, defaulting to the current slide", () => {
    expect(next(closed, event("slide_open", { slideId: "two", indexv: 1 }))).toEqual({
      isOpen: true,
      isMaximized: true,
      currentSlideId: "two",
      indexv: 1,
    });
    expect(next(closed, event("slide_open", { isMaximized: false }))).toEqual({
      isOpen: true,
      isMaximized: false,
      currentSlideId: "one",
      indexv: 0,
    });
    expect(next(open, event("slide_open", { slideId: "one", indexv: 2 }))).toBe(open);
  });

  it("closes to no slide, or keeps it when the slide is retained", () => {
    expect(next(open, event("slide_close"))).toEqual({
      isOpen: false,
      isMaximized: false,
      currentSlideId: null,
      indexv: 0,
    });
    expect(next(open, event("slide_close"), true)).toEqual({ ...closed, currentSlideId: "one" });
    expect(next(closed, event("slide_close"), true)).toBe(closed);
    const cleared = { ...closed, currentSlideId: null };
    expect(next(cleared, event("slide_close"))).toBe(cleared);
    // Closed but still naming a slide: closing again clears it.
    expect(next(closed, event("slide_close")).currentSlideId).toBeNull();
  });

  it("maximizes and minimizes only when that changes something", () => {
    expect(next(closed, event("slide_maximize", { isMaximized: true })).isMaximized).toBe(true);
    expect(next(open, event("slide_maximize", { isMaximized: true }))).toBe(open);
    expect(next(open, event("slide_maximize"))).toEqual({ ...open, isMaximized: false });
    expect(next(open, event("slide_minimize"))).toEqual({ ...open, isMaximized: false });
    expect(next(closed, event("slide_minimize"))).toBe(closed);
  });

  it("changes the slide or build step, keeping the current slide when none is named", () => {
    expect(next(open, event("slide_change", { slideId: "two" }))).toEqual({
      ...open,
      currentSlideId: "two",
      indexv: 0,
    });
    expect(next(open, event("slide_change", { indexv: 3 }))).toEqual({ ...open, indexv: 3 });
    expect(next(open, event("slide_change", { slideId: "one", indexv: 2 }))).toBe(open);
  });

  it("records the current interaction", () => {
    const interaction = { type: "click" } as IframeInteractionEvent;
    const interacted = next(open, event("slide_interaction", { interaction }));
    expect(interacted).toEqual({ ...open, currentInteraction: interaction });
    expect(next(interacted, event("slide_interaction", { interaction }))).toBe(interacted);
  });

  it("leaves the state alone for an event type it does not know", () => {
    const unknown = { type: "slide_unknown", timestamp: 1 } as unknown as SlideEvent;
    expect(next(open, unknown)).toBe(open);
  });
});
