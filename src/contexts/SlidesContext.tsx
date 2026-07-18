import React, { createContext, useCallback, useContext } from "react";
import { useSlidesController } from "../hooks/useSlidesController";
import { useSlidesStore } from "./SlidesStoreContext";
import { useNextEditorActions } from "../hooks/useNextEditorContext";
import { useOptionalCollaboration } from "./CollaborationContext";
import type { SlideEvent } from "../types/slides";

const SlidesContext = createContext<ReturnType<typeof useSlidesController> | null>(null);

interface SlidesProviderProps {
  children: React.ReactNode;
}

export const SlidesProvider: React.FC<SlidesProviderProps> = ({ children }) => {
  const { handleSlideEvent } = useNextEditorActions();
  const { store } = useSlidesStore();
  const collaboration = useOptionalCollaboration();

  const handleEvent = useCallback(
    (event: SlideEvent) => {
      if (
        collaboration?.provider &&
        collaboration.teaching.initialized &&
        event.type === "slide_change" &&
        event.slideId &&
        event.slideId !== collaboration.teaching.currentSlideId
      ) {
        return collaboration.publishCurrentSlide(event.slideId);
      }
      handleSlideEvent(event);
      return true;
    },
    [collaboration, handleSlideEvent],
  );

  const slidesData = useSlidesController({
    store,
    onSlideEvent: handleEvent,
    retainSlideOnClose: Boolean(collaboration?.provider),
    resetBuildStepOnOpen: Boolean(collaboration?.provider),
  });

  return <SlidesContext.Provider value={slidesData}>{children}</SlidesContext.Provider>;
};

export const useSlidesContext = () => {
  const context = useContext(SlidesContext);
  if (!context) {
    throw new Error("useSlidesContext must be used within a SlidesProvider");
  }
  return context;
};
