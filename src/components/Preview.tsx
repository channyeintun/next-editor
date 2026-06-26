import { useEffect } from "react";
import { PreviewChrome } from "./preview/PreviewChrome";
import { RuntimePreviewRenderer } from "./preview/RuntimePreviewRenderer";
import { usePreviewController } from "./preview/usePreviewController";
import { useCollapseTransition } from "../hooks/useCollapseTransition";
import { useNextEditorMetadata } from "../hooks/useNextEditorContext";

function Preview() {
  const controller = usePreviewController();
  const { isPlaying } = useNextEditorMetadata();
  const isDocked = controller.panelMode === "docked";

  // Slide the docked panel open/closed. Floating is fixed (out of layout flow),
  // so it keeps its own mount/unmount + reposition transition. The slide is
  // disabled during playback so the recorded preview's cursor mapping — which
  // scales proportionally with the panel width — isn't disturbed mid-animation.
  const dockSlide = useCollapseTransition(!controller.isOpen, {
    enabled: isDocked && !isPlaying,
  });

  // While the preview's resize handle is dragged, suspend the runtime dock's
  // left/right transition so it tracks the drag live instead of lagging behind.
  useEffect(() => {
    if (!controller.isResizing) {
      return;
    }

    document.body.classList.add("is-resizing-panel");
    return () => document.body.classList.remove("is-resizing-panel");
  }, [controller.isResizing]);

  // Docked: render while open, and keep rendering through the slide-out
  // (`isMounted` stays true until the panel is offscreen). Floating mounts/unmounts
  // directly with `isOpen`.
  const shouldRender = isDocked ? dockSlide.isMounted || controller.isOpen : controller.isOpen;
  if (!shouldRender) {
    return null;
  }

  const previewRenderer = (
    <RuntimePreviewRenderer
      iframeRef={controller.iframeRef}
      replayContainerRef={controller.replayContainerRef}
      isRrwebReplayActive={controller.isRrwebReplayActive}
      disablePointerEvents={controller.disablePointerEvents}
    />
  );

  const previewChrome = (
    <PreviewChrome
      containerRef={controller.containerRef}
      size={controller.size}
      mode={controller.panelMode}
      dockWidth={controller.dockWidth}
      dockExpanded={dockSlide.isExpanded}
      dockAnimating={dockSlide.isAnimating}
      onClose={controller.handleClose}
      onFloat={controller.handleFloat}
      onDock={controller.handleDock}
      onBack={controller.handleBack}
      onForward={controller.handleForward}
      onRefresh={controller.handleReload}
      isRefreshing={controller.isRefreshing}
      onOpenConsole={controller.handleOpenConsole}
      onResizeStart={controller.handleResizeStart}
      onDockResizeStart={controller.handleDockResizeStart}
      onTransitionStart={controller.handleTransitionStart}
      onTransitionComplete={controller.handleTransitionComplete}
      previewAddressLabel={controller.previewAddressLabel}
      previewAddressTitle={controller.previewAddressTitle}
    >
      {previewRenderer}
    </PreviewChrome>
  );

  return previewChrome;
}

export default Preview;
