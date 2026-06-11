import React, { createContext, useContext, useEffect, useCallback } from "react";
import { useNextEditorDomainAdapters } from "./NextEditorDomainAdaptersContext";
import { useSlides } from "../hooks/useSlides";
import { useNextEditorActions } from "../hooks/useNextEditorContext";
import type { SlidePreviewState } from "../types/slides";

const SlidesContext = createContext<ReturnType<typeof useSlides> | null>(null);

interface SlidesProviderProps {
  children: React.ReactNode;
}

export const SlidesProvider: React.FC<SlidesProviderProps> = ({ children }) => {
  const { handleSlideEvent } = useNextEditorActions();
  const { slides } = useNextEditorDomainAdapters();

  const slidesData = useSlides({
    onSlideEvent: handleSlideEvent,
  });

  const slideStateGetter = useCallback(
    () => ({
      previewState: slidesData.previewState,
      currentSlideIndex: slidesData.currentSlideIndex,
    }),
    [slidesData.previewState, slidesData.currentSlideIndex],
  );

  useEffect(() => {
    slides.setSnapshotGetter(slideStateGetter);

    return () => {
      slides.setSnapshotGetter(() => null);
    };
  }, [slideStateGetter, slides]);

  const slidesGetter = useCallback(() => slidesData.slides, [slidesData.slides]);

  useEffect(() => {
    slides.setSlidesGetter(slidesGetter);

    return () => {
      slides.setSlidesGetter(() => []);
    };
  }, [slides, slidesGetter]);

  const slideStateApplier = useCallback(
    (slideState: SlidePreviewState, currentSlideIndex: number) => {
      // Directly apply the slide state during playback without triggering events
      // to avoid double event recording during playback

      // Set the preview state directly to match the recorded state
      slidesData.setPreviewState((prev) => {
        const nextIsOpen = slideState.isOpen;
        const nextIsMaximized = slideState.isMaximized ?? prev.isMaximized ?? false;
        const nextSlideId = slideState.currentSlideId ?? prev.currentSlideId ?? null;
        // Preserve the current vertical index if slideState.indexv is undefined
        const nextIndexv = slideState.indexv ?? prev.indexv ?? 0;
        const nextInteraction = slideState.currentInteraction;

        if (
          nextIsOpen !== prev.isOpen ||
          nextIsMaximized !== prev.isMaximized ||
          nextSlideId !== prev.currentSlideId ||
          nextIndexv !== prev.indexv ||
          nextInteraction !== prev.currentInteraction
        ) {
          return {
            isOpen: nextIsOpen,
            isMaximized: nextIsMaximized,
            currentSlideId: nextSlideId,
            indexv: nextIndexv,
            currentInteraction: nextInteraction,
          };
        }
        return prev;
      });

      // Update slide index if needed
      if (slideState.isOpen) {
        const nextIndexv = slideState.indexv ?? slidesData.previewState.indexv ?? 0;
        const prevIndexv = slidesData.previewState.indexv ?? 0;

        if (
          currentSlideIndex !== slidesData.currentSlideIndex ||
          (slideState.indexv !== undefined && nextIndexv !== prevIndexv)
        ) {
          slides.navigate(currentSlideIndex, nextIndexv);
        }
      }
    },
    [slides, slidesData],
  );

  useEffect(() => {
    slides.setSnapshotApplier(slideStateApplier);

    return () => {
      slides.setSnapshotApplier((_nextSlideState, _nextSlideIndex) => undefined);
    };
  }, [slideStateApplier, slides]);

  const slidesApplier = useCallback(
    (
      slides: Array<{
        id: string;
        content: string;
        contentType: "html" | "markdown";
        name?: string;
        order: number;
      }>,
    ) => {
      slidesData.setSlides(slides);
    },
    [slidesData],
  );

  useEffect(() => {
    slides.setSlidesApplier(slidesApplier);

    return () => {
      slides.setSlidesApplier((_nextSlides) => undefined);
    };
  }, [slides, slidesApplier]);

  return <SlidesContext.Provider value={slidesData}>{children}</SlidesContext.Provider>;
};

export const useSlidesContext = () => {
  const context = useContext(SlidesContext);
  if (!context) {
    throw new Error("useSlidesContext must be used within a SlidesProvider");
  }
  return context;
};
