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

const loadSlidesFromStorage = (): Slide[] => {
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

const saveSlidesToStorage = (slides: Slide[]): void => {
  try {
    localStorage.setItem(SLIDES_STORAGE_KEY, JSON.stringify(slides));
  } catch (e) {
    console.error("Failed to save slides to localStorage:", e);
  }
};

export type SlideNavigator = (indexh: number, indexv: number) => void;

export interface SlidesStoreState {
  slides: Slide[];
  previewState: SlidePreviewState;
}

export interface SlidesStore {
  getState: () => SlidesStoreState;
  subscribe: (listener: () => void) => () => void;
  setSlides: (updater: Slide[] | ((prev: Slide[]) => Slide[])) => void;
  setPreviewState: (
    updater: SlidePreviewState | ((prev: SlidePreviewState) => SlidePreviewState),
  ) => void;
  navigator: { current: SlideNavigator | null };
}

const DEFAULT_PREVIEW_STATE: SlidePreviewState = {
  isOpen: false,
  isMaximized: false,
  currentSlideId: null,
  indexv: 0,
};

export function createSlidesStore(): SlidesStore {
  let state: SlidesStoreState = {
    slides: loadSlidesFromStorage(),
    previewState: DEFAULT_PREVIEW_STATE,
  };

  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const navigator: { current: SlideNavigator | null } = { current: null };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setSlides: (updater) => {
      const nextSlides = typeof updater === "function" ? updater(state.slides) : updater;
      if (nextSlides !== state.slides) {
        state = { ...state, slides: nextSlides };
        saveSlidesToStorage(nextSlides);
        notify();
      }
    },
    setPreviewState: (updater) => {
      const nextPreviewState =
        typeof updater === "function" ? updater(state.previewState) : updater;
      if (nextPreviewState !== state.previewState) {
        state = { ...state, previewState: nextPreviewState };
        notify();
      }
    },
    navigator,
  };
}
