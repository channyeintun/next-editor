import { createContext, useContext, type ReactNode } from "react";
import { useWhiteboardController } from "../hooks/useWhiteboardController";
import { useWhiteboardStore } from "./WhiteboardStoreContext";
import { useNextEditorActions, useNextEditorMetadata } from "../hooks/useNextEditorContext";
import { useOptionalCollaboration } from "./CollaborationContext";
import { useWhiteboardPanelPrefetch } from "../hooks/useWhiteboardPanelPrefetch";
import type { WhiteboardEvent } from "../core/src/whiteboard";

const WhiteboardContext = createContext<ReturnType<typeof useWhiteboardController> | null>(null);

interface WhiteboardProviderProps {
  children: ReactNode;
}

export function WhiteboardProvider({ children }: WhiteboardProviderProps) {
  const { handleWhiteboardEvent, handleViewerPanelViewChange } = useNextEditorActions();
  const { usesPlaybackModel, isInPlaybackSession, isPlaying, currentRecording } =
    useNextEditorMetadata();
  const { store } = useWhiteboardStore();
  const collaboration = useOptionalCollaboration();
  useWhiteboardPanelPrefetch(currentRecording, isPlaying);

  const handleEvent = (event: WhiteboardEvent) => {
    // The board was opened, closed, maximized or restored, and the store already shows it.
    // During a replay that is the viewer's view, which the replay keeps until the recording
    // next changes it; outside playback the machine ignores it.
    if (event.isOpen !== undefined || event.isMaximized !== undefined) {
      handleViewerPanelViewChange("whiteboard");
    }
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
  };

  const whiteboardData = useWhiteboardController({
    store,
    onWhiteboardEvent: handleEvent,
    scopeKey: usesPlaybackModel ? "playback" : collaboration?.provider,
    playbackKey: isInPlaybackSession ? (currentRecording?.id ?? "") : null,
  });

  return <WhiteboardContext value={whiteboardData}>{children}</WhiteboardContext>;
}

export const useWhiteboardContext = () => {
  const context = useContext(WhiteboardContext);
  if (!context) {
    throw new Error("useWhiteboardContext must be used within a WhiteboardProvider");
  }
  return context;
};
