import React, { createContext, useContext } from "react";
import { useSlidesController } from "../hooks/useSlidesController";
import { useSlidesStore } from "./SlidesStoreContext";
import { useNextEditorActions } from "../hooks/useNextEditorContext";

const SlidesContext = createContext<ReturnType<typeof useSlidesController> | null>(null);

interface SlidesProviderProps {
  children: React.ReactNode;
}

export const SlidesProvider: React.FC<SlidesProviderProps> = ({ children }) => {
  const { handleSlideEvent } = useNextEditorActions();
  const { store } = useSlidesStore();

  const slidesData = useSlidesController({
    store,
    onSlideEvent: handleSlideEvent,
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
