import { createStore } from "@xstate/store-react";
import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import type { Slide, SlideEvent, SlidePreviewState } from "../types/slides";
import { base64ToBytes, bytesToBase64 } from "../shared/base64";

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

/** A closed slide panel. Spread it (`{ ...DEFAULT_PREVIEW_STATE }`) for a fresh closed state. */
export const DEFAULT_PREVIEW_STATE: SlidePreviewState = {
  isOpen: false,
  isMaximized: false,
  currentSlideId: null,
  indexv: 0,
};

/** The panel showing `slideId`: maximized and on its first build step unless told otherwise. */
export function openedSlidePreviewState(
  slideId: string,
  { isMaximized = true, indexv = 0 }: { isMaximized?: boolean; indexv?: number } = {},
): SlidePreviewState {
  return { isOpen: true, isMaximized, currentSlideId: slideId, indexv };
}

/**
 * The preview state after a slide event: `prev` itself when the event changes
 * nothing, which the store keeps without emitting. A close keeps the current
 * slide when `retainSlideOnClose` (SlidesProvider sets it in a live room).
 */
export function nextSlidePreviewState(
  prev: SlidePreviewState,
  event: SlideEvent,
  { retainSlideOnClose }: { retainSlideOnClose: boolean },
): SlidePreviewState {
  switch (event.type) {
    case "slide_open": {
      const nextSlideId = event.slideId || prev.currentSlideId;
      const nextIndexv = event.indexv ?? 0;
      const nextIsMaximized = event.isMaximized ?? true;

      if (
        prev.isOpen &&
        prev.currentSlideId === nextSlideId &&
        prev.indexv === nextIndexv &&
        prev.isMaximized === nextIsMaximized
      ) {
        return prev;
      }

      return {
        ...prev,
        isOpen: true,
        isMaximized: nextIsMaximized,
        currentSlideId: nextSlideId,
        indexv: nextIndexv,
      };
    }
    case "slide_close":
      if (
        !prev.isOpen &&
        !prev.isMaximized &&
        (retainSlideOnClose || prev.currentSlideId === null)
      ) {
        return prev;
      }
      return {
        ...prev,
        isOpen: false,
        isMaximized: false,
        currentSlideId: retainSlideOnClose ? prev.currentSlideId : null,
        indexv: 0,
      };
    case "slide_maximize":
      if (prev.isMaximized === (event.isMaximized || false)) {
        return prev;
      }
      return { ...prev, isMaximized: event.isMaximized || false };
    case "slide_minimize":
      if (!prev.isMaximized) {
        return prev;
      }
      return { ...prev, isMaximized: false };
    case "slide_change": {
      const targetIndexv = event.indexv ?? 0;
      if (
        prev.currentSlideId === (event.slideId || prev.currentSlideId) &&
        prev.indexv === targetIndexv
      ) {
        return prev;
      }
      return {
        ...prev,
        currentSlideId: event.slideId || prev.currentSlideId,
        indexv: targetIndexv,
      };
    }
    case "slide_interaction":
      // Not stored: nothing reads it (decode drops the event and replay ignores it), and
      // storing each one re-rendered every slides consumer. The event still goes out
      // through onSlideEvent.
      return prev;
    default:
      // An event type outside SlideEvent's union changes nothing.
      return prev;
  }
}

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
