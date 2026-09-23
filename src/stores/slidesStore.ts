import { createStore } from "@xstate/store-react";
import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import type { Slide, SlidePreviewState } from "../types/slides";
import { base64ToBytes, bytesToBase64 } from "../types/workspace";

const SLIDES_STORAGE_KEY = "next-editor-slides";

// Payloads above this size (google-svg decks embed multi-MB SVG) are stored
// deflate-compressed with this prefix; smaller payloads stay plain JSON so
// existing storage remains readable and debuggable.
const COMPRESSED_PREFIX = "NEZ1:";
const COMPRESSION_THRESHOLD = 200_000;

export const isSlide = (item: unknown): item is Slide => {
  if (typeof item !== "object" || item === null) return false;
  const obj = item as { [K in keyof Slide]?: unknown };
  return (
    typeof obj.id === "string" &&
    typeof obj.content === "string" &&
    typeof obj.order === "number" &&
    (obj.contentType === "html" ||
      obj.contentType === "markdown" ||
      obj.contentType === "google-svg" ||
      obj.contentType === undefined) &&
    (obj.background === undefined || typeof obj.background === "string") &&
    (obj.title === undefined || typeof obj.title === "string") &&
    (obj.sourceUrl === undefined || typeof obj.sourceUrl === "string") &&
    // Loose check only — the guard is a corruption filter, not a schema.
    (obj.steps === undefined || Array.isArray(obj.steps))
  );
};

export const loadSlidesFromStorage = (): Slide[] => {
  try {
    const saved = localStorage.getItem(SLIDES_STORAGE_KEY);
    if (saved) {
      const json = saved.startsWith(COMPRESSED_PREFIX)
        ? strFromU8(inflateSync(base64ToBytes(saved.slice(COMPRESSED_PREFIX.length))))
        : saved;
      const parsed: unknown = JSON.parse(json);
      if (Array.isArray(parsed)) {
        return parsed.filter(isSlide).map((slide) => ({
          ...slide,
          contentType: slide.contentType ?? "html",
        }));
      }
    }
  } catch (e) {
    console.error("Failed to load slides from localStorage:", e);
  }
  return [];
};

export const saveSlidesToStorage = (slides: Slide[]): void => {
  let payloadSize = 0;
  try {
    const json = JSON.stringify(slides);
    const payload =
      json.length > COMPRESSION_THRESHOLD
        ? COMPRESSED_PREFIX + bytesToBase64(deflateSync(strToU8(json)))
        : json;
    payloadSize = payload.length;
    localStorage.setItem(SLIDES_STORAGE_KEY, payload);
  } catch (e) {
    console.warn(`Failed to save slides to localStorage (payload ${payloadSize} chars):`, e);
  }
};

export interface SlidesContext {
  slides: Slide[];
  previewState: SlidePreviewState;
  /**
   * The deck is not the user's own (a live room's, or a loaded recording's), so
   * persistence must never write it to the shared `next-editor-slides` key. It
   * lives in the context so a snapshot taken on entering a room restores it
   * along with the deck on leaving.
   */
  deckBorrowed: boolean;
}

const DEFAULT_PREVIEW_STATE: SlidePreviewState = {
  isOpen: false,
  isMaximized: false,
  currentSlideId: null,
  indexv: 0,
};

/** The whole store state, including whether the deck was borrowed. */
export type SlidesStoreSnapshot = SlidesContext;

export function createSlidesStore() {
  return createStore({
    context: {
      slides: loadSlidesFromStorage(),
      previewState: DEFAULT_PREVIEW_STATE,
      deckBorrowed: false,
    } as SlidesContext,
    on: {
      setSlides: (context, event: { slides: Slide[] }) =>
        event.slides === context.slides ? context : { ...context, slides: event.slides },
      setPreviewState: (context, event: { previewState: SlidePreviewState }) =>
        event.previewState === context.previewState
          ? context
          : { ...context, previewState: event.previewState },
      setDeckBorrowed: (context, event: { borrowed: boolean }) =>
        event.borrowed === context.deckBorrowed
          ? context
          : { ...context, deckBorrowed: event.borrowed },
    },
  });
}

export type SlidesStoreInstance = ReturnType<typeof createSlidesStore>;

export function snapshotSlidesStore(store: SlidesStoreInstance): SlidesStoreSnapshot {
  return structuredClone(store.getSnapshot().context);
}

export function restoreSlidesStore(
  store: SlidesStoreInstance,
  snapshot: SlidesStoreSnapshot,
): void {
  // The deck goes back while the current one is still marked borrowed, so
  // restoring the user's own deck does not write it to storage a second time.
  store.trigger.setSlides({ slides: structuredClone(snapshot.slides) });
  store.trigger.setPreviewState({ previewState: structuredClone(snapshot.previewState) });
  store.trigger.setDeckBorrowed({ borrowed: snapshot.deckBorrowed });
}

/**
 * Mark the store's deck as borrowed (a room's, or a recording's) so persistence
 * skips it. Replay hit this too: `applySlides(recording.slides)` changed the
 * slides identity like any edit, and the subscriber below wrote the lesson's
 * deck over the viewer's own, unrecoverably, just from opening a lesson.
 */
export function setSlidesStoreDeckBorrowed(store: SlidesStoreInstance, borrowed: boolean): void {
  store.trigger.setDeckBorrowed({ borrowed });
}

/** Persist only when the slides array identity changes; preview state stays ephemeral. */
export function subscribeSlidesPersistence(store: SlidesStoreInstance): () => void {
  let previousSlides = store.getSnapshot().context.slides;
  const subscription = store.subscribe((snapshot) => {
    if (snapshot.context.slides === previousSlides) return;
    previousSlides = snapshot.context.slides;
    if (snapshot.context.deckBorrowed) return;
    saveSlidesToStorage(previousSlides);
  });
  return () => subscription.unsubscribe();
}

export const selectSlides = (context: SlidesContext): Slide[] => context.slides;
export const selectPreviewState = (context: SlidesContext): SlidePreviewState =>
  context.previewState;
