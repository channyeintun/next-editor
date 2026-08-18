import { createStore } from "@xstate/store-react";
import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import type { Slide, SlidePreviewState } from "../types/slides";

const SLIDES_STORAGE_KEY = "next-editor-slides";

// Payloads above this size (google-svg decks embed multi-MB SVG) are stored
// deflate-compressed with this prefix; smaller payloads stay plain JSON so
// existing storage remains readable and debuggable.
const COMPRESSED_PREFIX = "NEZ1:";
const COMPRESSION_THRESHOLD = 200_000;

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

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
}

const DEFAULT_PREVIEW_STATE: SlidePreviewState = {
  isOpen: false,
  isMaximized: false,
  currentSlideId: null,
  indexv: 0,
};

/**
 * Stores whose current deck is not the user's own, so it must never be written
 * back to the shared `next-editor-slides` key: a live collaboration room, and a
 * loaded recording being replayed.
 */
const borrowedDeckStores = new WeakSet<object>();

export interface SlidesStoreSnapshot {
  slides: Slide[];
  previewState: SlidePreviewState;
}

export function createSlidesStore() {
  return createStore({
    context: {
      slides: loadSlidesFromStorage(),
      previewState: DEFAULT_PREVIEW_STATE,
    } as SlidesContext,
    on: {
      setSlides: (context, event: { slides: Slide[] }) =>
        event.slides === context.slides ? context : { ...context, slides: event.slides },
      setPreviewState: (context, event: { previewState: SlidePreviewState }) =>
        event.previewState === context.previewState
          ? context
          : { ...context, previewState: event.previewState },
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
  store.trigger.setSlides({ slides: structuredClone(snapshot.slides) });
  store.trigger.setPreviewState({ previewState: structuredClone(snapshot.previewState) });
}

/**
 * Mark the store's deck as borrowed (a room's, or a recording's) so persistence
 * skips it. Replay hit this too: `applySlides(recording.slides)` changed the
 * slides identity like any edit, and the subscriber below wrote the lesson's
 * deck over the viewer's own, unrecoverably, just from opening a lesson.
 */
export function setSlidesStoreDeckBorrowed(store: SlidesStoreInstance, borrowed: boolean): void {
  if (borrowed) borrowedDeckStores.add(store);
  else borrowedDeckStores.delete(store);
}

export function isSlidesStoreDeckBorrowed(store: SlidesStoreInstance): boolean {
  return borrowedDeckStores.has(store);
}

/** Persist only when the slides array identity changes; preview state stays ephemeral. */
export function subscribeSlidesPersistence(store: SlidesStoreInstance): () => void {
  let previousSlides = store.getSnapshot().context.slides;
  const subscription = store.subscribe((snapshot) => {
    if (snapshot.context.slides === previousSlides) return;
    previousSlides = snapshot.context.slides;
    if (isSlidesStoreDeckBorrowed(store)) return;
    saveSlidesToStorage(previousSlides);
  });
  return () => subscription.unsubscribe();
}

export const selectSlides = (context: SlidesContext): Slide[] => context.slides;
export const selectPreviewState = (context: SlidesContext): SlidePreviewState =>
  context.previewState;
