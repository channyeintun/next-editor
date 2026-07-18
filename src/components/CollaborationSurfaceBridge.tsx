import { useEffect, useRef } from "react";
import { useCollaboration } from "../contexts/CollaborationContext";
import { useSlidesContext } from "../contexts/SlidesContext";
import { useWhiteboardContext } from "../contexts/WhiteboardContext";
import { useNextEditorMetadata } from "../hooks/useNextEditorContext";
import {
  useWorkspaceActions,
  useWorkspaceActiveFilePath,
  useWorkspaceTreeVersion,
} from "../hooks/useWorkspace";

/** Coordinates the durable teaching projection with ephemeral followed view state. */
export default function CollaborationSurfaceBridge() {
  const collaboration = useCollaboration();
  const slides = useSlidesContext();
  const whiteboard = useWhiteboardContext();
  const { usesPlaybackModel } = useNextEditorMetadata();
  const activeFilePath = useWorkspaceActiveFilePath();
  const workspaceTreeVersion = useWorkspaceTreeVersion();
  const { setActiveFilePath } = useWorkspaceActions();
  const appliedRevisionRef = useRef<{ sessionId: string; revision: number } | null>(null);

  const slidesOpen = slides.previewState.isOpen;
  const whiteboardOpen = whiteboard.isOpen;

  useEffect(() => {
    if (!collaboration.provider || usesPlaybackModel) return;
    if (whiteboardOpen) {
      collaboration.publishSurface({
        kind: "whiteboard",
        isMaximized: whiteboard.scene.isMaximized,
        viewport: { ...whiteboard.scene.view },
      });
      return;
    }
    if (slidesOpen) {
      collaboration.publishSurface({
        kind: "slides",
        isMaximized: slides.previewState.isMaximized === true,
      });
      return;
    }
    collaboration.publishSurface({
      kind: "editor",
      fileNodeId: collaboration.getNodeIdForPath(activeFilePath),
      viewport: null,
    });
  }, [
    activeFilePath,
    collaboration,
    slides.previewState.isMaximized,
    slidesOpen,
    usesPlaybackModel,
    whiteboard.scene.isMaximized,
    whiteboard.scene.view,
    whiteboardOpen,
    workspaceTreeVersion,
  ]);

  useEffect(() => {
    if (!slidesOpen || !whiteboardOpen) return;
    // Whiteboard deterministically wins a legacy both-open state.
    collaboration.runFollowApplication(() => slides.closePresentation());
  }, [collaboration, slides, slidesOpen, whiteboardOpen]);

  useEffect(() => {
    const target = collaboration.followedParticipant;
    if (!target) {
      appliedRevisionRef.current = null;
      return;
    }
    if (collaboration.connectionState !== "live" || usesPlaybackModel || !collaboration.provider) {
      return;
    }
    const previousApplication = appliedRevisionRef.current;
    if (
      previousApplication?.sessionId === target.sessionId &&
      previousApplication.revision >= target.revision
    ) {
      return;
    }
    let didApply = false;
    collaboration.runFollowApplication(() => {
      const surface = target.surface;
      if (surface.kind === "editor") {
        if (whiteboard.isOpen) whiteboard.setOpen(false);
        if (slides.previewState.isOpen) slides.closePresentation();
        if (surface.fileNodeId) {
          const path = collaboration.getPathForNodeId(surface.fileNodeId);
          if (!path) return;
          if (path !== activeFilePath) setActiveFilePath(path);
        }
        didApply = true;
        return;
      }
      if (surface.kind === "slides") {
        if (whiteboard.isOpen) whiteboard.setOpen(false);
        const slideId = collaboration.teaching.currentSlideId;
        if (!slides.previewState.isOpen) {
          slides.handleSlideEvent({
            type: "slide_open",
            timestamp: performance.now(),
            ...(slideId ? { slideId } : {}),
            isMaximized: surface.isMaximized,
            indexv: 0,
          });
        } else if (slides.previewState.isMaximized !== surface.isMaximized) {
          slides.handleSlideEvent({
            type: surface.isMaximized ? "slide_maximize" : "slide_minimize",
            timestamp: performance.now(),
            ...(slideId ? { slideId } : {}),
            isMaximized: surface.isMaximized,
          });
        }
        didApply = true;
        return;
      }
      if (slides.previewState.isOpen) slides.closePresentation();
      if (!whiteboard.isOpen) whiteboard.setOpen(true);
      whiteboard.applyView(surface.viewport, surface.isMaximized);
      didApply = true;
    });
    if (didApply) {
      appliedRevisionRef.current = { sessionId: target.sessionId, revision: target.revision };
    }
  }, [
    activeFilePath,
    collaboration,
    setActiveFilePath,
    slides,
    usesPlaybackModel,
    whiteboard,
    workspaceTreeVersion,
  ]);

  return null;
}
