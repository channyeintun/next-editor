import { createContext, useContext, type ReactNode } from "react";
import { useSlidesController } from "../hooks/useSlidesController";
import { useSlidesStore } from "./SlidesStoreContext";
import { useNextEditorActions } from "../hooks/useNextEditorContext";
import { useOptionalCollaboration } from "./CollaborationContext";
import { isSlideViewEvent } from "../core/src/slides";
import type { SlideEvent } from "../types/slides";

const SlidesContext = createContext<ReturnType<typeof useSlidesController> | null>(null);

interface SlidesProviderProps {
  children: ReactNode;
}

export function SlidesProvider({ children }: SlidesProviderProps) {
  const { handleSlideEvent, handleViewerPanelViewChange } = useNextEditorActions();
  const { store } = useSlidesStore();
  const collaboration = useOptionalCollaboration();

  const handleEvent = (event: SlideEvent) => {
    // The deck was opened, closed, maximized or minimized. During a replay that is the
    // viewer's view, which the replay keeps until the recording next changes it; outside
    // playback the machine ignores it.
    if (isSlideViewEvent(event)) {
      handleViewerPanelViewChange("slides");
    }
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
  };

  const slidesData = useSlidesController({
    store,
    onSlideEvent: handleEvent,
    retainSlideOnClose: Boolean(collaboration?.provider),
    resetBuildStepOnOpen: Boolean(collaboration?.provider),
  });

  return <SlidesContext value={slidesData}>{children}</SlidesContext>;
}

export const useSlidesContext = () => {
  const context = useContext(SlidesContext);
  if (!context) {
    throw new Error("useSlidesContext must be used within a SlidesProvider");
  }
  return context;
};
