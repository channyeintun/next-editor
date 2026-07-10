import React, { createContext, useContext } from "react";
import { useWhiteboardController } from "../hooks/useWhiteboardController";
import { useWhiteboardStore } from "./WhiteboardStoreContext";
import { useNextEditorActions } from "../hooks/useNextEditorContext";

const WhiteboardContext = createContext<ReturnType<typeof useWhiteboardController> | null>(null);

interface WhiteboardProviderProps {
  children: React.ReactNode;
}

export const WhiteboardProvider: React.FC<WhiteboardProviderProps> = ({ children }) => {
  const { handleWhiteboardEvent } = useNextEditorActions();
  const { store } = useWhiteboardStore();

  const whiteboardData = useWhiteboardController({
    store,
    onWhiteboardEvent: handleWhiteboardEvent,
  });

  return <WhiteboardContext.Provider value={whiteboardData}>{children}</WhiteboardContext.Provider>;
};

export const useWhiteboardContext = () => {
  const context = useContext(WhiteboardContext);
  if (!context) {
    throw new Error("useWhiteboardContext must be used within a WhiteboardProvider");
  }
  return context;
};
