import { afterEach, describe, expect, it } from "vitest";
import {
  createSlidesStore,
  isSlide,
  loadSlidesFromStorage,
  restoreSlidesStore,
  saveSlidesToStorage,
  setSlidesStoreDeckBorrowed,
  snapshotSlidesStore,
  subscribeSlidesPersistence,
} from "./slidesStore";
import type { Slide } from "../types/slides";

const STORAGE_KEY = "next-editor-slides";

afterEach(() => {
  localStorage.clear();
});

function makeHtmlSlide(id: string): Slide {
  return { id, content: `<h1>${id}</h1>`, contentType: "html", order: 0 };
}

function makeGoogleSlide(id: string, svgSize: number): Slide {
  return {
    id,
    content: `<svg>${"x".repeat(svgSize)}</svg>`,
    contentType: "google-svg",
    order: 0,
    title: `Slide ${id}`,
    sourceUrl: "https://docs.google.com/presentation/d/e/TOKEN/pub",
    steps: [[{ elementId: "e1", durationMs: 500, delayMs: 0, tracks: [] }]],
  };
}

describe("isSlide", () => {
  it("accepts a google-svg slide with the extra fields", () => {
    expect(isSlide(makeGoogleSlide("p1", 10))).toBe(true);
  });

  it("accepts html and markdown slides", () => {
    expect(isSlide(makeHtmlSlide("a"))).toBe(true);
    expect(isSlide({ id: "b", content: "# hi", contentType: "markdown", order: 1 })).toBe(true);
  });

  it("rejects unknown content types and malformed items", () => {
    expect(isSlide({ id: "c", content: "x", contentType: "pdf", order: 0 })).toBe(false);
    expect(isSlide({ id: "d", contentType: "html", order: 0 })).toBe(false);
    expect(isSlide(null)).toBe(false);
    expect(
      isSlide({ id: "e", content: "x", contentType: "google-svg", order: 0, steps: "nope" }),
    ).toBe(false);
  });
});

describe("slides storage round-trip", () => {
  it("keeps room-scoped projection out of standalone persistence and restores it exactly", () => {
    const store = createSlidesStore();
    const unsubscribe = subscribeSlidesPersistence(store);
    const standalone = [makeHtmlSlide("standalone")];
    store.trigger.setSlides({ slides: standalone });
    const snapshot = snapshotSlidesStore(store);

    setSlidesStoreDeckBorrowed(store, true);
    store.trigger.setSlides({ slides: [makeHtmlSlide("room")] });
    expect(loadSlidesFromStorage()).toEqual(standalone);

    restoreSlidesStore(store, snapshot);
    setSlidesStoreDeckBorrowed(store, false);
    expect(store.getSnapshot().context).toEqual(snapshot);
    expect(loadSlidesFromStorage()).toEqual(standalone);
    unsubscribe();
  });

  // Replay reaches the same persistence subscriber as an edit: applying a
  // recording's deck changed the slides identity and wrote the lesson's slides
  // over the viewer's own — unrecoverably, just from opening a lesson.
  it("does not let a replayed lesson deck overwrite the viewer's saved deck", () => {
    const store = createSlidesStore();
    const unsubscribe = subscribeSlidesPersistence(store);
    const own = [makeHtmlSlide("my own deck")];
    store.trigger.setSlides({ slides: own });
    expect(loadSlidesFromStorage()).toEqual(own);

    // What NextEditorProvider's applySlides does when a recording loads.
    setSlidesStoreDeckBorrowed(store, true);
    store.trigger.setSlides({ slides: [makeHtmlSlide("lesson deck")] });

    expect(loadSlidesFromStorage()).toEqual(own);
    unsubscribe();
  });

  it("stores small decks as plain JSON", () => {
    const slides = [makeHtmlSlide("a"), makeHtmlSlide("b")];
    saveSlidesToStorage(slides);
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw?.startsWith("NEZ1:")).toBe(false);
    expect(raw?.startsWith("[")).toBe(true);
    expect(loadSlidesFromStorage()).toEqual(
      slides.map((s) => ({ ...s, contentType: s.contentType })),
    );
  });

  it("compresses large decks and reads them back identically", () => {
    // One google-svg slide well over the 200k-char threshold.
    const slides = [makeGoogleSlide("p1", 300_000)];
    saveSlidesToStorage(slides);
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw?.startsWith("NEZ1:")).toBe(true);
    // Compression actually shrank the payload well below the raw JSON size.
    expect(raw?.length ?? 0).toBeLessThan(JSON.stringify(slides).length);
    expect(loadSlidesFromStorage()).toEqual(slides);
  });

  it("still loads legacy uncompressed JSON written directly", () => {
    const slides = [makeHtmlSlide("legacy")];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slides));
    expect(loadSlidesFromStorage()).toEqual(slides);
  });

  it("migrates slides missing contentType to html", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ id: "z", content: "x", order: 0 }]));
    const loaded = loadSlidesFromStorage();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].contentType).toBe("html");
  });

  it("drops corrupt entries while keeping valid ones", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([makeHtmlSlide("ok"), { id: 5, content: "bad" }]),
    );
    const loaded = loadSlidesFromStorage();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("ok");
  });
});
