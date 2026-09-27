import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  applyRecordingSlides,
  applySlideRecordingState,
  readSlideRecordingState,
} from "./slidesRecordingAdapter";
import {
  createSlidesStore,
  loadSlidesFromStorage,
  subscribeSlidesPersistence,
} from "./slidesStore";
import type { Slide } from "../types/slides";

afterEach(() => {
  localStorage.clear();
});

function makeSlide(id: string): Slide {
  return { id, content: `<h1>${id}</h1>`, contentType: "html", order: 0 };
}

function storeShowing(previewState: Parameters<typeof applySlideRecordingState>[1]) {
  const store = createSlidesStore();
  store.trigger.setSlides({ slides: [makeSlide("a"), makeSlide("b"), makeSlide("c")] });
  store.trigger.setPreviewState({ previewState });
  return store;
}

describe("readSlideRecordingState", () => {
  it("reads the panel and the index of the slide it shows", () => {
    const store = storeShowing({ isOpen: true, currentSlideId: "b" });
    expect(readSlideRecordingState(store)).toEqual({
      previewState: { isOpen: true, currentSlideId: "b" },
      currentSlideIndex: 1,
    });
  });

  it("reads index 0 when the slide it shows is not in the deck", () => {
    const store = storeShowing({ isOpen: false, currentSlideId: "gone" });
    expect(readSlideRecordingState(store).currentSlideIndex).toBe(0);
  });
});

describe("applySlideRecordingState", () => {
  it("keeps what the recorded state leaves out", () => {
    const store = storeShowing({ isOpen: true, isMaximized: true, currentSlideId: "b", indexv: 2 });

    applySlideRecordingState(store, { isOpen: false });

    expect(store.getSnapshot().context.previewState).toEqual({
      isOpen: false,
      isMaximized: true,
      currentSlideId: "b",
      indexv: 2,
      currentInteraction: undefined,
    });
  });

  it("fills what neither side has with the closed-panel defaults", () => {
    const store = storeShowing({ isOpen: false });

    applySlideRecordingState(store, { isOpen: true, currentSlideId: "c" });

    expect(store.getSnapshot().context.previewState).toEqual({
      isOpen: true,
      isMaximized: false,
      currentSlideId: "c",
      indexv: 0,
      currentInteraction: undefined,
    });
  });

  it("leaves the store alone when the recorded state changes nothing", () => {
    const store = storeShowing({
      isOpen: true,
      isMaximized: false,
      currentSlideId: "a",
      indexv: 0,
    });
    const before = store.getSnapshot().context.previewState;

    applySlideRecordingState(store, { isOpen: true, currentSlideId: "a" });

    expect(store.getSnapshot().context.previewState).toBe(before);
  });
});

describe("applyRecordingSlides", () => {
  it("shows the recording's deck without saving it over the viewer's own", () => {
    const store = createSlidesStore();
    const unsubscribe = subscribeSlidesPersistence(store);
    const own = [makeSlide("my own deck")];
    store.trigger.setSlides({ slides: own });

    const lessonDeck = [makeSlide("lesson deck")];
    applyRecordingSlides(store, lessonDeck);

    expect(store.getSnapshot().context.slides).toBe(lessonDeck);
    expect(store.getSnapshot().context.deckBorrowed).toBe(true);
    expect(loadSlidesFromStorage()).toEqual(own);
    unsubscribe();
  });
});
