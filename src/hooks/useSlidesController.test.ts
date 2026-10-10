import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { Slide, SlideEvent, SlidePreviewState } from "../types/slides";
import { createSlidesStore } from "../stores/slidesStore";
import { useSlidesController } from "./useSlidesController";

const slide = (id: string): Slide => ({
  id,
  content: `<h1>${id}</h1>`,
  contentType: "html",
  order: 0,
});

function renderController(options: Partial<Parameters<typeof useSlidesController>[0]> = {}) {
  const store = createSlidesStore();
  store.trigger.setSlides({ slides: [slide("one"), slide("two")] });
  // Each preview state the store moves to, so a write that changes nothing shows up.
  const written: SlidePreviewState[] = [];
  store.subscribe((snapshot) => {
    const { previewState } = snapshot.context;
    if (previewState !== written.at(-1)) written.push(previewState);
  });
  const { result } = renderHook(() => useSlidesController({ store, ...options }));
  return { store, written, controller: () => result.current };
}

afterEach(() => {
  localStorage.clear();
});

describe("useSlidesController", () => {
  it("opens on the first slide, and leaves an already showing slide alone", () => {
    const { store, written, controller } = renderController();
    act(() => controller().startPresentation());
    const opened = store.getSnapshot().context.previewState;
    expect(opened).toEqual({ isOpen: true, isMaximized: true, currentSlideId: "one", indexv: 0 });
    expect(written).toEqual([opened]);

    act(() => controller().startPresentation());
    expect(store.getSnapshot().context.previewState).toBe(opened);
    expect(written).toHaveLength(1);
  });

  it("opens and closes even when onSlideEvent declines the events", () => {
    const events: SlideEvent["type"][] = [];
    const { store, controller } = renderController({
      onSlideEvent: (event) => {
        events.push(event.type);
        return false;
      },
    });
    act(() => controller().startPresentation());
    expect(store.getSnapshot().context.previewState).toEqual({
      isOpen: true,
      isMaximized: true,
      currentSlideId: "one",
      indexv: 0,
    });

    act(() => controller().closePresentation());
    expect(events).toEqual(["slide_open", "slide_close"]);
    expect(store.getSnapshot().context.previewState).toEqual({
      isOpen: false,
      isMaximized: false,
      currentSlideId: null,
      indexv: 0,
    });
  });

  it("writes a close once, keeping the retained slide, and none when already closed", () => {
    const { store, written, controller } = renderController({ retainSlideOnClose: true });
    act(() => controller().startPresentation());
    act(() => controller().closePresentation());
    const closed = store.getSnapshot().context.previewState;
    expect(closed).toEqual({ isOpen: false, isMaximized: false, currentSlideId: "one", indexv: 0 });
    expect(written).toHaveLength(2);

    act(() => controller().closePresentation());
    expect(store.getSnapshot().context.previewState).toBe(closed);
    expect(written).toHaveLength(2);
  });
});
