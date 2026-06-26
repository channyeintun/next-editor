import { createStore } from "@xstate/store-react";
import type { Slide, SlidePreviewState } from "../types/slides";

const SLIDES_STORAGE_KEY = "next-editor-slides";

const isSlide = (item: unknown): item is Slide => {
  if (typeof item !== "object" || item === null) return false;
  const obj = item as { [K in keyof Slide]?: unknown };
  return (
    typeof obj.id === "string" &&
    typeof obj.content === "string" &&
    typeof obj.order === "number" &&
    (obj.contentType === "html" || obj.contentType === "markdown" || obj.contentType === undefined)
  );
};

export const loadSlidesFromStorage = (): Slide[] => {
  try {
    const saved = localStorage.getItem(SLIDES_STORAGE_KEY);
    if (saved) {
      const parsed: unknown = JSON.parse(saved);
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
  try {
    localStorage.setItem(SLIDES_STORAGE_KEY, JSON.stringify(slides));
  } catch (e) {
    console.error("Failed to save slides to localStorage:", e);
  }
};

export type SlideNavigator = (indexh: number, indexv: number) => void;

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

export const selectSlides = (context: SlidesContext): Slide[] => context.slides;
export const selectPreviewState = (context: SlidesContext): SlidePreviewState =>
  context.previewState;
