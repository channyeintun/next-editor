import React, { createContext, useCallback, useContext } from "react";
import { useWhiteboardController } from "../hooks/useWhiteboardController";
import { useWhiteboardStore } from "./WhiteboardStoreContext";
import { useNextEditorActions, useNextEditorMetadata } from "../hooks/useNextEditorContext";
import { useOptionalCollaboration } from "./CollaborationContext";
import type { WhiteboardEvent } from "../core/src/whiteboard";

const WhiteboardContext = createContext<ReturnType<typeof useWhiteboardController> | null>(null);

interface WhiteboardProviderProps {
  children: React.ReactNode;
}

export const WhiteboardProvider: React.FC<WhiteboardProviderProps> = ({ children }) => {
  const { handleWhiteboardEvent } = useNextEditorActions();
  const { usesPlaybackModel } = useNextEditorMetadata();
  const { store } = useWhiteboardStore();
  const collaboration = useOptionalCollaboration();

  const handleEvent = useCallback(
    (event: WhiteboardEvent) => {
      const hasSharedDelta = Boolean(event.upserts?.length || event.removedIds?.length);
      if (collaboration?.provider && collaboration.teaching.initialized && hasSharedDelta) {
        const accepted = collaboration.publishWhiteboardDelta({
          ...(event.upserts?.length ? { upserts: event.upserts } : {}),
          ...(event.removedIds?.length ? { removedIds: event.removedIds } : {}),
        });
        if (event.view || event.isOpen !== undefined || event.isMaximized !== undefined) {
          handleWhiteboardEvent({
            timestamp: event.timestamp,
            ...(event.view ? { view: event.view } : {}),
            ...(event.isOpen === undefined ? {} : { isOpen: event.isOpen }),
            ...(event.isMaximized === undefined ? {} : { isMaximized: event.isMaximized }),
          });
        }
        return accepted;
      }
      handleWhiteboardEvent(event);
      return true;
    },
    [collaboration, handleWhiteboardEvent],
  );

  const whiteboardData = useWhiteboardController({
    store,
    onWhiteboardEvent: handleEvent,
    scopeKey: usesPlaybackModel ? "playback" : collaboration?.provider,
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
